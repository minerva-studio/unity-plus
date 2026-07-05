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
  let scheduledBuild = false;

  function refreshVersion(): void {
    const version = runtime.getCacheVersion();
    if (cachedVersion === version) {
      return;
    }

    cachedVersion = version;
    status = 'idle';
    index = undefined;
    buildPromise = undefined;
    scheduledBuild = false;
  }

  async function forceBuild(context: UnityEventReferenceBuildContext = { mode: 'background' }): Promise<UnitySerializedAssetReferenceIndex | undefined> {
    refreshVersion();

    if (status === 'building' && buildPromise) {
      return await buildPromise;
    }

    const buildVersion = cachedVersion;
    const previousIndex = index;
    const scanStatus = context.mode === 'background' ? runtime.scanStatus : undefined;
    const buildContext = scanStatus ? { ...context, scanStatus } : context;
    status = 'building';
    scanStatus?.start('Preparing UnityEvent reference scan', 'Unity refs: project');
    buildPromise = buildUnityEventReferenceIndex(runtime, undefined, buildContext)
      .then(builtIndex => {
        if (buildVersion !== runtime.getCacheVersion()) {
          status = 'idle';
          scanStatus?.finish('canceled', undefined, { label: 'Unity refs: project', phase: 'Canceled' });
          return undefined;
        }

        index = builtIndex;
        status = 'ready';
        scanStatus?.finish('completed', builtIndex.getDiagnostics(), {
          label: 'Unity refs: project',
          phase: 'Project scan complete',
          candidateCount: builtIndex.getDiagnostics().candidateAssetCount,
          scannedCount: builtIndex.getDiagnostics().prefabCount + builtIndex.getDiagnostics().sceneCount + builtIndex.getDiagnostics().assetCount,
          referenceCount: builtIndex.getDiagnostics().resolvedReferenceCount,
          instanceCount: builtIndex.getDiagnostics().serializedInstanceCount,
          elapsedMilliseconds: builtIndex.getDiagnostics().elapsedMilliseconds
        });
        codeLensEvents.fire();
        return builtIndex;
      })
      .catch(error => {
        if (isCancellationError(error)) {
          status = previousIndex ? 'ready' : 'idle';
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
        buildPromise = undefined;
      });

    return await buildPromise;
  }

  function scheduleBuild(): void {
    refreshVersion();
    if (scheduledBuild || status === 'building' || status === 'ready') {
      return;
    }

    scheduledBuild = true;
    setTimeout(() => {
      scheduledBuild = false;
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
    notifyCodeLensesChanged: () => codeLensEvents.fire()
  };
}
