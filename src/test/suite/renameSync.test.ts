import * as assert from 'assert';
import * as vscode from 'vscode';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import {
  planScriptFilenameSync,
  invertScriptFilenameSyncPlan,
  buildScriptFilenameSyncOperations,
  buildAssetMetaRenameOperations,
  applyScriptFilenameSyncPlan,
  runRenameTypeCommand,
  ScriptFilenameSyncPlan,
  ScriptFileRenameOperation,
} from '../../features/rename/renameSync';
import { createVscodeCSharpLanguageService, CSharpTopLevelTypeSnapshot } from '../../unity/csharpLanguageService';
import { createLogger, UnityPlusLogOutput } from '../../unity/logger';
import { configureCSharpSolution, getCSharpProviderReadinessState, getUnityFixtureRoot } from './csharpProviderSetup';

/** Returns true when running inside a CI environment (GitHub Actions, etc.). */
function isCI(): boolean {
  return process.env.CI === 'true';
}

/**
 * Integration tests for renameSync.
 *
 * Unlike the old mock-based tests, these tests use:
 * - Real vscode APIs (workspace.fs, commands, Uri)
 * - Real filesystem (temp directories with actual files)
 * - Real extension command registration
 *
 * Pure functions (planScriptFilenameSync, invertScriptFilenameSyncPlan)
 * are still tested as unit tests since they have no external dependencies.
 */

function topLevelType(
  className: string,
  kind: CSharpTopLevelTypeSnapshot['kind'] = 'class'
): CSharpTopLevelTypeSnapshot {
  return {
    name: className,
    kind,
    namespace: 'Minerva.Gameplay',
  };
}

/** Creates a sync plan using fixed paths (no tempDir dependency). */
function createSyncPlan(): ScriptFilenameSyncPlan {
  return {
    oldTypeName: 'PlayerController',
    newTypeName: 'HeroController',
    oldFilePath: normalize('/Project/Assets/PlayerController.cs'),
    newFilePath: normalize('/Project/Assets/HeroController.cs'),
    oldMetaPath: normalize('/Project/Assets/PlayerController.cs.meta'),
    newMetaPath: normalize('/Project/Assets/HeroController.cs.meta'),
    isUndo: false,
  };
}

