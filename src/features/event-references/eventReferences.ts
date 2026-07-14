import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';
import { findDefaultAssetFiles, findDefaultAssetFilesContainingText, findDefaultCSharpFiles, watchUnitySerializedAssetFiles } from './assetDiscovery';
import { formatDiagnostics } from './diagnostics';
import { createEventReferenceIndexController } from './indexController';
import { parseUnityEventReferences } from './parser';
import { createEventReferenceProvider } from './provider';
import { buildUnityEventReferenceIndex } from './scanner';
import { createUnityEventReferenceScanStatus } from './scanStatus';
import { getEventReferenceRescanDebounceMilliseconds } from './settings';
import { buildDefaultCSharpTypeIndex } from './typeIndex';
import { readDefaultTextFile } from './utils';
import { createSharedUnityYamlAssetHandler } from '../unity-yaml-assets/handler';
import type { EventReferenceFeatureOptions, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';

export type {
  UnityEventReference,
  UnityEventReferenceBuildContext,
  UnityEventReferenceBuildMode,
  UnityEventReferenceDiagnostics,
  UnitySerializedAssetKind,
  UnitySerializedAssetReferenceIndex
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
    const searchAssetFilesContainingText = options.searchAssetFilesContainingText ??
      (options.findAssetFilesContainingText
        ? async (root: vscode.Uri, searchRuntimeVscode: typeof vscode, texts: readonly string[]) => {
          const startedAt = Date.now();
          const candidates = new Map<string, vscode.Uri>();
          for (const text of texts) {
            const files = await options.findAssetFilesContainingText?.(root, searchRuntimeVscode, text) ?? [];
            for (const uri of files) {
              candidates.set(uri.fsPath.replace(/\\/g, '/').toLowerCase(), uri);
            }
          }

          return {
            files: [...candidates.values()],
            backend: 'injectedTextSearch' as const,
            searchCount: texts.length,
            elapsedMilliseconds: Date.now() - startedAt
          };
        }
        : (useDefaultAssetSearch ? findDefaultAssetFilesContainingText : undefined));
    const yamlAssets = createSharedUnityYamlAssetHandler({
      root: options.metadataIndex.root,
      runtimeVscode,
      logger,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      searchAssetFilesContainingText,
      readTextFile: options.readTextFile ?? readDefaultTextFile
    });
    const featureRuntime: EventReferenceRuntime = {
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      findAssetFilesContainingText: options.findAssetFilesContainingText,
      searchAssetFilesContainingText,
      findCSharpFiles: options.findCSharpFiles ?? findDefaultCSharpFiles,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      yamlAssets,
      getCacheVersion: () => (options.getCacheVersion?.() ?? 0) + serializedAssetCacheVersion,
      getRescanDebounceMilliseconds: () => getEventReferenceRescanDebounceMilliseconds(runtimeVscode),
      waitForBackgroundScanReady: createCSharpBackgroundScanReadiness(runtimeVscode, logger),
      resolveCSharpType: options.resolveCSharpType,
      buildCSharpTypeIndex: options.buildCSharpTypeIndex ?? buildDefaultCSharpTypeIndex,
      csharpLanguageService: options.csharpLanguageService ?? createVscodeCSharpLanguageService(runtimeVscode),
      scanStatus
    };
    indexController = createEventReferenceIndexController(featureRuntime);
    const provider = createEventReferenceProvider(featureRuntime, indexController, isEnabled);

    disposables.push(
      indexController,
      provider,
      scanStatus,
      watchUnitySerializedAssetFiles(runtimeVscode, options.metadataIndex.root, uri => {
        serializedAssetCacheVersion += 1;
        yamlAssets.invalidate(uri);
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

/** Creates one lazy readiness gate so automatic scans do not compete with C# startup. */
function createCSharpBackgroundScanReadiness(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger
): () => Promise<void> {
  let readiness: Promise<void> | undefined;
  return async () => {
    readiness ??= waitForCSharpBackgroundScanReadiness(runtimeVscode, logger);
    await readiness;
  };
}

/** Waits for the installed C# provider, with a bounded fallback for older exports. */
async function waitForCSharpBackgroundScanReadiness(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger
): Promise<void> {
  if (!runtimeVscode.extensions) {
    // Lightweight unit runtimes do not host extensions; they are already ready
    // for deterministic background scan scheduling.
    return;
  }

  const extension = runtimeVscode.extensions?.getExtension('ms-dotnettools.csharp');
  if (!extension) {
    logger.warn('UnityEvent background scan could not find the C# extension; using delayed startup fallback.');
    await wait(10000);
    return;
  }

  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    const initializationFinished = (exports as { initializationFinished?: () => Promise<void> } | undefined)?.initializationFinished;
    if (typeof initializationFinished !== 'function') {
      logger.info('UnityEvent background scan is using delayed startup because the C# initialization gate is unavailable.');
      await wait(10000);
      return;
    }

    const result = await Promise.race([
      initializationFinished().then(() => 'ready' as const),
      wait(60000).then(() => 'timeout' as const)
    ]);
    if (result === 'timeout') {
      logger.warn('UnityEvent background scan waited 60 seconds for C# initialization and will continue at reduced concurrency.');
    }
  } catch (error) {
    logger.warn(`UnityEvent background scan could not await C# initialization: ${error instanceof Error ? error.message : String(error)}`);
    await wait(10000);
  }
}

/** Waits without blocking the extension host event loop. */
async function wait(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
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
