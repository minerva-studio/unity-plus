import { relative } from 'node:path';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from './logger';

export interface UnityMetadataIndex extends vscode.Disposable {
  rebuild(): Promise<void>;
  getAssetPath(guid: string): string | undefined;
  getGuid(assetPath: string): string | undefined;
  getStatistics?(): UnityMetadataIndexStatistics;
}

export interface UnityMetadataIndexStatistics {
  rootPath: string;
  globs: readonly string[];
  foundMetaFileCount: number;
  readMetaFileCount: number;
  parsedGuidCount: number;
  malformedMetaFileCount: number;
  readErrorCount: number;
  usedDirectoryWalkFallback: boolean;
}

export interface LazyUnityMetadataIndex extends vscode.Disposable {
  readonly root: vscode.Uri;
  getOrBuild(): Promise<UnityMetadataIndex>;
  rebuild(): Promise<UnityMetadataIndex>;
  isBuilt(): boolean;
}

export interface UnityMetadataIndexOptions {
  root: vscode.Uri;
  logger: UnityPlusLogger;
  findMetaFiles?: () => Promise<readonly vscode.Uri[]>;
  readTextFile?: (uri: vscode.Uri) => Promise<string>;
  watchMetaFiles?: (handlers: UnityMetaFileWatchHandlers) => vscode.Disposable;
  toAssetPath?: (metaUri: vscode.Uri) => string;
}

export interface UnityMetaFileWatchHandlers {
  onCreate(uri: vscode.Uri): void;
  onChange(uri: vscode.Uri): void;
  onDelete(uri: vscode.Uri): void;
}

export interface LazyUnityMetadataIndexOptions extends UnityMetadataIndexOptions {
  createIndex?: (options: UnityMetadataIndexOptions) => UnityMetadataIndex;
}

export const defaultMetaFilesGlobs = ['Assets/**/*.meta', 'Packages/**/*.meta'];
export const defaultMetaFilesGlob = defaultMetaFilesGlobs[0];

const metaExtension = '.meta';
const guidPattern = /^guid:\s*([a-fA-F0-9]{32})\s*$/m;
const defaultRebuildConcurrency = 32;
const skippedDirectoryNames = new Set(['.git', 'Library', 'Temp', 'Obj', 'obj']);

