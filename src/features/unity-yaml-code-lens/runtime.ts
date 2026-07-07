import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex } from '../../unity/metadataIndex';

export interface UnityYamlCodeLensFeatureOptions {
  metadataIndex?: LazyUnityMetadataIndex;
  runtimeVscode?: typeof vscode;
}

export interface UnityYamlCodeLensRuntime {
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  metadataIndex: LazyUnityMetadataIndex;
}
