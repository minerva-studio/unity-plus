import type { UnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnitySerializedInstanceBuildContext, UnitySerializedInstanceIndex } from './model';
import {
  backgroundBuildDebounceMilliseconds,
  type SerializedInstanceIndexController,
  type SerializedInstanceIndexStatus,
  type SerializedInstancesRuntime
} from './runtime';
import { buildSerializedInstanceIndex } from './scanner';
import { errorMessage, isCancellationError } from '../serialized-assets/utils';

/** Coordinates cached background and interactive serialized instance index builds. */
export function createSerializedInstanceIndexController(runtime: SerializedInstancesRuntime): SerializedInstanceIndexController {
  const codeLensEvents = new runtime.runtimeVscode.EventEmitter<void>();
  let status: SerializedInstanceIndexStatus = 'idle';
  let cachedVersion: number | undefined;
  let index: UnitySerializedInstanceIndex | undefined;
  let buildPromise: Promise<UnitySerializedInstanceIndex | undefined> | undefined;
  let scheduledBuild = false;

  function refreshVersion(): void {
    const version = runtime.getCacheVersion();
    if (cachedVersion === version) {
      return;
    }

    if (status === 'building' && buildPromise) {
      cachedVersion = version;
      return;
    }

    cachedVersion = version;
    status = 'idle';
    index = undefined;
    buildPromise = undefined;
    scheduledBuild = false;
  }

  async function forceBuild(
    context: UnitySerializedInstanceBuildContext = { mode: 'background' },
    metadata?: UnityMetadataIndex
  ): Promise<UnitySerializedInstanceIndex | undefined> {
    refreshVersion();

    if (status === 'building' && buildPromise) {
      return await buildPromise;
    }

    const buildVersion = cachedVersion;
    const previousIndex = index;
    const scanStatus = context.mode === 'background' ? runtime.scanStatus : undefined;
    const buildContext = scanStatus ? { ...context, scanStatus } : context;
    status = 'building';
    scanStatus?.start('Preparing Unity serialized instance scan', 'Unity inst: project');
    runtime.logger.info(`Unity serialized instance ${context.mode} scan started.`);
    buildPromise = buildSerializedInstanceIndex(runtime, metadata, buildContext)
      .then(builtIndex => {
        if (buildVersion !== runtime.getCacheVersion()) {
          status = 'idle';
          scanStatus?.finish('canceled', undefined, { label: 'Unity inst: project', phase: 'Canceled' });
          return undefined;
        }

        index = builtIndex;
        status = 'ready';
        runtime.logger.info(`Unity serialized instance ${context.mode} scan completed: ${builtIndex.getDiagnostics().serializedInstanceCount} instance(s), ${builtIndex.getDiagnostics().elapsedMilliseconds}ms.`);
        scanStatus?.finish('completed', builtIndex.getDiagnostics(), {
          label: 'Unity inst: project',
          phase: 'Project scan complete',
          candidateCount: builtIndex.getDiagnostics().candidateAssetCount,
          scannedCount: builtIndex.getDiagnostics().prefabCount + builtIndex.getDiagnostics().sceneCount + builtIndex.getDiagnostics().assetCount,
          instanceCount: builtIndex.getDiagnostics().serializedInstanceCount,
          elapsedMilliseconds: builtIndex.getDiagnostics().elapsedMilliseconds
        });
        codeLensEvents.fire();
        return builtIndex;
      })
      .catch(error => {
        if (isCancellationError(error)) {
          status = previousIndex ? 'ready' : 'idle';
          scanStatus?.finish('canceled', undefined, { label: 'Unity inst: project', phase: 'Canceled' });
          runtime.logger.info('Unity serialized instance index build canceled.');
          codeLensEvents.fire();
          return undefined;
        }

        status = 'failed';
        scanStatus?.finish('failed', undefined, { label: 'Unity inst: project', phase: 'Failed' });
        runtime.logger.error(`Could not build Unity serialized instance index: ${errorMessage(error)}`);
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
    runtime.logger.debug('Unity serialized instance background scan scheduled.');
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
