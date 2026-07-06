import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { buildUnityEventReferenceIndex } from '../../features/event-references/eventReferences';
import { findDefaultAssetFiles, findDefaultCSharpFiles } from '../../features/event-references/assetDiscovery';
import { createCodeLensesFromIndex } from '../../features/event-references/codeLens';
import { showReferenceLocations } from '../../features/event-references/referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime } from '../../features/event-references/runtime';
import { readDefaultTextFile } from '../../features/event-references/utils';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';
import { createLazyUnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityPlusLogger } from '../../unity/logger';

let fixtureRoot: vscode.Uri;

suite('eventReferences - Real Unity Project Shape', () => {
  suiteSetup(async function () {
    this.timeout(120_000);
    fixtureRoot = getUnityFixtureRoot();
    await configureCSharpSolution(fixtureRoot);
    await waitForUnityFixtureDiscovery(fixtureRoot);
    await waitForCSharpLanguageServiceDeclarations(
      vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs')),
      ['type:Interactable', 'field:OnCheckEnable']
    );
    await waitForCSharpLanguageServiceDeclarations(
      vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Cannon.cs')),
      ['type:Cannon', 'method:Fire']
    );
  });

  test('resolves UnityEvent target methods through default workspace scans', async function () {
    this.timeout(120_000);
    const metadataIndex = createLazyUnityMetadataIndex({
      root: fixtureRoot,
      logger: createMemoryLogger()
    });

    try {
      const runtime = createRealEventReferenceRuntime(metadataIndex);
      const index = await buildUnityEventReferenceIndex(runtime, await metadataIndex.getOrBuild(), { mode: 'interactive' });

      const diagnostics = index.getDiagnostics();
      const methodReferences = index.getReferences('Assets/Scripts/Cannon.cs', 'Fire', 'Amlos.Fixtures.Cannon');
      const fieldReferences = index.getFieldReferences('Assets/Scripts/Interactable.cs', 'OnCheckEnable', 'Amlos.Control.Interact.Interactable');
      const fieldTargets = index.getFieldTargets('Assets/Scripts/Interactable.cs', 'OnCheckEnable', 'Amlos.Control.Interact.Interactable');
      const interactableDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs')));
      const cannonDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Cannon.cs')));
      const interactableLenses = await createCodeLensesFromIndex(runtime, interactableDocument, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true
      });
      const cannonLenses = await createCodeLensesFromIndex(runtime, cannonDocument, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true
      });
      const serializedInstanceLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'serializedInstance');
      const fieldReferenceLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
      const fieldTargetLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');
      const methodLens = cannonLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');

      assert.strictEqual(diagnostics.persistentCallCount, 1);
      assert.strictEqual(diagnostics.resolvedByTargetTypeNameCount, 1);
      assert.strictEqual(diagnostics.resolvedReferenceCount, 1);
      assert.strictEqual(methodReferences.length, 1);
      assert.strictEqual(fieldReferences.length, 1);
      assert.strictEqual(fieldTargets.length, 1);
      assert.strictEqual(fieldTargets[0].scriptPath, 'Assets/Scripts/Cannon.cs');
      assert.strictEqual(serializedInstanceLens?.command?.title, '1 Unity serialized instances');
      assert.strictEqual(serializedInstanceLens?.range.start.line, 5);
      assert.strictEqual(serializedInstanceLens?.range.start.character, 24);
      assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
      assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
      assert.strictEqual(methodLens?.command?.title, '1 UnityEvent references');
      assert.strictEqual(methodLens?.range.start.line, 6);
      assert.strictEqual(methodLens?.range.start.character, 16);

      const commandRecorder = createShowReferencesRecorder();
      await showReferenceLocations(
        { ...runtime, runtimeVscode: commandRecorder.runtimeVscode },
        index,
        fieldReferenceLens?.command?.arguments?.[0] as EventReferenceLocationTarget,
        () => undefined,
        () => true
      );
      await showReferenceLocations(
        { ...runtime, runtimeVscode: commandRecorder.runtimeVscode },
        index,
        fieldTargetLens?.command?.arguments?.[0] as EventReferenceLocationTarget,
        () => undefined,
        () => true
      );

      assert.strictEqual(commandRecorder.calls.length, 2);
      assert.strictEqual(normalizeFsPath(commandRecorder.calls[0].locations[0].uri.fsPath), normalizeFsPath(join(fixtureRoot.fsPath, 'Assets', 'Prefabs', 'Gate.prefab')));
      assert.strictEqual(normalizeFsPath(commandRecorder.calls[1].locations[0].uri.fsPath), normalizeFsPath(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Cannon.cs')));
      assert.strictEqual(commandRecorder.calls[1].locations[0].range.start.line, 6);
      assert.strictEqual(commandRecorder.calls[1].locations[0].range.start.character, 16);
    } finally {
      metadataIndex.dispose();
    }
  });
});

/** Returns the Unity project folder opened by the integration test runner. */
function getUnityFixtureRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'integration tests must open the Unity fixture workspace');
  return folder.uri;
}

