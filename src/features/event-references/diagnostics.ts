import type * as vscode from 'vscode';
import type { UnityEventReferenceDiagnostics, UnitySerializedAssetKind } from './model';

/** Creates a fresh diagnostics accumulator for one UnityEvent reference scan. */
export function createEmptyDiagnostics(): UnityEventReferenceDiagnostics {
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
    parsedUnityEventAssetCount: 0,
    skippedUnityEventAssetCount: 0,
    persistentCallCount: 0,
    resolvedReferenceCount: 0,
    resolvedByTargetTypeNameCount: 0,
    resolvedOwnerScriptGuidCount: 0,
    resolvedOwnerEditorClassIdentifierCount: 0,
    unresolvedOwnerScriptCount: 0,
    skippedDisabledCallCount: 0,
    skippedMissingTargetTypeNameCount: 0,
    skippedUnresolvedTargetTypeNameCount: 0,
    skippedMissingMethodNameCount: 0,
    elapsedMilliseconds: 0
  };
}

/** Adds one scanned asset to the diagnostics counters by serialized asset kind. */
export function incrementAssetCount(diagnostics: UnityEventReferenceDiagnostics, assetKind: UnitySerializedAssetKind): void {
  if (assetKind === 'prefab') {
    diagnostics.prefabCount += 1;
  } else if (assetKind === 'scene') {
    diagnostics.sceneCount += 1;
  } else {
    diagnostics.assetCount += 1;
  }
}

/** Merges parsed-asset diagnostics into a scan-level accumulator. */
export function mergeDiagnostics(target: UnityEventReferenceDiagnostics, source: UnityEventReferenceDiagnostics): void {
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
  target.parsedUnityEventAssetCount += source.parsedUnityEventAssetCount;
  target.skippedUnityEventAssetCount += source.skippedUnityEventAssetCount;
  target.persistentCallCount += source.persistentCallCount;
  target.resolvedReferenceCount += source.resolvedReferenceCount;
  target.resolvedByTargetTypeNameCount += source.resolvedByTargetTypeNameCount;
  target.resolvedOwnerScriptGuidCount += source.resolvedOwnerScriptGuidCount;
  target.resolvedOwnerEditorClassIdentifierCount += source.resolvedOwnerEditorClassIdentifierCount;
  target.unresolvedOwnerScriptCount += source.unresolvedOwnerScriptCount;
  target.skippedDisabledCallCount += source.skippedDisabledCallCount;
  target.skippedMissingTargetTypeNameCount += source.skippedMissingTargetTypeNameCount;
  target.skippedUnresolvedTargetTypeNameCount += source.skippedUnresolvedTargetTypeNameCount;
  target.skippedMissingMethodNameCount += source.skippedMissingMethodNameCount;
}

/** Formats a compact scan diagnostics summary for notifications and logs. */
export function formatDiagnostics(runtimeVscode: typeof vscode, diagnostics: UnityEventReferenceDiagnostics): string {
  const skippedCallCount = diagnostics.skippedDisabledCallCount +
    diagnostics.skippedMissingTargetTypeNameCount +
    diagnostics.skippedUnresolvedTargetTypeNameCount +
    diagnostics.skippedMissingMethodNameCount;
  const skippedAssetCount = diagnostics.skippedAssetCount + diagnostics.canceledAssetCount;

  return [
    runtimeVscode.l10n.t('discovered {count} serialized asset(s)', {
      count: diagnostics.discoveredAssetCount
    }),
    runtimeVscode.l10n.t('asset candidates: {candidateCount} asset(s), {searchCount} text search(es), backend {backend}, read {readCount}', {
      candidateCount: diagnostics.candidateAssetCount,
      searchCount: diagnostics.textCandidateSearchCount,
      backend: diagnostics.candidateSearchBackend,
      readCount: diagnostics.assetReadCount
    }),
    runtimeVscode.l10n.t('scanned {prefabCount} prefab(s), {sceneCount} scene(s), and {assetCount} asset file(s)', {
      prefabCount: diagnostics.prefabCount,
      sceneCount: diagnostics.sceneCount,
      assetCount: diagnostics.assetCount
    }),
    runtimeVscode.l10n.t('found {count} persistent call(s)', {
      count: diagnostics.persistentCallCount
    }),
    runtimeVscode.l10n.t('YAML parser paths: {assetCount} asset parse(s), {unityEventCount} UnityEvent parse(s), {skippedUnityEventCount} UnityEvent parse(s) skipped', {
      assetCount: diagnostics.parsedYamlAssetCount,
      unityEventCount: diagnostics.parsedUnityEventAssetCount,
      skippedUnityEventCount: diagnostics.skippedUnityEventAssetCount
    }),
    runtimeVscode.l10n.t('found {count} UnityEvent reference(s)', {
      count: diagnostics.resolvedReferenceCount
    }),
    runtimeVscode.l10n.t('resolved {count} UnityEvent target script path(s) by type name', {
      count: diagnostics.resolvedByTargetTypeNameCount
    }),
    runtimeVscode.l10n.t('owner scripts: {guidCount} GUID, {editorCount} editor class, {unresolvedCount} unresolved', {
      guidCount: diagnostics.resolvedOwnerScriptGuidCount,
      editorCount: diagnostics.resolvedOwnerEditorClassIdentifierCount,
      unresolvedCount: diagnostics.unresolvedOwnerScriptCount
    }),
    runtimeVscode.l10n.t('skipped {callCount} call(s) and {assetCount} asset(s)', {
      callCount: skippedCallCount,
      assetCount: skippedAssetCount
    }),
    runtimeVscode.l10n.t('finished in {elapsedMilliseconds}ms', {
      elapsedMilliseconds: diagnostics.elapsedMilliseconds
    })
  ].join(', ');
}

/** Estimates how many candidate assets were not completed after cancellation. */
export function countUnfinishedAssets(totalCount: number, diagnostics: UnityEventReferenceDiagnostics): number {
  const finishedCount = diagnostics.prefabCount + diagnostics.sceneCount + diagnostics.assetCount + diagnostics.skippedAssetCount;
  return Math.max(0, totalCount - finishedCount);
}
