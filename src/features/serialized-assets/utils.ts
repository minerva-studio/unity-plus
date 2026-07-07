import type * as vscode from 'vscode';

export interface RunWithConcurrencyOptions {
  cancellationToken?: vscode.CancellationToken;
  yieldEvery?: number;
  onProgress?: (completedCount: number, totalCount: number) => void;
}

/** Converts a Unity project-relative asset path into a VS Code file URI. */
export function toWorkspaceUri(runtimeVscode: typeof vscode, root: vscode.Uri, projectPath: string): vscode.Uri {
  return runtimeVscode.Uri.file(`${root.fsPath.replace(/[\\/]+$/, '')}/${projectPath.replace(/\\/g, '/')}`);
}

/** Runs async work with bounded concurrency and optional progress callbacks. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
  options: RunWithConcurrencyOptions = {}
): Promise<void> {
  let nextIndex = 0;
  let completedCount = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    // Keep project-wide IO bounded so background indexing does not starve the extension host.
    while (nextIndex < items.length) {
      if (isCancellationRequested(options.cancellationToken)) {
        break;
      }

      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);

      completedCount += 1;
      options.onProgress?.(completedCount, items.length);

      if (options.yieldEvery && completedCount % options.yieldEvery === 0) {
        await yieldToEventLoop();
      }
    }
  });

  await Promise.all(workers);
}

/** Reads a UTF-8 text file through VS Code workspace APIs. */
export async function readDefaultTextFile(uri: vscode.Uri, runtimeVscode: typeof vscode): Promise<string> {
  const bytes = await runtimeVscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Returns the final segment of a managed type name. */
export function shortTypeName(fullTypeName: string): string {
  return fullTypeName.split('.').at(-1) ?? fullTypeName;
}

/** Finds the last namespace declaration before a type declaration offset. */
export function findNearestNamespace(matches: RegExpMatchArray[], offset: number): string | undefined {
  let namespaceName: string | undefined;
  for (const match of matches) {
    if ((match.index ?? 0) > offset) {
      break;
    }

    namespaceName = match[1];
  }

  return namespaceName;
}

/** Converts a file URI into a Unity project-relative path when possible. */
export function toProjectPath(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = toNormalizedPath(root.fsPath);
  const path = toNormalizedPath(uri.fsPath);

  if (path.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`)) {
    return path.slice(rootPath.length + 1);
  }

  return path;
}

/** Normalizes Windows separators for Unity asset-path comparisons. */
export function toNormalizedPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Escapes Markdown punctuation before writing asset names into hover content. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

/** Checks VS Code cancellation tokens without forcing callers to branch on undefined. */
export function isCancellationRequested(token: vscode.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}

/** Throws the shared scan-canceled error when a token has been canceled. */
export function throwIfCancellationRequested(token: vscode.CancellationToken | undefined): void {
  if (isCancellationRequested(token)) {
    throw new UnitySerializedAssetScanCanceledError();
  }
}

/** Detects the shared scan-canceled error type. */
export function isCancellationError(error: unknown): boolean {
  return error instanceof UnitySerializedAssetScanCanceledError;
}

/** Lets the extension host process pending work between large scan batches. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Converts unknown thrown values into readable log text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Formats an unknown thrown value with stack text when the provider supplies it. */
export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }

  return String(error);
}

/** Represents an expected cancellation rather than a failed serialized asset scan. */
export class UnitySerializedAssetScanCanceledError extends Error {
  constructor(message = 'Unity serialized asset scan canceled.') {
    super(message);
  }
}
