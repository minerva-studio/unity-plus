import type * as vscode from 'vscode';
import type { UnityMetadataIndex } from '../../unity/metadataIndex';
import { eventReferenceCandidateTexts, getAssetKind } from './assetDiscovery';
import { countUnfinishedAssets, createEmptyDiagnostics, incrementAssetCount, mergeDiagnostics } from './diagnostics';
import type { UnityEventCandidateSearchBackend, UnityEventReference, UnityEventReferenceBuildContext, UnitySerializedAssetReferenceIndex, UnitySerializedInstanceLocation } from './model';
import { createReferenceIndex } from './referenceIndex';
import { parseUnityEventReferencesWithDiagnostics } from './parser';
import { buildDefaultCSharpTypeIndex } from './typeIndex';
import type { CSharpTypeIndex, EventReferenceRuntime } from './runtime';
import { backgroundScanYieldEvery, defaultAssetScanConcurrency, progressReportInterval, scanYieldEvery } from './runtime';
import { getBackgroundScanConcurrency, shouldIncludeScenesOutsideBuildSettings } from './settings';
import { errorMessage, isCancellationError, isCancellationRequested, runWithConcurrency, throwIfCancellationRequested, toNormalizedPath, toProjectPath, toWorkspaceUri, UnityEventReferenceScanCanceledError } from './utils';

const editorBuildSettingsPath = 'ProjectSettings/EditorBuildSettings.asset';
const buildSettingsScenePathPattern = /^\s*path:\s*(Assets\/.*\.unity)\s*$/gm;

/** Builds the project-wide reference index by discovering, filtering, and parsing serialized Unity assets. */
export async function buildUnityEventReferenceIndex(
  runtime: EventReferenceRuntime,
  metadata?: UnityMetadataIndex,
  context: UnityEventReferenceBuildContext = { mode: 'background' }
): Promise<UnitySerializedAssetReferenceIndex> {
  const startedAt = Date.now();
  const references: UnityEventReference[] = [];
  const serializedInstances: UnitySerializedInstanceLocation[] = [];
  const diagnostics = createEmptyDiagnostics();

  throwIfCancellationRequested(context.cancellationToken);
  context.progress?.report({ message: runtime.runtimeVscode.l10n.t('Finding Unity serialized assets') });
  context.scanStatus?.update({ label: 'Unity refs: metadata', phase: 'Preparing Unity metadata' });

  const metadataIndex = metadata ?? await runtime.metadataIndex.getOrBuild();
  context.scanStatus?.update({
    label: 'Unity refs: metadata',
    phase: 'Unity metadata ready',
    metadataGuidCount: metadataIndex.getStatistics?.().parsedGuidCount
  });
  context.scanStatus?.update({ label: 'Unity refs: project', phase: 'Finding Unity serialized asset candidates' });
  const discovery = await findUnityEventCandidateAssetFiles(runtime, context);
  const assetFiles = await filterAssetFilesForConfiguredSceneScope(runtime, discovery.files);
  const resolveCSharpType = await createBuildScopedTypeResolver(runtime, context);
  let lastReportedCount = 0;

  diagnostics.discoveredAssetCount = discovery.files.length;
  diagnostics.candidateAssetCount = discovery.files.length;
  diagnostics.candidateSearchBackend = discovery.backend;
  diagnostics.textCandidateSearchCount = discovery.textSearchCount;
  diagnostics.skippedAssetCount += discovery.files.length - assetFiles.length;
  context.scanStatus?.update({
    label: 'Unity refs: project',
    phase: 'Scanning Unity serialized assets',
    candidateCount: assetFiles.length,
    scannedCount: 0,
    totalCount: assetFiles.length,
    referenceCount: 0,
    instanceCount: 0,
    elapsedMilliseconds: Date.now() - startedAt
  });

  await runWithConcurrency(assetFiles, async assetUri => {
    throwIfCancellationRequested(context.cancellationToken);

    try {
      const assetPath = toProjectPath(runtime.metadataIndex.root, assetUri);
      const assetKind = getAssetKind(assetUri);

      if (!assetKind) {
        diagnostics.skippedAssetCount += 1;
        return;
      }

      const content = await runtime.readTextFile(assetUri, runtime.runtimeVscode);
      diagnostics.assetReadCount += 1;
      throwIfCancellationRequested(context.cancellationToken);

      if (!isUnityEventReferenceCandidateContent(content)) {
        diagnostics.skippedAssetCount += 1;
        return;
      }

      incrementAssetCount(diagnostics, assetKind);
      const parsed = await parseUnityEventReferencesWithDiagnostics(content, assetPath, assetKind, metadataIndex, resolveCSharpType);
      throwIfCancellationRequested(context.cancellationToken);

      mergeDiagnostics(diagnostics, parsed.diagnostics);
      references.push(...parsed.references);
      serializedInstances.push(...parsed.serializedInstances);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }

      // Asset read and YAML parse failures make the scan incomplete, so the UI
      // must report a failed scan instead of silently showing fewer references.
      throw new Error(`Could not scan UnityEvent references in ${assetUri.fsPath}: ${errorMessage(error)}`);
    }
  }, context.mode === 'background' ? getBackgroundScanConcurrency(runtime.runtimeVscode) : defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: context.mode === 'background' ? backgroundScanYieldEvery : scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      context.scanStatus?.update({
        label: 'Unity refs: project',
        phase: 'Scanning Unity serialized assets',
        candidateCount: assetFiles.length,
        scannedCount: completedCount,
        totalCount,
        referenceCount: references.length,
        instanceCount: serializedInstances.length,
        elapsedMilliseconds: Date.now() - startedAt
      });

      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({
          message: runtime.runtimeVscode.l10n.t('Scanning Unity serialized assets {completedCount}/{totalCount}', {
            completedCount,
            totalCount
          })
        });
      }
    }
  });

  if (isCancellationRequested(context.cancellationToken)) {
    diagnostics.canceledAssetCount = countUnfinishedAssets(assetFiles.length, diagnostics);
    diagnostics.elapsedMilliseconds = Date.now() - startedAt;
    throw new UnityEventReferenceScanCanceledError();
  }

  diagnostics.resolvedReferenceCount = references.length;
  diagnostics.serializedInstanceCount = serializedInstances.length;
  diagnostics.elapsedMilliseconds = Date.now() - startedAt;
  return createReferenceIndex(references, serializedInstances, diagnostics);
}

