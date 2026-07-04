import * as assert from 'assert';
import { normalize } from 'node:path';
import type * as vscode from 'vscode';
import { applyScriptFilenameSyncPlan, buildAssetMetaRenameOperations, buildScriptFilenameSyncOperations, confirmRenamePreview, executeAtomicScriptRename, invertScriptFilenameSyncPlan, planScriptFilenameSync, registerRenameFeature, RenameFileSyncMode, RenamePreviewMode, runRenameTypeCommand, ScriptFilenameSyncPlan, syncScriptRenameAfterClassChange } from '../features/rename/renameSync';
import { CSharpTopLevelTypeSnapshot, CSharpLanguageService } from '../unity/csharpLanguageService';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';

describe('renameSync', () => {
  it('plans a file rename when the primary top-level type is renamed', () => {
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

  it('does not plan type-to-file rename when sync mode is off', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      topLevelType('PlayerController'),
      topLevelType('HeroController'),
      'off'
    );

    assert.strictEqual(plan, undefined);
  });

  it('plans ordinary C# type rename when sync mode is on', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryTopLevelType('PlainUtility'),
      ordinaryTopLevelType('RenamedUtility'),
      'on'
    );

    assert.strictEqual(plan?.oldTypeName, 'PlainUtility');
    assert.strictEqual(plan?.newTypeName, 'RenamedUtility');
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/RenamedUtility.cs'));
  });

  it('plans file rename for supported top-level type kinds', () => {
    const cases = [
      { kind: 'class', oldName: 'PlayerController', newName: 'HeroController' },
      { kind: 'struct', oldName: 'HeroStats', newName: 'EnemyStats' },
      { kind: 'enum', oldName: 'CombatState', newName: 'BattleState' },
      { kind: 'interface', oldName: 'IQuestRule', newName: 'IObjectiveRule' },
      { kind: 'record', oldName: 'QuestDefinition', newName: 'MissionDefinition' }
    ] as const;

    for (const testCase of cases) {
      const plan = planScriptFilenameSync(
        normalize(`/Project/Assets/${testCase.oldName}.cs`),
        topLevelType(testCase.oldName, testCase.kind),
        topLevelType(testCase.newName, testCase.kind),
        'on'
      );

      assert.strictEqual(plan?.newFilePath, normalize(`/Project/Assets/${testCase.newName}.cs`));
    }
  });

  it('does not plan ordinary C# type rename when the provider cannot return one primary top-level type', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlainUtility.cs'),
      ordinaryTopLevelType('PlainUtility'),
      undefined,
      'on'
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename files that do not match the old type name', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/CustomName.cs'),
      topLevelType('PlayerController'),
      topLevelType('HeroController')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the provider cannot return one primary top-level type', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      topLevelType('PlayerController'),
      undefined
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

  it('builds Unity meta rename operation for a direct asset rename', async () => {
    const oldPath = normalize('/Project/Assets/PlayerController.cs');
    const newPath = normalize('/Project/Assets/HeroController.cs');

    const operations = await buildAssetMetaRenameOperations([{
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

  it('builds Unity meta rename operation for a non-C# asset rename', async () => {
    const oldPath = normalize('/Project/Assets/icon.png');
    const newPath = normalize('/Project/Assets/icon-renamed.png');

    const operations = await buildAssetMetaRenameOperations([{
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

  it('builds Unity meta rename operation for an asset moved to another folder', async () => {
    const oldPath = normalize('/Project/Assets/Player.prefab');
    const newPath = normalize('/Project/Assets/Characters/Player.prefab');

    const operations = await buildAssetMetaRenameOperations([{
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
    const operations = await buildAssetMetaRenameOperations([{
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
    assert.strictEqual(output.lines.some(line => line.includes('Unity meta file was not found')), true);
  });

  it('does not build Unity meta rename operation when the target meta file already exists', async () => {
    const output = createMemoryOutput();
    const oldPath = normalize('/Project/Assets/PlayerController.cs');
    const newPath = normalize('/Project/Assets/HeroController.cs');

    const operations = await buildAssetMetaRenameOperations([{
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

    const operations = await buildAssetMetaRenameOperations([
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

  it('does not build Unity meta rename operation for meta file moves', async () => {
    const operations = await buildAssetMetaRenameOperations([{
      oldPath: normalize('/Project/Assets/icon.png.meta'),
      newPath: normalize('/Project/Assets/icon-renamed.png.meta')
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

    const metaOperations = await buildAssetMetaRenameOperations(classSyncOperations, {
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
      mode: 'on',
      oldType: topLevelType(plan.oldTypeName),
      languageService: createFakeLanguageService(topLevelType(plan.newTypeName)),
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
    assert.strictEqual(result.appliedPlan?.newTypeName, plan.newTypeName);
  });

  it('waits before reading the C# language service for class rename sync', async () => {
    const waited: number[] = [];
    const plan = createSyncPlan();

    await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      oldType: topLevelType(plan.oldTypeName),
      languageService: createFakeLanguageService(topLevelType(plan.newTypeName)),
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
      topLevelType(plan.oldTypeName),
      topLevelType(plan.newTypeName)
    ];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      oldType: topLevelType(plan.oldTypeName),
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
    assert.strictEqual(result.appliedPlan?.newTypeName, plan.newTypeName);
  });

  it('does not show progress when class rename sync has no plan', async () => {
    const plan = createSyncPlan();
    const progressTitles: string[] = [];

    const result = await syncScriptRenameAfterClassChange({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      oldType: topLevelType(plan.oldTypeName),
      languageService: createFakeLanguageService(topLevelType(plan.oldTypeName)),
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
      mode: 'on',
      oldType: topLevelType(plan.oldTypeName),
      languageService: createFakeLanguageService(topLevelType(plan.newTypeName)),
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

  it('applies atomic class rename with C# edit plus script and Unity meta rename', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let appliedEdit: FakeWorkspaceEdit | undefined;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async edit => {
        appliedEdit = edit as unknown as FakeWorkspaceEdit;
        return true;
      },
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'applied');
    assert.strictEqual(appliedEdit, csharpEdit);
    assert.deepStrictEqual(csharpEdit.fileRenames, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
  });

  it('applies atomic class rename silently without showing preview', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let previewCalled = false;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      previewMode: 'silent',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => true,
      confirmRenamePreview: async () => {
        previewCalled = true;
        return false;
      },
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'applied');
    assert.strictEqual(previewCalled, false);
    assert.deepStrictEqual(csharpEdit.fileRenames, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
  });

  it('previews atomic class, script, and Unity meta rename before applying', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    const order: string[] = [];
    let previewPlan: ScriptFilenameSyncPlan | undefined;
    let previewOperations: readonly { oldPath: string; newPath: string }[] = [];

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => {
        order.push('apply');
        return true;
      },
      confirmRenamePreview: async (_previewMode, previewedPlan, operations) => {
        order.push('preview');
        previewPlan = previewedPlan;
        previewOperations = [...operations];
        return true;
      },
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(order, ['preview', 'apply']);
    assert.deepStrictEqual(previewPlan, plan);
    assert.deepStrictEqual(previewOperations, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
  });

  it('applies only the C# rename edit when preview removes script rename operations', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let appliedEdit: FakeWorkspaceEdit | undefined;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      previewMode: 'ask',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async edit => {
        appliedEdit = edit as unknown as FakeWorkspaceEdit;
        return true;
      },
      confirmRenamePreview: async () => ({
        kind: 'confirmed',
        operations: []
      }),
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'applied');
    assert.strictEqual(appliedEdit, csharpEdit);
    assert.deepStrictEqual(csharpEdit.fileRenames, []);
  });

  it('cancels atomic rename from the safety preview without applying edits', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let applyCalled = false;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => {
        applyCalled = true;
        return true;
      },
      confirmRenamePreview: async () => false,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'cancelled');
    assert.strictEqual(applyCalled, false);
    assert.deepStrictEqual(csharpEdit.fileRenames, []);
  });

  it('chooses script and Unity meta file operations from the ask preview', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({});

    const decision = await confirmRenamePreview(
      previewRuntime.runtime,
      'ask',
      plan,
      [
        { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
        { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
      ],
      createFakeWorkspaceEdit()
    );

    assert.strictEqual(decision.kind, 'confirmed');
    assert.deepStrictEqual(decision.kind === 'confirmed' ? decision.operations : [], [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
    assert.strictEqual(previewRuntime.warningMessages.length, 0);
  });

  it('applies only C# rename edits when the ask preview unchecks script rename', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({
      selectedLabels: []
    });

    const decision = await confirmRenamePreview(
      previewRuntime.runtime,
      'ask',
      plan,
      [
        { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
        { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
      ],
      createFakeWorkspaceEdit()
    );

    assert.strictEqual(decision.kind, 'confirmed');
    assert.deepStrictEqual(decision.kind === 'confirmed' ? decision.operations : [], []);
  });

  it('cancels rename when the ask preview picker is cancelled', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({
      cancelPicker: true
    });

    const decision = await confirmRenamePreview(
      previewRuntime.runtime,
      'ask',
      plan,
      [{ oldPath: plan.oldFilePath, newPath: plan.newFilePath }],
      createFakeWorkspaceEdit()
    );

    assert.strictEqual(decision.kind, 'cancelled');
  });

  it('shows detailed affected-file warning after ask+warn preview selection', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({});

    const decision = await confirmRenamePreview(
      previewRuntime.runtime,
      'ask+warn',
      plan,
      [
        { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
        { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
      ],
      createFakeWorkspaceEdit([
        normalize('/Project/Assets/PlayerController.cs'),
        normalize('/Project/Assets/PlayerSpawner.cs')
      ])
    );

    assert.strictEqual(decision.kind, 'confirmed');
    assert.strictEqual(previewRuntime.warningMessages.length, 1);
    assert.strictEqual(previewRuntime.warningMessages[0].includes('PlayerController.cs'), true);
    assert.strictEqual(previewRuntime.warningMessages[0].includes('PlayerSpawner.cs'), true);
  });

  it('cancels rename when the ask+warn detailed warning is cancelled', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({
      warningResult: undefined
    });

    const decision = await confirmRenamePreview(
      previewRuntime.runtime,
      'ask+warn',
      plan,
      [{ oldPath: plan.oldFilePath, newPath: plan.newFilePath }],
      createFakeWorkspaceEdit([normalize('/Project/Assets/PlayerController.cs')])
    );

    assert.strictEqual(decision.kind, 'cancelled');
  });

  it('limits detailed affected-file warning to five files plus a remainder count', async () => {
    const plan = createSyncPlan();
    const previewRuntime = createRenamePreviewRuntime({});

    await confirmRenamePreview(
      previewRuntime.runtime,
      'ask+warn',
      plan,
      [{ oldPath: plan.oldFilePath, newPath: plan.newFilePath }],
      createFakeWorkspaceEdit([
        normalize('/Project/Assets/File1.cs'),
        normalize('/Project/Assets/File2.cs'),
        normalize('/Project/Assets/File3.cs'),
        normalize('/Project/Assets/File4.cs'),
        normalize('/Project/Assets/File5.cs'),
        normalize('/Project/Assets/File6.cs')
      ])
    );

    assert.strictEqual(previewRuntime.warningMessages[0].includes('File5.cs'), true);
    assert.strictEqual(previewRuntime.warningMessages[0].includes('File6.cs'), false);
    assert.strictEqual(previewRuntime.warningMessages[0].includes('and 1 other files'), true);
  });

  it('applies atomic class rename without Unity meta when the old meta is missing', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => true,
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(csharpEdit.fileRenames, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath }
    ]);
  });

  it('falls back from atomic rename when the cursor is not on the primary top-level type name', async () => {
    const plan = createSyncPlan();

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 8, character: 4 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), new FakeWorkspaceEdit()),
      fileExists: async () => true,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => true,
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'fallback');
  });

  it('fails atomic rename preflight when the target script already exists', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let applyCalled = false;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.newFilePath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => {
        applyCalled = true;
        return true;
      },
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'failed');
    assert.strictEqual(applyCalled, false);
    assert.deepStrictEqual(csharpEdit.fileRenames, []);
  });

  it('fails atomic rename preflight when the target Unity meta already exists', async () => {
    const plan = createSyncPlan();
    const csharpEdit = new FakeWorkspaceEdit();
    let applyCalled = false;

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), csharpEdit),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath || path === plan.newMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => {
        applyCalled = true;
        return true;
      },
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'failed');
    assert.strictEqual(applyCalled, false);
    assert.deepStrictEqual(csharpEdit.fileRenames, []);
  });

  it('fails atomic rename when applyEdit returns false', async () => {
    const plan = createSyncPlan();

    const result = await executeAtomicScriptRename({
      uri: fakeUri(plan.oldFilePath),
      filePath: plan.oldFilePath,
      mode: 'on',
      currentType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      cursor: { line: 2, character: 18 },
      newTypeName: plan.newTypeName,
      languageService: createFakeLanguageService(topLevelTypeAt(plan.oldTypeName, 2, 14), new FakeWorkspaceEdit()),
      fileExists: async path => path === plan.oldFilePath || path === plan.oldMetaPath,
      createFileUri: fakeUri,
      applyWorkspaceEdit: async () => false,
      confirmRenamePreview: async () => true,
      logger: createTestLogger()
    });

    assert.strictEqual(result.kind, 'failed');
  });

  it('falls back silently outside C# editors', async () => {
    const runtime = createRenameCommandRuntime({
      editor: {
        languageId: 'typescript',
        uri: fakeUri('/Project/Assets/tool.ts'),
        filePath: normalize('/Project/Assets/tool.ts'),
        cursor: { line: 1, character: 2 }
      }
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.progressTitles, ['Unity Plus: Preparing rename...']);
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.deepStrictEqual(runtime.messages, []);
  });

  it('falls back silently when no active editor is available', async () => {
    const runtime = createRenameCommandRuntime({});

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.deepStrictEqual(runtime.messages, []);
  });

  it('falls back with a visible message when rename sync mode is off', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      mode: 'off',
      editor: createCSharpEditor(plan.oldFilePath)
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.strictEqual(runtime.messages.some(message => message.includes('Rename sync mode is off')), true);
  });

  it('falls back silently when the cursor is not on the primary top-level type name', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 8, character: 2 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14)
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.deepStrictEqual(runtime.messages, []);
    assert.deepStrictEqual(runtime.inputBoxCalls, []);
    assert.deepStrictEqual(runtime.atomicRenameCalls, []);
    assert.deepStrictEqual(runtime.waited, []);
  });

  it('falls back silently for field rename even when type and file names do not match', async () => {
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(normalize('/Project/Assets/CustomName.cs'), { line: 8, character: 12 }),
      primaryTopLevelType: topLevelTypeAt('PlayerController', 2, 14)
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.deepStrictEqual(runtime.messages, []);
    assert.deepStrictEqual(runtime.inputBoxCalls, []);
    assert.deepStrictEqual(runtime.atomicRenameCalls, []);
    assert.deepStrictEqual(runtime.waited, []);
  });

  it('falls back with a visible message when type and file names do not match', async () => {
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(normalize('/Project/Assets/CustomName.cs'), { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt('PlayerController', 2, 14)
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.strictEqual(runtime.messages.some(message => message.includes('type/file names do not match')), true);
  });

  it('shows preparing and renaming progress for valid atomic type rename command', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: plan.newTypeName
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(runtime.progressTitles, [
      'Unity Plus: Preparing rename...',
      'Unity Plus: Renaming type and script file...'
    ]);
    assert.deepStrictEqual(runtime.nativeRenameCalls, []);
    assert.strictEqual(runtime.messages.length, 0);
    assert.strictEqual(runtime.renameInputCalls.length, 1);
    assert.strictEqual(runtime.previewCalls.length, 0);
    assert.strictEqual(runtime.markedSyncing.includes(plan.oldFilePath), true);
    assert.strictEqual(runtime.unmarkedSyncing.includes(plan.oldFilePath), true);
  });

  it('uses the combined rename input without opening a second preview picker in ask mode', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: plan.newTypeName
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(runtime.inputBoxCalls, []);
    assert.deepStrictEqual(runtime.renameInputCalls, ['showRenameInput']);
    assert.deepStrictEqual(runtime.previewCalls, []);
    assert.deepStrictEqual(runtime.appliedFileRenames, [
      { oldPath: plan.oldFilePath, newPath: plan.newFilePath },
      { oldPath: plan.oldMetaPath, newPath: plan.newMetaPath }
    ]);
  });

  it('renames only the C# type when the combined rename input disables file changes', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: plan.newTypeName,
      renameOperationKinds: []
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(runtime.appliedFileRenames, []);
  });

  it('renames without waiting when the source snapshot already has the primary top-level type', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: plan.newTypeName
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(runtime.waited, []);
    assert.deepStrictEqual(runtime.nativeRenameCalls, []);
  });

  it('retries command primary top-level type lookup before falling back', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelTypes: [
        undefined,
        topLevelTypeAt(plan.oldTypeName, 2, 14)
      ],
      inputValue: plan.newTypeName
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'applied');
    assert.deepStrictEqual(runtime.waited, [200]);
    assert.deepStrictEqual(runtime.nativeRenameCalls, []);
  });

  it('does not retry command fallback when cursor is not on the type name', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 8, character: 2 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14)
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.waited, []);
    assert.deepStrictEqual(runtime.messages, []);
  });

  it('falls back after command primary top-level type lookup timeout', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelTypes: [undefined, undefined, undefined, undefined]
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'fallback');
    assert.deepStrictEqual(runtime.nativeRenameCalls, ['editor.action.rename']);
    assert.strictEqual(runtime.messages.some(message => message.includes('no primary top-level C# type was found')), true);
    assert.deepStrictEqual(runtime.waited, [200, 200, 200]);
  });

  it('cancels visible rename command without applying or falling back when input is cancelled', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: undefined
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'cancelled');
    assert.deepStrictEqual(runtime.nativeRenameCalls, []);
    assert.deepStrictEqual(runtime.appliedEdits, []);
    assert.deepStrictEqual(runtime.warnings, []);
  });

  it('cancels visible rename command without falling back when safety preview is cancelled', async () => {
    const plan = createSyncPlan();
    const runtime = createRenameCommandRuntime({
      editor: createCSharpEditor(plan.oldFilePath, { line: 2, character: 18 }),
      previewMode: 'ask+warn',
      primaryTopLevelType: topLevelTypeAt(plan.oldTypeName, 2, 14),
      inputValue: plan.newTypeName,
      confirmRenameWarningResult: false
    });

    const result = await runRenameTypeCommand(runtime);

    assert.strictEqual(result.kind, 'cancelled');
    assert.deepStrictEqual(runtime.nativeRenameCalls, []);
    assert.deepStrictEqual(runtime.appliedEdits, []);
    assert.strictEqual(runtime.renameInputCalls.length, 1);
    assert.strictEqual(runtime.warningPreviewCalls.length, 1);
    assert.deepStrictEqual(runtime.warnings, []);
  });

  it('inverts a type-to-file rename plan for undo', () => {
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

  it('plans undo from the last applied type-to-file rename', () => {
    const previousPlan = createSyncPlan();
    const undoPlan = planScriptFilenameSync(
      previousPlan.newFilePath,
      topLevelType(previousPlan.newTypeName),
      topLevelType(previousPlan.oldTypeName),
      'on',
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.oldMetaPath, previousPlan.newMetaPath);
    assert.strictEqual(undoPlan?.newMetaPath, previousPlan.oldMetaPath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });

  it('plans undo for ordinary C# type rename when sync mode is on', () => {
    const previousPlan: ScriptFilenameSyncPlan = {
      oldTypeName: 'PlainUtility',
      newTypeName: 'RenamedUtility',
      oldFilePath: normalize('/Project/Assets/PlainUtility.cs'),
      newFilePath: normalize('/Project/Assets/RenamedUtility.cs'),
      oldMetaPath: normalize('/Project/Assets/PlainUtility.cs.meta'),
      newMetaPath: normalize('/Project/Assets/RenamedUtility.cs.meta'),
      isUndo: false
    };
    const undoPlan = planScriptFilenameSync(
      previousPlan.newFilePath,
      ordinaryTopLevelType(previousPlan.newTypeName),
      ordinaryTopLevelType(previousPlan.oldTypeName),
      'on',
      { plan: previousPlan }
    );

    assert.strictEqual(undoPlan?.oldFilePath, previousPlan.newFilePath);
    assert.strictEqual(undoPlan?.newFilePath, previousPlan.oldFilePath);
    assert.strictEqual(undoPlan?.isUndo, true);
  });

  it('registers only rename commands when type/file sync mode is off', () => {
    const runtime = createRenameFeatureRuntime();

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'off',
      getMoveMetaWithAsset: () => false
    });

    assert.deepStrictEqual(runtime.registeredCommands, [
      'unityPlus.syncScriptFilename',
      'unityPlus.syncClassName'
    ]);
    assert.strictEqual(runtime.renameFileListeners, 0);
    assert.strictEqual(runtime.openDocumentListeners, 0);
    assert.strictEqual(runtime.closeDocumentListeners, 0);
    assert.strictEqual(runtime.changeDocumentListeners, 0);
    assert.strictEqual(runtime.textDocumentsReads, 0);
  });

  it('registers only asset meta rename listener when type/file sync is off and meta moves are on', () => {
    const runtime = createRenameFeatureRuntime();

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'off',
      getMoveMetaWithAsset: () => true
    });

    assert.strictEqual(runtime.renameFileListeners, 1);
    assert.strictEqual(runtime.openDocumentListeners, 0);
    assert.strictEqual(runtime.closeDocumentListeners, 0);
    assert.strictEqual(runtime.changeDocumentListeners, 0);
  });

  it('moves asset meta files from the rename listener when meta moves are enabled', async () => {
    const runtime = createRenameFeatureRuntime();
    const oldPath = normalize('/Project/Assets/icon.png');
    const newPath = normalize('/Project/Assets/icon-renamed.png');
    runtime.files.add(`${oldPath}.meta`);

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'off',
      getMoveMetaWithAsset: () => true
    });

    await runtime.fireRenameFiles([{ oldPath, newPath }]);

    assert.deepStrictEqual(runtime.appliedRenames, [{
      oldPath: `${oldPath}.meta`,
      newPath: `${newPath}.meta`
    }]);
  });

  it('does not move asset meta files from the rename listener when meta moves are disabled', async () => {
    const runtime = createRenameFeatureRuntime();
    const oldPath = normalize('/Project/Assets/icon.png');
    const newPath = normalize('/Project/Assets/icon-renamed.png');
    runtime.files.add(`${oldPath}.meta`);

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'on',
      getMoveMetaWithAsset: () => false
    });

    await runtime.fireRenameFiles([{ oldPath, newPath }]);

    assert.deepStrictEqual(runtime.appliedRenames, []);
  });

  it('registers automatic rename listeners without scanning already-open documents', () => {
    const runtime = createRenameFeatureRuntime();

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'on',
      getMoveMetaWithAsset: () => false
    });

    assert.strictEqual(runtime.renameFileListeners, 1);
    assert.strictEqual(runtime.openDocumentListeners, 1);
    assert.strictEqual(runtime.closeDocumentListeners, 1);
    assert.strictEqual(runtime.changeDocumentListeners, 1);
    assert.strictEqual(runtime.textDocumentsReads, 0);
  });

  it('does not register automatic rename listeners outside Unity workspaces', () => {
    const runtime = createRenameFeatureRuntime();

    registerRenameFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      getMode: () => 'on',
      getMoveMetaWithAsset: () => true,
      isUnityWorkspace: false
    });

    assert.strictEqual(runtime.renameFileListeners, 0);
    assert.strictEqual(runtime.openDocumentListeners, 0);
    assert.strictEqual(runtime.closeDocumentListeners, 0);
    assert.strictEqual(runtime.changeDocumentListeners, 0);
    assert.strictEqual(runtime.textDocumentsReads, 0);
  });
});

