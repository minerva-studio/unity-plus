import * as assert from 'assert';
import type * as vscode from 'vscode';
import { assetsCsharpGlob, registerProjectSyncFeature, shouldRegisterProjectSyncWatcher } from '../features/project-sync/projectSync';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';

describe('projectSync', () => {
  it('does not register a C# watcher when auto refresh is disabled', () => {
    const runtime = createProjectSyncRuntime();

    registerProjectSyncFeature(createTestLogger(), {
      root: createUri('/Project'),
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => false
    });

    assert.strictEqual(runtime.watcherPatterns.length, 0);
  });

  it('registers an Assets-scoped C# watcher when auto refresh is enabled', () => {
    const runtime = createProjectSyncRuntime();
    const root = createUri('/Project');

    registerProjectSyncFeature(createTestLogger(), {
      root,
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => true
    });

    assert.strictEqual(runtime.watcherPatterns.length, 1);
    assert.strictEqual(runtime.watcherPatterns[0].baseUri, root);
    assert.strictEqual(runtime.watcherPatterns[0].pattern, assetsCsharpGlob);
    assert.strictEqual(runtime.createListeners, 1);
    assert.strictEqual(runtime.deleteListeners, 1);
    assert.strictEqual(runtime.changeListeners, 0);
  });

  it('requires both a Unity root and enabled auto refresh before watching scripts', () => {
    assert.strictEqual(shouldRegisterProjectSyncWatcher(undefined, true), false);
    assert.strictEqual(shouldRegisterProjectSyncWatcher(createUri('/Project'), false), false);
    assert.strictEqual(shouldRegisterProjectSyncWatcher(createUri('/Project'), true), true);
  });
});

interface ProjectSyncRuntime {
  runtime: typeof vscode;
  watcherPatterns: FakeRelativePattern[];
  createListeners: number;
  deleteListeners: number;
  changeListeners: number;
}

class FakeRelativePattern {
  public constructor(
    public readonly baseUri: vscode.Uri,
    public readonly pattern: string
  ) {}
}

function createProjectSyncRuntime(): ProjectSyncRuntime {
  const state = {
    watcherPatterns: [] as FakeRelativePattern[],
    createListeners: 0,
    deleteListeners: 0,
    changeListeners: 0
  };
  const watcher = {
    onDidCreate: () => {
      state.createListeners += 1;
      return createDisposable();
    },
    onDidDelete: () => {
      state.deleteListeners += 1;
      return createDisposable();
    },
    onDidChange: () => {
      state.changeListeners += 1;
      return createDisposable();
    },
    dispose: () => undefined
  };
  const runtime = {
    commands: {
      registerCommand: () => createDisposable()
    },
    workspace: {
      getConfiguration: () => ({
        get: () => false
      }),
      createFileSystemWatcher: (pattern: FakeRelativePattern) => {
        state.watcherPatterns.push(pattern);
        return watcher;
      }
    },
    window: {
      showInformationMessage: () => undefined
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    },
    RelativePattern: FakeRelativePattern
  } as unknown as typeof vscode;

  return {
    runtime,
    get watcherPatterns() {
      return state.watcherPatterns;
    },
    get createListeners() {
      return state.createListeners;
    },
    get deleteListeners() {
      return state.deleteListeners;
    },
    get changeListeners() {
      return state.changeListeners;
    }
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
