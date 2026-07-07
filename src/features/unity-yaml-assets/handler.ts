import type * as vscode from 'vscode';
import type { UnityYamlParsedAsset } from '../../unity/unityYaml';
import { parseUnityYamlAsset } from '../../unity/unityYaml';
import type { UnityYamlParseProfile } from '../../vendor/unity-yaml-bridge/types';
import type { UnityPlusLogger } from '../../unity/logger';
import {
  findDefaultAssetFilesContainingText,
  getAssetKind
} from './assetDiscovery';
import type { UnitySerializedAssetCandidateSearchBackend, UnitySerializedAssetKind } from './model';
import { readDefaultTextFile, toProjectPath } from './utils';

export interface UnityYamlAssetHandlerOptions {
  root: vscode.Uri;
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  findAssetFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  searchAssetFilesContainingText?: UnityAssetTextSearch;
  readTextFile?: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
}

export type UnityAssetTextSearch = (
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  texts: readonly string[],
  cancellationToken?: vscode.CancellationToken
) => Promise<UnityAssetTextSearchResult>;

export interface UnityAssetTextSearchResult {
  backend: UnitySerializedAssetCandidateSearchBackend;
  files: readonly vscode.Uri[];
  searchCount: number;
  elapsedMilliseconds: number;
}

export interface UnityGuidHitResult {
  guid: string;
  files: readonly vscode.Uri[];
  backend: UnitySerializedAssetCandidateSearchBackend;
  searchCount: number;
}

export interface UnityGuidCountResult extends UnityGuidHitResult {
  count: number;
  readCount: number;
}

export interface UnityParsedYamlAsset {
  uri: vscode.Uri;
  projectPath: string;
  assetKind: UnitySerializedAssetKind;
  content: string;
  parsed: UnityYamlParsedAsset;
}

export interface UnityYamlAssetHandler {
  findAssetsContainingText(texts: readonly string[], cancellationToken?: vscode.CancellationToken): Promise<UnityAssetTextSearchResult>;
  findAssetsContainingGuid(guid: string, cancellationToken?: vscode.CancellationToken): Promise<UnityGuidHitResult>;
  countGuidOccurrences(guid: string, cancellationToken?: vscode.CancellationToken): Promise<UnityGuidCountResult>;
  getParsedAsset(uri: vscode.Uri, profile?: UnityYamlParseProfile): Promise<UnityParsedYamlAsset | undefined>;
  invalidate(uri?: vscode.Uri): void;
}

interface TextCacheEntry {
  content: string;
}

interface ParsedCacheEntry {
  asset: UnityParsedYamlAsset;
}

interface GuidHitCacheEntry {
  result: UnityGuidHitResult;
}

interface GuidCountCacheEntry {
  result: UnityGuidCountResult;
}

const sharedHandlers = new Map<string, UnityYamlAssetHandler>();
const sharedFunctionIds = new WeakMap<object, number>();
let nextSharedFunctionId = 1;

/** Returns one shared Unity YAML handler per workspace root for feature-level cache reuse. */
export function createSharedUnityYamlAssetHandler(options: UnityYamlAssetHandlerOptions): UnityYamlAssetHandler {
  const key = [
    assetCacheKey(options.root),
    sharedIdentity(options.findAssetFiles),
    sharedIdentity(options.searchAssetFilesContainingText),
    sharedIdentity(options.readTextFile)
  ].join('#');
  const cached = sharedHandlers.get(key);
  if (cached) {
    return cached;
  }

  const handler = createUnityYamlAssetHandler(options);
  sharedHandlers.set(key, handler);
  return handler;
}

/** Creates a stable cache-key fragment for injected functions used by tests and features. */
function sharedIdentity(value: object | undefined): string {
  if (!value) {
    return 'default';
  }

  const existing = sharedFunctionIds.get(value);
  if (existing) {
    return String(existing);
  }

  const id = nextSharedFunctionId;
  nextSharedFunctionId += 1;
  sharedFunctionIds.set(value, id);
  return String(id);
}

