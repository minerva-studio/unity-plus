import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { buildUnityEventReferenceIndex } from '../../features/event-references/eventReferences';
import { findDefaultAssetFiles, findDefaultCSharpFiles } from '../../features/event-references/assetDiscovery';
import { createEventReferenceProvider } from '../../features/event-references/provider';
import type { EventReferenceRuntime, UnityEventReferenceIndexController } from '../../features/event-references/runtime';
import type { UnitySerializedAssetReferenceIndex } from '../../features/event-references/model';
import { readDefaultTextFile } from '../../features/event-references/utils';
import type { CSharpFieldSymbolSnapshot, CSharpMethodSymbolSnapshot, CSharpSymbolLanguageService, CSharpTypeSymbolSnapshot } from '../../unity/csharpLanguageService';
import { createLazyUnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityPlusLogger } from '../../unity/logger';
import { getUnityFixtureRoot } from './csharpProviderSetup';

suite('eventReferences - VS Code CodeLens Provider', () => {
  test('shows YAML instance lenses immediately and UnityEvent hints after C# symbols become ready', async function () {
    this.timeout(30_000);

    const root = getUnityFixtureRoot();
    const metadataIndex = createLazyUnityMetadataIndex({
      root,
      logger: createMemoryLogger()
    });
    const csharpService = createDeferredCSharpService();

    try {
      const runtime = createFixtureRuntime(metadataIndex, csharpService);
      const index = await buildUnityEventReferenceIndex(runtime, await metadataIndex.getOrBuild(), { mode: 'interactive' });
      const controller = createReadyIndexController(index, vscode);
      const provider = createEventReferenceProvider(runtime, controller, () => true);
      const disposable = vscode.languages.registerCodeLensProvider({ language: 'csharp' }, provider);

      try {
        const previousEnabled = vscode.workspace.getConfiguration('unityPlus').get<boolean>('eventReferences.enabled');
        await vscode.workspace.getConfiguration('unityPlus').update('eventReferences.enabled', false, vscode.ConfigurationTarget.Global);

        try {
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs')));
          const firstLenses = await executeCodeLensProvider(document.uri);

          assert.strictEqual(firstLenses.some(lens => lens.command?.title === '1 Unity serialized instances'), true);
          assert.strictEqual(firstLenses.some(lens => lens.command?.title === '1 UnityEvent references'), false);
          assert.strictEqual(firstLenses.some(lens => lens.command?.title === '1 UnityEvent targets'), false);

          csharpService.markReady();
          await waitForCodeLensRetry();

          const readyLenses = await executeCodeLensProvider(document.uri);
          const instanceLens = readyLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'serializedInstance');
          const fieldReferenceLens = readyLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
          const fieldTargetLens = readyLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

          assert.strictEqual(instanceLens?.command?.title, '1 Unity serialized instances');
          assert.strictEqual(instanceLens?.range.start.line, 5);
          assert.strictEqual(instanceLens?.range.start.character, 24);
          assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
          assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
        } finally {
          await vscode.workspace.getConfiguration('unityPlus').update('eventReferences.enabled', previousEnabled, vscode.ConfigurationTarget.Global);
        }
      } finally {
        disposable.dispose();
      }
    } finally {
      metadataIndex.dispose();
    }
  });
});

/** Executes VS Code's real CodeLens provider command and normalizes missing results. */
async function executeCodeLensProvider(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return await vscode.commands.executeCommand<vscode.CodeLens[] | undefined>(
    'vscode.executeCodeLensProvider',
    uri
  ) ?? [];
}

/** Waits long enough for the provider retry timer to fire once. */
async function waitForCodeLensRetry(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 1200));
}

/** Creates a runtime that scans the real Unity fixture while using a controlled C# provider. */
function createFixtureRuntime(
  metadataIndex: EventReferenceRuntime['metadataIndex'],
  csharpLanguageService: CSharpSymbolLanguageService
): EventReferenceRuntime {
  return {
    runtimeVscode: vscode,
    logger: createMemoryLogger(),
    metadataIndex,
    findAssetFiles: findDefaultAssetFiles,
    findCSharpFiles: findDefaultCSharpFiles,
    readTextFile: readDefaultTextFile,
    getCacheVersion: () => 0,
    csharpLanguageService,
    resolveCSharpType: async fullTypeName => {
      if (fullTypeName === 'Amlos.Fixtures.Cannon') {
        return 'Assets/Scripts/Cannon.cs';
      }

      return fullTypeName === 'Amlos.Control.Interact.Interactable'
        ? 'Assets/Scripts/Interactable.cs'
        : undefined;
    }
  };
}

