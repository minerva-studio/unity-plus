import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type * as vscode from 'vscode';

export type UnityTextSearchBackend = 'ripgrep' | 'systemRg' | 'findFilesFallback';

export interface UnityTextSearchFileResult {
  backend: UnityTextSearchBackend;
  files: readonly vscode.Uri[];
  searchCount: number;
  elapsedMilliseconds: number;
}

export interface UnityTextSearchMatch {
  uri: vscode.Uri;
  line: number;
  character: number;
  text: string;
}

export interface UnityTextSearchMatchResult {
  backend: Exclude<UnityTextSearchBackend, 'findFilesFallback'>;
  matches: readonly UnityTextSearchMatch[];
  searchCount: number;
  elapsedMilliseconds: number;
}

export interface UnityTextSearchOptions {
  root: vscode.Uri;
  runtimeVscode: typeof vscode;
  texts: readonly string[];
  includeGlobs: readonly string[];
  cancellationToken?: vscode.CancellationToken;
}

const maxRipgrepBufferBytes = 64 * 1024 * 1024;

/** Finds files containing any fixed text using ripgrep, with a stable VS Code API fallback. */
export async function searchUnityFilesContainingText(
  options: UnityTextSearchOptions
): Promise<UnityTextSearchFileResult> {
  const startedAt = Date.now();
  const normalizedTexts = normalizeSearchTexts(options.texts);

  if (normalizedTexts.length === 0) {
    return {
      backend: 'findFilesFallback',
      files: [],
      searchCount: 0,
      elapsedMilliseconds: Date.now() - startedAt
    };
  }

  const ripgrepResult = await trySearchFilesWithRipgrep(options, normalizedTexts);
  if (ripgrepResult) {
    return {
      ...ripgrepResult,
      elapsedMilliseconds: Date.now() - startedAt
    };
  }

  const files = await searchFilesWithStableApiFallback(options, normalizedTexts);
  return {
    backend: 'findFilesFallback',
    files,
    searchCount: normalizedTexts.length,
    elapsedMilliseconds: Date.now() - startedAt
  };
}

/** Finds matching text lines with ripgrep JSON output, returning undefined when ripgrep is unavailable. */
export async function trySearchUnityTextMatches(
  options: UnityTextSearchOptions
): Promise<UnityTextSearchMatchResult | undefined> {
  const startedAt = Date.now();
  const normalizedTexts = normalizeSearchTexts(options.texts);

  if (normalizedTexts.length === 0) {
    return {
      backend: 'ripgrep',
      matches: [],
      searchCount: 0,
      elapsedMilliseconds: Date.now() - startedAt
    };
  }

  for (const candidate of await getRipgrepCandidates()) {
    const output = await runRipgrepCandidate(candidate, options, [
      '--json',
      ...createFixedTextRipgrepArgs(normalizedTexts, options.includeGlobs),
      '.'
    ]);

    if (!output) {
      continue;
    }

    return {
      backend: candidate.backend,
      matches: parseRipgrepJsonMatches(output.stdout, options),
      searchCount: normalizedTexts.length,
      elapsedMilliseconds: Date.now() - startedAt
    };
  }

  return undefined;
}

/** Runs ripgrep in files-with-matches mode and returns undefined when no ripgrep backend succeeds. */
async function trySearchFilesWithRipgrep(
  options: UnityTextSearchOptions,
  texts: readonly string[]
): Promise<Omit<UnityTextSearchFileResult, 'elapsedMilliseconds'> | undefined> {
  for (const candidate of await getRipgrepCandidates()) {
    const output = await runRipgrepCandidate(candidate, options, [
      '--files-with-matches',
      ...createFixedTextRipgrepArgs(texts, options.includeGlobs),
      '.'
    ]);

    if (!output) {
      continue;
    }

    return {
      backend: candidate.backend,
      files: parseRipgrepFileList(output.stdout, options),
      searchCount: texts.length
    };
  }

  return undefined;
}

/** Builds fixed-string ripgrep arguments shared by file and line searches. */
function createFixedTextRipgrepArgs(texts: readonly string[], includeGlobs: readonly string[]): string[] {
  return [
    '--color',
    'never',
    '--fixed-strings',
    '--no-ignore',
    ...includeGlobs.flatMap(glob => ['--glob', glob]),
    ...texts.flatMap(text => ['-e', text])
  ];
}

/** Reads all candidate files with stable VS Code APIs when ripgrep is unavailable. */
async function searchFilesWithStableApiFallback(
  options: UnityTextSearchOptions,
  texts: readonly string[]
): Promise<readonly vscode.Uri[]> {
  const fileGroups = await Promise.all(options.includeGlobs.map(async glob =>
    await options.runtimeVscode.workspace.findFiles(new options.runtimeVscode.RelativePattern(options.root, glob), null)
  ));
  const matches: vscode.Uri[] = [];

  for (const uri of fileGroups.flat()) {
    throwIfCancellationRequested(options.cancellationToken);

    try {
      const bytes = await options.runtimeVscode.workspace.fs.readFile(uri);
      const content = new TextDecoder('utf-8').decode(bytes);
      if (texts.some(text => content.includes(text))) {
        matches.push(uri);
      }
    } catch {
      // Unreadable files cannot contribute text candidates.
    }
  }

  return dedupeUris(matches);
}

