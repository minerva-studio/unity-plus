import * as assert from 'assert';
import { normalize } from 'node:path';
import { applyScriptFilenameSyncPlan, buildScriptFilenameSyncOperations, buildScriptMetaRenameOperations, invertScriptFilenameSyncPlan, planScriptFilenameSync, ScriptFilenameSyncPlan } from '../features/rename/renameSync';
import { CSharpClassSnapshot } from '../unity/csharpLanguageService';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';

describe('renameSync', () => {
  it('plans a file rename when the primary Unity class is renamed', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityClass('PlayerController'),
      unityClass('HeroController')
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
      unityClass('PlayerController'),
      unityClass('HeroController'),
      'off'
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not plan ordinary C# class rename in unity-object mode', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryClass('PlainUtility'),
      ordinaryClass('RenamedUtility'),
      'unity-object'
    );

    assert.strictEqual(plan, undefined);
  });

  it('plans ordinary C# class rename in any mode', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryClass('PlainUtility'),
      ordinaryClass('RenamedUtility'),
      'any'
    );

    assert.strictEqual(plan?.oldClassName, 'PlainUtility');
    assert.strictEqual(plan?.newClassName, 'RenamedUtility');
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/RenamedUtility.cs'));
  });

  it('does not plan ordinary C# class rename in any mode when the provider cannot return one primary class', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryClass('PlainUtility'),
      undefined,
      'any'
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename files that do not match the old class name', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/CustomName.cs'),
      unityClass('PlayerController'),
      unityClass('HeroController')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the provider cannot return one Unity primary class', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityClass('PlayerController'),
      undefined
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename in unity-object mode when the current class is not a Unity object', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityClass('PlayerController'),
      ordinaryClass('HeroController')
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

  it('builds Unity meta rename operation for a direct C# file rename', async () => {
    const oldPath = normalize('/Project/Assets/PlayerController.cs');
    const newPath = normalize('/Project/Assets/HeroController.cs');

    const operations = await buildScriptMetaRenameOperations([{
      oldPath,
      newPath
    }], {
      fileExists: async path => path === `${oldPath}.meta`,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(operations, [{
      oldPath: `${oldPath}.meta`,
      newPath: `${newPath}.meta`
    }]);
  });

  it('does not build Unity meta rename operation when the old meta file is missing', async () => {
    const output = createMemoryOutput();
    const operations = await buildScriptMetaRenameOperations([{
      oldPath: normalize('/Project/Assets/PlayerController.cs'),
      newPath: normalize('/Project/Assets/HeroController.cs')
    }], {
      fileExists: async () => false,
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(operations, []);
    assert.strictEqual(output.lines.some(line => line.includes('Unity script meta file was not found')), true);
  });

  it('does not build Unity meta rename operation when the target meta file already exists', async () => {
    const output = createMemoryOutput();
    const oldPath = normalize('/Project/Assets/PlayerController.cs');
    const newPath = normalize('/Project/Assets/HeroController.cs');

    const operations = await buildScriptMetaRenameOperations([{
      oldPath,
      newPath
    }], {
      fileExists: async path => path === `${oldPath}.meta` || path === `${newPath}.meta`,
      logger: createLogger({
        output,
        getLevel: () => 'debug'
      })
    });

    assert.deepStrictEqual(operations, []);
    assert.strictEqual(output.lines.some(line => line.includes('HeroController.cs.meta already exists')), true);
  });

  it('does not duplicate Unity meta rename when the same rename batch already contains it', async () => {
    const oldPath = normalize('/Project/Assets/PlayerController.cs');
    const newPath = normalize('/Project/Assets/HeroController.cs');

    const operations = await buildScriptMetaRenameOperations([
      {
        oldPath,
        newPath
      },
      {
        oldPath: `${oldPath}.meta`,
        newPath: `${newPath}.meta`
      }
    ], {
      fileExists: async path => path === `${oldPath}.meta`,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(operations, []);
  });

  it('does not build Unity meta rename operation for non-C# file moves', async () => {
    const operations = await buildScriptMetaRenameOperations([{
      oldPath: normalize('/Project/Assets/icon.png'),
      newPath: normalize('/Project/Assets/icon-renamed.png')
    }], {
      fileExists: async () => true,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(operations, []);
  });

  it('does not add extra Unity meta rename operation for a class sync batch that already moves meta', async () => {
    const plan = createSyncPlan();
    const classSyncOperations = await buildScriptFilenameSyncOperations(plan, {
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      logger: createTestLogger()
    });

    const metaOperations = await buildScriptMetaRenameOperations(classSyncOperations, {
      fileExists: async path => path === plan.oldMetaPath,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(metaOperations, []);
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
      unityClass(previousPlan.newClassName),
      unityClass(previousPlan.oldClassName),
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
      ordinaryClass(previousPlan.newClassName),
      ordinaryClass(previousPlan.oldClassName),
      'any',
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });
});

function unityClass(className: string): CSharpClassSnapshot {
  return {
    name: className,
    namespace: 'Minerva.Gameplay',
    isUnityObject: true
  };
}

function ordinaryClass(className: string): CSharpClassSnapshot {
  return {
    name: className,
    namespace: 'Minerva.Tools',
    isUnityObject: false
  };
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