/** Points the real C# extension at the generated solution before symbol queries start. */
async function configureCSharpSolution(root: vscode.Uri): Promise<void> {
  const solutionPath = join(root.fsPath, 'UnityEventFixture.sln');
  await vscode.workspace.getConfiguration('dotnet').update('defaultSolution', solutionPath, vscode.ConfigurationTarget.Global);
  await vscode.workspace.openTextDocument(vscode.Uri.file(solutionPath));
  await vscode.extensions.getExtension('ms-dotnettools.csdevkit')?.activate();
  await vscode.extensions.getExtension('ms-dotnettools.csharp')?.activate();

  try {
    // The C# extension reads dotnet.defaultSolution when the language server starts.
    await vscode.commands.executeCommand('dotnet.restartServer');
  } catch {
    // Some extension versions only register restart after activation completes.
  }
}

/** Normalizes Windows drive casing so URI round-trips do not make assertions flaky. */
function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Waits until VS Code workspace discovery can see the real Unity fixture files. */
async function waitForUnityFixtureDiscovery(root: vscode.Uri): Promise<void> {
  const timeoutAt = Date.now() + 10_000;
  while (Date.now() < timeoutAt) {
    const assetFiles = await findDefaultAssetFiles(root, vscode);
    const csharpFiles = await findDefaultCSharpFiles(root, vscode);
    const hasPrefab = assetFiles.some(uri => normalizeFsPath(uri.fsPath).endsWith('/assets/prefabs/gate.prefab'));
    const hasScripts = ['interactable.cs', 'cannon.cs'].every(file =>
      csharpFiles.some(uri => normalizeFsPath(uri.fsPath).endsWith(`/assets/scripts/${file}`))
    );

    if (hasPrefab && hasScripts) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  assert.fail('VS Code workspace discovery did not find the Unity fixture prefab and C# scripts.');
}

/** Waits until the production C# service can report expected declarations. */
async function waitForCSharpLanguageServiceDeclarations(uri: vscode.Uri, expectedDeclarations: readonly string[]): Promise<void> {
  const timeoutAt = Date.now() + 60_000;
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const csharpLanguageService = createVscodeCSharpLanguageService(vscode);
  let lastDeclarations: string[] = [];
  let lastProviderNames: string[] = [];

  while (Date.now() < timeoutAt) {
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    lastProviderNames = flattenSymbolNames(symbols ?? []);
    const [types, fields, methods] = await Promise.all([
      csharpLanguageService.findTypes(document.uri),
      csharpLanguageService.findUnityEventFields(document.uri),
      csharpLanguageService.findMethods(document.uri)
    ]);
    lastDeclarations = [
      ...types.map(type => `type:${type.name}`),
      ...fields.map(field => `field:${field.name}`),
      ...methods.map(method => `method:${method.name}`)
    ];
    const declarations = new Set(lastDeclarations);
    if (expectedDeclarations.every(name => declarations.has(name))) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  assert.fail(
    `C# language service did not include ${expectedDeclarations.join(', ')} for ${uri.fsPath}. ` +
    `Last declarations: ${lastDeclarations.join(', ') || '<none>'}. ` +
    `Last raw provider symbols: ${lastProviderNames.join(', ') || '<none>'}.`
  );
}

/** Flattens VS Code document symbols into normalized declaration names. */
function flattenSymbolNames(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string[] {
  const names: string[] = [];
  for (const symbol of symbols) {
    names.push(normalizeSymbolName(symbol.name));
    if (symbol instanceof vscode.DocumentSymbol) {
      names.push(...flattenSymbolNames(symbol.children));
    }
  }

  return names;
}

/** Removes language-server display suffixes such as method parameter lists. */
function normalizeSymbolName(name: string): string {
  return name.replace(/\s*\(.*$/, '');
}

/** Creates a test logger that records messages without touching the UI. */
function createMemoryLogger(): UnityPlusLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    dispose: () => undefined
  };
}

/** Creates the production UnityEvent runtime surface while keeping the real VS Code C# service. */
function createRealEventReferenceRuntime(metadataIndex: EventReferenceRuntime['metadataIndex']): EventReferenceRuntime {
  return {
    runtimeVscode: vscode,
    logger: createMemoryLogger(),
    metadataIndex,
    findAssetFiles: findDefaultAssetFiles,
    findCSharpFiles: findDefaultCSharpFiles,
    readTextFile: readDefaultTextFile,
    getCacheVersion: () => 0,
    csharpLanguageService: createVscodeCSharpLanguageService(vscode)
  };
}

interface ShowReferencesCall {
  uri: vscode.Uri;
  position: vscode.Position;
  locations: vscode.Location[];
}

/** Records peek-reference commands while delegating every other VS Code API to the real runtime. */
function createShowReferencesRecorder(): { runtimeVscode: typeof vscode; calls: ShowReferencesCall[] } {
  const calls: ShowReferencesCall[] = [];
  const runtimeVscode = {
    ...vscode,
    commands: {
      ...vscode.commands,
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === 'editor.action.showReferences') {
          const [uri, position, locations] = args as [vscode.Uri, vscode.Position, vscode.Location[]];
          calls.push({ uri, position, locations });
          return undefined;
        }

        return await vscode.commands.executeCommand(command, ...args);
      }
    }
  } as typeof vscode;

  return { runtimeVscode, calls };
}