function topLevelType(
  className: string,
  kind: CSharpTopLevelTypeSnapshot['kind'] = 'class'
): CSharpTopLevelTypeSnapshot {
  return {
    name: className,
    kind,
    namespace: 'Minerva.Gameplay'
  };
}

function topLevelTypeAt(className: string, line: number, character: number): CSharpTopLevelTypeSnapshot {
  return {
    ...topLevelType(className),
    position: { line, character },
    nameRange: {
      start: { line, character },
      end: { line, character: character + className.length }
    }
  };
}

function ordinaryTopLevelType(className: string): CSharpTopLevelTypeSnapshot {
  return {
    name: className,
    kind: 'class',
    namespace: 'Minerva.Tools'
  };
}

function ordinaryTopLevelTypeAt(className: string, line: number, character: number): CSharpTopLevelTypeSnapshot {
  return {
    ...ordinaryTopLevelType(className),
    position: { line, character },
    nameRange: {
      start: { line, character },
      end: { line, character: character + className.length }
    }
  };
}

function createFakeLanguageService(
  primaryTopLevelType: CSharpTopLevelTypeSnapshot | undefined,
  renameEdit?: unknown
): CSharpLanguageService {
  return {
    async getPrimaryTopLevelType() {
      return primaryTopLevelType;
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return renameEdit as never;
    }
  };
}

