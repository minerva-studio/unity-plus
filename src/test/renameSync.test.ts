import * as assert from 'assert';
import { normalize } from 'node:path';
import { applyScriptFilenameSyncPlan, buildScriptFilenameSyncOperations, buildScriptMetaRenameOperations, invertScriptFilenameSyncPlan, planScriptFilenameSync, ScriptFilenameSyncPlan, syncScriptRenameAfterClassChange } from '../features/rename/renameSync';
import { CSharpClassSnapshot, CSharpLanguageService } from '../unity/csharpLanguageService';
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

  it('syncs class rename through progress and shows success message', async () => {
    const plan = createSyncPlan();
    const progressTitles: string[] = [];
    const messages: string[] = [];
    const appliedOperations: unknown[] = [];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'unity-object',
      oldClass: unityClass(plan.oldClassName),
      languageService: createFakeLanguageService(unityClass(plan.newClassName)),
      operations: {
        fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
        applyRenameOperations: async operations => {
          appliedOperations.push(...operations);
          return true;
        },
        logger: createTestLogger()
      },
      showProgress: async (title, task) => {
        progressTitles.push(title);
        return await task();
      },
      showInformationMessage: message => messages.push(message),
      showWarningMessage: () => undefined,
      wait: async () => undefined,
      debounceMs: 400,
      retryIntervalMs: 200,
      settleTimeoutMs: 2000,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(progressTitles, ['Unity Plus: Syncing script rename...']);
    assert.deepStrictEqual(appliedOperations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
    assert.strictEqual(messages[0], 'Unity Plus: Renamed PlayerController.cs -> HeroController.cs');
    assert.strictEqual(result.appliedPlan?.newClassName, plan.newClassName);
  });

  it('waits before reading the C# language service for class rename sync', async () => {
    const waited: number[] = [];
    const plan = createSyncPlan();

    await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'unity-object',
      oldClass: unityClass(plan.oldClassName),
      languageService: createFakeLanguageService(unityClass(plan.newClassName)),
      operations: {
        fileExists: async () => true,
        applyRenameOperations: async () => true,
        logger: createTestLogger()
      },
      showProgress: async (_title, task) => await task(),
      showInformationMessage: () => undefined,
      showWarningMessage: () => undefined,
      wait: async ms => {
        waited.push(ms);
      },
      debounceMs: 450,
      retryIntervalMs: 200,
      settleTimeoutMs: 2000,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(waited, [450]);
  });

  it('retries class snapshot reads until the C# language service reports the renamed class', async () => {
    const waited: number[] = [];
    const plan = createSyncPlan();
    const classes = [
      unityClass(plan.oldClassName),
      unityClass(plan.newClassName)
    ];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'unity-object',
      oldClass: unityClass(plan.oldClassName),
      languageService: createSequenceLanguageService(classes),
      operations: {
        fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
        applyRenameOperations: async () => true,
        logger: createTestLogger()
      },
      showProgress: async (_title, task) => await task(),
      showInformationMessage: () => undefined,
      showWarningMessage: () => undefined,
      wait: async ms => {
        waited.push(ms);
      },
      debounceMs: 400,
      retryIntervalMs: 200,
      settleTimeoutMs: 2000,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(waited, [400, 200]);
    assert.strictEqual(result.appliedPlan?.newClassName, plan.newClassName);
  });

  it('does not show progress when class rename sync has no plan', async () => {
    const plan = createSyncPlan();
    const progressTitles: string[] = [];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'unity-object',
      oldClass: unityClass(plan.oldClassName),
      languageService: createFakeLanguageService(unityClass(plan.oldClassName)),
      operations: {
        fileExists: async () => true,
        applyRenameOperations: async () => true,
        logger: createTestLogger()
      },
      showProgress: async (title, task) => {
        progressTitles.push(title);
        return await task();
      },
      showInformationMessage: () => undefined,
      showWarningMessage: () => undefined,
      wait: async () => undefined,
      debounceMs: 400,
      retryIntervalMs: 200,
      settleTimeoutMs: 2000,
      logger: createTestLogger()
    });

    assert.deepStrictEqual(progressTitles, []);
    assert.strictEqual(result.appliedPlan, undefined);
  });

  it('warns when class rename sync apply path returns false', async () => {
    const plan = createSyncPlan();
    const output = createMemoryOutput();
    const logger = createLogger({
      output,
      getLevel: () => 'debug'
    });
    const warnings: string[] = [];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'unity-object',
      oldClass: unityClass(plan.oldClassName),
      languageService: createFakeLanguageService(unityClass(plan.newClassName)),
      operations: {
        fileExists: async path => path === plan.oldFilePath || path === plan.newFilePath,
        applyRenameOperations: async () => true,
        logger
      },
      showProgress: async (_title, task) => await task(),
      showInformationMessage: () => undefined,
      showWarningMessage: message => warnings.push(message),
      wait: async () => undefined,
      debounceMs: 400,
      retryIntervalMs: 200,
      settleTimeoutMs: 2000,
      logger
    });

    assert.strictEqual(result.appliedPlan, undefined);
    assert.strictEqual(output.lines.some(line => line.includes('Unity script rename sync did not apply')), true);
    assert.strictEqual(warnings.some(line => line.includes('Unity Plus: Unity script rename sync did not apply')), true);
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

function createFakeLanguageService(primaryClass: CSharpClassSnapshot | undefined): CSharpLanguageService {
  return {
    async getPrimaryClass() {
      return primaryClass;
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return undefined;
    }
  };
}

function createSequenceLanguageService(classes: CSharpClassSnapshot[]): CSharpLanguageService {
  let index = 0;

  return {
    async getPrimaryClass() {
      const current = classes[Math.min(index, classes.length - 1)];
      index += 1;
      return current;
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return undefined;
    }
  };
}

function fakeUri(path: string) {
  return {
    fsPath: path,
    path,
    toString: () => path
  } as never;
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
