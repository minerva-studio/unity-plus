import type * as vscode from 'vscode';
import type { UnityEventReferenceBuildContext, UnitySerializedAssetReferenceIndex } from './model';
import { backgroundBuildDebounceMilliseconds, type EventReferenceRuntime, type UnityEventReferenceIndexController, type UnityEventReferenceIndexStatus } from './runtime';
import { buildUnityEventReferenceIndex } from './scanner';
import { errorMessage, isCancellationError } from './utils';

/** Coordinates cached background and interactive UnityEvent reference index builds. */
export function createEventReferenceIndexController(runtime: EventReferenceRuntime): UnityEventReferenceIndexController {
  const codeLensEvents = new runtime.runtimeVscode.EventEmitter<void>();
  let status: UnityEventReferenceIndexStatus = 'idle';
  let cachedVersion: number | undefined;
  let index: UnitySerializedAssetReferenceIndex | undefined;
  let buildPromise: Promise<UnitySerializedAssetReferenceIndex | undefined> | undefined;
  let activeBuildCancellation: vscode.CancellationTokenSource | undefined;
  let scheduledBuild: ReturnType<typeof setTimeout> | undefined;
  let rebuildRequested = false;
  let disposed = false;

  function refreshVersion(): void {
    const version = runtime.getCacheVersion();
    if (cachedVersion === version) {
      return;
    }

    cachedVersion = version;
    index = undefined;

    if (status === 'building' && buildPromise) {
      // The controller owns scan cancellation so invalidation cannot leave a
      // stale full-project scan consuming I/O until natural completion.
      rebuildRequested = true;
      activeBuildCancellation?.cancel();
      return;
    }

    status = 'idle';
    buildPromise = undefined;
  }

  async function forceBuild(context: UnityEventReferenceBuildContext = { mode: 'background' }): Promise<UnitySerializedAssetReferenceIndex | undefined> {
    if (disposed) {
      return undefined;
    }

    refreshVersion();

    if (status === 'building' && buildPromise) {
      return await buildPromise;
    }

    const buildVersion = cachedVersion;
    const previousIndex = index;
    const scanStatus = context.mode === 'background' ? runtime.scanStatus : undefined;
    const buildCancellation = new runtime.runtimeVscode.CancellationTokenSource();
    const externalCancellation = context.cancellationToken?.onCancellationRequested(() => buildCancellation.cancel());
    if (context.cancellationToken?.isCancellationRequested) {
      buildCancellation.cancel();
    }

    const buildContext = {
      ...context,
      cancellationToken: buildCancellation.token,
      ...(scanStatus ? { scanStatus } : {})
    };
    status = 'building';
    activeBuildCancellation = buildCancellation;
    rebuildRequested = false;
    if (scheduledBuild) {
      clearTimeout(scheduledBuild);
      scheduledBuild = undefined;
    }
    scanStatus?.start('Preparing UnityEvent reference scan', 'Unity refs: project');
    runtime.logger.info(`UnityEvent ${context.mode} reference scan started.`);
    buildPromise = buildUnityEventReferenceIndex(runtime, undefined, buildContext)
      .then(builtIndex => {
        if (buildVersion !== runtime.getCacheVersion()) {
          status = 'idle';
          scanStatus?.finish('canceled', undefined, { label: 'Unity refs: project', phase: 'Canceled' });
          return undefined;
        }

        index = builtIndex;
        status = 'ready';
        runtime.logger.info(`UnityEvent ${context.mode} reference scan completed: ${builtIndex.getDiagnostics().resolvedReferenceCount} reference(s), ${builtIndex.getDiagnostics().elapsedMilliseconds}ms.`);
        scanStatus?.finish('completed', builtIndex.getDiagnostics(), {
          label: 'Unity refs: project',
          phase: 'Project scan complete',
          candidateCount: builtIndex.getDiagnostics().candidateAssetCount,
          scannedCount: builtIndex.getDiagnostics().prefabCount + builtIndex.getDiagnostics().sceneCount + builtIndex.getDiagnostics().assetCount,
          referenceCount: builtIndex.getDiagnostics().resolvedReferenceCount,
          elapsedMilliseconds: builtIndex.getDiagnostics().elapsedMilliseconds
        });
        codeLensEvents.fire();
        return builtIndex;
      })
      .catch(error => {
        if (isCancellationError(error)) {
          status = previousIndex && buildVersion === runtime.getCacheVersion() ? 'ready' : 'idle';
          scanStatus?.finish('canceled', undefined, { label: 'Unity refs: project', phase: 'Canceled' });
          runtime.logger.info('UnityEvent reference index build canceled.');
          codeLensEvents.fire();
          return undefined;
        }

        status = 'failed';
        scanStatus?.finish('failed', undefined, { label: 'Unity refs: project', phase: 'Failed' });
        runtime.logger.warn(`Could not build UnityEvent reference index: ${errorMessage(error)}`);
        codeLensEvents.fire();
        return undefined;
      })
      .finally(() => {
        externalCancellation?.dispose();
        buildCancellation.dispose();
        if (activeBuildCancellation === buildCancellation) {
          activeBuildCancellation = undefined;
        }
        buildPromise = undefined;

        // Coalesce any number of invalidations observed during this build into
        // exactly one trailing rebuild for the newest cache version.
        if (rebuildRequested && !disposed) {
          rebuildRequested = false;
          scheduleBuild();
        }
      });

    return await buildPromise;
  }

  function scheduleBuild(): void {
    if (disposed) {
      return;
    }

    refreshVersion();
    if (status === 'building') {
      rebuildRequested = true;
      return;
    }

    if (status === 'ready') {
      return;
    }

    if (scheduledBuild) {
      clearTimeout(scheduledBuild);
    }

    runtime.logger.debug('UnityEvent background reference scan scheduled.');
    scheduledBuild = setTimeout(() => {
      scheduledBuild = undefined;
      refreshVersion();

      if (status === 'idle' || status === 'failed') {
        void forceBuild({ mode: 'background' });
      }
    }, backgroundBuildDebounceMilliseconds);
  }

  return {
    onDidChangeCodeLenses: codeLensEvents.event,
    getStatus: () => {
      refreshVersion();
      return status;
    },
    getReadyIndex: () => {
      refreshVersion();
      return status === 'ready' ? index : undefined;
    },
    scheduleBuild,
    forceBuild,
    notifyCodeLensesChanged: () => {
      // Watcher invalidation must reach the active build immediately instead of
      // waiting for VS Code to request CodeLens data again.
      refreshVersion();
      codeLensEvents.fire();
    },
    dispose: () => {
      disposed = true;
      rebuildRequested = false;
      if (scheduledBuild) {
        clearTimeout(scheduledBuild);
        scheduledBuild = undefined;
      }

      activeBuildCancellation?.cancel();
      codeLensEvents.dispose();
    }
  };
}