export function createUnityMetadataIndex(options: UnityMetadataIndexOptions): UnityMetadataIndex {
  const guidToAssetPath = new Map<string, string>();
  const assetPathToGuid = new Map<string, string>();
  const metaPathToGuid = new Map<string, string>();
  let usedDirectoryWalkFallback = false;
  const findMetaFiles = options.findMetaFiles ?? (async () => {
    const runtimeVscode = await import('vscode');
    return await findUnityMetaFilesWithFallback(options.root, runtimeVscode, options.logger, () => {
      usedDirectoryWalkFallback = true;
    });
  });
  const readTextFile = options.readTextFile ?? readDefaultTextFile;
  const toAssetPath = options.toAssetPath ?? (metaUri => defaultAssetPath(options.root, metaUri));
  let statistics = createEmptyStatistics(options.root);
  const watcher = (options.watchMetaFiles ?? (handlers => watchDefaultMetaFiles(options.root, handlers)))({
    onCreate: uri => void updateMetaFile(uri),
    onChange: uri => void updateMetaFile(uri),
    onDelete: uri => removeMetaFile(uri)
  });

  async function rebuild(): Promise<void> {
    guidToAssetPath.clear();
    assetPathToGuid.clear();
    metaPathToGuid.clear();
    statistics = createEmptyStatistics(options.root);
    usedDirectoryWalkFallback = false;

    const metaFiles = await findMetaFiles();
    statistics.foundMetaFileCount = metaFiles.length;
    statistics.usedDirectoryWalkFallback = usedDirectoryWalkFallback;
    await runWithConcurrency(metaFiles, uri => updateMetaFile(uri, statistics), defaultRebuildConcurrency);
    statistics.parsedGuidCount = guidToAssetPath.size;
    logMetadataStatistics(options.logger, statistics);
  }

  async function updateMetaFile(uri: vscode.Uri, rebuildStatistics?: UnityMetadataIndexStatistics): Promise<void> {
    try {
      const content = await readTextFile(uri);
      if (rebuildStatistics) {
        rebuildStatistics.readMetaFileCount += 1;
      }

      const guid = parseUnityMetaGuid(content);

      if (!guid) {
        removeMetaFile(uri);
        if (rebuildStatistics) {
          rebuildStatistics.malformedMetaFileCount += 1;
        }
        options.logger.debug(`Skipped malformed Unity metadata file: ${uri.fsPath}`);
        return;
      }

      removeMetaFile(uri);
      const assetPath = toAssetPath(uri);
      guidToAssetPath.set(guid, assetPath);
      assetPathToGuid.set(pathKey(assetPath), guid);
      metaPathToGuid.set(metaKey(uri), guid);
    } catch (error) {
      removeMetaFile(uri);
      if (rebuildStatistics) {
        rebuildStatistics.readErrorCount += 1;
      }
      options.logger.warn(`Could not index Unity metadata file ${uri.fsPath}: ${errorMessage(error)}`);
    }
  }

  function removeMetaFile(uri: vscode.Uri): void {
    const key = metaKey(uri);
    const existingGuid = metaPathToGuid.get(key);

    if (!existingGuid) {
      return;
    }

    metaPathToGuid.delete(key);
    const existingAssetPath = guidToAssetPath.get(existingGuid);
    guidToAssetPath.delete(existingGuid);
    if (existingAssetPath) {
      assetPathToGuid.delete(pathKey(existingAssetPath));
    }
  }

  return {
    rebuild,
    getAssetPath: (guid: string) => guidToAssetPath.get(guid),
    getGuid: (assetPath: string) => assetPathToGuid.get(pathKey(assetPath)),
    getStatistics: () => ({ ...statistics }),
    dispose: () => watcher.dispose()
  };
}

export function createLazyUnityMetadataIndex(options: LazyUnityMetadataIndexOptions): LazyUnityMetadataIndex {
  const { createIndex = createUnityMetadataIndex, ...indexOptions } = options;
  let index: UnityMetadataIndex | undefined;
  let built = false;
  let buildPromise: Promise<UnityMetadataIndex> | undefined;

  async function build(force: boolean): Promise<UnityMetadataIndex> {
    const currentIndex = index ?? createIndex(indexOptions);
    index = currentIndex;

    if (built && !force) {
      return currentIndex;
    }

    if (buildPromise) {
      return await buildPromise;
    }

    buildPromise = currentIndex.rebuild()
      .then(() => {
        built = true;
        return currentIndex;
      })
      .finally(() => {
        buildPromise = undefined;
      });

    return await buildPromise;
  }

  return {
    root: options.root,
    getOrBuild: async () => await build(false),
    rebuild: async () => await build(true),
    isBuilt: () => built,
    dispose: () => {
      index?.dispose();
    }
  };
}

export function parseUnityMetaGuid(content: string): string | undefined {
  return guidPattern.exec(content)?.[1];
}

/** Finds Unity .meta files with VS Code search, then falls back to a bounded Assets/Packages directory walk. */
export async function findUnityMetaFilesWithFallback(
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  logger?: Pick<UnityPlusLogger, 'warn'>,
  onFallback?: () => void
): Promise<readonly vscode.Uri[]> {
  const fileGroups = await Promise.all(defaultMetaFilesGlobs.map(async glob =>
    await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, glob))
  ));
  const files = fileGroups.flat();
  if (files.length > 0) {
    return files;
  }

  logger?.warn(`Unity metadata glob search found 0 .meta files under ${root.fsPath}; falling back to directory walk for Assets and Packages.`);
  onFallback?.();
  return await findMetaFilesByDirectoryWalk(root, runtimeVscode);
}

