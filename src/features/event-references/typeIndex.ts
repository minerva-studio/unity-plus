import type { UnityEventReferenceBuildContext } from './model';
import type { CSharpTypeIndex, EventReferenceRuntime } from './runtime';
import { backgroundScanYieldEvery, defaultAssetScanConcurrency, progressReportInterval, scanYieldEvery } from './runtime';
import { getBackgroundScanConcurrency } from './settings';
import { errorMessage, isCancellationRequested, runWithConcurrency, shortTypeName, throwIfCancellationRequested, toProjectPath, UnityEventReferenceScanCanceledError } from './utils';

/** Builds a C# type-name index from C# server symbols only. */
export async function buildDefaultCSharpTypeIndex(
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'logger' | 'metadataIndex' | 'findCSharpFiles' | 'csharpLanguageService'>,
  context: UnityEventReferenceBuildContext = { mode: 'background' }
): Promise<CSharpTypeIndex> {
  throwIfCancellationRequested(context.cancellationToken);

  const files = await runtime.findCSharpFiles(runtime.metadataIndex.root, runtime.runtimeVscode);
  const matches: Array<{ fullName: string; shortName: string; path: string }> = [];
  let lastReportedCount = 0;
  let serverTypeCount = 0;
  let symbolReadFailureCount = 0;

  await runWithConcurrency(files, async file => {
    throwIfCancellationRequested(context.cancellationToken);

    try {
      const path = toProjectPath(runtime.metadataIndex.root, file);
      const types = await runtime.csharpLanguageService?.findTypes(file) ?? [];
      throwIfCancellationRequested(context.cancellationToken);

      if (types.length > 0) {
        serverTypeCount += types.length;
        matches.push(...types.map(type => ({ fullName: type.fullName, shortName: type.name, path })));
      }
    } catch (error) {
      if (isCancellationRequested(context.cancellationToken)) {
        throw new UnityEventReferenceScanCanceledError();
      }

      symbolReadFailureCount += 1;
      // C# type resolution remains backed only by the configured C# server.
      // A warming or partial server means this file contributes no type data
      // for this scan, but YAML GUID-based references and instances can still
      // build a useful index.
      runtime.logger.debug(`UnityEvent C# type index skipped ${file.fsPath}: ${errorMessage(error)}`);
    }
  }, context.mode === 'background' ? getBackgroundScanConcurrency(runtime.runtimeVscode) : defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: context.mode === 'background' ? backgroundScanYieldEvery : scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({
          message: runtime.runtimeVscode.l10n.t('Indexing C# type declarations {completedCount}/{totalCount}', {
            completedCount,
            totalCount
          })
        });
      }
    }
  });

  logCSharpTypeIndexSummary(runtime, files.length, serverTypeCount, countResolvableTypeMatches(matches), symbolReadFailureCount);
  return createCSharpTypeIndex(matches);
}

/** Logs enough C# index detail to diagnose C# server symbol coverage. */
function logCSharpTypeIndexSummary(
  runtime: Pick<EventReferenceRuntime, 'logger'>,
  fileCount: number,
  serverTypeCount: number,
  resolvableTypeCount: number,
  symbolReadFailureCount: number
): void {
  runtime.logger.debug(`UnityEvent C# type index: ${fileCount} C# file(s), ${serverTypeCount} C# server type(s), ${resolvableTypeCount} resolvable type key(s), ${symbolReadFailureCount} symbol read failure(s).`);

  if (fileCount === 0) {
    runtime.logger.warn('UnityEvent C# type index found 0 C# files; target type resolution will be empty.');
  } else if (resolvableTypeCount === 0) {
    runtime.logger.warn('UnityEvent C# type index found 0 resolvable types; check C# server document symbols.');
  } else if (symbolReadFailureCount > 0) {
    runtime.logger.info(`UnityEvent C# type index used partial C# server symbols: ${symbolReadFailureCount}/${fileCount} file(s) had no symbols yet.`);
  }
}

/** Creates lookup maps that only resolve unique full or short type names. */
function createCSharpTypeIndex(matches: readonly { fullName: string; shortName: string; path: string }[]): CSharpTypeIndex {
  const fullNameToPath = new Map<string, string | undefined>();
  const shortNameToPath = new Map<string, string | undefined>();

  for (const match of matches) {
    setUniquePath(fullNameToPath, match.fullName, match.path);
    setUniquePath(shortNameToPath, match.shortName, match.path);
  }

  return {
    resolve(fullTypeName) {
      return fullNameToPath.get(typeLookupKey(fullTypeName)) ?? shortNameToPath.get(typeLookupKey(shortTypeName(fullTypeName)));
    }
  };
}

/** Counts unique type lookup keys that still resolve to one unambiguous script path. */
function countResolvableTypeMatches(matches: readonly { fullName: string; shortName: string; path: string }[]): number {
  const keysToPath = new Map<string, string | undefined>();

  for (const match of matches) {
    setUniquePath(keysToPath, match.fullName, match.path);
    setUniquePath(keysToPath, match.shortName, match.path);
  }

  return [...keysToPath.values()].filter(path => path !== undefined).length;
}

/** Stores a path only while a type-name key remains unambiguous. */
function setUniquePath(map: Map<string, string | undefined>, key: string, path: string): void {
  const normalizedKey = typeLookupKey(key);

  if (!map.has(normalizedKey)) {
    map.set(normalizedKey, path);
    return;
  }

  if (map.get(normalizedKey) !== path) {
    map.set(normalizedKey, undefined);
  }
}

/** Normalizes serialized and source type names for resilient lookups. */
function typeLookupKey(typeName: string): string {
  return typeName.split(',')[0]?.trim().toLowerCase() ?? typeName.toLowerCase();
}
