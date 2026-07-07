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
import { configureCSharpSolution, getCSharpProviderReadinessState, getUnityFixtureRoot } from './csharpProviderSetup';

let fixtureRoot: vscode.Uri;
const csharpReadinessTimeoutMs = 60_000;
const csharpNamespaceOnlyFastFailMs = 20_000;
const csharpReadinessLogIntervalMs = 2_000;

suite('eventReferences - Real Unity Project Shape', () => {
  suiteSetup(async function () {
    this.timeout(120_000);
    fixtureRoot = getUnityFixtureRoot();
    await configureCSharpSolution(fixtureRoot);
    await waitForUnityFixtureDiscovery(fixtureRoot);
    await vscode.workspace.getConfiguration('unityPlus').update('eventReferences.enabled', false, vscode.ConfigurationTarget.Global);
    await waitForCSharpLanguageServiceDeclarations(
      vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs')),
      ['type:Interactable', 'field:OnCheckEnable']
    );
    await waitForCSharpLanguageServiceDeclarations(
      vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Cannon.cs')),
      ['type:Cannon', 'method:Fire']
    );
    await waitForCSharpLanguageServiceDeclarations(
      vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'PlainService.cs')),
      ['type:PlainService']
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
      const fieldReferences = index.getFieldReferences('Assets/Scripts/Interactable.cs', 'OnCheckEnable', 'Amlos.Control.Interact.Interactable');
      const fieldTargets = index.getFieldTargets('Assets/Scripts/Interactable.cs', 'OnCheckEnable', 'Amlos.Control.Interact.Interactable');
      const interactableDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs')));
      const cannonDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Cannon.cs')));
      const plainDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'PlainService.cs')));
      const interactableMethods: never[] = [];
      const interactableFields = await runtime.csharpLanguageService?.findUnityEventFields(interactableDocument.uri, ['OnCheckEnable']) ?? [];
      const cannonMethods = await runtime.csharpLanguageService?.findMethods(cannonDocument.uri, ['Fire']) ?? [];
      const plainMethods: never[] = [];
      const interactableLenses = await createCodeLensesFromIndex(runtime, interactableDocument, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true,
        cachedMethods: interactableMethods,
        cachedFields: interactableFields
      });
      const cannonLenses = await createCodeLensesFromIndex(runtime, cannonDocument, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true,
        cachedMethods: cannonMethods
      });
      const plainLenses = await createCodeLensesFromIndex(runtime, plainDocument, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true,
        cachedMethods: plainMethods
      });
      const methodLens = cannonLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');
      const fieldReferenceLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
      const fieldTargetLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

      assert.strictEqual(diagnostics.persistentCallCount, 1);
      assert.strictEqual(fieldReferences.length, 1);
      assert.strictEqual(fieldTargets.length, 1);
      assert.strictEqual(methodLens?.command?.title, '1 UnityEvent references');
      assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
      assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
      assert.strictEqual(interactableLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'method'), false);
      assert.strictEqual(plainLenses.length, 0);
      assert.strictEqual(plainLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'serializedInstance'), false);

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
  const startedAt = Date.now();
  const timeoutAt = startedAt + csharpReadinessTimeoutMs;
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  const csharpLanguageService = createVscodeCSharpLanguageService(vscode);
  let namespaceOnlySince: number | undefined;
  let nextLogAt = startedAt + csharpReadinessLogIntervalMs;
  let lastDeclarations: string[] = [];
  let lastProviderNames: string[] = [];
  let lastError: string | undefined;

  while (Date.now() < timeoutAt) {
    const now = Date.now();
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    );
    lastProviderNames = flattenSymbolNames(symbols ?? []);
    try {
      const types = await csharpLanguageService.findTypes(document.uri);
      const needsFields = expectedDeclarations.some(declaration => declaration.startsWith('field:'));
      const fields = needsFields
        ? await csharpLanguageService.findUnityEventFields(
          document.uri,
          expectedDeclarations
            .filter(declaration => declaration.startsWith('field:'))
            .map(declaration => declaration.slice('field:'.length))
        )
        : [];
      lastDeclarations = [
        ...types.map(type => `type:${type.name}`),
        ...fields.map(field => `field:${field.name}`)
      ];
      for (const expectedMethod of expectedDeclarations
        .filter(declaration => declaration.startsWith('method:'))
        .map(declaration => declaration.slice('method:'.length))) {
        const targetType = types[0]?.fullName;
        if (!targetType || lastDeclarations.includes(`method:${expectedMethod}`)) {
          continue;
        }

        // Target-method lookup is the product path for UnityEvent YAML calls because the method name is known.
        const positions = await csharpLanguageService.findTargetMethodPosition(document.uri, targetType, expectedMethod);
        if (positions.length > 0) {
          lastDeclarations.push(`method:${expectedMethod}`);
        }
      }
      lastError = undefined;
      namespaceOnlySince = undefined;
      const declarations = new Set(lastDeclarations);
      if (expectedDeclarations.every(name => declarations.has(name))) {
        return;
      }
    } catch (error) {
      // The provider can briefly return namespace-only symbols while loading.
      lastError = error instanceof Error ? error.message : String(error);
      namespaceOnlySince = isNamespaceOnlyProviderError(lastError)
        ? namespaceOnlySince ?? now
        : undefined;
    }

    if (namespaceOnlySince !== undefined && Date.now() - namespaceOnlySince >= csharpNamespaceOnlyFastFailMs) {
      failCSharpDeclarationReadiness(uri, expectedDeclarations, lastDeclarations, lastProviderNames, lastError);
    }

    if (Date.now() >= nextLogAt) {
      console.log(
        `[csharp readiness] waiting for ${expectedDeclarations.join(', ')} after ${Math.round((Date.now() - startedAt) / 1000)}s. ` +
        `Last declarations: ${lastDeclarations.join(', ') || '<none>'}. ` +
        `Last raw provider symbols: ${lastProviderNames.join(', ') || '<none>'}. ` +
        `Last error: ${lastError ?? '<none>'}.`
      );
      nextLogAt = Date.now() + csharpReadinessLogIntervalMs;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  failCSharpDeclarationReadiness(uri, expectedDeclarations, lastDeclarations, lastProviderNames, lastError);
}

/** Checks for the production service's namespace-only provider contract error. */
function isNamespaceOnlyProviderError(message: string | undefined): boolean {
  return message?.includes('namespace-only symbols') ?? false;
}

/** Fails a C# declaration readiness wait with the last provider state. */
function failCSharpDeclarationReadiness(
  uri: vscode.Uri,
  expectedDeclarations: readonly string[],
  lastDeclarations: readonly string[],
  lastProviderNames: readonly string[],
  lastError: string | undefined
): never {
  assert.fail(
    `C# language service did not include ${expectedDeclarations.join(', ')} for ${uri.fsPath}. ` +
    `Last declarations: ${lastDeclarations.join(', ') || '<none>'}. ` +
    `Last raw provider symbols: ${lastProviderNames.join(', ') || '<none>'}. ` +
    `Last error: ${lastError ?? '<none>'}. ` +
    `C# readiness: ${JSON.stringify(getCSharpProviderReadinessState() ?? {})}.`
  );
}

/** Flattens VS Code document symbols into normalized declaration names. */
function flattenSymbolNames(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string[] {
  const names: string[] = [];
  for (const symbol of symbols) {
    names.push(normalizeSymbolName(symbol.name));
    if (!isSymbolInformation(symbol)) {
      names.push(...flattenSymbolNames(symbol.children));
    }
  }

  return names;
}

/** Checks for SymbolInformation without relying on extension-host class identity. */
function isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
  return 'location' in symbol;
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
