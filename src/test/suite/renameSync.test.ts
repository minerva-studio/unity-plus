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
  ScriptFilenameSyncPlan,
  ScriptFileRenameOperation,
} from '../../features/rename/renameSync';
import { CSharpTopLevelTypeSnapshot } from '../../unity/csharpLanguageService';
import { createLogger, UnityPlusLogOutput } from '../../unity/logger';

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
