import type * as vscode from 'vscode';
import type { UnityMetadataIndex } from '../../unity/metadataIndex';
import { getAssetKind } from '../serialized-assets/assetDiscovery';
import { errorMessage, isCancellationError, isCancellationRequested, runWithConcurrency, throwIfCancellationRequested, toProjectPath, UnitySerializedAssetScanCanceledError } from '../serialized-assets/utils';
import {
  countUnfinishedSerializedInstanceAssets,
  createEmptySerializedInstanceDiagnostics,
  incrementSerializedInstanceAssetCount,
  mergeSerializedInstanceDiagnostics
} from './diagnostics';
import type { UnitySerializedAssetCandidateSearchBackend } from '../serialized-assets/model';
import type { SerializedInstancesRuntime } from './runtime';
import { backgroundScanYieldEvery, defaultAssetScanConcurrency, progressReportInterval, scanYieldEvery } from './runtime';
import type { UnitySerializedInstanceBuildContext, UnitySerializedInstanceIndex, UnitySerializedInstanceLocation } from './model';
import { parseSerializedInstancesWithDiagnostics } from './parser';
import { createSerializedInstanceIndex } from './referenceIndex';

export const serializedInstanceCandidateTexts = ['m_Script'];

/** Builds the project-wide serialized instance index from Unity YAML assets. */
export async function buildSerializedInstanceIndex(
  runtime: SerializedInstancesRuntime,
  metadata?: UnityMetadataIndex,
  context: UnitySerializedInstanceBuildContext = { mode: 'background' }
): Promise<UnitySerializedInstanceIndex> {
  const startedAt = Date.now();
  const serializedInstances: UnitySerializedInstanceLocation[] = [];
  const diagnostics = createEmptySerializedInstanceDiagnostics();

  throwIfCancellationRequested(context.cancellationToken);
  context.progress?.report({ message: runtime.runtimeVscode.l10n.t('Finding Unity serialized instances') });
  context.scanStatus?.update({ label: 'Unity inst: metadata', phase: 'Preparing Unity metadata' });

  const metadataIndex = metadata ?? await runtime.metadataIndex.getOrBuild();
  context.scanStatus?.update({
    label: 'Unity inst: metadata',
    phase: 'Unity metadata ready',
    metadataGuidCount: metadataIndex.getStatistics?.().parsedGuidCount
  });

  const discovery = await findSerializedInstanceCandidateAssetFiles(runtime, context);
  const assetFiles = discovery.files;
  let lastReportedCount = 0;

  diagnostics.discoveredAssetCount = discovery.files.length;
  diagnostics.candidateAssetCount = discovery.files.length;
  diagnostics.candidateSearchBackend = discovery.backend;
  diagnostics.textCandidateSearchCount = discovery.textSearchCount;
  context.scanStatus?.update({
    label: 'Unity inst: project',
    phase: 'Scanning Unity serialized instances',
    candidateCount: assetFiles.length,
    scannedCount: 0,
    totalCount: assetFiles.length,
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

      if (!content.includes('m_Script')) {
        diagnostics.skippedAssetCount += 1;
        return;
      }

      incrementSerializedInstanceAssetCount(diagnostics, assetKind);
      const parsed = await parseSerializedInstancesWithDiagnostics(content, assetPath, assetKind, metadataIndex);
      throwIfCancellationRequested(context.cancellationToken);

      mergeSerializedInstanceDiagnostics(diagnostics, parsed.diagnostics);
      serializedInstances.push(...parsed.serializedInstances);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }

      throw new Error(`Could not scan Unity serialized instances in ${assetUri.fsPath}: ${errorMessage(error)}`);
    }
  }, context.mode === 'background' ? defaultAssetScanConcurrency : defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: context.mode === 'background' ? backgroundScanYieldEvery : scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      context.scanStatus?.update({
        label: 'Unity inst: project',
        phase: 'Scanning Unity serialized instances',
        candidateCount: assetFiles.length,
        scannedCount: completedCount,
        totalCount,
        instanceCount: serializedInstances.length,
        elapsedMilliseconds: Date.now() - startedAt
      });

      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({
          message: runtime.runtimeVscode.l10n.t('Scanning Unity serialized instances {completedCount}/{totalCount}', {
            completedCount,
            totalCount
          })
        });
      }
    }
  });

  if (isCancellationRequested(context.cancellationToken)) {
    diagnostics.canceledAssetCount = countUnfinishedSerializedInstanceAssets(assetFiles.length, diagnostics);
    diagnostics.elapsedMilliseconds = Date.now() - startedAt;
    throw new UnitySerializedAssetScanCanceledError('Unity serialized instance scan canceled.');
  }

  diagnostics.serializedInstanceCount = serializedInstances.length;
  diagnostics.elapsedMilliseconds = Date.now() - startedAt;
  return createSerializedInstanceIndex(serializedInstances, diagnostics);
}

/** Enumerates candidate assets that can contain serialized script instances. */
async function findSerializedInstanceCandidateAssetFiles(
  runtime: SerializedInstancesRuntime,
  context: UnitySerializedInstanceBuildContext
): Promise<{ files: readonly vscode.Uri[]; backend: UnitySerializedAssetCandidateSearchBackend; textSearchCount: number }> {
  throwIfCancellationRequested(context.cancellationToken);
  if (runtime.searchAssetFilesContainingText) {
    const result = await runtime.searchAssetFilesContainingText(
      runtime.metadataIndex.root,
      runtime.runtimeVscode,
      serializedInstanceCandidateTexts,
      context.cancellationToken
    );

    return {
      files: result.files,
      backend: result.backend,
      textSearchCount: result.searchCount
    };
  }

  return {
    files: await runtime.findAssetFiles(runtime.metadataIndex.root, runtime.runtimeVscode),
    backend: 'none',
    textSearchCount: 0
  };
}
