import type * as vscode from 'vscode';
import type { UnitySerializedAssetKind } from '../serialized-assets/model';
import type { UnitySerializedInstanceDiagnostics } from './model';

/** Creates a fresh diagnostics accumulator for one serialized instance scan. */
export function createEmptySerializedInstanceDiagnostics(): UnitySerializedInstanceDiagnostics {
  return {
    discoveredAssetCount: 0,
    candidateAssetCount: 0,
    candidateSearchBackend: 'none',
    textCandidateSearchCount: 0,
    assetReadCount: 0,
    prefabCount: 0,
    sceneCount: 0,
    assetCount: 0,
    skippedAssetCount: 0,
    canceledAssetCount: 0,
    parsedYamlAssetCount: 0,
    serializedInstanceCount: 0,
    resolvedSerializedInstanceScriptGuidCount: 0,
    resolvedSerializedInstanceEditorClassIdentifierCount: 0,
    unresolvedSerializedInstanceScriptCount: 0,
    serializedInstanceScriptTextHitCount: 0,
    serializedInstanceScriptResolvedTextHitCount: 0,
    serializedInstanceScriptUnresolvedTextHitCount: 0,
    serializedInstanceScriptDedupedTextHitCount: 0,
    elapsedMilliseconds: 0
  };
}

/** Adds one scanned asset to the diagnostics counters by serialized asset kind. */
export function incrementSerializedInstanceAssetCount(diagnostics: UnitySerializedInstanceDiagnostics, assetKind: UnitySerializedAssetKind): void {
  if (assetKind === 'prefab') {
    diagnostics.prefabCount += 1;
  } else if (assetKind === 'scene') {
    diagnostics.sceneCount += 1;
  } else {
    diagnostics.assetCount += 1;
  }
}

/** Merges parsed-asset diagnostics into a scan-level accumulator. */
export function mergeSerializedInstanceDiagnostics(
  target: UnitySerializedInstanceDiagnostics,
  source: UnitySerializedInstanceDiagnostics
): void {
  target.discoveredAssetCount += source.discoveredAssetCount;
  target.candidateAssetCount += source.candidateAssetCount;
  target.candidateSearchBackend = source.candidateSearchBackend !== 'none'
    ? source.candidateSearchBackend
    : target.candidateSearchBackend;
  target.textCandidateSearchCount += source.textCandidateSearchCount;
  target.assetReadCount += source.assetReadCount;
  target.prefabCount += source.prefabCount;
  target.sceneCount += source.sceneCount;
  target.assetCount += source.assetCount;
  target.skippedAssetCount += source.skippedAssetCount;
  target.canceledAssetCount += source.canceledAssetCount;
  target.parsedYamlAssetCount += source.parsedYamlAssetCount;
  target.serializedInstanceCount += source.serializedInstanceCount;
  target.resolvedSerializedInstanceScriptGuidCount += source.resolvedSerializedInstanceScriptGuidCount;
  target.resolvedSerializedInstanceEditorClassIdentifierCount += source.resolvedSerializedInstanceEditorClassIdentifierCount;
  target.unresolvedSerializedInstanceScriptCount += source.unresolvedSerializedInstanceScriptCount;
  target.serializedInstanceScriptTextHitCount += source.serializedInstanceScriptTextHitCount;
  target.serializedInstanceScriptResolvedTextHitCount += source.serializedInstanceScriptResolvedTextHitCount;
  target.serializedInstanceScriptUnresolvedTextHitCount += source.serializedInstanceScriptUnresolvedTextHitCount;
  target.serializedInstanceScriptDedupedTextHitCount += source.serializedInstanceScriptDedupedTextHitCount;
}

/** Formats a compact serialized-instance scan diagnostics summary. */
export function formatSerializedInstanceDiagnostics(runtimeVscode: typeof vscode, diagnostics: UnitySerializedInstanceDiagnostics): string {
  const skippedAssetCount = diagnostics.skippedAssetCount + diagnostics.canceledAssetCount;
  return [
    runtimeVscode.l10n.t('discovered {count} serialized asset(s)', { count: diagnostics.discoveredAssetCount }),
    runtimeVscode.l10n.t('asset candidates: {candidateCount} asset(s), {searchCount} text search(es), backend {backend}, read {readCount}', {
      candidateCount: diagnostics.candidateAssetCount,
      searchCount: diagnostics.textCandidateSearchCount,
      backend: diagnostics.candidateSearchBackend,
      readCount: diagnostics.assetReadCount
    }),
    runtimeVscode.l10n.t('found {count} serialized instance(s)', { count: diagnostics.serializedInstanceCount }),
    runtimeVscode.l10n.t('serialized instance scripts: {guidCount} GUID, {editorCount} editor class, {unresolvedCount} unresolved', {
      guidCount: diagnostics.resolvedSerializedInstanceScriptGuidCount,
      editorCount: diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount,
      unresolvedCount: diagnostics.unresolvedSerializedInstanceScriptCount
    }),
    runtimeVscode.l10n.t('serialized instance text hits: {hitCount} found, {resolvedCount} metadata-resolved, {unresolvedCount} unresolved, {dedupedCount} deduped', {
      hitCount: diagnostics.serializedInstanceScriptTextHitCount,
      resolvedCount: diagnostics.serializedInstanceScriptResolvedTextHitCount,
      unresolvedCount: diagnostics.serializedInstanceScriptUnresolvedTextHitCount,
      dedupedCount: diagnostics.serializedInstanceScriptDedupedTextHitCount
    }),
    runtimeVscode.l10n.t('skipped {assetCount} asset(s)', { assetCount: skippedAssetCount }),
    runtimeVscode.l10n.t('finished in {elapsedMilliseconds}ms', { elapsedMilliseconds: diagnostics.elapsedMilliseconds })
  ].join(', ');
}

/** Estimates how many candidate assets were not completed after cancellation. */
export function countUnfinishedSerializedInstanceAssets(totalCount: number, diagnostics: UnitySerializedInstanceDiagnostics): number {
  const finishedCount = diagnostics.prefabCount + diagnostics.sceneCount + diagnostics.assetCount + diagnostics.skippedAssetCount;
  return Math.max(0, totalCount - finishedCount);
}
