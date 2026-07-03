import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  buildUnityEventReferenceIndex,
  parseUnityEventReferences,
  registerEventReferenceFeature
} from '../features/event-references/eventReferences';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createLazyUnityMetadataIndex, UnityMetadataIndex } from '../unity/metadataIndex';

const gateGuid = '11111111111111111111111111111111';
const gateScriptPath = 'Assets/Gate.cs';

describe('eventReferences', () => {
  it('does not build metadata when UnityEvent references are disabled', async () => {
    let builds = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => ({
        rebuild: async () => {
          builds += 1;
        },
        getAssetPath: () => undefined,
        dispose: () => undefined
      })
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => false
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(builds, 0);
    assert.strictEqual(lazyIndex.isBuilt(), false);
  });

  it('builds metadata lazily from the enabled UnityEvent references command', async () => {
    let builds = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => ({
        rebuild: async () => {
          builds += 1;
        },
        getAssetPath: () => undefined,
        dispose: () => undefined
      })
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [],
      readTextFile: async () => ''
    });

    assert.strictEqual(builds, 0);
    await runtime.runCommand('unityPlus.showUnityEventReferences');
    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(builds, 1);
    assert.strictEqual(lazyIndex.isBuilt(), true);
  });

  it('parses prefab UnityEvent persistent calls', () => {
    const references = parseUnityEventReferences(createPrefabYaml(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].assetPath, 'Assets/Gate.prefab');
    assert.strictEqual(references[0].assetKind, 'prefab');
    assert.strictEqual(references[0].eventFieldName, 'OnCheckEnable');
    assert.strictEqual(references[0].gameObjectName, 'North Gate');
    assert.strictEqual(references[0].targetTypeName, 'Amlos.Fixtures.Gate');
    assert.strictEqual(references[0].methodName, 'CanInteract');
    assert.strictEqual(references[0].scriptPath, gateScriptPath);
  });

  it('parses scene UnityEvent persistent calls', () => {
    const references = parseUnityEventReferences(createPrefabYaml(2), 'Assets/Scenes/Main.unity', 'scene', createMetadataIndex());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].assetKind, 'scene');
    assert.strictEqual(references[0].assetPath, 'Assets/Scenes/Main.unity');
  });

  it('skips disabled persistent calls', () => {
    const references = parseUnityEventReferences(createPrefabYaml(0), 'Assets/Gate.prefab', 'prefab', createMetadataIndex());

    assert.strictEqual(references.length, 0);
  });

  it('skips malformed or unresolved serialized data without throwing', () => {
    const references = parseUnityEventReferences([
      '%YAML 1.1',
      '--- !u!114 &460066068064628344',
      'MonoBehaviour:',
      '  OnCheckEnable:',
      '    m_PersistentCalls:',
      '      m_Calls:',
      '      - m_Target: {fileID: 999}',
      '        m_MethodName: CanInteract',
      '        m_CallState: 2'
    ].join('\n'), 'Assets/Broken.prefab', 'prefab', createMetadataIndex());

    assert.strictEqual(references.length, 0);
  });

  it('reports scanner diagnostics for scanned assets and skipped calls', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/Main.unity')
      ],
      readTextFile: async uri => uri.fsPath.endsWith('.prefab')
        ? createPrefabYaml(2)
        : createMissingScriptGuidYaml()
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();

    assert.strictEqual(diagnostics.prefabCount, 1);
    assert.strictEqual(diagnostics.sceneCount, 1);
    assert.strictEqual(diagnostics.persistentCallCount, 2);
    assert.strictEqual(diagnostics.resolvedReferenceCount, 1);
    assert.strictEqual(diagnostics.skippedMissingScriptGuidCount, 1);
  });

  it('parses m_Target fileID from nested YAML lines', () => {
    const references = parseUnityEventReferences(createPrefabYamlWithNestedTarget(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].methodName, 'CanInteract');
  });

  it('shows CodeLens and hover details for referenced C# methods', async () => {
    const runtime = createEventReferenceRuntime();
    const prefabUri = createUri('/Project/Assets/Gate.prefab');
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'public class Gate',
      '{',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [prefabUri],
      readTextFile: async () => createPrefabYaml(2)
    });

    const lenses = await runtime.provideCodeLenses(csharpDocument);
    assert.strictEqual(lenses.length, 1);
    assert.strictEqual(lenses[0].command?.title, 'UnityEvent references: 1');

    const hover = await runtime.provideHover(csharpDocument, new FakePosition(2, 16) as unknown as vscode.Position);
    assert.ok(hover);
    const hoverText = (hover.contents[0] as vscode.MarkdownString).value;
    assert.strictEqual(hoverText.includes('Assets/Gate\\.prefab'), true);
    assert.strictEqual(hoverText.includes('OnCheckEnable'), true);
    assert.strictEqual(hoverText.includes('North Gate'), true);
  });

  it('does not scan for CodeLens when UnityEvent references are disabled', async () => {
    let scans = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => false,
      findAssetFiles: async () => {
        scans += 1;
        return [createUri('/Project/Assets/Gate.prefab')];
      },
      readTextFile: async () => createPrefabYaml(2)
    });

    const lenses = await runtime.provideCodeLenses(createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;'));

    assert.strictEqual(lenses.length, 0);
    assert.strictEqual(scans, 0);
  });

  it('shows diagnostic summary from the command when no references resolve', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Main.unity')],
      readTextFile: async () => createMissingScriptGuidYaml()
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(runtime.infoMessages[0].includes('scanned 0 prefab(s) and 1 scene(s)'), true);
    assert.strictEqual(runtime.infoMessages[0].includes('resolved 0 UnityEvent reference(s)'), true);
  });
});

