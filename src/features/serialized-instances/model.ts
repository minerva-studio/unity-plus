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
