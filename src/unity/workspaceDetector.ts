import * as vscode from 'vscode';
import { hasUnityWorkspaceMarkers, unityWorkspaceMarkers } from './workspaceMarkers';

export interface UnityWorkspaceInfo {
  isUnityProject: boolean;
  root?: vscode.Uri;
}

export async function detectUnityWorkspace(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<UnityWorkspaceInfo> {
  for (const folder of workspaceFolders) {
    const markerResults = await Promise.all(unityWorkspaceMarkers.map(async marker => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, ...marker.split('/')));
        return marker;
      } catch {
        return undefined;
      }
    }));

    // A Unity workspace has all three canonical markers at the workspace root.
    if (hasUnityWorkspaceMarkers(markerResults.filter((marker): marker is string => marker !== undefined))) {
      return {
        isUnityProject: true,
        root: folder.uri
      };
    }
  }

  return {
    isUnityProject: false
  };
}
