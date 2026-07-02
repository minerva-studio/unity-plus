import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createUnityMetadataIndex, parseUnityMetaGuid, UnityMetaFileWatchHandlers } from '../unity/metadataIndex';

const firstGuid = '11111111111111111111111111111111';
const secondGuid = '22222222222222222222222222222222';

describe('metadataIndex', () => {
  it('parses Unity meta GUIDs', () => {
    assert.strictEqual(parseUnityMetaGuid([
      'fileFormatVersion: 2',
      `guid: ${firstGuid}`,
      'MonoImporter:'
    ].join('\n')), firstGuid);
  });

  it('maps GUIDs to asset paths during rebuild', async () => {
    const output = createMemoryOutput();
    const firstMeta = createUri('/Project/Assets/Player.cs.meta');
    const index = createUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createLogger({
        output,
        getLevel: () => 'info'
      }),
      findMetaFiles: async () => [firstMeta],
      readTextFile: async () => `guid: ${firstGuid}`,
      watchMetaFiles: createNoopWatcher
    });

    await index.rebuild();

    assert.strictEqual(index.getAssetPath(firstGuid), 'Assets/Player.cs');
  });

  it('updates GUID mappings from meta file watcher events', async () => {
    const output = createMemoryOutput();
    let handlers: UnityMetaFileWatchHandlers | undefined;
    const metaFile = createUri('/Project/Assets/Enemy.prefab.meta');
    const fileContents = new Map<string, string>();
    const index = createUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createLogger({
        output,
        getLevel: () => 'info'
      }),
      findMetaFiles: async () => [],
      readTextFile: async uri => fileContents.get(uri.fsPath) ?? '',
      watchMetaFiles: watchedHandlers => {
        handlers = watchedHandlers;
        return createDisposable();
      }
    });

    await index.rebuild();
    fileContents.set(metaFile.fsPath, `guid: ${firstGuid}`);
    handlers?.onCreate(metaFile);
    await flushPromises();

    assert.strictEqual(index.getAssetPath(firstGuid), 'Assets/Enemy.prefab');

    fileContents.set(metaFile.fsPath, `guid: ${secondGuid}`);
    handlers?.onChange(metaFile);
    await flushPromises();

    assert.strictEqual(index.getAssetPath(firstGuid), undefined);
    assert.strictEqual(index.getAssetPath(secondGuid), 'Assets/Enemy.prefab');

    handlers?.onDelete(metaFile);

    assert.strictEqual(index.getAssetPath(secondGuid), undefined);
  });

  it('skips malformed meta files without breaking rebuild', async () => {
    const output = createMemoryOutput();
    const goodMeta = createUri('/Project/Assets/Valid.asset.meta');
    const badMeta = createUri('/Project/Assets/Broken.asset.meta');
    const index = createUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      }),
      findMetaFiles: async () => [badMeta, goodMeta],
      readTextFile: async uri => uri.fsPath === goodMeta.fsPath ? `guid: ${firstGuid}` : 'fileFormatVersion: 2',
      watchMetaFiles: createNoopWatcher
    });

    await index.rebuild();

    assert.strictEqual(index.getAssetPath(firstGuid), 'Assets/Valid.asset');
    assert.strictEqual(output.lines.some(line => line.includes('Skipped malformed Unity metadata file')), true);
  });
});

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

function createUri(fsPath: string): vscode.Uri {
  return { fsPath } as vscode.Uri;
}

function createNoopWatcher(_handlers: UnityMetaFileWatchHandlers): vscode.Disposable {
  return createDisposable();
}

function createDisposable(): vscode.Disposable {
  return {
    dispose(): void {
      return;
    }
  };
}

async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}
