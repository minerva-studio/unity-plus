import { relative } from 'node:path';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from './logger';

export interface UnityMetadataIndex extends vscode.Disposable {
  rebuild(): Promise<void>;
  getAssetPath(guid: string): string | undefined;
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

const metaExtension = '.meta';
const guidPattern = /^guid:\s*([a-fA-F0-9]{32})\s*$/m;

export function createUnityMetadataIndex(options: UnityMetadataIndexOptions): UnityMetadataIndex {
  const guidToAssetPath = new Map<string, string>();
  const metaPathToGuid = new Map<string, string>();
  const findMetaFiles = options.findMetaFiles ?? (() => findDefaultMetaFiles(options.root));
  const readTextFile = options.readTextFile ?? readDefaultTextFile;
  const toAssetPath = options.toAssetPath ?? (metaUri => defaultAssetPath(options.root, metaUri));
  const watcher = (options.watchMetaFiles ?? (handlers => watchDefaultMetaFiles(options.root, handlers)))({
    onCreate: uri => void updateMetaFile(uri),
    onChange: uri => void updateMetaFile(uri),
    onDelete: uri => removeMetaFile(uri)
  });

  async function rebuild(): Promise<void> {
    guidToAssetPath.clear();
    metaPathToGuid.clear();

    const metaFiles = await findMetaFiles();
    await Promise.all(metaFiles.map(updateMetaFile));
    options.logger.info(`Indexed ${guidToAssetPath.size} Unity metadata GUID(s).`);
  }

  async function updateMetaFile(uri: vscode.Uri): Promise<void> {
    try {
      const content = await readTextFile(uri);
      const guid = parseUnityMetaGuid(content);

      if (!guid) {
        removeMetaFile(uri);
        options.logger.debug(`Skipped malformed Unity metadata file: ${uri.fsPath}`);
        return;
      }

      removeMetaFile(uri);
      guidToAssetPath.set(guid, toAssetPath(uri));
      metaPathToGuid.set(metaKey(uri), guid);
    } catch (error) {
      removeMetaFile(uri);
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
    guidToAssetPath.delete(existingGuid);
  }

  return {
    rebuild,
    getAssetPath: (guid: string) => guidToAssetPath.get(guid),
    dispose: () => watcher.dispose()
  };
}

export function parseUnityMetaGuid(content: string): string | undefined {
  return guidPattern.exec(content)?.[1];
}

async function findDefaultMetaFiles(root: vscode.Uri): Promise<readonly vscode.Uri[]> {
  const runtimeVscode = await import('vscode');
  return await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, '**/*.meta'));
}

async function readDefaultTextFile(uri: vscode.Uri): Promise<string> {
  const runtimeVscode = await import('vscode');
  const bytes = await runtimeVscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

function watchDefaultMetaFiles(root: vscode.Uri, handlers: UnityMetaFileWatchHandlers): vscode.Disposable {
  // Load VS Code only inside the extension host so Node-based unit tests can inject watcher behavior.
  const runtimeVscode = createRequire(__filename)('vscode') as typeof vscode;
  const watcher = runtimeVscode.workspace.createFileSystemWatcher(
    new runtimeVscode.RelativePattern(root, '**/*.meta')
  );

  return runtimeVscode.Disposable.from(
    watcher,
    watcher.onDidCreate(handlers.onCreate),
    watcher.onDidChange(handlers.onChange),
    watcher.onDidDelete(handlers.onDelete)
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
