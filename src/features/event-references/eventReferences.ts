import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import { findDefaultAssetFiles, findDefaultAssetFilesContainingText, findDefaultCSharpFiles, watchUnitySerializedAssetFiles } from './assetDiscovery';
import { formatDiagnostics } from './diagnostics';
import { createEventReferenceIndexController } from './indexController';
import { parseUnityEventReferences } from './parser';
import { createEventReferenceProvider } from './provider';
import { buildUnityEventReferenceIndex } from './scanner';
import { createUnityEventReferenceScanStatus } from './scanStatus';
import { buildDefaultCSharpTypeIndex } from './typeIndex';
import { readDefaultTextFile } from './utils';
import type { EventReferenceFeatureOptions, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';

export type {
  UnityEventReference,
  UnityEventReferenceBuildContext,
  UnityEventReferenceBuildMode,
  UnityEventReferenceDiagnostics,
  UnitySerializedAssetKind,
  UnitySerializedAssetReferenceIndex,
  UnitySerializedInstanceLocation
} from './model';
export type { CSharpTypeIndex, CSharpTypeIndexBuilder, CSharpTypeResolver, EventReferenceFeatureOptions } from './runtime';
export { buildUnityEventReferenceIndex } from './scanner';
export { parseUnityEventReferences } from './parser';

/** Registers UnityEvent commands, CodeLens, hover providers, and cache invalidation hooks. */
export function registerEventReferenceFeature(
  logger: UnityPlusLogger,
  options: EventReferenceFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isEnabled = options.isEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('eventReferences.enabled') === true
  );
  const disposables: vscode.Disposable[] = [];
  let indexController: UnityEventReferenceIndexController | undefined;
  let serializedAssetCacheVersion = 0;

  if (options.metadataIndex) {
    const useDefaultAssetSearch = !options.findAssetFiles &&
      !options.findAssetFilesContainingText &&
      !options.searchAssetFilesContainingText;
    const scanStatus = createUnityEventReferenceScanStatus(runtimeVscode, logger, formatDiagnostics);
    const featureRuntime: EventReferenceRuntime = {
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      findAssetFilesContainingText: options.findAssetFilesContainingText,
      searchAssetFilesContainingText: options.searchAssetFilesContainingText ?? (useDefaultAssetSearch ? findDefaultAssetFilesContainingText : undefined),
      findCSharpFiles: options.findCSharpFiles ?? findDefaultCSharpFiles,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      getCacheVersion: () => (options.getCacheVersion?.() ?? 0) + serializedAssetCacheVersion,
      resolveCSharpType: options.resolveCSharpType,
      buildCSharpTypeIndex: options.buildCSharpTypeIndex ?? buildDefaultCSharpTypeIndex,
      scanStatus
    };
    indexController = createEventReferenceIndexController(featureRuntime);
    const provider = createEventReferenceProvider(featureRuntime, indexController, isEnabled);

    disposables.push(
      scanStatus,
      watchUnitySerializedAssetFiles(runtimeVscode, options.metadataIndex.root, uri => {
        serializedAssetCacheVersion += 1;
        logger.debug(`UnityEvent reference cache invalidated by serialized asset change: ${uri.fsPath}`);
        indexController?.notifyCodeLensesChanged();
      }),
      runtimeVscode.languages.registerCodeLensProvider({ language: 'csharp' }, provider),
      runtimeVscode.languages.registerHoverProvider({ language: 'csharp' }, provider),
      runtimeVscode.commands.registerCommand('unityPlus.showUnityEventReferenceLocations', async target => {
        await provider.showReferenceLocations(target);
      })
    );
  }

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.showUnityEventReferences', async () => {
    if (!isEnabled()) {
      logger.info('UnityEvent reference lookup is disabled.');
      runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent references are disabled.'));
      return;
    }

    if (!options.metadataIndex) {
      logger.warn('UnityEvent reference lookup requires a detected Unity workspace.');
      runtimeVscode.window.showWarningMessage(createMissingWorkspaceMessage(runtimeVscode));
      return;
    }

    const metadataIndex = options.metadataIndex;
    const scanResult = { canceled: false };
    const index = await runtimeVscode.window.withProgress({
      location: runtimeVscode.ProgressLocation.Notification,
      title: runtimeVscode.l10n.t('Unity Plus: scanning UnityEvent references'),
      cancellable: true
    }, async (progress, cancellationToken) => {
      progress.report({ message: runtimeVscode.l10n.t('Preparing Unity metadata') });
      await metadataIndex.getOrBuild();

      if (cancellationToken?.isCancellationRequested === true) {
        scanResult.canceled = true;
        return undefined;
      }

      const builtIndex = await indexController?.forceBuild({
        mode: 'interactive',
        cancellationToken,
        progress
      });
      scanResult.canceled = Boolean(cancellationToken?.isCancellationRequested);
      return builtIndex;
    });

    if (!index) {
      if (scanResult.canceled) {
        runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent reference scan canceled.'));
        return;
      }

      runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent reference index could not be built.'));
      return;
    }

    const diagnostics = index.getDiagnostics();
    const summary = formatDiagnostics(runtimeVscode, diagnostics);
    logger.info(`UnityEvent reference lookup ${summary}.`);
    runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: {summary}.', { summary }));
  }));

  return runtimeVscode.Disposable.from(...disposables);
}

/** Creates the warning shown when the command runs outside a detected Unity workspace. */
function createMissingWorkspaceMessage(runtimeVscode: typeof vscode): string {
  const roots = runtimeVscode.workspace.workspaceFolders
    ?.map(folder => folder.uri.fsPath)
    .join(', ') ?? '<none>';
  return runtimeVscode.l10n.t('Unity Plus: open a Unity project to scan UnityEvent references. Workspace roots: {roots}. Required markers: Assets, ProjectSettings, Packages/manifest.json.', {
    roots
  });
}

/** Loads VS Code lazily so unit tests can inject a fake runtime. */
function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
