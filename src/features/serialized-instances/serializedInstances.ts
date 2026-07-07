import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import {
  findDefaultAssetFiles,
  findDefaultAssetFilesContainingText,
  watchUnitySerializedAssetFiles
} from '../serialized-assets/assetDiscovery';
import { readDefaultTextFile } from '../serialized-assets/utils';
import { createSharedUnityYamlAssetHandler } from '../unity-yaml-assets/handler';
import { createSerializedInstanceProvider } from './provider';
import type { SerializedInstancesFeatureOptions, SerializedInstancesRuntime } from './runtime';

export type {
  SerializedInstancesFeatureOptions,
  SerializedInstancesRuntime,
  SerializedInstanceLocationTarget
} from './runtime';
export type {
  UnitySerializedInstanceDiagnostics,
  UnitySerializedInstanceLocation
} from './model';
export { parseSerializedInstancesWithDiagnostics } from './parser';

/** Registers serialized instance commands, CodeLens provider, and cache invalidation hooks. */
export function registerSerializedInstancesFeature(
  logger: UnityPlusLogger,
  options: SerializedInstancesFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isEnabled = options.isEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('eventReferences.enabled') === true
  );
  const disposables: vscode.Disposable[] = [];
  let serializedAssetCacheVersion = 0;

  if (options.metadataIndex) {
    const yamlAssets = createSharedUnityYamlAssetHandler({
      root: options.metadataIndex.root,
      runtimeVscode,
      logger,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      searchAssetFilesContainingText: options.findAssetFilesContainingText ?? findDefaultAssetFilesContainingText,
      readTextFile: options.readTextFile ?? readDefaultTextFile
    });
    const featureRuntime: SerializedInstancesRuntime = {
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      searchAssetFilesContainingText: options.findAssetFilesContainingText ?? findDefaultAssetFilesContainingText,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      yamlAssets,
      getCacheVersion: () => (options.getCacheVersion?.() ?? 0) + serializedAssetCacheVersion
    };
    const provider = createSerializedInstanceProvider(featureRuntime, isEnabled);

    disposables.push(
      watchUnitySerializedAssetFiles(runtimeVscode, options.metadataIndex.root, uri => {
        serializedAssetCacheVersion += 1;
        yamlAssets.invalidate(uri);
        logger.debug(`Unity serialized instance cache invalidated by serialized asset change: ${uri.fsPath}`);
        provider.notifyCodeLensesChanged();
      }),
      runtimeVscode.languages.registerCodeLensProvider({ language: 'csharp' }, provider),
      runtimeVscode.commands.registerCommand('unityPlus.showUnitySerializedInstanceLocations', async target => {
        await provider.showSerializedInstanceLocations(target);
      })
    );
  }

  return runtimeVscode.Disposable.from(...disposables);
}

/** Loads VS Code lazily so unit tests can inject a fake runtime. */
function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
