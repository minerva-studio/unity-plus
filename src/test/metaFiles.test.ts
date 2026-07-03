import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  ensureMetaFilesHiddenInExplorer,
  formatMetaFileSummary,
  hideMetaFilesInExplorerIfEnabled,
  metaFilesExcludePattern,
  provideMetaFileCodeLenses,
  registerMetaFilesFeature
} from '../features/meta-files/metaFiles';
import { UnityPlusLogger } from '../unity/logger';

describe('metaFiles', () => {
  it('shows a CodeLens when a matching Unity meta file exists', async () => {
    const runtime = createMetaFilesRuntime();
    const document = createTextDocument('/Project/Assets/Player.cs');
    runtime.files.set('/Project/Assets/Player.cs.meta', [
      'fileFormatVersion: 2',
      'guid: 1234567890abcdef1234567890abcdef',
      'MonoImporter:'
    ].join('\n'));

    const lenses = await provideMetaFileCodeLenses(runtime.runtime, document);

    assert.strictEqual(lenses.length, 1);
    assert.strictEqual(lenses[0].command?.title, 'Meta | guid 12345678 | MonoImporter - Open Meta');
    assert.strictEqual(lenses[0].command?.command, 'unityPlus.openMetaFile');
  });

  it('does not show a CodeLens when the matching meta file is missing', async () => {
    const runtime = createMetaFilesRuntime();
    const document = createTextDocument('/Project/Assets/Missing.prefab');

    const lenses = await provideMetaFileCodeLenses(runtime.runtime, document);

    assert.deepStrictEqual(lenses, []);
  });

  it('does not show a CodeLens for meta files themselves', async () => {
    const runtime = createMetaFilesRuntime();
    const document = createTextDocument('/Project/Assets/Player.cs.meta');
    runtime.files.set('/Project/Assets/Player.cs.meta.meta', 'guid: 1234567890abcdef1234567890abcdef');

    const lenses = await provideMetaFileCodeLenses(runtime.runtime, document);

    assert.deepStrictEqual(lenses, []);
  });

  it('falls back to a safe summary for malformed meta content', () => {
    assert.strictEqual(formatMetaFileSummary('fileFormatVersion: 2'), 'Meta');
  });

  it('writes the Unity meta exclude pattern when hiding is enabled', async () => {
    const runtime = createMetaFilesRuntime({
      unityPlusConfiguration: {
        'metaFiles.hideInExplorer': true
      },
      filesExclude: {
        '**/*.tmp': true
      }
    });

    await hideMetaFilesInExplorerIfEnabled(runtime.runtime, createTestLogger());

    assert.deepStrictEqual(runtime.filesExcludeUpdates, [{
      '**/*.tmp': true,
      [metaFilesExcludePattern]: true
    }]);
    assert.strictEqual(runtime.configurationTargets[0], runtime.runtime.ConfigurationTarget.Workspace);
  });

  it('keeps an existing Unity meta exclude setting without rewriting configuration', async () => {
    const runtime = createMetaFilesRuntime({
      filesExclude: {
        [metaFilesExcludePattern]: true
      }
    });

    await ensureMetaFilesHiddenInExplorer(runtime.runtime, createTestLogger());

    assert.deepStrictEqual(runtime.filesExcludeUpdates, []);
  });

  it('registers the open meta command and opens the target meta file', async () => {
    const runtime = createMetaFilesRuntime();
    const metaUri = createUri('/Project/Assets/Player.cs.meta');
    runtime.files.set(metaUri.fsPath, 'guid: 1234567890abcdef1234567890abcdef');

    registerMetaFilesFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime
    });
    await runtime.runCommand('unityPlus.openMetaFile', metaUri);

    assert.strictEqual(runtime.openedDocuments[0].uri.fsPath, metaUri.fsPath);
    assert.strictEqual(runtime.shownDocuments[0].uri.fsPath, metaUri.fsPath);
  });
});

interface MetaFilesRuntimeOptions {
  unityPlusConfiguration?: Record<string, unknown>;
  filesExclude?: Record<string, boolean>;
}

interface MetaFilesRuntime {
  runtime: typeof vscode;
  files: Map<string, string>;
  filesExcludeUpdates: Record<string, boolean>[];
  configurationTargets: vscode.ConfigurationTarget[];
  openedDocuments: vscode.TextDocument[];
  shownDocuments: vscode.TextDocument[];
  runCommand(command: string, ...args: unknown[]): Promise<void>;
}

function createMetaFilesRuntime(options: MetaFilesRuntimeOptions = {}): MetaFilesRuntime {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const files = new Map<string, string>();
  const filesExcludeUpdates: Record<string, boolean>[] = [];
  const configurationTargets: vscode.ConfigurationTarget[] = [];
  const openedDocuments: vscode.TextDocument[] = [];
  const shownDocuments: vscode.TextDocument[] = [];
  const workspaceTarget = 1 as vscode.ConfigurationTarget;

  const runtime = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
        commands.set(command, callback);
        return createDisposable();
      }
    },
    languages: {
      registerCodeLensProvider: () => createDisposable()
    },
    workspace: {
      getConfiguration(section: string) {
        if (section === 'unityPlus') {
          return {
            get: (key: string) => options.unityPlusConfiguration?.[key]
          };
        }

        return {
          get: (key: string) => key === 'exclude' ? options.filesExclude : undefined,
          update: async (_key: string, value: Record<string, boolean>, target: vscode.ConfigurationTarget) => {
            filesExcludeUpdates.push(value);
            configurationTargets.push(target);
          }
        };
      },
      fs: {
        readFile: async (uri: vscode.Uri) => {
          const content = files.get(uri.fsPath);

          if (content === undefined) {
            throw new Error(`Missing file: ${uri.fsPath}`);
          }

          // Encode through TextEncoder so the tests match VS Code's Uint8Array file API.
          return new TextEncoder().encode(content);
        }
      },
      openTextDocument: async (uri: vscode.Uri) => {
        const document = createTextDocument(uri.fsPath);
        openedDocuments.push(document);
        return document;
      }
    },
    window: {
      showTextDocument: async (document: vscode.TextDocument) => {
        shownDocuments.push(document);
      }
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    },
    Uri: {
      file: createUri
    },
    Range: FakeRange,
    CodeLens: FakeCodeLens,
    ConfigurationTarget: {
      Workspace: workspaceTarget
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    files,
    filesExcludeUpdates,
    configurationTargets,
    openedDocuments,
    shownDocuments,
    async runCommand(command: string, ...args: unknown[]): Promise<void> {
      await Promise.resolve(commands.get(command)?.(...args));
    }
  };
}

function createTextDocument(fsPath: string): vscode.TextDocument {
  return {
    uri: createUri(fsPath),
    lineCount: 1
  } as vscode.TextDocument;
}

function createUri(fsPath: string): vscode.Uri {
  return {
    scheme: 'file',
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

function createTestLogger(): UnityPlusLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    dispose: () => undefined
  };
}

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}

class FakeRange {
  constructor(
    public readonly startLine: number,
    public readonly startCharacter: number,
    public readonly endLine: number,
    public readonly endCharacter: number
  ) {}
}

class FakeCodeLens {
  constructor(
    public readonly range: vscode.Range,
    public readonly command?: vscode.Command
  ) {}
}