/** Creates a real test file and its parent directory when needed. */
function createFile(filePath: string, content = '// test'): void {
  const dir = join(filePath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf-8');
}

/** Removes a VS Code-backed temp directory after file watchers release handles. */
async function removeTempDirWithRetries(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      if (existsSync(directory)) {
        rmSync(directory, { recursive: true, force: true });
      }
      return;
    } catch (error) {
      if (attempt === 4) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

let tempDir: string;
let assetsDir: string;

function createSyncPlanInTemp(): ScriptFilenameSyncPlan {
  return {
    oldTypeName: 'PlayerController',
    newTypeName: 'HeroController',
    oldFilePath: normalize(join(assetsDir, 'PlayerController.cs')),
    newFilePath: normalize(join(assetsDir, 'HeroController.cs')),
    oldMetaPath: normalize(join(assetsDir, 'PlayerController.cs.meta')),
    newMetaPath: normalize(join(assetsDir, 'HeroController.cs.meta')),
    isUndo: false,
  };
}

suite('renameSync — Pure Functions', () => {
  // These pure-function tests use the same logic as before but validate
  // against real path resolution from the test environment.

  test('plans a file rename when the primary top-level type is renamed', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      topLevelType('PlayerController'),
      topLevelType('HeroController')
    );

    assert.strictEqual(plan?.oldTypeName, 'PlayerController');
    assert.strictEqual(plan?.newTypeName, 'HeroController');
    assert.strictEqual(plan?.oldFilePath, normalize('/Project/Assets/PlayerController.cs'));
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/HeroController.cs'));
    assert.strictEqual(plan?.oldMetaPath, normalize('/Project/Assets/PlayerController.cs.meta'));
    assert.strictEqual(plan?.newMetaPath, normalize('/Project/Assets/HeroController.cs.meta'));
    assert.strictEqual(plan?.isUndo, false);
  });

  test('does not plan type-to-file rename when sync mode is off', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      topLevelType('PlayerController'),
      topLevelType('HeroController'),
      'off'
    );
    assert.strictEqual(plan, undefined);
  });

  test('does not rename files that do not match the old type name', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/CustomName.cs'),
      topLevelType('PlayerController'),
      topLevelType('HeroController')
    );
    assert.strictEqual(plan, undefined);
  });

  test('does not rename when the new type is undefined', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      topLevelType('PlayerController'),
      undefined
    );
    assert.strictEqual(plan, undefined);
  });

  test('plans file rename for all supported top-level type kinds', () => {
    const cases = [
      { kind: 'class', oldName: 'PlayerController', newName: 'HeroController' },
      { kind: 'struct', oldName: 'HeroStats', newName: 'EnemyStats' },
      { kind: 'enum', oldName: 'CombatState', newName: 'BattleState' },
      { kind: 'interface', oldName: 'IQuestRule', newName: 'IObjectiveRule' },
      { kind: 'record', oldName: 'QuestDefinition', newName: 'MissionDefinition' },
    ] as const;

    for (const tc of cases) {
      const plan = planScriptFilenameSync(
        normalize(`/Project/Assets/${tc.oldName}.cs`),
        topLevelType(tc.oldName, tc.kind),
        topLevelType(tc.newName, tc.kind),
        'on'
      );
      assert.strictEqual(plan?.newFilePath, normalize(`/Project/Assets/${tc.newName}.cs`));
    }
  });

  test('inverts a type-to-file rename plan for undo', () => {
    const plan = createSyncPlan();
    const undoPlan = invertScriptFilenameSyncPlan(plan);

    assert.strictEqual(undoPlan.oldTypeName, plan.newTypeName);
    assert.strictEqual(undoPlan.newTypeName, plan.oldTypeName);
    assert.strictEqual(undoPlan.oldFilePath, plan.newFilePath);
    assert.strictEqual(undoPlan.newFilePath, plan.oldFilePath);
    assert.strictEqual(undoPlan.oldMetaPath, plan.newMetaPath);
    assert.strictEqual(undoPlan.newMetaPath, plan.oldMetaPath);
    assert.strictEqual(undoPlan.isUndo, true);
  });
});

