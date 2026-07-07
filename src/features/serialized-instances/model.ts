import type * as vscode from 'vscode';
import type { UnitySerializedAssetCandidateSearchBackend, UnitySerializedAssetKind } from '../serialized-assets/model';

export interface UnitySerializedInstanceLocation {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  line: number;
  character: number;
  fileId: string;
  scriptPath?: string;
  scriptTypeName?: string;
  name?: string;
  gameObjectName?: string;
}

export interface UnitySerializedInstanceIndex {
  getSerializedInstances(scriptPath: string, typeName?: string): readonly UnitySerializedInstanceLocation[];
  getSerializedInstanceCount(scriptPath: string, typeName?: string): number;
  getDiagnostics(): UnitySerializedInstanceDiagnostics;
}

export interface UnitySerializedInstanceDiagnostics {
  discoveredAssetCount: number;
  candidateAssetCount: number;
  candidateSearchBackend: UnitySerializedAssetCandidateSearchBackend;
  textCandidateSearchCount: number;
  assetReadCount: number;
  prefabCount: number;
  sceneCount: number;
  assetCount: number;
  skippedAssetCount: number;
  canceledAssetCount: number;
  parsedYamlAssetCount: number;
  serializedInstanceCount: number;
  resolvedSerializedInstanceScriptGuidCount: number;
  resolvedSerializedInstanceEditorClassIdentifierCount: number;
  unresolvedSerializedInstanceScriptCount: number;
  serializedInstanceScriptTextHitCount: number;
  serializedInstanceScriptResolvedTextHitCount: number;
  serializedInstanceScriptUnresolvedTextHitCount: number;
  serializedInstanceScriptDedupedTextHitCount: number;
  elapsedMilliseconds: number;
}

export type UnitySerializedInstanceBuildMode = 'background' | 'interactive';

export interface UnitySerializedInstanceBuildContext {
  mode: UnitySerializedInstanceBuildMode;
  cancellationToken?: vscode.CancellationToken;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
  scanStatus?: UnitySerializedInstanceScanStatusReporter;
}

export interface UnitySerializedInstanceScanStatusReporter {
  /** Shows the status item with the first visible phase. */
  start(phase: string, label?: string): void;
  /** Updates the status item with bounded scan progress. */
  update(status: UnitySerializedInstanceScanStatus): void;
  /** Keeps the status item visible with the final scan result. */
  finish(result: 'completed' | 'failed' | 'canceled', diagnostics?: UnitySerializedInstanceDiagnostics, status?: UnitySerializedInstanceScanStatus): void;
  /** Releases the status item when the extension feature is disposed. */
  dispose(): void;
}

export interface UnitySerializedInstanceScanStatus {
  phase: string;
  label?: string;
  scriptPath?: string;
  scriptGuid?: string;
  metadataGuidCount?: number;
  candidateCount?: number;
  scannedCount?: number;
  totalCount?: number;
  instanceCount?: number;
  elapsedMilliseconds?: number;
}