/** Creates a controller whose index is already built for deterministic CodeLens tests. */
function createReadyIndexController(
  index: UnitySerializedAssetReferenceIndex,
  runtimeVscode: typeof vscode
): UnityEventReferenceIndexController {
  const emitter = new runtimeVscode.EventEmitter<void>();
  return {
    onDidChangeCodeLenses: emitter.event,
    getStatus: () => 'ready',
    getReadyIndex: () => index,
    scheduleBuild: () => undefined,
    forceBuild: async () => index,
    notifyCodeLensesChanged: () => emitter.fire()
  };
}

interface DeferredCSharpService extends CSharpSymbolLanguageService {
  markReady(): void;
}

/** Creates a C# service that first behaves like a warming server, then returns fixture symbols. */
function createDeferredCSharpService(): DeferredCSharpService {
  let ready = false;

  function throwIfNotReady(): void {
    if (!ready) {
      throw new Error('C# document symbol provider returned namespace-only symbols for fixture symbols.');
    }
  }

  return {
    markReady() {
      ready = true;
    },
    async getPrimaryTopLevelType() {
      throwIfNotReady();
      return undefined;
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return undefined;
    },
    async findMethods(uri) {
      throwIfNotReady();
      return getMethodSymbols(uri.fsPath);
    },
    async findTypes(uri) {
      throwIfNotReady();
      return getTypeSymbols(uri.fsPath);
    },
    async findUnityEventFields(uri) {
      throwIfNotReady();
      return getFieldSymbols(uri.fsPath);
    },
    async findMethodAtPosition(uri, position) {
      throwIfNotReady();
      return getMethodSymbols(uri.fsPath).find(method => containsPosition(method.range, position));
    },
    async findUnityEventFieldAtPosition(uri, position) {
      throwIfNotReady();
      return getFieldSymbols(uri.fsPath).find(field => containsPosition(field.range, position));
    },
    async findTargetMethodPosition(uri, _targetTypeName, methodName) {
      throwIfNotReady();
      return getMethodSymbols(uri.fsPath)
        .filter(method => method.name === methodName)
        .map(method => method.range.start);
    },
    async isUnityObjectType() {
      throwIfNotReady();
      return true;
    }
  };
}

/** Returns fixture method symbols by script path. */
function getMethodSymbols(fsPath: string): CSharpMethodSymbolSnapshot[] {
  if (normalizeFsPath(fsPath).endsWith('/assets/scripts/cannon.cs')) {
    return [{
      name: 'Fire',
      typeName: 'Amlos.Fixtures.Cannon',
      range: createRange(6, 16, 20)
    }];
  }

  return [];
}

/** Returns fixture type symbols by script path. */
function getTypeSymbols(fsPath: string): CSharpTypeSymbolSnapshot[] {
  if (normalizeFsPath(fsPath).endsWith('/assets/scripts/interactable.cs')) {
    return [{
      name: 'Interactable',
      fullName: 'Amlos.Control.Interact.Interactable',
      range: createRange(5, 24, 36)
    }];
  }

  if (normalizeFsPath(fsPath).endsWith('/assets/scripts/cannon.cs')) {
    return [{
      name: 'Cannon',
      fullName: 'Amlos.Fixtures.Cannon',
      range: createRange(4, 20, 26)
    }];
  }

  return [];
}

/** Returns fixture UnityEvent field symbols by script path. */
function getFieldSymbols(fsPath: string): CSharpFieldSymbolSnapshot[] {
  if (!normalizeFsPath(fsPath).endsWith('/assets/scripts/interactable.cs')) {
    return [];
  }

  return [{
    name: 'OnCheckEnable',
    typeName: 'Amlos.Control.Interact.Interactable',
    range: createRange(7, 26, 39)
  }];
}

/** Creates a C# range for fixture symbols. */
function createRange(line: number, startCharacter: number, endCharacter: number): CSharpMethodSymbolSnapshot['range'] {
  return {
    start: { line, character: startCharacter },
    end: { line, character: endCharacter }
  };
}

/** Checks whether a position lies inside a fixture symbol range. */
function containsPosition(
  range: CSharpMethodSymbolSnapshot['range'],
  position: { line: number; character: number }
): boolean {
  return range.start.line === position.line &&
    range.start.character <= position.character &&
    position.character <= range.end.character;
}

/** Normalizes paths for Windows-safe fixture matching. */
function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Creates a quiet logger for integration fixtures. */
function createMemoryLogger(): UnityPlusLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    dispose: () => undefined
  };
}
