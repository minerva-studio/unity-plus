import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityAssetTextSearchResult, UnityYamlAssetHandler } from '../unity-yaml-assets/handler';
import type {
  UnitySerializedInstanceBuildContext,
  UnitySerializedInstanceIndex,
  UnitySerializedInstanceScanStatusReporter
} from './model';

export interface SerializedInstancesFeatureOptions {
  metadataIndex?: LazyUnityMetadataIndex;
  runtimeVscode?: typeof vscode;
  isEnabled?: () => boolean;
  findAssetFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  findAssetFilesContainingText?: (root: vscode.Uri, runtimeVscode: typeof vscode, text: readonly string[], cancellationToken?: vscode.CancellationToken) => Promise<UnityAssetTextSearchResult>;
  readTextFile?: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion?: () => number;
}

export interface SerializedInstancesRuntime {
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  metadataIndex: LazyUnityMetadataIndex;
  findAssetFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  searchAssetFilesContainingText?: UnityAssetTextSearch;
  readTextFile: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  yamlAssets?: UnityYamlAssetHandler;
  getCacheVersion: () => number;
  scanStatus?: UnitySerializedInstanceScanStatusReporter;
}

export type UnityAssetTextSearch = (
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  texts: readonly string[],
  cancellationToken?: vscode.CancellationToken
) => Promise<UnityAssetTextSearchResult>;

export interface SerializedInstanceLocationTarget {
  kind: 'serializedInstance';
  scriptPath: string;
  scriptGuid?: string;
  typeName?: string;
  serializedInstances?: readonly import('./model').UnitySerializedInstanceLocation[];
  position: vscode.Position;
}

export type SerializedInstanceIndexStatus = 'idle' | 'building' | 'ready' | 'failed';

export interface SerializedInstanceIndexController {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  getStatus(): SerializedInstanceIndexStatus;
  getReadyIndex(): UnitySerializedInstanceIndex | undefined;
  scheduleBuild(): void;
  forceBuild(context?: UnitySerializedInstanceBuildContext, metadata?: UnityMetadataIndex): Promise<UnitySerializedInstanceIndex | undefined>;
  notifyCodeLensesChanged(): void;
}

export interface RunWithConcurrencyOptions {
  cancellationToken?: vscode.CancellationToken;
  yieldEvery?: number;
  onProgress?: (completedCount: number, totalCount: number) => void;
}

export const defaultAssetScanConcurrency = 4;
export const scanYieldEvery = 4;
export const backgroundScanYieldEvery = 1;
export const backgroundBuildDebounceMilliseconds = 150;
export const progressReportInterval = 10;
