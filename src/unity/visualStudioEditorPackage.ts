import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import type { UnityPlusLogger } from './logger';

export const visualStudioEditorPackageName = 'com.unity.ide.visualstudio';
export const missingVisualStudioEditorPackageMessage =
  'Unity Plus: Install the Unity Visual Studio Editor package (com.unity.ide.visualstudio) in this Unity project.';

export interface UnityPackageManifestRuntime {
  runtimeVscode?: typeof vscode;
  logger: UnityPlusLogger;
}

interface UnityPackageManifest {
  dependencies?: Record<string, unknown>;
}

export async function checkUnityVisualStudioEditorPackage(
  root: vscode.Uri,
  options: UnityPackageManifestRuntime
): Promise<boolean> {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const manifestUri = runtimeVscode.Uri.joinPath(root, 'Packages', 'manifest.json');

  try {
    const manifest = await readUnityPackageManifest(runtimeVscode, manifestUri);
    const hasPackage = Object.prototype.hasOwnProperty.call(
      manifest.dependencies ?? {},
      visualStudioEditorPackageName
    );

    if (!hasPackage) {
      const message = runtimeVscode.l10n.t(missingVisualStudioEditorPackageMessage);
      options.logger.warn(message);
      void runtimeVscode.window.showWarningMessage(message);
    }

    return hasPackage;
  } catch (error) {
    // Package checks should never block extension activation or Unity workspace rescans.
    options.logger.warn(`Could not check Unity Visual Studio Editor package: ${errorMessage(error)}`);
    return false;
  }
}

async function readUnityPackageManifest(
  runtimeVscode: typeof vscode,
  manifestUri: vscode.Uri
): Promise<UnityPackageManifest> {
  const content = await runtimeVscode.workspace.fs.readFile(manifestUri);
  const manifest = JSON.parse(Buffer.from(content).toString('utf8')) as unknown;

  return isUnityPackageManifest(manifest) ? manifest : {};
}

function isUnityPackageManifest(value: unknown): value is UnityPackageManifest {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const dependencies = (value as UnityPackageManifest).dependencies;
  return dependencies === undefined || (dependencies !== null && typeof dependencies === 'object');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
