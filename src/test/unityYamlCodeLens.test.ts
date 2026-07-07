import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createUnityYamlCodeLensProvider } from '../features/unity-yaml-code-lens/provider';
import type { UnityYamlCodeLensRuntime } from '../features/unity-yaml-code-lens/runtime';
import type { UnityMetadataIndex } from '../unity/metadataIndex';

const gateScriptGuid = '0123456789abcdef0123456789abcdef';

describe('unityYamlCodeLens', () => {
  it('creates a MonoBehaviour C# script CodeLens from m_Script GUID metadata', async () => {
    const runtime = createRuntime({
      [gateScriptGuid]: 'Assets/Scripts/Gate.cs'
    });
    const provider = createUnityYamlCodeLensProvider(runtime);
    const document = createTextDocument('/Project/Assets/Gate.prefab', [
      '--- !u!114 &6007196025337158600',
      'MonoBehaviour:',
      '  m_ObjectHideFlags: 0',
      `  m_Script: {fileID: 11500000, guid: ${gateScriptGuid}, type: 3}`,
      '  m_Name:'
    ].join('\n'));

    const lenses = await provider.provideCodeLenses?.(document, createCancellationToken());

    assert.strictEqual(lenses?.length, 1);
    assert.strictEqual(lenses?.[0].command?.title, 'C# script: Gate');
    assert.strictEqual(lenses?.[0].command?.command, 'unityPlus.openUnityYamlMonoBehaviourScript');
    assert.strictEqual(
      normalizePath(String(lenses?.[0].command?.arguments?.[0] ?? '')),
      '/Project/Assets/Scripts/Gate.cs'
    );
    assert.strictEqual(lenses?.[0].command?.arguments?.[1], gateScriptGuid);
    assert.deepStrictEqual(lenses?.[0].range.start, new FakePosition(1, 0));
  });

  it('shows unresolved MonoBehaviour script CodeLens without m_EditorClassIdentifier fallback guessing', async () => {
    const runtime = createRuntime({});
    const provider = createUnityYamlCodeLensProvider(runtime);
    const document = createTextDocument('/Project/Assets/Gate.prefab', [
      '--- !u!114 &6007196025337158600',
      'MonoBehaviour:',
      `  m_Script: {fileID: 11500000, guid: ${gateScriptGuid}, type: 3}`,
      '  m_EditorClassIdentifier: Assembly-CSharp::Gate'
    ].join('\n'));

    const lenses = await provider.provideCodeLenses?.(document, createCancellationToken());

    assert.strictEqual(lenses?.length, 1);
    assert.strictEqual(lenses?.[0].command?.title, 'C# script: unresolved');
    assert.strictEqual(lenses?.[0].command?.command, 'unityPlus.openUnityYamlMonoBehaviourScript');
    assert.deepStrictEqual(lenses?.[0].command?.arguments, ['', gateScriptGuid]);
    assert.strictEqual(runtime.infoLogs.some(message => message.includes(gateScriptGuid)), true);
  });
});

interface TestRuntime extends UnityYamlCodeLensRuntime {
  infoLogs: string[];
}

/** Creates the minimal runtime needed by the YAML CodeLens provider. */
function createRuntime(guidToAssetPath: Record<string, string>): TestRuntime {
  const infoLogs: string[] = [];
  return {
    runtimeVscode: {
      CodeLens: FakeCodeLens,
      Position: FakePosition,
      Range: FakeRange,
      l10n: {
        t: localize
      }
    } as unknown as typeof vscode,
    logger: {
      debug: () => undefined,
      info: message => infoLogs.push(message),
      warn: () => undefined,
      error: () => undefined,
      dispose: () => undefined
    },
    metadataIndex: {
      root: createUri('/Project'),
      getOrBuild: async () => ({
        getAssetPath: guid => guidToAssetPath[guid],
        getGuid: () => undefined,
        rebuild: async () => undefined,
        dispose: () => undefined
      } as UnityMetadataIndex),
      rebuild: async () => ({
        getAssetPath: guid => guidToAssetPath[guid],
        getGuid: () => undefined,
        rebuild: async () => undefined,
        dispose: () => undefined
      } as UnityMetadataIndex),
      isBuilt: () => true,
      dispose: () => undefined
    },
    infoLogs
  };
}

/** Creates a tiny VS Code-like text document for current-file YAML parsing. */
function createTextDocument(fsPath: string, text: string): vscode.TextDocument {
  return {
    uri: createUri(fsPath),
    getText: () => text
  } as vscode.TextDocument;
}

/** Creates a file URI shape with only the fsPath read by production code. */
function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

/** Normalizes Windows separators in test-only URI assertions. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Creates a cancellation token that never cancels. */
function createCancellationToken(): vscode.CancellationToken {
  return {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
  } as vscode.CancellationToken;
}

/** Applies VS Code l10n placeholder replacement for test strings. */
function localize(message: string, args?: Record<string, string | number | boolean>): string {
  return Object.entries(args ?? {}).reduce((current, [key, value]) =>
    current.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)), message
  );
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