/** Creates a resolver that reuses one C# type index for the duration of a scan. */
async function createBuildScopedTypeResolver(
  runtime: EventReferenceRuntime,
  context: UnityEventReferenceBuildContext
): Promise<(fullTypeName: string) => Promise<string | undefined>> {
  if (runtime.resolveCSharpType) {
    return async fullTypeName => {
      throwIfCancellationRequested(context.cancellationToken);
      return await runtime.resolveCSharpType?.(fullTypeName, runtime, context);
    };
  }

  if (context.mode === 'background') {
    let loggedSkip = false;
    return async fullTypeName => {
      throwIfCancellationRequested(context.cancellationToken);

      if (!loggedSkip) {
        // Background scans must stay YAML/metadata-only so CodeLens startup does
        // not compete with the C# language server while it is still warming up.
        runtime.logger.debug(`UnityEvent background scan skipped C# type index for ${fullTypeName}.`);
        loggedSkip = true;
      }

      return undefined;
    };
  }

  let typeIndexPromise: Promise<CSharpTypeIndex> | undefined;
  return async fullTypeName => {
    throwIfCancellationRequested(context.cancellationToken);

    if (!typeIndexPromise) {
      context.progress?.report({ message: runtime.runtimeVscode.l10n.t('Indexing C# type declarations') });
      typeIndexPromise = (runtime.buildCSharpTypeIndex ?? buildDefaultCSharpTypeIndex)(runtime, context);
    }

    const typeIndex = await typeIndexPromise;
    throwIfCancellationRequested(context.cancellationToken);
    return typeIndex.resolve(fullTypeName);
  };
}


/** Applies the Build Settings scene-scope option while keeping non-scene assets. */
async function filterAssetFilesForConfiguredSceneScope(
  runtime: EventReferenceRuntime,
  files: readonly vscode.Uri[]
): Promise<readonly vscode.Uri[]> {
  if (shouldIncludeScenesOutsideBuildSettings(runtime.runtimeVscode)) {
    return files;
  }

  const buildSettingsScenePaths = await findBuildSettingsSceneFiles(runtime);
  const filtered = files.filter(uri => {
    const assetKind = getAssetKind(uri);
    if (assetKind !== 'scene') {
      return true;
    }

    return buildSettingsScenePaths.has(toNormalizedPath(toProjectPath(runtime.metadataIndex.root, uri)));
  });

  const skippedCount = files.length - filtered.length;
  if (skippedCount > 0) {
    runtime.logger.info(`Skipped ${skippedCount} Unity scene file(s) outside Build Settings.`);
  }

  return filtered;
}

