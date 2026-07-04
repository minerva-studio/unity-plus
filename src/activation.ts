import type * as vscode from 'vscode';
import type { EventReferenceFeatureOptions } from './features/event-references/eventReferences';
import type { MetaFilesFeatureOptions } from './features/meta-files/metaFiles';
import type { ProjectSyncFeatureOptions } from './features/project-sync/projectSync';
import type { RenameFeatureOptions } from './features/rename/renameSync';
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
  registerMetaFilesFeature(logger: UnityPlusLogger, options?: MetaFilesFeatureOptions): vscode.Disposable;
  hideMetaFilesInExplorerIfEnabled(logger: UnityPlusLogger): Promise<void>;
  checkUnityVisualStudioEditorPackage(root: vscode.Uri): Promise<boolean>;
}

export async function activateUnityPlus(
  context: UnityPlusActivationContext,
  runtime: UnityPlusActivationRuntime,
  dependencies: UnityPlusActivationDependencies
): Promise<void> {
  const logger = dependencies.logger;
  context.subscriptions.push(logger);

  const unityWorkspace = await dependencies.detectUnityWorkspace(runtime.workspaceFolders ?? []);
  logWorkspaceDetection(logger, unityWorkspace, 'detected');

  const metadataIndex = unityWorkspace.root
    ? dependencies.createLazyMetadataIndex({
      root: unityWorkspace.root,
      logger
    })
    : undefined;
  let eventReferenceCacheVersion = 0;

  if (metadataIndex) {
    context.subscriptions.push(metadataIndex);
  }

  if (unityWorkspace.root) {
    await dependencies.hideMetaFilesInExplorerIfEnabled(logger);
    await dependencies.checkUnityVisualStudioEditorPackage(unityWorkspace.root);
  }

  context.subscriptions.push(
    dependencies.registerRenameFeature(logger, {
      isUnityWorkspace: unityWorkspace.root !== undefined
    }),
    dependencies.registerProjectSyncFeature(logger, {
      root: unityWorkspace.root
    }),
    dependencies.registerEventReferenceFeature(logger, {
      metadataIndex,
      getCacheVersion: () => eventReferenceCacheVersion
    }),
    dependencies.registerMetaFilesFeature(logger, {
      root: unityWorkspace.root
    }),
    runtime.registerCommand('unityPlus.rescanUnityProject', async () => {
      const refreshed = await dependencies.detectUnityWorkspace(runtime.workspaceFolders ?? []);
      logWorkspaceDetection(logger, refreshed, 'rescan found');

      if (refreshed.root) {
        await dependencies.hideMetaFilesInExplorerIfEnabled(logger);
        await dependencies.checkUnityVisualStudioEditorPackage(refreshed.root);
      }

      if (metadataIndex && refreshed.root && sameWorkspaceRoot(metadataIndex.root, refreshed.root)) {
        await metadataIndex.rebuild();
        eventReferenceCacheVersion += 1;
        logger.info('Unity metadata index rebuilt after project rescan.');
      }
    })
  );
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
  return first.fsPath === second.fsPath;
}
