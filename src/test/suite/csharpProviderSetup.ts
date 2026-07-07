import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';

const setupState = globalThis as typeof globalThis & {
  __unityPlusCSharpProviderSetup?: Promise<void>;
  __unityPlusCSharpProviderReadiness?: CSharpProviderReadinessState;
};

export interface CSharpProviderReadinessState {
  csharpExtensionActivated: boolean;
  csDevKitExtensionActivated: boolean;
  initializationFinishedExport: 'awaited' | 'missing' | 'failed';
  initializationFinishedError?: string;
}

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

/** Returns diagnostic details about how the real C# provider was initialized. */
export function getCSharpProviderReadinessState(): CSharpProviderReadinessState | undefined {
  return setupState.__unityPlusCSharpProviderReadiness;
}

/** Starts the C# provider against the fixture solution without repeated server restarts. */
async function configureCSharpSolutionOnce(solutionUri: vscode.Uri): Promise<void> {
  const readiness: CSharpProviderReadinessState = {
    csharpExtensionActivated: false,
    csDevKitExtensionActivated: false,
    initializationFinishedExport: 'missing'
  };
  setupState.__unityPlusCSharpProviderReadiness = readiness;

  await vscode.workspace.openTextDocument(solutionUri);
  const csDevKitExports = await vscode.extensions.getExtension('ms-dotnettools.csdevkit')?.activate();
  readiness.csDevKitExtensionActivated = !!vscode.extensions.getExtension('ms-dotnettools.csdevkit')?.isActive || !!csDevKitExports;
  const csharpExports = await vscode.extensions.getExtension('ms-dotnettools.csharp')?.activate();
  readiness.csharpExtensionActivated = !!vscode.extensions.getExtension('ms-dotnettools.csharp')?.isActive || !!csharpExports;

  try {
    // The first restart makes the provider read the test user-data solution settings.
    await vscode.commands.executeCommand('dotnet.restartServer');
  } catch {
    // Some extension versions only register restart after activation completes.
  }

  await openCSharpProviderSolution(solutionUri);
  await waitForCSharpInitializationExport(csharpExports, readiness);
}

/** Awaits vscode-csharp's exported project initialization gate when this extension version exposes it. */
async function waitForCSharpInitializationExport(
  csharpExports: unknown,
  readiness: CSharpProviderReadinessState
): Promise<void> {
  const maybeExport = csharpExports as { initializationFinished?: () => Promise<void> } | undefined;
  if (typeof maybeExport?.initializationFinished !== 'function') {
    readiness.initializationFinishedExport = 'missing';
    return;
  }

  try {
    await maybeExport.initializationFinished();
    readiness.initializationFinishedExport = 'awaited';
  } catch (error) {
    readiness.initializationFinishedExport = 'failed';
    readiness.initializationFinishedError = error instanceof Error ? error.message : String(error);
  }
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