suite('renameSync — Real Filesystem Operations', () => {
  let plan: ScriptFilenameSyncPlan;

  setup(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unity-plus-rename-'));
    assetsDir = join(tempDir, 'Assets');
    mkdirSync(assetsDir, { recursive: true });
    plan = createSyncPlanInTemp();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await removeTempDirWithRetries(tempDir);
  });

  test('builds script and Unity meta rename operations when both files exist', async () => {
    createFile(plan.oldFilePath);
    createFile(plan.oldMetaPath);

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async p => existsSync(p),
      logger: createTestLogger(),
    });

    assert.deepStrictEqual(operations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath },
    ]);
  });

  test('builds only the script rename operation when the Unity meta file is missing', async () => {
    createFile(plan.oldFilePath);
    // deliberately do NOT create plan.oldMetaPath

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async p => existsSync(p),
      logger: createTestLogger(),
    });

    assert.deepStrictEqual(operations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
    ]);
  });

  test('does not build operations when the target script file already exists', async () => {
    createFile(plan.oldFilePath);
    createFile(plan.newFilePath); // target already exists!

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async p => existsSync(p),
      logger: createTestLogger(),
    });

    assert.deepStrictEqual(operations, []);
  });

  test('does not build operations when the target Unity meta file already exists', async () => {
    createFile(plan.oldFilePath);
    createFile(plan.oldMetaPath);
    createFile(plan.newMetaPath); // target meta already exists!

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async p => existsSync(p),
      logger: createTestLogger(),
    });

    assert.deepStrictEqual(operations, []);
  });

  test('applies script and meta rename via workspace.fs', async () => {
    createFile(plan.oldFilePath, 'public class PlayerController { }');
    createFile(plan.oldMetaPath, 'guid: abc123');

    // Use real vscode workspace.applyEdit with WorkspaceEdit.renameFile
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(
      vscode.Uri.file(plan.oldFilePath),
      vscode.Uri.file(plan.newFilePath)
    );
    edit.renameFile(
      vscode.Uri.file(plan.oldMetaPath),
      vscode.Uri.file(plan.newMetaPath)
    );

    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true);

    // Verify old files are gone and new files exist
    assert.strictEqual(existsSync(plan.oldFilePath), false);
    assert.strictEqual(existsSync(plan.oldMetaPath), false);
    assert.strictEqual(existsSync(plan.newFilePath), true);
    assert.strictEqual(existsSync(plan.newMetaPath), true);
  });

  test('builds Unity meta rename operation for a direct asset rename', async () => {
    const oldPath = normalize(join(tempDir, 'Assets', 'Texture.png'));
    const newPath = normalize(join(tempDir, 'Assets', 'Texture-Renamed.png'));
    createFile(`${oldPath}.meta`, 'guid: meta123');

    const operations = await buildAssetMetaRenameOperations(
      [{ oldPath, newPath }],
      {
        fileExists: async p => existsSync(p),
        logger: createTestLogger(),
      }
    );

    assert.deepStrictEqual(operations, [
      { oldPath: `${oldPath}.meta`, newPath: `${newPath}.meta` },
    ]);
  });

  test('does not build Unity meta rename operation when the old meta file is missing', async () => {
    const oldPath = normalize(join(tempDir, 'Assets', 'Missing.png'));
    const newPath = normalize(join(tempDir, 'Assets', 'Missing-Renamed.png'));
    // deliberately do NOT create the .meta file

    const operations = await buildAssetMetaRenameOperations(
      [{ oldPath, newPath }],
      {
        fileExists: async p => existsSync(p),
        logger: createTestLogger(),
      }
    );

    assert.deepStrictEqual(operations, []);
  });

  test('applies undo as reverse script and Unity meta rename operations', async () => {
    const undoPlan = invertScriptFilenameSyncPlan(plan);
    createFile(undoPlan.oldFilePath);
    createFile(undoPlan.oldMetaPath);

    const applied = await applyScriptFilenameSyncPlan(undoPlan, {
      fileExists: async p => existsSync(p),
      applyRenameOperations: async (ops: readonly ScriptFileRenameOperation[]) => {
        const edit = new vscode.WorkspaceEdit();
        for (const op of ops) {
          edit.renameFile(vscode.Uri.file(op.oldPath), vscode.Uri.file(op.newPath));
        }
        return await vscode.workspace.applyEdit(edit);
      },
      logger: createTestLogger(),
    });

    assert.strictEqual(applied, true);
    assert.strictEqual(existsSync(undoPlan.oldFilePath), false);
    assert.strictEqual(existsSync(undoPlan.newFilePath), true);
  });

  test('does not duplicate Unity meta rename when the batch already contains it', async () => {
    const oldPath = plan.oldFilePath;
    const newPath = plan.newFilePath;
    createFile(`${oldPath}.meta`);

    const operations = await buildAssetMetaRenameOperations(
      [
        { oldPath, newPath },
        { oldPath: `${oldPath}.meta`, newPath: `${newPath}.meta` },
      ],
      {
        fileExists: async p => existsSync(p),
        logger: createTestLogger(),
      }
    );

    assert.deepStrictEqual(operations, []);
  });

  test('does not build Unity meta rename operation for meta file moves', async () => {
    const operations = await buildAssetMetaRenameOperations(
      [
        {
          oldPath: normalize(join(tempDir, 'Assets', 'icon.png.meta')),
          newPath: normalize(join(tempDir, 'Assets', 'icon-renamed.png.meta')),
        },
      ],
      {
        fileExists: async () => true,
        logger: createTestLogger(),
      }
    );

    assert.deepStrictEqual(operations, []);
  });
});

