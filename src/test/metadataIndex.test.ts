import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createLazyUnityMetadataIndex, createUnityMetadataIndex, defaultMetaFilesGlob, defaultMetaFilesGlobs, findUnityMetaFilesWithFallback, parseUnityMetaGuid, UnityMetaFileWatchHandlers } from '../unity/metadataIndex';

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
    assert.strictEqual(index.getGuid('Assets/Player.cs'), firstGuid);
    assert.strictEqual(index.getStatistics?.().foundMetaFileCount, 1);
    assert.strictEqual(index.getStatistics?.().readMetaFileCount, 1);
    assert.strictEqual(index.getStatistics?.().parsedGuidCount, 1);
    assert.strictEqual(output.lines.some(line => line.includes('found=1, read=1, parsed GUIDs=1')), true);
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
    assert.strictEqual(index.getGuid('Assets/Enemy.prefab'), firstGuid);

    fileContents.set(metaFile.fsPath, `guid: ${secondGuid}`);
    handlers?.onChange(metaFile);
    await flushPromises();

    assert.strictEqual(index.getAssetPath(firstGuid), undefined);
    assert.strictEqual(index.getAssetPath(secondGuid), 'Assets/Enemy.prefab');
    assert.strictEqual(index.getGuid('Assets/Enemy.prefab'), secondGuid);

    handlers?.onDelete(metaFile);

    assert.strictEqual(index.getAssetPath(secondGuid), undefined);
    assert.strictEqual(index.getGuid('Assets/Enemy.prefab'), undefined);
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
    assert.strictEqual(index.getStatistics?.().malformedMetaFileCount, 1);
    assert.strictEqual(output.lines.some(line => line.includes('Skipped malformed Unity metadata file')), true);
  });

  it('reports read errors and warns when the metadata index is empty', async () => {
    const output = createMemoryOutput();
    const index = createUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      }),
      findMetaFiles: async () => [createUri('/Project/Assets/Broken.cs.meta')],
      readTextFile: async () => {
        throw new Error('denied');
      },
      watchMetaFiles: createNoopWatcher
    });

    await index.rebuild();

    assert.strictEqual(index.getStatistics?.().foundMetaFileCount, 1);
    assert.strictEqual(index.getStatistics?.().readErrorCount, 1);
    assert.strictEqual(index.getStatistics?.().parsedGuidCount, 0);
    assert.strictEqual(output.lines.some(line => line.includes('Unity metadata index is empty')), true);
  });

  it('falls back to directory walking when VS Code file search returns no meta files', async () => {
    const fallbackCalls: string[] = [];
    const runtime = createMetadataSearchRuntime({
      '/Project/Assets': [
        ['Player.cs.meta', 1],
        ['Nested', 2],
        ['Library', 2]
      ],
      '/Project/Assets/Nested': [
        ['Enemy.prefab.meta', 1]
      ],
      '/Project/Assets/Library': [
        ['Ignored.asset.meta', 1]
      ],
      '/Project/Packages': [
        ['package.json.meta', 1]
      ]
    });
    const files = await findUnityMetaFilesWithFallback(
      createUri('/Project'),
      runtime,
      { warn: message => fallbackCalls.push(message) }
    );

    assert.deepStrictEqual(files.map(uri => uri.fsPath), [
      '/Project/Assets/Player.cs.meta',
      '/Project/Assets/Nested/Enemy.prefab.meta',
      '/Project/Packages/package.json.meta'
    ]);
    assert.strictEqual(fallbackCalls.length, 1);
  });

  it('uses findFiles with excludes disabled before directory walking', async () => {
    const excludes: unknown[] = [];
    const runtime = createMetadataSearchRuntime({}, {
      findFiles: async (pattern, exclude) => {
        excludes.push(exclude);
        return String((pattern as { pattern?: string }).pattern).startsWith('Assets/')
          ? [createUri('/Project/Assets/Player.cs.meta')]
          : [];
      }
    });
    const files = await findUnityMetaFilesWithFallback(createUri('/Project'), runtime);

    assert.deepStrictEqual(files.map(uri => uri.fsPath), ['/Project/Assets/Player.cs.meta']);
    assert.deepStrictEqual(excludes, [null, null]);
  });

  it('keeps the legacy Assets metadata glob and scans package metadata too', () => {
    assert.strictEqual(defaultMetaFilesGlob, 'Assets/**/*.meta');
    assert.deepStrictEqual(defaultMetaFilesGlobs, ['Assets/**/*.meta', 'Packages/**/*.meta']);
  });

  it('builds lazily and reuses the first metadata index until forced to rebuild', async () => {
    const output = createMemoryOutput();
    let created = 0;
    let rebuilds = 0;
    let disposed = 0;
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createLogger({
        output,
        getLevel: () => 'info'
      }),
      createIndex: () => {
        created += 1;
        return {
          rebuild: async () => {
            rebuilds += 1;
          },
          getAssetPath: guid => guid === firstGuid ? 'Assets/Player.cs' : undefined,
          getGuid: assetPath => assetPath === 'Assets/Player.cs' ? firstGuid : undefined,
          dispose: () => {
            disposed += 1;
          }
        };
      }
    });

    assert.strictEqual(created, 0);
    assert.strictEqual(lazyIndex.isBuilt(), false);

    const firstIndex = await lazyIndex.getOrBuild();
    const secondIndex = await lazyIndex.getOrBuild();

    assert.strictEqual(firstIndex, secondIndex);
    assert.strictEqual(firstIndex.getAssetPath(firstGuid), 'Assets/Player.cs');
    assert.strictEqual(created, 1);
    assert.strictEqual(rebuilds, 1);
    assert.strictEqual(lazyIndex.isBuilt(), true);

    await lazyIndex.rebuild();
    lazyIndex.dispose();

    assert.strictEqual(created, 1);
    assert.strictEqual(rebuilds, 2);
    assert.strictEqual(disposed, 1);
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
  return { fsPath, path: fsPath } as vscode.Uri;
}

/** Creates a small VS Code runtime fake for metadata search fallback tests. */
function createMetadataSearchRuntime(
  directories: Record<string, Array<[string, number]>>,
  options: { findFiles?: (pattern: unknown, exclude?: unknown) => Promise<readonly vscode.Uri[]> } = {}
): typeof vscode {
  return {
    workspace: {
      findFiles: async (pattern: unknown, exclude?: unknown) =>
        await options.findFiles?.(pattern, exclude) ?? [],
      fs: {
        readDirectory: async (uri: vscode.Uri) => directories[uri.fsPath] ?? []
      }
    },
    RelativePattern: class {
      constructor(
        public readonly base: vscode.Uri,
        public readonly pattern: string
      ) {}
    },
    Uri: {
      joinPath: (base: vscode.Uri, ...segments: string[]) =>
        createUri([base.fsPath.replace(/\\/g, '/').replace(/\/$/, ''), ...segments].join('/'))
    },
    FileType: {
      File: 1,
      Directory: 2
    }
  } as unknown as typeof vscode;
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