function createSequenceLanguageService(classes: CSharpTopLevelTypeSnapshot[]): CSharpLanguageService {
  let index = 0;

  return {
    async getPrimaryTopLevelType() {
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

function createOptionalSequenceLanguageService(classes: Array<CSharpTopLevelTypeSnapshot | undefined>): CSharpLanguageService {
  let index = 0;

  return {
    async getPrimaryTopLevelType() {
      const current = classes[Math.min(index, classes.length - 1)];
      index += 1;
      return current;
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return new FakeWorkspaceEdit() as never;
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

class FakeWorkspaceEdit {
  public readonly fileRenames: { oldPath: string; newPath: string }[] = [];

  public constructor(private readonly affectedFiles: string[] = []) {}

  renameFile(oldUri: { fsPath: string }, newUri: { fsPath: string }): void {
    this.fileRenames.push({
      oldPath: oldUri.fsPath,
      newPath: newUri.fsPath
    });
  }

  entries(): Array<[{ fsPath: string }, unknown[]]> {
    return this.affectedFiles.map(filePath => [
      fakeUri(filePath),
      [{}]
    ]);
  }
}

function createFakeWorkspaceEdit(affectedFiles: string[] = []): vscode.WorkspaceEdit {
  return new FakeWorkspaceEdit(affectedFiles) as unknown as vscode.WorkspaceEdit;
}

interface RenameCommandRuntimeOptions {
  editor?: {
    languageId: string;
    uri: ReturnType<typeof fakeUri>;
    filePath: string;
    cursor: { line: number; character: number };
  };
  mode?: RenameFileSyncMode;
  previewMode?: RenamePreviewMode;
  primaryTopLevelType?: CSharpTopLevelTypeSnapshot;
  primaryTopLevelTypes?: Array<CSharpTopLevelTypeSnapshot | undefined>;
  inputValue?: string;
  renameOperationKinds?: Array<'script' | 'meta'>;
  confirmRenamePreviewResult?: boolean;
  confirmRenameWarningResult?: boolean;
}

function createRenameCommandRuntime(options: RenameCommandRuntimeOptions) {
  const plan = createSyncPlan();
  const progressTitles: string[] = [];
  const messages: string[] = [];
  const warnings: string[] = [];
  const nativeRenameCalls: string[] = [];
  const markedSyncing: string[] = [];
  const unmarkedSyncing: string[] = [];
  const inputBoxCalls: string[] = [];
  const renameInputCalls: string[] = [];
  const atomicRenameCalls: string[] = [];
  const appliedEdits: unknown[] = [];
  const appliedFileRenames: { oldPath: string; newPath: string }[] = [];
  const previewCalls: { plan: ScriptFilenameSyncPlan; operations: { oldPath: string; newPath: string }[] }[] = [];
  const warningPreviewCalls: { plan: ScriptFilenameSyncPlan; operations: { oldPath: string; newPath: string }[] }[] = [];
  const waited: number[] = [];
  const languageService = options.primaryTopLevelTypes
    ? createOptionalSequenceLanguageService(options.primaryTopLevelTypes)
    : createFakeLanguageService(options.primaryTopLevelType, new FakeWorkspaceEdit());

  const runtime = {
    editor: options.editor,
    mode: options.mode ?? 'on',
    previewMode: options.previewMode ?? 'ask',
    languageService,
    async showInputBox() {
      inputBoxCalls.push('showInputBox');
      return options.inputValue;
    },
    async showRenameInput() {
      renameInputCalls.push('showRenameInput');
      if (options.inputValue === undefined) {
        return undefined;
      }

      return {
        newTypeName: options.inputValue,
        operationKinds: options.renameOperationKinds ?? ['script', 'meta']
      };
    },
    async showProgress<T>(title: string, task: () => Promise<T>): Promise<T> {
      progressTitles.push(title);
      return await task();
    },
    showInformationMessage(message: string): void {
      messages.push(message);
    },
    showWarningMessage(message: string): void {
      warnings.push(message);
    },
    async executeNativeRename(): Promise<void> {
      nativeRenameCalls.push('editor.action.rename');
    },
    async executeAtomicRename(request: Parameters<typeof executeAtomicScriptRename>[0]) {
      atomicRenameCalls.push(request.newTypeName);
      return await executeAtomicScriptRename(request);
    },
    async fileExists(path: string): Promise<boolean> {
      return path === plan.oldFilePath || path === plan.oldMetaPath;
    },
    createFileUri: fakeUri,
    async applyWorkspaceEdit(edit: unknown): Promise<boolean> {
      appliedEdits.push(edit);
      appliedFileRenames.push(...(edit as FakeWorkspaceEdit).fileRenames);
      return true;
    },
    async confirmRenamePreview(
      _previewMode: RenamePreviewMode,
      plan: ScriptFilenameSyncPlan,
      operations: readonly { oldPath: string; newPath: string }[]
    ): Promise<boolean> {
      previewCalls.push({
        plan,
        operations: [...operations]
      });
      return options.confirmRenamePreviewResult ?? true;
    },
    async confirmRenameWarning(
      plan: ScriptFilenameSyncPlan,
      operations: readonly { oldPath: string; newPath: string }[]
    ): Promise<boolean> {
      warningPreviewCalls.push({
        plan,
        operations: [...operations]
      });
      return options.confirmRenameWarningResult ?? true;
    },
    async wait(ms: number): Promise<void> {
      waited.push(ms);
    },
    retryIntervalMs: 200,
    settleTimeoutMs: 400,
    markSyncing(filePath: string): void {
      markedSyncing.push(filePath);
    },
    unmarkSyncing(filePath: string): void {
      unmarkedSyncing.push(filePath);
    },
    logger: createTestLogger(),
    progressTitles,
    messages,
    warnings,
    nativeRenameCalls,
    markedSyncing,
    unmarkedSyncing,
    inputBoxCalls,
    renameInputCalls,
    atomicRenameCalls,
    appliedEdits,
    appliedFileRenames,
    previewCalls,
    warningPreviewCalls,
    waited
  };

  return runtime;
}

function createCSharpEditor(
  filePath: string,
  cursor: { line: number; character: number } = { line: 2, character: 18 }
) {
  return {
    languageId: 'csharp',
    uri: fakeUri(filePath),
    filePath,
    cursor
  };
}

function createSyncPlan(): ScriptFilenameSyncPlan {
  return {
    oldTypeName: 'PlayerController',
    newTypeName: 'HeroController',
    oldFilePath: normalize('/Project/Assets/PlayerController.cs'),
    newFilePath: normalize('/Project/Assets/HeroController.cs'),
    oldMetaPath: normalize('/Project/Assets/PlayerController.cs.meta'),
    newMetaPath: normalize('/Project/Assets/HeroController.cs.meta'),
    isUndo: false
  };
}

interface RenameFeatureRuntime {
  runtime: typeof vscode;
  registeredCommands: string[];
  files: Set<string>;
  appliedRenames: { oldPath: string; newPath: string }[];
  renameFileListeners: number;
  openDocumentListeners: number;
  closeDocumentListeners: number;
  changeDocumentListeners: number;
  textDocumentsReads: number;
  fireRenameFiles(files: { oldPath: string; newPath: string }[]): Promise<void>;
}

function createRenameFeatureRuntime(): RenameFeatureRuntime {
  const state = {
    registeredCommands: [] as string[],
    files: new Set<string>(),
    appliedRenames: [] as { oldPath: string; newPath: string }[],
    renameFileHandler: undefined as ((event: { files: { oldUri: ReturnType<typeof fakeUri>; newUri: ReturnType<typeof fakeUri> }[] }) => void) | undefined,
    renameFileListeners: 0,
    openDocumentListeners: 0,
    closeDocumentListeners: 0,
    changeDocumentListeners: 0,
    textDocumentsReads: 0
  };
  const runtime = {
    commands: {
      registerCommand(command: string) {
        state.registeredCommands.push(command);
        return createDisposable();
      }
    },
    workspace: {
      get textDocuments() {
        state.textDocumentsReads += 1;
        return [];
      },
      getConfiguration: () => ({
        get: (_key: string, defaultValue: unknown) => defaultValue
      }),
      onDidRenameFiles: (handler: (event: { files: { oldUri: ReturnType<typeof fakeUri>; newUri: ReturnType<typeof fakeUri> }[] }) => void) => {
        state.renameFileListeners += 1;
        state.renameFileHandler = handler;
        return createDisposable();
      },
      onDidOpenTextDocument: () => {
        state.openDocumentListeners += 1;
        return createDisposable();
      },
      onDidCloseTextDocument: () => {
        state.closeDocumentListeners += 1;
        return createDisposable();
      },
      onDidChangeTextDocument: () => {
        state.changeDocumentListeners += 1;
        return createDisposable();
      },
      fs: {
        async stat(uri: { fsPath: string }) {
          if (!state.files.has(uri.fsPath)) {
            throw new Error('File not found.');
          }
        }
      },
      async applyEdit(edit: FakeWorkspaceEdit) {
        state.appliedRenames.push(...edit.fileRenames);
        return true;
      }
    },
    Uri: {
      file: fakeUri
    },
    WorkspaceEdit: FakeWorkspaceEdit,
    window: {
      activeTextEditor: undefined
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    get registeredCommands() {
      return state.registeredCommands;
    },
    get files() {
      return state.files;
    },
    get appliedRenames() {
      return state.appliedRenames;
    },
    get renameFileListeners() {
      return state.renameFileListeners;
    },
    get openDocumentListeners() {
      return state.openDocumentListeners;
    },
    get closeDocumentListeners() {
      return state.closeDocumentListeners;
    },
    get changeDocumentListeners() {
      return state.changeDocumentListeners;
    },
    get textDocumentsReads() {
      return state.textDocumentsReads;
    },
    async fireRenameFiles(files: { oldPath: string; newPath: string }[]): Promise<void> {
      state.renameFileHandler?.({
        files: files.map(file => ({
          oldUri: fakeUri(file.oldPath),
          newUri: fakeUri(file.newPath)
        }))
      });
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

function createRenamePreviewRuntime(options: {
  selectedLabels?: string[];
  cancelPicker?: boolean;
  warningResult?: string;
}) {
  const warningMessages: string[] = [];
  const runtime = {
    l10n: {
      t(message: string, args?: Record<string, unknown>) {
        return args
          ? Object.entries(args).reduce((current, [key, value]) => current.replace(`{${key}}`, String(value)), message)
          : message;
      }
    },
    window: {
      async showQuickPick(items: Array<vscode.QuickPickItem & { kind?: string }>) {
        if (options.cancelPicker) {
          return undefined;
        }

        if (!options.selectedLabels) {
          return items.filter(item => item.picked);
        }

        return items.filter(item => options.selectedLabels?.includes(item.label));
      },
      async showWarningMessage(message: string, _options: { modal: boolean }, ...items: string[]) {
        warningMessages.push(message);
        return options.warningResult === undefined && 'warningResult' in options
          ? undefined
          : options.warningResult ?? items[0];
      }
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    warningMessages
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

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}
