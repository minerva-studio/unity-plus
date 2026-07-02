import * as vscode from 'vscode';
import { registerEventReferenceFeature } from './features/event-references/eventReferences';
import { registerProjectSyncFeature } from './features/project-sync/projectSync';
import { registerRenameFeature } from './features/rename/renameSync';
import { createLogger } from './unity/logger';
import { detectUnityWorkspace } from './unity/workspaceDetector';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  context.subscriptions.push(logger);

  const unityWorkspace = await detectUnityWorkspace(vscode.workspace.workspaceFolders ?? []);
  logger.info(unityWorkspace.isUnityProject
    ? `Unity project detected at ${unityWorkspace.root?.fsPath}`
    : 'No Unity project detected in the current workspace.');

  context.subscriptions.push(
    registerRenameFeature(logger),
    registerProjectSyncFeature(logger),
    registerEventReferenceFeature(logger),
    vscode.commands.registerCommand('unityPlus.rescanUnityProject', async () => {
      const refreshed = await detectUnityWorkspace(vscode.workspace.workspaceFolders ?? []);
      logger.info(refreshed.isUnityProject
        ? `Unity project rescan found ${refreshed.root?.fsPath}`
        : 'Unity project rescan did not find a Unity workspace.');
    })
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}
