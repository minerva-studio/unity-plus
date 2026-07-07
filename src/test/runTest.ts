import { resolve } from 'node:path';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';

/**
 * Integration test runner.
 *
 * On Windows, @vscode/test-electron v2.x does not properly quote paths
 * with spaces when using shell:true. We use a directory junction at
 * C:\unity-plus-test as a workaround.
 */
const JUNCTION_PATH = 'C:\\unity-plus-test';
const WINDOWS_VSCODE_TEST_CACHE_PATH = 'C:\\unity-plus-vscode-test';
const PROJECT_ROOT = resolve(__dirname, '../..');
const EXTENSION_DEPENDENCIES = [
  'ms-dotnettools.csdevkit',
  'ms-dotnettools.csharp'
];

function getSafePath(relativePath: string): string {
  if (process.platform === 'win32' && existsSync(JUNCTION_PATH)) {
    return resolve(JUNCTION_PATH, relativePath);
  }
  return resolve(PROJECT_ROOT, relativePath);
}

/** Returns a physical no-space cache path for the downloaded VS Code test app. */
function getSafeVSCodeTestCachePath(): string {
  return process.platform === 'win32'
    ? WINDOWS_VSCODE_TEST_CACHE_PATH
    : resolve(PROJECT_ROOT, '.vscode-test');
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = getSafePath('');
    const extensionTestsPath = getSafePath('out/test/suite/index');
    const workspacePath = getSafePath('test-fixtures');
    const vscodeTestCachePath = getSafeVSCodeTestCachePath();
    const userDataDir = mkdtempSync(resolve(tmpdir(), 'unity-plus-vscode-user-data-'));
    writeIntegrationUserSettings(userDataDir, workspacePath);

    console.log(`Extension path: ${extensionDevelopmentPath}`);
    console.log(`Tests path:     ${extensionTestsPath}`);

    await installExtensionDependencies(vscodeTestCachePath);

    await runTests({
      cachePath: vscodeTestCachePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        `--user-data-dir=${userDataDir}`,
        `--folder-uri=${pathToFileURL(workspacePath).toString()}`,
        '--new-window',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--skip-add-to-recently-opened',
      ],
    });
  } catch (error) {
    console.error('Failed to run integration tests:', error);
    process.exit(1);
  }
}

/** Writes VS Code user settings before C# providers activate in the test profile. */
function writeIntegrationUserSettings(userDataDir: string, workspacePath: string): void {
  const userSettingsDir = resolve(userDataDir, 'User');
  mkdirSync(userSettingsDir, { recursive: true });
  writeFileSync(resolve(userSettingsDir, 'settings.json'), JSON.stringify({
    'dotnet.defaultSolution': resolve(workspacePath, 'UnityEventFixture.sln'),
    'dotnet.projects.enableFileBasedPrograms': false,
    'unityPlus.rename.classFileSyncMode': 'on',
    'unityPlus.rename.previewMode': 'silent',
    'unityPlus.metaFiles.moveWithAsset': true,
    'unityPlus.logging.level': 'debug'
  }, null, 2), 'utf-8');
}

/** Installs required marketplace dependencies into the isolated VS Code test profile. */
async function installExtensionDependencies(cachePath: string): Promise<void> {
  for (const extensionId of EXTENSION_DEPENDENCIES) {
    console.log(`Installing test dependency: ${extensionId}`);
    await runVSCodeCommand(['--install-extension', extensionId], { cachePath });
  }
}

void main();
