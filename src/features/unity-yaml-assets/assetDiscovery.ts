import { extname } from 'node:path';
import type * as vscode from 'vscode';
import { searchUnityFilesContainingText, type UnityTextSearchFileResult } from '../../unity/textSearch';
import type { UnitySerializedAssetKind } from './model';

const assetGlobs = ['Assets/**/*', 'Packages/**/*'];
const csharpGlobs = ['Assets/**/*.cs', 'Packages/**/*.cs'];
const serializedAssetSearchGlobs = ['Assets/**/*.{prefab,unity,asset}', 'Packages/**/*.{prefab,unity,asset}'];
const supportedAssetExtensions = new Set(['.prefab', '.unity', '.asset']);

/** Watches serialized Unity assets so cached YAML/text facts do not outlive changed assets. */
export function watchUnitySerializedAssetFiles(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  onChanged: (uri: vscode.Uri) => void
): vscode.Disposable {
  const watchers = serializedAssetSearchGlobs.map(glob =>
    runtimeVscode.workspace.createFileSystemWatcher(new runtimeVscode.RelativePattern(root, glob))
  );

  return runtimeVscode.Disposable.from(
    ...watchers.flatMap(watcher => [
      watcher,
      watcher.onDidCreate(onChanged),
      watcher.onDidChange(onChanged),
      watcher.onDidDelete(onChanged)
    ])
  );
}

/** Enumerates serialized Unity assets with VS Code workspace globs. */
export async function findDefaultAssetFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const fileGroups = await Promise.all(assetGlobs.map(async glob =>
    await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, glob), null)
  ));
  const files = fileGroups.flat();
  return files.filter(uri => supportedAssetExtensions.has(extname(uri.fsPath).toLowerCase()));
}

/** Searches serialized Unity assets for fixed text with ripgrep and stable fallbacks. */
export async function findDefaultAssetFilesContainingText(
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  texts: readonly string[],
  cancellationToken?: vscode.CancellationToken
): Promise<UnityTextSearchFileResult> {
  return await searchUnityFilesContainingText({
    root,
    runtimeVscode,
    texts,
    includeGlobs: serializedAssetSearchGlobs,
    cancellationToken
  });
}

/** Enumerates C# source files that can own UnityEvent fields or target methods. */
export async function findDefaultCSharpFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const fileGroups = await Promise.all(csharpGlobs.map(async glob =>
    await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, glob))
  ));
  return fileGroups.flat();
}

/** Classifies a URI as a supported serialized Unity asset kind. */
export function getAssetKind(uri: vscode.Uri): UnitySerializedAssetKind | undefined {
  const extension = extname(uri.fsPath).toLowerCase();
  if (extension === '.prefab') {
    return 'prefab';
  }

  if (extension === '.unity') {
    return 'scene';
  }

  if (extension === '.asset') {
    return 'asset';
  }

  return undefined;
}

/** Checks whether a URI points to a C# source file. */
export function isCSharpFile(uri: vscode.Uri): boolean {
  return extname(uri.fsPath).toLowerCase() === '.cs';
}