interface EventReferenceRuntime {
  runtime: typeof vscode;
  infoMessages: string[];
  runCommand(command: string): Promise<void>;
  provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]>;
  provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined>;
}

function createEventReferenceRuntime(): EventReferenceRuntime {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const codeLensProviders: vscode.CodeLensProvider[] = [];
  const hoverProviders: vscode.HoverProvider[] = [];
  const infoMessages: string[] = [];
  const runtime = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
        commands.set(command, callback);
        return createDisposable();
      }
    },
    languages: {
      registerCodeLensProvider(_selector: unknown, provider: vscode.CodeLensProvider): vscode.Disposable {
        codeLensProviders.push(provider);
        return createDisposable();
      },
      registerHoverProvider(_selector: unknown, provider: vscode.HoverProvider): vscode.Disposable {
        hoverProviders.push(provider);
        return createDisposable();
      }
    },
    workspace: {
      getConfiguration: () => ({
        get: () => false
      })
    },
    window: {
      showInformationMessage: (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showWarningMessage: () => undefined
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    },
    Position: FakePosition,
    Range: FakeRange,
    CodeLens: FakeCodeLens,
    Hover: FakeHover,
    MarkdownString: FakeMarkdownString
  } as unknown as typeof vscode;

  return {
    runtime,
    infoMessages,
    async runCommand(command: string): Promise<void> {
      await Promise.resolve(commands.get(command)?.());
    },
    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
      const results = await Promise.all(codeLensProviders.map(async provider =>
        await provider.provideCodeLenses(document, {} as vscode.CancellationToken) ?? []
      ));
      return results.flat();
    },
    async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
      return await hoverProviders[0]?.provideHover(document, position, {} as vscode.CancellationToken) ?? undefined;
    }
  };
}

function createPrefabYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: North Gate',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '  OnCheckEnable:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 460066068064628344}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.Gate, Amlos.Gameplay.Core',
    '        m_MethodName: CanInteract',
    '        m_Mode: 0',
    '        m_Arguments:',
    '          m_ObjectArgument: {fileID: 0}',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createPrefabYamlWithNestedTarget(callState: number): string {
  return createPrefabYaml(callState).replace(
    '- m_Target: {fileID: 460066068064628344}',
    ['- m_Target:', '    fileID: 460066068064628344'].join('\n')
  );
}

function createMissingScriptGuidYaml(): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  OnCheckEnable:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 460066068064628344}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.Gate, Amlos.Gameplay.Core',
    '        m_MethodName: CanInteract',
    '        m_CallState: 2'
  ].join('\n');
}

function createMetadataIndex(): UnityMetadataIndex {
  return {
    rebuild: async () => undefined,
    getAssetPath: guid => guid === gateGuid ? gateScriptPath : undefined,
    dispose: () => undefined
  };
}

interface MemoryLogOutput extends UnityPlusLogOutput {
  lines: string[];
}

function createMemoryOutput(): MemoryLogOutput {
  return {
    lines: [],
    appendLine(message: string): void {
      this.lines.push(message);
    },
    dispose(): void {
      this.lines = [];
    }
  };
}

function createTestLogger() {
  return createLogger({
    output: createMemoryOutput(),
    getLevel: () => 'debug'
  });
}

function createTextDocument(fsPath: string, text: string): vscode.TextDocument {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    uri: createUri(fsPath),
    getText: () => text,
    positionAt: (offset: number) => {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line += 1;
      }

      return new FakePosition(line, offset - lineStarts[line]);
    }
  } as vscode.TextDocument;
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}

class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class FakeRange {
  constructor(
    public readonly start: vscode.Position,
    public readonly end: vscode.Position
  ) {}
}

class FakeCodeLens {
  constructor(
    public readonly range: vscode.Range,
    public readonly command?: vscode.Command
  ) {}
}

class FakeMarkdownString {
  value = '';

  appendMarkdown(value: string): void {
    this.value += value;
  }
}

class FakeHover {
  constructor(
    contents: FakeMarkdownString | FakeMarkdownString[],
    public readonly range?: vscode.Range
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }

  public readonly contents: FakeMarkdownString[];
}
