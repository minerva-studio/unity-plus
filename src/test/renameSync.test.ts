import * as assert from 'assert';
import { normalize } from 'node:path';
import { applyScriptFilenameSyncPlan, invertScriptFilenameSyncPlan, planScriptFilenameSync, ScriptFilenameSyncPlan } from '../features/rename/renameSync';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';

describe('renameSync', () => {
  it('plans a file rename when the primary Unity class is renamed', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityScript('PlayerController'),
      unityScript('HeroController')
    );

    assert.strictEqual(plan?.oldClassName, 'PlayerController');
    assert.strictEqual(plan?.newClassName, 'HeroController');
    assert.strictEqual(plan?.oldFilePath, normalize('/Project/Assets/PlayerController.cs'));
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/HeroController.cs'));
    assert.strictEqual(plan?.oldMetaPath, normalize('/Project/Assets/PlayerController.cs.meta'));
    assert.strictEqual(plan?.newMetaPath, normalize('/Project/Assets/HeroController.cs.meta'));
    assert.strictEqual(plan?.isUndo, false);
  });

  it('does not rename files that do not match the old class name', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/CustomName.cs'),
      unityScript('PlayerController'),
      unityScript('HeroController')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the file has multiple Unity primary classes', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      [
        'public class PlayerController : MonoBehaviour { }',
        'public class EnemyController : MonoBehaviour { }'
      ].join('\n'),
      [
        'public class HeroController : MonoBehaviour { }',
        'public class EnemyController : MonoBehaviour { }'
      ].join('\n')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the detected Unity type changes kind', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      'public class PlayerController : MonoBehaviour { }',
      'public class HeroController : ScriptableObject { }'
    );

    assert.strictEqual(plan, undefined);
  });

  it('renames the matching Unity meta file when it exists', async () => {
    const renames: string[] = [];
    const plan = createSyncPlan();

    await applyScriptFilenameSyncPlan(plan, {
      fileExists: async path => path === plan.oldMetaPath,
      renameFile: async (oldPath, newPath) => {
        renames.push(`${oldPath}->${newPath}`);
      },
      logger: createTestLogger()
    });

    assert.deepStrictEqual(renames, [
      `${plan.oldFilePath}->${plan.newFilePath}`,
      `${plan.oldMetaPath}->${plan.newMetaPath}`
    ]);
  });

  it('keeps the script rename when the Unity meta file is missing', async () => {
    const output = createMemoryOutput();
    const renames: string[] = [];
    const plan = createSyncPlan();

    await applyScriptFilenameSyncPlan(plan, {
      fileExists: async () => false,
      renameFile: async (oldPath, newPath) => {
        renames.push(`${oldPath}->${newPath}`);
      },
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(renames, [
      `${plan.oldFilePath}->${plan.newFilePath}`
    ]);
    assert.strictEqual(output.lines.some(line => line.includes('Unity script meta file was not found')), true);
  });

  it('inverts a class-to-file rename plan for undo', () => {
    const plan = createSyncPlan();
    const undoPlan = invertScriptFilenameSyncPlan(plan);

    assert.strictEqual(undoPlan.oldClassName, plan.newClassName);
    assert.strictEqual(undoPlan.newClassName, plan.oldClassName);
    assert.strictEqual(undoPlan.oldFilePath, plan.newFilePath);
    assert.strictEqual(undoPlan.newFilePath, plan.oldFilePath);
    assert.strictEqual(undoPlan.oldMetaPath, plan.newMetaPath);
    assert.strictEqual(undoPlan.newMetaPath, plan.oldMetaPath);
    assert.strictEqual(undoPlan.isUndo, true);
  });

  it('plans undo from the last applied class-to-file rename', () => {
    const previousPlan = createSyncPlan();
    const undoPlan = planScriptFilenameSync(
      previousPlan.newFilePath,
      unityScript(previousPlan.newClassName),
      unityScript(previousPlan.oldClassName),
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.oldMetaPath, previousPlan.newMetaPath);
    assert.strictEqual(undoPlan?.newMetaPath, previousPlan.oldMetaPath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });
});

function unityScript(className: string): string {
  return `namespace Minerva.Gameplay { public class ${className} : MonoBehaviour { } }`;
}

function createSyncPlan(): ScriptFilenameSyncPlan {
  return {
    oldClassName: 'PlayerController',
    newClassName: 'HeroController',
    oldFilePath: normalize('/Project/Assets/PlayerController.cs'),
    newFilePath: normalize('/Project/Assets/HeroController.cs'),
    oldMetaPath: normalize('/Project/Assets/PlayerController.cs.meta'),
    newMetaPath: normalize('/Project/Assets/HeroController.cs.meta'),
    isUndo: false
  };
}

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
    }
  };
}

function createTestLogger() {
  return createLogger({
    output: createMemoryOutput(),
    getLevel: () => 'debug'
  });
}
