import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runTests } from '@vscode/test-electron';

/**
 * Integration test runner.
 *
 * On Windows, @vscode/test-electron v2.x does not properly quote paths
 * with spaces when using shell:true. We use a directory junction at
 * C:\unity-plus-test as a workaround.
 */
const JUNCTION_PATH = 'C:\\unity-plus-test';
const PROJECT_ROOT = resolve(__dirname, '../..');

function getSafePath(relativePath: string): string {
  if (process.platform === 'win32' && existsSync(JUNCTION_PATH)) {
    return resolve(JUNCTION_PATH, relativePath);
  }
  return resolve(PROJECT_ROOT, relativePath);
}

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = getSafePath('');
    const extensionTestsPath = getSafePath('out/test/suite/index');
    const workspacePath = getSafePath('test-fixtures');

    console.log(`Extension path: ${extensionDevelopmentPath}`);
    console.log(`Tests path:     ${extensionTestsPath}`);

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspacePath,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } catch (error) {
    console.error('Failed to run integration tests:', error);
    process.exit(1);
  }
}

void main();