/** Reads Unity Build Settings and returns normalized scene paths. */
async function findBuildSettingsSceneFiles(runtime: EventReferenceRuntime): Promise<ReadonlySet<string>> {
  const buildSettingsUri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, editorBuildSettingsPath);

  try {
    const content = await runtime.readTextFile(buildSettingsUri, runtime.runtimeVscode);
    const scenePaths = parseBuildSettingsScenePaths(content);

    if (scenePaths.size === 0) {
      runtime.logger.warn('Unity Build Settings did not list any scene paths; UnityEvent scene scanning will include prefabs only.');
    }

    return scenePaths;
  } catch (error) {
    runtime.logger.warn(`Could not read Unity Build Settings for UnityEvent scene filtering: ${errorMessage(error)}`);
    return new Set<string>();
  }
}

/** Checks whether an asset can affect serialized instances or UnityEvent references before AST parsing. */
function isUnityEventReferenceCandidateContent(content: string): boolean {
  return content.includes('m_Script') ||
    content.includes('m_PersistentCalls') ||
    content.includes('.m_PersistentCalls.');
}

/** Parses scene paths from the EditorBuildSettings YAML text. */
function parseBuildSettingsScenePaths(content: string): ReadonlySet<string> {
  const scenePaths = new Set<string>();
  let match: RegExpExecArray | null;

  buildSettingsScenePathPattern.lastIndex = 0;
  while ((match = buildSettingsScenePathPattern.exec(content))) {
    scenePaths.add(toNormalizedPath(match[1].trim()));
  }

  return scenePaths;
}

/** Enumerates serialized asset candidates with stable VS Code file APIs. */
async function findUnityEventCandidateAssetFiles(
  runtime: EventReferenceRuntime,
  context: UnityEventReferenceBuildContext
): Promise<{ files: readonly vscode.Uri[]; backend: UnityEventCandidateSearchBackend; textSearchCount: number }> {
  throwIfCancellationRequested(context.cancellationToken);
  if (runtime.searchAssetFilesContainingText) {
    const result = await runtime.searchAssetFilesContainingText(
      runtime.metadataIndex.root,
      runtime.runtimeVscode,
      eventReferenceCandidateTexts,
      context.cancellationToken
    );

    return {
      files: result.files,
      backend: result.backend,
      textSearchCount: result.searchCount
    };
  }

  if (runtime.findAssetFilesContainingText) {
    const candidates = new Map<string, vscode.Uri>();
    for (const text of eventReferenceCandidateTexts) {
      throwIfCancellationRequested(context.cancellationToken);
      for (const uri of await runtime.findAssetFilesContainingText(runtime.metadataIndex.root, runtime.runtimeVscode, text)) {
        candidates.set(uri.fsPath.replace(/\\/g, '/').toLowerCase(), uri);
      }
    }

    return {
      files: [...candidates.values()],
      backend: 'injectedTextSearch',
      textSearchCount: eventReferenceCandidateTexts.length
    };
  }

  return {
    files: await runtime.findAssetFiles(runtime.metadataIndex.root, runtime.runtimeVscode),
    backend: 'none',
    textSearchCount: 0
  };
}

/** Finds candidate assets for a current-script priority scan. */
export async function findCurrentScriptCandidateAssetFiles(
  runtime: EventReferenceRuntime,
  scriptGuid: string,
  token: vscode.CancellationToken
): Promise<{ files: readonly vscode.Uri[]; backend: UnityEventCandidateSearchBackend; textSearchCount: number }> {
  throwIfCancellationRequested(token);

  if (runtime.searchAssetFilesContainingText) {
    const result = await runtime.searchAssetFilesContainingText(
      runtime.metadataIndex.root,
      runtime.runtimeVscode,
      [scriptGuid],
      token
    );
    return {
      files: result.files,
      backend: result.backend,
      textSearchCount: result.searchCount
    };
  }

  if (runtime.findAssetFilesContainingText) {
    return {
      files: await runtime.findAssetFilesContainingText(runtime.metadataIndex.root, runtime.runtimeVscode, scriptGuid),
      backend: 'injectedTextSearch',
      textSearchCount: 1
    };
  }

  return {
    files: await runtime.findAssetFiles(runtime.metadataIndex.root, runtime.runtimeVscode),
    backend: 'findFilesFallback',
    textSearchCount: 0
  };
}
