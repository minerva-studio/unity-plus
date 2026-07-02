import * as assert from 'assert';
import type * as vscode from 'vscode';
import { detectUnityWorkspace, UnityMarkerProbe } from '../unity/workspaceDetector';
import { hasUnityWorkspaceMarkers } from '../unity/workspaceMarkers';

describe('workspaceDetector', () => {
  it('accepts a Unity project root with canonical markers', () => {
    assert.strictEqual(hasUnityWorkspaceMarkers([
      'Assets',
      'ProjectSettings',
      'Packages/manifest.json'
    ]), true);
  });

  it('normalizes Windows-style marker paths', () => {
    assert.strictEqual(hasUnityWorkspaceMarkers([
      'Assets',
      'ProjectSettings',
      'Packages\\manifest.json'
    ]), true);
  });

  it('rejects a non-Unity folder', () => {
    assert.strictEqual(hasUnityWorkspaceMarkers([
      'src',
      'package.json'
    ]), false);
  });

  it('returns a Unity project root when all canonical markers exist', async () => {
    const unityFolder = createWorkspaceFolder('UnityGame', 0);
    const markerProbe = createMarkerProbe({
      UnityGame: [
        'Assets',
        'ProjectSettings',
        'Packages/manifest.json'
      ]
    });

    const result = await detectUnityWorkspace([unityFolder], markerProbe);

    assert.strictEqual(result.isUnityProject, true);
    assert.strictEqual(result.root, unityFolder.uri);
  });

  it('rejects a workspace folder when any canonical marker is missing', async () => {
    const folder = createWorkspaceFolder('LibraryOnly', 0);
    const markerProbe = createMarkerProbe({
      LibraryOnly: [
        'Assets',
        'ProjectSettings'
      ]
    });

    const result = await detectUnityWorkspace([folder], markerProbe);

    assert.strictEqual(result.isUnityProject, false);
    assert.strictEqual(result.root, undefined);
  });

  it('returns the first Unity root from multiple workspace folders', async () => {
    const libraryFolder = createWorkspaceFolder('LibraryOnly', 0);
    const firstUnityFolder = createWorkspaceFolder('FirstUnityGame', 1);
    const secondUnityFolder = createWorkspaceFolder('SecondUnityGame', 2);
    const markerProbe = createMarkerProbe({
      LibraryOnly: [
        'Assets',
        'ProjectSettings'
      ],
      FirstUnityGame: [
        'Assets',
        'ProjectSettings',
        'Packages/manifest.json'
      ],
      SecondUnityGame: [
        'Assets',
        'ProjectSettings',
        'Packages/manifest.json'
      ]
    });

    const result = await detectUnityWorkspace([
      libraryFolder,
      firstUnityFolder,
      secondUnityFolder
    ], markerProbe);

    assert.strictEqual(result.isUnityProject, true);
    assert.strictEqual(result.root, firstUnityFolder.uri);
  });
});

function createWorkspaceFolder(name: string, index: number): vscode.WorkspaceFolder {
  return {
    uri: { fsPath: `/${name}` } as vscode.Uri,
    name,
    index
  };
}

function createMarkerProbe(markersByFolderName: Record<string, readonly string[]>): UnityMarkerProbe {
  return async (folder, marker) => {
    const markers = markersByFolderName[folder.name] ?? [];
    return markers.includes(marker);
  };
}
