import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';

const setupState = globalThis as typeof globalThis & {
  __unityPlusCSharpProviderSetup?: Promise<void>;
};

/** Returns the Unity fixture workspace opened by the integration test runner. */
export function getUnityFixtureRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'integration tests must open the Unity fixture workspace');
  return folder.uri;
}

/** Configures the C# provider once per VS Code test window. */
export async function configureCSharpSolution(root: vscode.Uri): Promise<void> {
  const solutionPath = join(root.fsPath, 'UnityEventFixture.sln');
  const solutionUri = vscode.Uri.file(solutionPath);

  if (!setupState.__unityPlusCSharpProviderSetup) {
    setupState.__unityPlusCSharpProviderSetup = configureCSharpSolutionOnce(solutionUri).catch(error => {
      setupState.__unityPlusCSharpProviderSetup = undefined;
      throw error;
    });
  }

  await setupState.__unityPlusCSharpProviderSetup;
}

/** Starts the C# provider against the fixture solution without repeated server restarts. */
async function configureCSharpSolutionOnce(solutionUri: vscode.Uri): Promise<void> {
  await vscode.workspace.openTextDocument(solutionUri);
  await vscode.extensions.getExtension('ms-dotnettools.csdevkit')?.activate();
  await vscode.extensions.getExtension('ms-dotnettools.csharp')?.activate();

  try {
    // The first restart makes the provider read the test user-data solution settings.
    await vscode.commands.executeCommand('dotnet.restartServer');
  } catch {
    // Some extension versions only register restart after activation completes.
  }

  await openCSharpProviderSolution(solutionUri);
}

/** Asks installed C# providers to load the fixture solution explicitly. */
async function openCSharpProviderSolution(solutionUri: vscode.Uri): Promise<void> {
  for (const command of ['csdevkit.openSolution', 'dotnet.openSolution']) {
    try {
      await vscode.commands.executeCommand(command, solutionUri);
    } catch {
      // Older provider versions may not support argument-based solution opening.
    }
  }
}