/** Resolves bundled ripgrep first, then falls back to a PATH-based rg command. */
async function getRipgrepCandidates(): Promise<readonly { backend: Exclude<UnityTextSearchBackend, 'findFilesFallback'>; command: string }[]> {
  const candidates: Array<{ backend: Exclude<UnityTextSearchBackend, 'findFilesFallback'>; command: string }> = [];
  const bundledPath = await resolveBundledRipgrepPath();

  if (bundledPath) {
    candidates.push({ backend: 'ripgrep', command: bundledPath });
  }

  candidates.push({ backend: 'systemRg', command: process.platform === 'win32' ? 'rg.exe' : 'rg' });
  return candidates;
}

/** Dynamically imports the ESM ripgrep package from this CommonJS extension bundle. */
async function resolveBundledRipgrepPath(): Promise<string | undefined> {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ rgPath?: string }>;
    return (await dynamicImport('@vscode/ripgrep')).rgPath;
  } catch {
    return undefined;
  }
}

/** Executes one ripgrep candidate and treats exit code 1 as an empty successful search. */
async function runRipgrepCandidate(
  candidate: { backend: Exclude<UnityTextSearchBackend, 'findFilesFallback'>; command: string },
  options: UnityTextSearchOptions,
  args: readonly string[]
): Promise<{ stdout: string } | undefined> {
  throwIfCancellationRequested(options.cancellationToken);

  return await new Promise(resolvePromise => {
    let cleanupCancellation: () => void = () => undefined;
    const child = execFile(candidate.command, args, {
      cwd: options.root.fsPath,
      maxBuffer: maxRipgrepBufferBytes,
      windowsHide: true
    }, (error, stdout) => {
      cleanupCancellation();
      const exitCode = (error as { code?: unknown } | null)?.code;

      if (!error || exitCode === 1) {
        resolvePromise({ stdout });
        return;
      }

      resolvePromise(undefined);
    });

    cleanupCancellation = registerCancellation(options.cancellationToken, () => {
      child.kill();
      resolvePromise(undefined);
    });
  });
}

/** Parses ripgrep files-with-matches output into workspace URIs. */
function parseRipgrepFileList(stdout: string, options: UnityTextSearchOptions): readonly vscode.Uri[] {
  return dedupeUris(stdout
    .split(/\r?\n/)
    .filter(line => line.length > 0)
    .map(line => uriFromRipgrepPath(options, line)));
}

/** Parses ripgrep JSON match events into line-oriented matches. */
function parseRipgrepJsonMatches(stdout: string, options: UnityTextSearchOptions): readonly UnityTextSearchMatch[] {
  const matches: UnityTextSearchMatch[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    try {
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          lines?: { text?: string };
          line_number?: number;
          submatches?: Array<{ start?: number }>;
        };
      };

      if (event.type !== 'match' || !event.data?.path?.text || !event.data.lines?.text || event.data.line_number === undefined) {
        continue;
      }

      matches.push({
        uri: uriFromRipgrepPath(options, event.data.path.text),
        line: Math.max(0, event.data.line_number - 1),
        character: Math.max(0, event.data.submatches?.[0]?.start ?? 0),
        text: event.data.lines.text.replace(/\r?\n$/, '')
      });
    } catch {
      // Malformed JSON lines are ignored so one bad event does not disable search.
    }
  }

  return matches;
}

/** Converts a ripgrep path, relative to the Unity root, into a VS Code URI. */
function uriFromRipgrepPath(options: UnityTextSearchOptions, pathText: string): vscode.Uri {
  const normalized = pathText.replace(/\\/g, '/').replace(/^\.\//, '');
  return options.runtimeVscode.Uri.file(resolve(options.root.fsPath, normalized));
}

/** Removes duplicate URIs while preserving ripgrep discovery order. */
function dedupeUris(uris: readonly vscode.Uri[]): readonly vscode.Uri[] {
  const seen = new Set<string>();
  const results: vscode.Uri[] = [];

  for (const uri of uris) {
    const key = uri.fsPath.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(uri);
  }

  return results;
}

/** Normalizes user-provided fixed strings before invoking search backends. */
function normalizeSearchTexts(texts: readonly string[]): readonly string[] {
  return [...new Set(texts.filter(text => text.length > 0))];
}

/** Registers cancellation without depending on concrete VS Code runtime classes. */
function registerCancellation(token: vscode.CancellationToken | undefined, callback: () => void): () => void {
  if (!token) {
    return () => undefined;
  }

  if (token.isCancellationRequested) {
    callback();
    return () => undefined;
  }

  const disposable = token.onCancellationRequested(callback);
  return () => disposable.dispose();
}

/** Throws the same lightweight cancellation error shape used by callers. */
function throwIfCancellationRequested(token: vscode.CancellationToken | undefined): void {
  if (token?.isCancellationRequested) {
    throw new Error('Unity text search canceled');
  }
}
