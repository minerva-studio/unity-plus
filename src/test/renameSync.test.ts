import * as assert from 'assert';
import { normalize } from 'node:path';
import { applyScriptFilenameSyncPlan, buildScriptFilenameSyncOperations, invertScriptFilenameSyncPlan, planScriptFilenameSync, ScriptFilenameSyncPlan } from '../features/rename/renameSync';
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

  it('does not plan class-to-file rename when sync mode is off', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityScript('PlayerController'),
      unityScript('HeroController'),
      'off'
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not plan ordinary C# class rename in unity-object mode', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryScript('PlainUtility'),
      ordinaryScript('RenamedUtility'),
      'unity-object'
    );

    assert.strictEqual(plan, undefined);
  });

  it('plans ordinary C# class rename in any mode', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryScript('PlainUtility'),
      ordinaryScript('RenamedUtility'),
      'any'
    );

    assert.strictEqual(plan?.oldClassName, 'PlainUtility');
    assert.strictEqual(plan?.newClassName, 'RenamedUtility');
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/RenamedUtility.cs'));
  });

  it('does not plan ordinary C# class rename in any mode for multi-class files', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      [
        'public class PlainUtility { }',
        'public class OtherUtility { }'
      ].join('\n'),
      [
        'public class RenamedUtility { }',
        'public class OtherUtility { }'
      ].join('\n'),
      'any'
    );

    assert.strictEqual(plan, undefined);
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

  it('builds script and Unity meta rename operations when both files exist', async () => {
    const plan = createSyncPlan();

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(operations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
  });

  it('builds only the script rename operation when the Unity meta file is missing', async () => {
    const output = createMemoryOutput();
    const plan = createSyncPlan();

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async path => path === plan.oldFilePath,
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(operations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath }
    ]);
    assert.strictEqual(output.lines.some(line => line.includes('Unity script meta file was not found')), true);
  });

  it('does not build operations when the target script file already exists', async () => {
    const output = createMemoryOutput();
    const plan = createSyncPlan();

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.newFilePath,
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(operations, []);
    assert.strictEqual(output.lines.some(line => line.includes('HeroController.cs already exists')), true);
  });

  it('does not build operations when the target Unity meta file already exists', async () => {
    const output = createMemoryOutput();
    const plan = createSyncPlan();

    const operations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath || path === plan.newMetaPath,
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(operations, []);
    assert.strictEqual(output.lines.some(line => line.includes('HeroController.cs.meta already exists')), true);
  });

  it('returns false when rename operations cannot be applied', async () => {
    const plan = createSyncPlan();

    const applied = await applyScriptFilenameSyncPlan(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      applyRenameOperations: async () => false,
      logger: createTestLogger()
    });

    assert.strictEqual(applied, false);
  });

  it('applies undo as reverse script and Unity meta rename operations', async () => {
    const plan = invertScriptFilenameSyncPlan(createSyncPlan());
    const appliedOperations: unknown[] = [];

    const applied = await applyScriptFilenameSyncPlan(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      applyRenameOperations: async operations => {
        appliedOperations.push(...operations);
        return true;
      },
      logger: createTestLogger()
    });

    assert.strictEqual(applied, true);
    assert.deepStrictEqual(appliedOperations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
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
      'unity-object',
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.oldMetaPath, previousPlan.newMetaPath);
    assert.strictEqual(undoPlan?.newMetaPath, previousPlan.oldMetaPath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });

  it('plans undo for ordinary C# class rename in any mode', () => {
    const previousPlan: ScriptFilenameSyncPlan = {
      oldClassName: 'PlainUtility',
      newClassName: 'RenamedUtility',
      oldFilePath: normalize('/Project/Assets/PlainUtility.cs'),
      newFilePath: normalize('/Project/Assets/RenamedUtility.cs'),
      oldMetaPath: normalize('/Project/Assets/PlainUtility.cs.meta'),
      newMetaPath: normalize('/Project/Assets/RenamedUtility.cs.meta'),
      isUndo: false
    };
    const undoPlan = planScriptFilenameSync(
      previousPlan.newFilePath,
      ordinaryScript(previousPlan.newClassName),
      ordinaryScript(previousPlan.oldClassName),
      'any',
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });
});

function unityScript(className: string): string {
  return `namespace Minerva.Gameplay { public class ${className} : MonoBehaviour { } }`;
}

function ordinaryScript(className: string): string {
  return `namespace Minerva.Tools { public class ${className} { } }`;
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