/** Walks only Unity source roots for .meta files when workspace search returns no candidates. */
export async function findMetaFilesByDirectoryWalk(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const results: vscode.Uri[] = [];
  const roots = ['Assets', 'Packages'].map(segment => runtimeVscode.Uri.joinPath(root, segment));

  for (const directory of roots) {
    await collectMetaFiles(directory, runtimeVscode, results);
  }

  return results;
}

/** Recursively collects .meta files while skipping generated or irrelevant directories. */
async function collectMetaFiles(
  directory: vscode.Uri,
  runtimeVscode: typeof vscode,
  results: vscode.Uri[]
): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await runtimeVscode.workspace.fs.readDirectory(directory);
  } catch {
    return;
  }

  for (const [name, type] of entries) {
    if (type === runtimeVscode.FileType.File && name.endsWith(metaExtension)) {
      results.push(runtimeVscode.Uri.joinPath(directory, name));
      continue;
    }

    if (type === runtimeVscode.FileType.Directory && !skippedDirectoryNames.has(name)) {
      await collectMetaFiles(runtimeVscode.Uri.joinPath(directory, name), runtimeVscode, results);
    }
  }
}

/** Creates a fresh metadata rebuild statistics object for one Unity project root. */
function createEmptyStatistics(root: vscode.Uri): UnityMetadataIndexStatistics {
  return {
    rootPath: root.fsPath,
    globs: defaultMetaFilesGlobs,
    foundMetaFileCount: 0,
    readMetaFileCount: 0,
    parsedGuidCount: 0,
    malformedMetaFileCount: 0,
    readErrorCount: 0,
    usedDirectoryWalkFallback: false
  };
}

/** Writes a compact metadata rebuild diagnostic summary to the Unity Plus output. */
function logMetadataStatistics(logger: UnityPlusLogger, statistics: UnityMetadataIndexStatistics): void {
  logger.info(`Unity metadata index: root=${statistics.rootPath}, globs=${statistics.globs.join(', ')}, found=${statistics.foundMetaFileCount}, read=${statistics.readMetaFileCount}, parsed GUIDs=${statistics.parsedGuidCount}, malformed=${statistics.malformedMetaFileCount}, read errors=${statistics.readErrorCount}.`);

  if (statistics.parsedGuidCount === 0) {
    logger.warn('Unity metadata index is empty; UnityEvent CodeLens cannot resolve script GUIDs.');
  }
}

async function readDefaultTextFile(uri: vscode.Uri): Promise<string> {
  const runtimeVscode = await import('vscode');
  const bytes = await runtimeVscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

function watchDefaultMetaFiles(root: vscode.Uri, handlers: UnityMetaFileWatchHandlers): vscode.Disposable {
  // Load VS Code only inside the extension host so Node-based unit tests can inject watcher behavior.
  const runtimeVscode = createRequire(__filename)('vscode') as typeof vscode;
  const watchers = defaultMetaFilesGlobs.map(glob =>
    runtimeVscode.workspace.createFileSystemWatcher(new runtimeVscode.RelativePattern(root, glob))
  );

  return runtimeVscode.Disposable.from(
    ...watchers.flatMap(watcher => [
      watcher,
      watcher.onDidCreate(handlers.onCreate),
      watcher.onDidChange(handlers.onChange),
      watcher.onDidDelete(handlers.onDelete)
    ])
  );
}

function defaultAssetPath(root: vscode.Uri, metaUri: vscode.Uri): string {
  const assetFsPath = stripMetaExtension(metaUri.fsPath);
  return relative(root.fsPath, assetFsPath).replace(/\\/g, '/');
}

function stripMetaExtension(path: string): string {
  return path.endsWith(metaExtension) ? path.slice(0, -metaExtension.length) : path;
}

function metaKey(uri: vscode.Uri): string {
  return uri.fsPath.replace(/\\/g, '/');
}

function pathKey(assetPath: string): string {
  return assetPath.replace(/\\/g, '/').toLowerCase();
}

async function runWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency: number
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    // Keep rebuild IO bounded so large Unity projects do not swamp the extension host.
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });

  await Promise.all(workers);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
