import type * as vscode from 'vscode';
import type { UnityTextSearchBackend } from '../../unity/textSearch';
import type { UnitySerializedAssetKind } from '../serialized-assets/model';

export type { UnitySerializedAssetKind } from '../serialized-assets/model';

export type UnityEventCandidateSearchBackend = UnityTextSearchBackend | 'injectedTextSearch' | 'none';

export interface UnityEventReference {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  line: number;
  character: number;
  eventFieldName: string;
  eventScriptPath?: string;
  eventOwnerTypeName?: string;
  gameObjectName?: string;
  targetFileId?: string;
  targetTypeName: string;
  methodName: string;
  scriptPath?: string;
  scriptTypeName?: string;
}

export interface UnitySerializedAssetReferenceIndex {
  getReferences(scriptPath: string, methodName: string, typeName?: string): readonly UnityEventReference[];
  getReferenceCount(scriptPath: string, methodName: string, typeName?: string): number;
  getFieldReferences(scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[];
  getFieldReferenceCount(scriptPath: string, fieldName: string, typeName?: string): number;
  getFieldTargets(scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[];
  getFieldTargetCount(scriptPath: string, fieldName: string, typeName?: string): number;
  getAllReferences(): readonly UnityEventReference[];
  getDiagnostics(): UnityEventReferenceDiagnostics;
}

export interface UnityEventReferenceDiagnostics {
  discoveredAssetCount: number;
  candidateAssetCount: number;
  candidateSearchBackend: UnityEventCandidateSearchBackend;
  textCandidateSearchCount: number;
  assetReadCount: number;
  prefabCount: number;
  sceneCount: number;
  assetCount: number;
  skippedAssetCount: number;
  canceledAssetCount: number;
  parsedYamlAssetCount: number;
  parsedUnityEventAssetCount: number;
  skippedUnityEventAssetCount: number;
  persistentCallCount: number;
  resolvedReferenceCount: number;
  resolvedByTargetTypeNameCount: number;
  resolvedOwnerScriptGuidCount: number;
  resolvedOwnerEditorClassIdentifierCount: number;
  unresolvedOwnerScriptCount: number;
  skippedDisabledCallCount: number;
  skippedMissingTargetTypeNameCount: number;
  skippedUnresolvedTargetTypeNameCount: number;
  skippedMissingMethodNameCount: number;
  elapsedMilliseconds: number;
}

export type UnityEventReferenceBuildMode = 'background' | 'interactive';

export interface UnityEventReferenceBuildContext {
  mode: UnityEventReferenceBuildMode;
  cancellationToken?: vscode.CancellationToken;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  scanStatus?: UnityEventReferenceScanStatusReporter;
}

export interface UnityEventReferenceScanStatusReporter {
  /** Shows the background scan status item with the first visible phase. */
  start(phase: string, label?: string): void;
  /** Updates the status item with bounded scan progress. */
  update(status: UnityEventReferenceScanStatus): void;
  /** Hides the status item and records the final scan result. */
  finish(result: 'completed' | 'failed' | 'canceled', diagnostics?: UnityEventReferenceDiagnostics, status?: UnityEventReferenceScanStatus): void;
  /** Releases the status item when the extension feature is disposed. */
  dispose(): void;
}

export interface UnityEventReferenceScanStatus {
  phase: string;
  label?: string;
  scriptPath?: string;
  scriptGuid?: string;
  metadataGuidCount?: number;
  candidateCount?: number;
  scannedCount?: number;
  totalCount?: number;
  referenceCount?: number;
  elapsedMilliseconds?: number;
}
