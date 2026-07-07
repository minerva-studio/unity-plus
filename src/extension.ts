import * as vscode from 'vscode';
import { activateUnityPlus } from './activation';
import { registerEventReferenceFeature } from './features/event-references/eventReferences';
import { hideMetaFilesInExplorerIfEnabled, registerMetaFilesFeature } from './features/meta-files/metaFiles';
import { registerProjectSyncFeature } from './features/project-sync/projectSync';
import { registerRenameFeature } from './features/rename/renameSync';
import { registerSerializedInstancesFeature } from './features/serialized-instances/serializedInstances';
import { createLogger } from './unity/logger';
import { createLazyUnityMetadataIndex } from './unity/metadataIndex';
import { checkUnityVisualStudioEditorPackage } from './unity/visualStudioEditorPackage';
import { detectUnityWorkspace } from './unity/workspaceDetector';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();

  await activateUnityPlus(context, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback)
  }, {
    logger,
    detectUnityWorkspace,
    createLazyMetadataIndex: createLazyUnityMetadataIndex,
    registerRenameFeature,
    registerProjectSyncFeature,
    registerEventReferenceFeature,
    registerSerializedInstancesFeature,
    registerMetaFilesFeature,
    hideMetaFilesInExplorerIfEnabled: async logger => await hideMetaFilesInExplorerIfEnabled(vscode, logger),
    checkUnityVisualStudioEditorPackage: async root => await checkUnityVisualStudioEditorPackage(root, {
      runtimeVscode: vscode,
      logger
    })
  });
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}
