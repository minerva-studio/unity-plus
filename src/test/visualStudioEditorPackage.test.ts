import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  checkUnityVisualStudioEditorPackage,
  missingVisualStudioEditorPackageMessage
} from '../unity/visualStudioEditorPackage';
import type { UnityPlusLogger } from '../unity/logger';

describe('Unity Visual Studio Editor package check', () => {
  it('does not warn when the Unity package manifest contains the Visual Studio Editor package', async () => {
    const warnings: string[] = [];
    const result = await checkUnityVisualStudioEditorPackage(createUri('/Project'), {
      runtimeVscode: createVscodeRuntime({
        manifest: {
          dependencies: {
            'com.unity.ide.visualstudio': '2.0.22'
          }
        },
        warnings
      }),
      logger: createLogger()
    });

    assert.strictEqual(result, true);
    assert.deepStrictEqual(warnings, []);
  });

  it('warns when the Unity package manifest does not contain the Visual Studio Editor package', async () => {
    const warnings: string[] = [];
    const loggerWarnings: string[] = [];
    const result = await checkUnityVisualStudioEditorPackage(createUri('/Project'), {
      runtimeVscode: createVscodeRuntime({
        manifest: {
          dependencies: {
            'com.unity.textmeshpro': '3.0.9'
          }
        },
        warnings
      }),
      logger: createLogger(loggerWarnings)
    });

    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, [missingVisualStudioEditorPackageMessage]);
    assert.deepStrictEqual(loggerWarnings, [missingVisualStudioEditorPackageMessage]);
  });

  it('does not throw when the Unity package manifest cannot be read', async () => {
    const warnings: string[] = [];
    const loggerWarnings: string[] = [];
    const result = await checkUnityVisualStudioEditorPackage(createUri('/Project'), {
      runtimeVscode: createVscodeRuntime({
        readError: new Error('file not found'),
        warnings
      }),
      logger: createLogger(loggerWarnings)
    });

    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(loggerWarnings.length, 1);
    assert.ok(loggerWarnings[0].includes('Could not check Unity Visual Studio Editor package'));
  });

  it('does not throw when the Unity package manifest is invalid JSON', async () => {
    const warnings: string[] = [];
    const loggerWarnings: string[] = [];
    const result = await checkUnityVisualStudioEditorPackage(createUri('/Project'), {
      runtimeVscode: createVscodeRuntime({
        manifestText: '{ invalid json',
        warnings
      }),
      logger: createLogger(loggerWarnings)
    });

    assert.strictEqual(result, false);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(loggerWarnings.length, 1);
    assert.ok(loggerWarnings[0].includes('Could not check Unity Visual Studio Editor package'));
  });
});

interface VscodeRuntimeOptions {
  manifest?: unknown;
  manifestText?: string;
  readError?: Error;
  warnings: string[];
}

function createVscodeRuntime(options: VscodeRuntimeOptions): typeof vscode {
  return {
    Uri: {
      joinPath: (root: vscode.Uri, ...segments: string[]) => createUri([root.fsPath, ...segments].join('/'))
    },
    workspace: {
      fs: {
        readFile: async () => {
          if (options.readError) {
            throw options.readError;
          }

          // Tests pass either raw invalid JSON or a serializable manifest shape.
          const content = options.manifestText ?? JSON.stringify(options.manifest ?? {});
          return Buffer.from(content, 'utf8');
        }
      }
    },
    window: {
      showWarningMessage: (message: string) => {
        options.warnings.push(message);
        return Promise.resolve(undefined);
      }
    },
    l10n: {
      t: (message: string) => message
    }
  } as unknown as typeof vscode;
}

function createLogger(warnings: string[] = []): UnityPlusLogger {
  return {
    info: () => undefined,
    warn: message => warnings.push(message),
    error: () => undefined,
    debug: () => undefined,
    dispose: () => undefined
  };
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}