/** Creates the shared Unity YAML asset access layer used by feature-specific indexes. */
export function createUnityYamlAssetHandler(options: UnityYamlAssetHandlerOptions): UnityYamlAssetHandler {
  const findAssetFiles = options.findAssetFiles;
  const searchAssetFilesContainingText = options.searchAssetFilesContainingText ?? (findAssetFiles ? undefined : findDefaultAssetFilesContainingText);
  const readTextFile = options.readTextFile ?? readDefaultTextFile;
  const textCache = new Map<string, TextCacheEntry>();
  const parsedCache = new Map<string, ParsedCacheEntry>();
  const guidHitCache = new Map<string, GuidHitCacheEntry>();
  const guidCountCache = new Map<string, GuidCountCacheEntry>();

  async function readAssetText(uri: vscode.Uri): Promise<string> {
    const key = assetCacheKey(uri);
    const cached = textCache.get(key);
    if (cached) {
      return cached.content;
    }

    const content = await readTextFile(uri, options.runtimeVscode);
    textCache.set(key, { content });
    return content;
  }

  return {
    async findAssetsContainingText(texts, cancellationToken) {
      if (searchAssetFilesContainingText) {
        return await searchAssetFilesContainingText(options.root, options.runtimeVscode, texts, cancellationToken);
      }

      const startedAt = Date.now();
      const files = await findAssetsByReadingText(options.root, options.runtimeVscode, findAssetFiles, readAssetText, texts, cancellationToken);
      return {
        files,
        backend: 'none',
        searchCount: 0,
        elapsedMilliseconds: Date.now() - startedAt
      };
    },
    async findAssetsContainingGuid(guid, cancellationToken) {
      const normalizedGuid = normalizeGuid(guid);
      const cached = guidHitCache.get(normalizedGuid);
      if (cached) {
        return cached.result;
      }

      const result = await this.findAssetsContainingText([normalizedGuid], cancellationToken);
      const hitResult: UnityGuidHitResult = {
        guid: normalizedGuid,
        files: result.files,
        backend: result.backend,
        searchCount: result.searchCount
      };
      guidHitCache.set(normalizedGuid, { result: hitResult });
      return hitResult;
    },
    async countGuidOccurrences(guid, cancellationToken) {
      const normalizedGuid = normalizeGuid(guid);
      const cached = guidCountCache.get(normalizedGuid);
      if (cached) {
        return cached.result;
      }

      const hitResult = await this.findAssetsContainingGuid(normalizedGuid, cancellationToken);
      let count = 0;
      let readCount = 0;
      for (const uri of hitResult.files) {
        if (cancellationToken?.isCancellationRequested === true) {
          break;
        }

        const content = await readAssetText(uri);
        readCount += 1;
        count += countLiteralOccurrences(content, normalizedGuid);
      }

      const result: UnityGuidCountResult = {
        ...hitResult,
        count,
        readCount
      };
      guidCountCache.set(normalizedGuid, { result });
      return result;
    },
    async getParsedAsset(uri, profile = 'eventReferences') {
      const assetKind = getAssetKind(uri);
      if (!assetKind) {
        return undefined;
      }

      const key = `${assetCacheKey(uri)}#${profile}`;
      const cached = parsedCache.get(key);
      if (cached) {
        return cached.asset;
      }

      const content = await readAssetText(uri);
      const asset: UnityParsedYamlAsset = {
        uri,
        projectPath: toProjectPath(options.root, uri),
        assetKind,
        content,
        parsed: parseUnityYamlAsset(content, { profile })
      };
      parsedCache.set(key, { asset });
      return asset;
    },
    invalidate(uri) {
      if (!uri) {
        textCache.clear();
        parsedCache.clear();
        guidHitCache.clear();
        guidCountCache.clear();
        return;
      }

      const keyPrefix = assetCacheKey(uri);
      textCache.delete(keyPrefix);
      for (const key of [...parsedCache.keys()]) {
        if (key.startsWith(`${keyPrefix}#`)) {
          parsedCache.delete(key);
        }
      }
      guidHitCache.clear();
      guidCountCache.clear();
      options.logger.debug(`Unity YAML asset handler invalidated cached facts for ${uri.fsPath}.`);
    }
  };
}

/** Filters an injected asset enumeration by fixed text when no text-search backend is available. */
async function findAssetsByReadingText(
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  findAssetFiles: ((root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>) | undefined,
  readAssetText: (uri: vscode.Uri) => Promise<string>,
  texts: readonly string[],
  cancellationToken?: vscode.CancellationToken
): Promise<readonly vscode.Uri[]> {
  if (!findAssetFiles) {
    return [];
  }

  const results: vscode.Uri[] = [];
  for (const uri of await findAssetFiles(root, runtimeVscode)) {
    if (cancellationToken?.isCancellationRequested === true) {
      break;
    }

    const content = await readAssetText(uri);
    if (texts.some(text => content.includes(text))) {
      results.push(uri);
    }
  }

  return results;
}

/** Normalizes a Unity GUID for text matching and cache keys. */
function normalizeGuid(guid: string): string {
  return guid.trim().toLowerCase();
}

/** Creates a stable per-file cache key. */
function assetCacheKey(uri: vscode.Uri): string {
  return uri.fsPath.replace(/\\/g, '/').toLowerCase();
}

/** Counts exact text occurrences without regular expression overhead or escaping. */
function countLiteralOccurrences(content: string, value: string): number {
  if (!value) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (index < content.length) {
    const found = content.toLowerCase().indexOf(value, index);
    if (found === -1) {
      break;
    }

    count += 1;
    index = found + value.length;
  }

  return count;
}
