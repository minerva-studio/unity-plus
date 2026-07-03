import * as assert from 'assert';
import type * as vscode from 'vscode';
import { registerEventReferenceFeature } from '../features/event-references/eventReferences';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createLazyUnityMetadataIndex } from '../unity/metadataIndex';

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
      isEnabled: () => true
    });

    assert.strictEqual(builds, 0);
    await runtime.runCommand('unityPlus.showUnityEventReferences');
    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(builds, 1);
    assert.strictEqual(lazyIndex.isBuilt(), true);
  });
});

interface EventReferenceRuntime {
  runtime: typeof vscode;
  runCommand(command: string): Promise<void>;
}

function createEventReferenceRuntime(): EventReferenceRuntime {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const runtime = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
        commands.set(command, callback);
        return createDisposable();
      }
    },
    workspace: {
      getConfiguration: () => ({
        get: () => false
      })
    },
    window: {
      showInformationMessage: () => undefined,
      showWarningMessage: () => undefined
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    async runCommand(command: string): Promise<void> {
      await Promise.resolve(commands.get(command)?.());
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
