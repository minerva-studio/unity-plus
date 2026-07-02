import type * as vscode from 'vscode';
import { hasUnityWorkspaceMarkers, unityWorkspaceMarkers } from './workspaceMarkers';

export interface UnityWorkspaceInfo {
  isUnityProject: boolean;
  root?: vscode.Uri;
}

export type UnityMarkerProbe = (folder: vscode.WorkspaceFolder, marker: string) => Promise<boolean>;

export async function detectUnityWorkspace(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
  markerExists: UnityMarkerProbe = defaultUnityMarkerProbe
): Promise<UnityWorkspaceInfo> {
  for (const folder of workspaceFolders) {
    const markerResults = await Promise.all(unityWorkspaceMarkers.map(async marker => {
      return await markerExists(folder, marker) ? marker : undefined;
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

async function defaultUnityMarkerProbe(folder: vscode.WorkspaceFolder, marker: string): Promise<boolean> {
  // Load VS Code only inside the extension host so Node-based unit tests can inject a probe.
  const runtimeVscode = await import('vscode');

  try {
    await runtimeVscode.workspace.fs.stat(runtimeVscode.Uri.joinPath(folder.uri, ...marker.split('/')));
    return true;
  } catch {
    return false;
  }
}