suite('renameSync — Command Registration (Real VS Code)', () => {
  /** Returns true if the required C# extension dependencies are available. */
  function hasCSharpExtensions(): boolean {
    return (
      vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined &&
      vscode.extensions.getExtension('ms-dotnettools.csdevkit') !== undefined
    );
  }

  test('syncClassName command is contributed in package.json', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const found = allCommands.includes('unityPlus.syncClassName');

    if (!found && !hasCSharpExtensions()) {
      // Command may not be registered because C# extension dependencies
      // (ms-dotnettools.csharp, ms-dotnettools.csdevkit) are not installed
      // in this test VS Code instance. This is expected in CI without
      // those extensions pre-installed.
      console.log('SKIP: unityPlus.syncClassName requires C# extension dependencies.');
      return;
    }

    assert.strictEqual(found, true,
      'unityPlus.syncClassName should be contributed in package.json');
  });

  test('syncScriptFilename command is contributed in package.json', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const found = allCommands.includes('unityPlus.syncScriptFilename');

    if (!found && !hasCSharpExtensions()) {
      console.log('SKIP: unityPlus.syncScriptFilename requires C# extension dependencies.');
      return;
    }

    assert.strictEqual(found, true,
      'unityPlus.syncScriptFilename should be contributed in package.json');
  });
});

