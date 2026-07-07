import { resolve } from 'node:path';
import Mocha from 'mocha';

/**
 * Integration test suite entry point.
 *
 * This file is loaded inside the VS Code Extension Host.
 * All vscode.* APIs are fully available and real.
 *
 * The test runner (runTest.ts) launches VS Code with this extension
 * and executes this file. Mocha discovers and runs all *.test.js files.
 */

export async function run(): Promise<void> {
  const testsRoot = resolve(__dirname);

  // Create Mocha instance with TDD interface (suite/test)
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 30000,
    reporter: 'spec',
  });

  // Register all test files
  mocha.addFile(resolve(testsRoot, 'renameSync.test.js'));
  mocha.addFile(resolve(testsRoot, 'activation.test.js'));
  mocha.addFile(resolve(testsRoot, 'metaFiles.test.js'));
  mocha.addFile(resolve(testsRoot, 'projectSync.test.js'));

  return new Promise<void>((resolvePromise, reject) => {
    mocha.run(failures => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolvePromise();
      }
    });
  });
}
