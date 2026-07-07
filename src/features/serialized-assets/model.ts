import type { UnityTextSearchBackend } from '../../unity/textSearch';

export type UnitySerializedAssetKind = 'prefab' | 'scene' | 'asset';

export type UnitySerializedAssetCandidateSearchBackend = UnityTextSearchBackend | 'injectedTextSearch' | 'none';