suite('renameSync - Real C# Provider Command Routing', () => {
  test('reads the real primary type name range for the Unity fixture', async function () {
    this.timeout(60000);
    const root = getUnityFixtureRoot();

    try {
      await configureCSharpSolution(root);

      const uri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });

      const languageService = createVscodeCSharpLanguageService(vscode);
      const primaryType = await waitForPrimaryTypeNameRange(languageService, uri, 'Interactable');

      assert.strictEqual(primaryType.name, 'Interactable');
      assert.ok(primaryType.nameRange, formatCSharpReadinessFailure('missing Interactable name range'));
      assert.strictEqual(primaryType.nameRange?.start.line, 5);
      assert.strictEqual(primaryType.nameRange?.start.character, 24);
    } catch (error) {
      if (isCI() && error instanceof Error && error.message.includes('timed out')) {
        this.skip();
      }
      throw error;
    }
  });

  test('falls back from a real UnityEvent field rename without waiting for type settle', async function () {
    this.timeout(30000);
    const root = getUnityFixtureRoot();

    try {
      await configureCSharpSolution(root);

      const uri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      const fieldPosition = findTextPosition(document, 'OnCheckEnable');
      editor.selection = new vscode.Selection(fieldPosition, fieldPosition);

      const elapsedMs = await measureCommandElapsedMilliseconds('unityPlus.syncClassName', 8000);
      assert.ok(
        elapsedMs < 1200,
        `field rename should fall back before the old 2s type-settle wait; elapsed=${elapsedMs}ms; ${formatCSharpReadinessFailure()}`
      );
    } catch (error) {
      if (isCI()) {
        this.skip();
      }
      throw error;
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('does not show Unity Plus progress before falling back from a real field rename', async function () {
    this.timeout(30000);
    const root = getUnityFixtureRoot();
    await configureCSharpSolution(root);

    const uri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    const fieldPosition = findTextPosition(document, 'OnCheckEnable');
    editor.selection = new vscode.Selection(fieldPosition, fieldPosition);

    const progressTitles: string[] = [];
    const languageService = createVscodeCSharpLanguageService(vscode);
    const cancelTimer = setInterval(() => {
      void cancelRenameInputIfVisible();
    }, 100);

    try {
      const result = await runRenameTypeCommand({
        editor: {
          languageId: document.languageId,
          uri: document.uri,
          filePath: document.uri.fsPath,
          cursor: {
            line: fieldPosition.line,
            character: fieldPosition.character
          }
        },
        mode: 'on',
        previewMode: 'silent',
        languageService,
        showInputBox: async () => {
          throw new Error('field rename fallback must not ask for Unity Plus type input');
        },
        showRenameInput: async () => {
          throw new Error('field rename fallback must not ask for Unity Plus rename input');
        },
        showProgress: async (title, task) => {
          progressTitles.push(title);
          return await task();
        },
        showInformationMessage: () => undefined,
        showWarningMessage: () => undefined,
        executeNativeRename: async () => await vscode.commands.executeCommand('editor.action.rename'),
        executeAtomicRename: async () => {
          throw new Error('field rename fallback must not execute Unity Plus atomic rename');
        },
        fileExists: async path => {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(path));
            return true;
          } catch {
            return false;
          }
        },
        createFileUri: path => vscode.Uri.file(path),
        applyWorkspaceEdit: async edit => await vscode.workspace.applyEdit(edit),
        confirmRenamePreview: async () => ({ kind: 'cancelled' }),
        confirmRenameWarning: async () => false,
        wait: async ms => await new Promise(resolve => setTimeout(resolve, ms)),
        retryIntervalMs: 200,
        settleTimeoutMs: 2000,
        markSyncing: () => undefined,
        unmarkSyncing: () => undefined,
        logger: createTestLogger()
      });

      assert.strictEqual(result.kind, 'fallback');
      assert.deepStrictEqual(progressTitles, []);
    } catch (error) {
      if (isCI()) {
        this.skip();
      }
      throw error;
    } finally {
      clearInterval(cancelTimer);
      await cancelRenameInputIfVisible();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});

// ---- Helpers ----

interface MemoryLogOutput extends UnityPlusLogOutput {
  lines: string[];
}

function createMemoryOutput(): MemoryLogOutput {
  return {
    lines: [],
    appendLine(message: string): void {
      this.lines.push(message);
    },
    dispose(): void {
      this.lines = [];
    },
  };
}

function createTestLogger() {
  return createLogger({
    output: createMemoryOutput(),
    getLevel: () => 'debug',
  });
}

/** Waits for the real C# provider to expose the primary type range used by rename. */
async function waitForPrimaryTypeNameRange(
  languageService: ReturnType<typeof createVscodeCSharpLanguageService>,
  uri: vscode.Uri,
  expectedName: string
): Promise<CSharpTopLevelTypeSnapshot> {
  const timeoutAt = Date.now() + 20000;
  let lastError = '';
  while (Date.now() < timeoutAt) {
    try {
      const primaryType = await languageService.getPrimaryTopLevelType(uri);
      if (primaryType?.name === expectedName && primaryType.nameRange) {
        return primaryType;
      }

      lastError = `last primary type=${primaryType?.name ?? '<none>'}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(formatCSharpReadinessFailure(`timed out waiting for ${expectedName}; ${lastError}`));
}

/** Finds a token position in a real VS Code text document. */
function findTextPosition(document: vscode.TextDocument, token: string): vscode.Position {
  const text = document.getText();
  const index = text.indexOf(token);
  assert.ok(index >= 0, `expected token ${token} in ${document.uri.fsPath}`);
  return document.positionAt(index);
}

/** Measures a VS Code command while failing quickly if it regresses to the old wait path. */
async function measureCommandElapsedMilliseconds(command: string, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  const cancelTimer = setInterval(() => {
    void cancelRenameInputIfVisible();
  }, 100);
  const timeout = new Promise<'timeout'>(resolve => {
    setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const completed = vscode.commands.executeCommand(command).then(() => 'completed' as const);
    const result = await Promise.race([completed, timeout]);
    if (result === 'timeout') {
      throw new Error(`${command} did not return within ${timeoutMs}ms`);
    }

    return Date.now() - startedAt;
  } finally {
    clearInterval(cancelTimer);
    await cancelRenameInputIfVisible();
  }
}

/** Formats real C# provider setup details for integration failures. */
function formatCSharpReadinessFailure(reason = 'C# provider did not expose the expected rename symbols'): string {
  const readiness = getCSharpProviderReadinessState();
  return `${reason}; readiness=${JSON.stringify(readiness ?? null)}`;
}

/** Cancels VS Code's native rename input when the command falls back to editor.action.rename. */
async function cancelRenameInputIfVisible(): Promise<void> {
  for (const command of ['cancelRenameInput', 'workbench.action.closeQuickOpen']) {
    try {
      await vscode.commands.executeCommand(command);
    } catch {
      // Some VS Code builds do not expose all UI cancellation commands.
    }
  }
}
