import type * as vscode from 'vscode';
import type { EventReferenceFeatureOptions } from './features/event-references/eventReferences';
import type { MetaFilesFeatureOptions } from './features/meta-files/metaFiles';
import type { ProjectSyncFeatureOptions } from './features/project-sync/projectSync';
import type { RenameFeatureOptions } from './features/rename/renameSync';
import type { SerializedInstancesFeatureOptions } from './features/serialized-instances/serializedInstances';
import type { UnityPlusLogger } from './unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndexOptions } from './unity/metadataIndex';
import type { UnityWorkspaceInfo } from './unity/workspaceDetector';

export interface UnityPlusActivationContext {
  subscriptions: {
    push(...disposables: vscode.Disposable[]): number;
  };
}

export interface UnityPlusActivationRuntime {
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
}

export interface UnityPlusActivationDependencies {
  logger: UnityPlusLogger;
  detectUnityWorkspace(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<UnityWorkspaceInfo>;
  createLazyMetadataIndex(options: Pick<UnityMetadataIndexOptions, 'root' | 'logger'>): LazyUnityMetadataIndex;
  registerRenameFeature(logger: UnityPlusLogger, options?: RenameFeatureOptions): vscode.Disposable;
  registerProjectSyncFeature(logger: UnityPlusLogger, options?: ProjectSyncFeatureOptions): vscode.Disposable;
  registerEventReferenceFeature(logger: UnityPlusLogger, options?: EventReferenceFeatureOptions): vscode.Disposable;
  registerSerializedInstancesFeature(logger: UnityPlusLogger, options?: SerializedInstancesFeatureOptions): vscode.Disposable;
  registerMetaFilesFeature(logger: UnityPlusLogger, options?: MetaFilesFeatureOptions): vscode.Disposable;
  hideMetaFilesInExplorerIfEnabled(logger: UnityPlusLogger): Promise<void>;
  checkUnityVisualStudioEditorPackage(root: vscode.Uri): Promise<boolean>;
}

interface UnityPlusWorkspaceSession extends vscode.Disposable {
  apply(workspace: UnityWorkspaceInfo, reason: 'initial' | 'rescan'): Promise<void>;
  getCacheVersion(): number;
}

export async function activateUnityPlus(
  context: UnityPlusActivationContext,
  runtime: UnityPlusActivationRuntime,
  dependencies: UnityPlusActivationDependencies
): Promise<void> {
  const logger = dependencies.logger;
  context.subscriptions.push(logger);

  const session = createUnityPlusWorkspaceSession(dependencies);
  context.subscriptions.push(session);

  const unityWorkspace = await dependencies.detectUnityWorkspace(runtime.workspaceFolders ?? []);
  logWorkspaceDetection(logger, unityWorkspace, 'detected');
  await session.apply(unityWorkspace, 'initial');

  context.subscriptions.push(
    runtime.registerCommand('unityPlus.rescanUnityProject', async () => {
      const refreshed = await dependencies.detectUnityWorkspace(runtime.workspaceFolders ?? []);
      logWorkspaceDetection(logger, refreshed, 'rescan found');
      await session.apply(refreshed, 'rescan');
    })
  );
}

function createUnityPlusWorkspaceSession(dependencies: UnityPlusActivationDependencies): UnityPlusWorkspaceSession {
  const logger = dependencies.logger;
  let metadataIndex: LazyUnityMetadataIndex | undefined;
  let featureRegistration: vscode.Disposable | undefined;
  let eventReferenceCacheVersion = 0;

  return {
    async apply(workspace, reason) {
      if (workspace.root) {
        await dependencies.hideMetaFilesInExplorerIfEnabled(logger);
        await dependencies.checkUnityVisualStudioEditorPackage(workspace.root);
      }

      if (reason === 'rescan' && metadataIndex && workspace.root && sameWorkspaceRoot(metadataIndex.root, workspace.root)) {
        await rebuildMetadataIndex(metadataIndex, logger);
        eventReferenceCacheVersion += 1;
        return;
      }

      if (!sameOptionalWorkspaceRoot(metadataIndex?.root, workspace.root)) {
        disposeCurrentRegistration();
        metadataIndex?.dispose();
        metadataIndex = workspace.root
          ? dependencies.createLazyMetadataIndex({
            root: workspace.root,
            logger
          })
          : undefined;
        if (reason === 'rescan') {
          eventReferenceCacheVersion += 1;
        }
        featureRegistration = registerWorkspaceFeatures(dependencies, metadataIndex, workspace, () => eventReferenceCacheVersion);

        if (reason === 'rescan' && metadataIndex) {
          await rebuildMetadataIndex(metadataIndex, logger);
        }
      } else if (!featureRegistration) {
        featureRegistration = registerWorkspaceFeatures(dependencies, metadataIndex, workspace, () => eventReferenceCacheVersion);
      }
    },
    getCacheVersion: () => eventReferenceCacheVersion,
    dispose() {
      disposeCurrentRegistration();
      metadataIndex?.dispose();
    }
  };

  function disposeCurrentRegistration(): void {
    featureRegistration?.dispose();
    featureRegistration = undefined;
  }
}

function registerWorkspaceFeatures(
  dependencies: UnityPlusActivationDependencies,
  metadataIndex: LazyUnityMetadataIndex | undefined,
  workspace: UnityWorkspaceInfo,
  getCacheVersion: () => number
): vscode.Disposable {
  const logger = dependencies.logger;
  const disposables = [
    dependencies.registerRenameFeature(logger, {
      isUnityWorkspace: workspace.root !== undefined
    }),
    dependencies.registerProjectSyncFeature(logger, {
      root: workspace.root
    }),
    dependencies.registerEventReferenceFeature(logger, {
      metadataIndex,
      getCacheVersion
    }),
    dependencies.registerSerializedInstancesFeature(logger, {
      metadataIndex,
      getCacheVersion
    }),
    dependencies.registerMetaFilesFeature(logger, {
      root: workspace.root
    })
  ];

  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    }
  };
}

async function rebuildMetadataIndex(metadataIndex: LazyUnityMetadataIndex, logger: UnityPlusLogger): Promise<void> {
  const rebuiltIndex = await metadataIndex.rebuild();
  const statistics = rebuiltIndex.getStatistics?.();

  if (!statistics) {
    logger.info('Unity metadata index rebuilt after project rescan.');
    return;
  }

  logger.info(`Unity metadata index rebuilt after project rescan: found=${statistics.foundMetaFileCount}, parsed GUIDs=${statistics.parsedGuidCount}, malformed=${statistics.malformedMetaFileCount}, read errors=${statistics.readErrorCount}.`);
}

function logWorkspaceDetection(
  logger: UnityPlusLogger,
  workspace: UnityWorkspaceInfo,
  action: 'detected' | 'rescan found'
): void {
  if (workspace.isUnityProject) {
    logger.info(`Unity project ${action} at ${workspace.root?.fsPath}`);
    return;
  }

  logger.info(action === 'detected'
    ? 'No Unity project detected in the current workspace.'
    : 'Unity project rescan did not find a Unity workspace.');
}

function sameWorkspaceRoot(first: vscode.Uri, second: vscode.Uri): boolean {
  return normalizeWorkspaceRoot(first.fsPath) === normalizeWorkspaceRoot(second.fsPath);
}

function sameOptionalWorkspaceRoot(first: vscode.Uri | undefined, second: vscode.Uri | undefined): boolean {
  if (!first || !second) {
    return first === second;
  }

  return sameWorkspaceRoot(first, second);
}

function normalizeWorkspaceRoot(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
