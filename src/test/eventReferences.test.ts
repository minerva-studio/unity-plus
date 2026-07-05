import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  buildUnityEventReferenceIndex,
  parseUnityEventReferences,
  registerEventReferenceFeature
} from '../features/event-references/eventReferences';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createLazyUnityMetadataIndex, UnityMetadataIndex } from '../unity/metadataIndex';
import type { CSharpSymbolLanguageService, CSharpTypeSymbolSnapshot } from '../unity/csharpLanguageService';
import { findSourceTypes } from '../features/event-references/typeIndex';

const gateGuid = '11111111111111111111111111111111';
const gateScriptPath = 'Assets/Gate.cs';
const interactableGuid = '33333333333333333333333333333333';
const interactableScriptPath = 'Packages/com.example/Runtime/Interactable.cs';
const tutorialGuid = '44444444444444444444444444444444';
const tutorialScriptPath = 'Assets/TutorialCheck.cs';
const gateControllerGuid = '55555555555555555555555555555555';
const gateControllerScriptPath = 'Assets/GateController.cs';
const ironDoorGuid = '66666666666666666666666666666666';
const ironDoorScriptPath = 'Assets/IronDoor.cs';

describe('eventReferences', () => {
  it('does not build metadata when UnityEvent references are disabled', async () => {
    let builds = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => ({
        rebuild: async () => {
          builds += 1;
        },
        getAssetPath: () => undefined,
        getGuid: () => undefined,
        dispose: () => undefined
      })
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => false
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(builds, 0);
    assert.strictEqual(lazyIndex.isBuilt(), false);
  });

  it('builds metadata lazily from the enabled UnityEvent references command', async () => {
    let builds = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => ({
        rebuild: async () => {
          builds += 1;
        },
        getAssetPath: () => undefined,
        getGuid: () => undefined,
        dispose: () => undefined
      })
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [],
      readTextFile: async () => ''
    });

    assert.strictEqual(builds, 0);
    await runtime.runCommand('unityPlus.showUnityEventReferences');
    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(builds, 1);
    assert.strictEqual(lazyIndex.isBuilt(), true);
  });

  it('parses prefab UnityEvent persistent calls through the target type name', async () => {
    const references = await parseUnityEventReferences(createPrefabYaml(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].assetPath, 'Assets/Gate.prefab');
    assert.strictEqual(references[0].assetKind, 'prefab');
    assert.strictEqual(references[0].eventFieldName, 'OnCheckEnable');
    assert.strictEqual(references[0].eventScriptPath, gateScriptPath);
    assert.strictEqual(references[0].line, 13);
    assert.strictEqual(references[0].character, 22);
    assert.strictEqual(references[0].gameObjectName, 'North Gate');
    assert.strictEqual(references[0].targetTypeName, 'Amlos.Fixtures.Gate');
    assert.strictEqual(references[0].methodName, 'CanInteract');
    assert.strictEqual(references[0].scriptPath, gateScriptPath);
  });

  it('parses scene UnityEvent persistent calls', async () => {
    const references = await parseUnityEventReferences(createPrefabYaml(2), 'Assets/Scenes/Main.unity', 'scene', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].assetKind, 'scene');
    assert.strictEqual(references[0].assetPath, 'Assets/Scenes/Main.unity');
  });

  it('keeps field references when UnityEvent targets are Unity built-in methods', async () => {
    const references = await parseUnityEventReferences(createBuiltinTargetYaml(2), 'Assets/Tutorial.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 2);
    assert.strictEqual(references[0].eventFieldName, 'OnEquipMagicBook');
    assert.strictEqual(references[0].eventScriptPath, tutorialScriptPath);
    assert.strictEqual(references[0].targetFileId, '3861731173795288140');
    assert.strictEqual(references[0].targetTypeName, 'UnityEngine.GameObject');
    assert.strictEqual(references[0].methodName, 'SetActive');
    assert.strictEqual(references[0].scriptPath, undefined);
    assert.strictEqual(references[0].line, 19);
    assert.strictEqual(references[0].character, 22);
    assert.strictEqual(references[1].targetFileId, '1324802612482997380');
    assert.strictEqual(references[1].scriptPath, undefined);
  });

  it('skips disabled persistent calls', async () => {
    const references = await parseUnityEventReferences(createPrefabYaml(0), 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 0);
  });

  it('skips malformed or unresolved serialized data without throwing', async () => {
    const references = await parseUnityEventReferences([
      '%YAML 1.1',
      '--- !u!114 &460066068064628344',
      'MonoBehaviour:',
      '  OnCheckEnable:',
      '    m_PersistentCalls:',
      '      m_Calls:',
      '      - m_Target: {fileID: 999}',
      '        m_MethodName: CanInteract',
      '        m_CallState: 2'
    ].join('\n'), 'Assets/Broken.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 0);
  });

  it('reports scanner diagnostics for scanned assets and skipped calls', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/Main.unity')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async uri => uri.fsPath.endsWith('.prefab')
        ? createPrefabYaml(2)
        : createMissingTargetTypeYaml(),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();

    assert.strictEqual(diagnostics.prefabCount, 1);
    assert.strictEqual(diagnostics.sceneCount, 1);
    assert.strictEqual(diagnostics.persistentCallCount, 2);
    assert.strictEqual(diagnostics.resolvedReferenceCount, 1);
    assert.strictEqual(diagnostics.resolvedByTargetTypeNameCount, 1);
    assert.strictEqual(diagnostics.skippedMissingTargetTypeNameCount, 1);
  });

  it('indexes MonoBehaviour serialized instances from prefab and scene files', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/Scenes/Main.unity')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async () => createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const instances = index.getSerializedInstances(gateScriptPath);

    assert.strictEqual(instances.length, 2);
    assert.strictEqual(index.getSerializedInstanceCount(gateScriptPath), 2);
    assert.deepStrictEqual(instances.map(instance => instance.assetKind), ['prefab', 'scene']);
    assert.deepStrictEqual(instances.map(instance => instance.gameObjectName), ['North Gate', 'North Gate']);
    assert.strictEqual(instances[0].line, 7);
    assert.strictEqual(instances[0].character, 37);
    assert.strictEqual(index.getDiagnostics().serializedInstanceScriptTextHitCount, 2);
    assert.strictEqual(index.getDiagnostics().serializedInstanceScriptDedupedTextHitCount, 0);
  });

  it('counts every metadata-resolved m_Script AST hit across many serialized assets', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const assetUris = Array.from({ length: 57 }, (_value, index) => createUri(`/Project/Assets/Generated/Gate${index}.prefab`));
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => assetUris,
      findCSharpFiles: async () => [],
      readTextFile: async (_uri, _runtimeVscode) => createSerializedScriptInstanceYaml(gateGuid),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());
    const diagnostics = index.getDiagnostics();

    assert.strictEqual(index.getSerializedInstanceCount(gateScriptPath), 57);
    assert.strictEqual(diagnostics.parsedYamlAssetCount, 57);
    assert.strictEqual(diagnostics.skippedUnityEventAssetCount, 57);
    assert.strictEqual(diagnostics.serializedInstanceScriptTextHitCount, 57);
    assert.strictEqual(diagnostics.serializedInstanceScriptResolvedTextHitCount, 57);
    assert.strictEqual(diagnostics.serializedInstanceScriptDedupedTextHitCount, 0);
  });

  it('counts serialized instances from raw m_Script text hits even when object enrichment is incomplete', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/LooseScripts.prefab')],
      findCSharpFiles: async () => [],
      readTextFile: async () => createLooseScriptReferenceYaml(),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const instances = index.getSerializedInstances(gateScriptPath);
    const diagnostics = index.getDiagnostics();

    assert.strictEqual(instances.length, 3);
    assert.deepStrictEqual(instances.map(instance => instance.fileId), ['7001', '7002', '7003']);
    assert.deepStrictEqual(instances.map(instance => instance.line), [3, 6, 9]);
    assert.strictEqual(diagnostics.serializedInstanceScriptTextHitCount, 4);
    assert.strictEqual(diagnostics.serializedInstanceScriptResolvedTextHitCount, 3);
    assert.strictEqual(diagnostics.serializedInstanceScriptUnresolvedTextHitCount, 1);
    assert.strictEqual(diagnostics.serializedInstanceScriptDedupedTextHitCount, 0);
  });

  it('uses AST serialized instance parsing without UnityEvent parsing for script-only assets', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const assetUris = Array.from({ length: 8 }, (_, index) => createUri(`/Project/Assets/Generated/OnlyScript${index}.asset`));
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => assetUris,
      findCSharpFiles: async () => [],
      readTextFile: async () => createLooseScriptReferenceYaml(),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();

    assert.strictEqual(index.getSerializedInstanceCount(gateScriptPath), 24);
    assert.strictEqual(diagnostics.parsedYamlAssetCount, 8);
    assert.strictEqual(diagnostics.parsedUnityEventAssetCount, 0);
    assert.strictEqual(diagnostics.skippedUnityEventAssetCount, 8);
    assert.strictEqual(diagnostics.persistentCallCount, 0);
  });

  it('indexes ScriptableObject and MonoBehaviour serialized instances from asset files', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/GateConfig.asset')],
      findCSharpFiles: async () => [],
      readTextFile: async () => createScriptableObjectAssetYaml(),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const gateInstances = index.getSerializedInstances(gateScriptPath);
    const interactableInstances = index.getSerializedInstances(interactableScriptPath);
    const diagnostics = index.getDiagnostics();

    assert.strictEqual(gateInstances.length, 1);
    assert.strictEqual(gateInstances[0].assetKind, 'asset');
    assert.strictEqual(gateInstances[0].name, 'Gate Config');
    assert.strictEqual(interactableInstances.length, 1);
    assert.strictEqual(interactableInstances[0].assetKind, 'asset');
    assert.strictEqual(interactableInstances[0].name, 'Package Config');
    assert.strictEqual(diagnostics.assetCount, 1);
    assert.strictEqual(diagnostics.serializedInstanceCount, 2);
  });

  it('skips serialized instances with missing or unresolved script GUIDs', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/Broken.asset')],
      findCSharpFiles: async () => [],
      readTextFile: async () => [
        '%YAML 1.1',
        '--- !u!114 &1',
        'MonoBehaviour:',
        '  m_Name: Missing Script',
        '--- !u!114 &2',
        'MonoBehaviour:',
        '  m_Name: Unknown Script',
        '  m_Script: {fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}'
      ].join('\n'),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    assert.strictEqual(index.getSerializedInstanceCount(gateScriptPath), 0);
    assert.strictEqual(index.getDiagnostics().serializedInstanceCount, 0);
  });

  it('parses m_Target fileID from nested YAML lines', async () => {
    const references = await parseUnityEventReferences(createPrefabYamlWithNestedTarget(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].methodName, 'CanInteract');
    assert.strictEqual(references[0].line, 14);
  });

  it('parses UnityEvent persistent calls from prefab override modifications', async () => {
    const references = await parseUnityEventReferences(createPrefabOverrideYaml(2), 'Assets/GateVariant.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].assetPath, 'Assets/GateVariant.prefab');
    assert.strictEqual(references[0].eventFieldName, 'OnCheckEnable');
    assert.strictEqual(references[0].eventScriptPath, gateScriptPath);
    assert.strictEqual(references[0].gameObjectName, 'North Gate Variant');
    assert.strictEqual(references[0].targetTypeName, 'Amlos.Fixtures.Gate');
    assert.strictEqual(references[0].methodName, 'CanInteract');
    assert.strictEqual(references[0].scriptPath, gateScriptPath);
    assert.strictEqual(references[0].line, 22);
    assert.strictEqual(references[0].character, 13);
  });

  it('parses UnityEvent calls only for assets with persistent calls or overrides', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/GateVariant.prefab'),
        createUri('/Project/Assets/OnlyScript.asset')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('GateVariant.prefab')) {
          return createPrefabOverrideYaml(2);
        }

        return uri.fsPath.endsWith('OnlyScript.asset')
          ? createLooseScriptReferenceYaml()
          : createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();

    assert.strictEqual(diagnostics.parsedYamlAssetCount, 3);
    assert.strictEqual(diagnostics.parsedUnityEventAssetCount, 2);
    assert.strictEqual(diagnostics.skippedUnityEventAssetCount, 1);
    assert.strictEqual(diagnostics.persistentCallCount, 2);
    assert.strictEqual(index.getReferenceCount(gateScriptPath, 'CanInteract'), 2);
  });

  it('keeps UnityEvent line numbers correct after many serialized documents', async () => {
    const prefix = createManyEmptyYamlDocuments(1500);
    const content = `${prefix}\n${createPrefabYaml(2)}`;
    const references = await parseUnityEventReferences(content, 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].line, countNewlines(prefix) + 1 + 13);
    assert.strictEqual(references[0].character, 22);
  });

  it('shows CodeLens and hover details for referenced C# methods', async () => {
    const runtime = createEventReferenceRuntime();
    const prefabUri = createUri('/Project/Assets/Gate.prefab');
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [prefabUri],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    const initialLenses = await runtime.provideCodeLenses(csharpDocument);
    assert.deepStrictEqual(initialLenses.map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    assert.strictEqual(lenses.length, 4);
    assert.strictEqual(lenses[0].command?.title, '1 Unity serialized instances');
    assert.strictEqual(lenses[0].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[0].command?.arguments?.[0], {
      kind: 'serializedInstance',
      scriptPath: gateScriptPath,
      typeName: 'Gate',
      position: new FakePosition(1, 13)
    });
    assert.strictEqual(lenses[1].command?.title, '1 UnityEvent references');
    assert.strictEqual(lenses[1].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[1].command?.arguments?.[0], {
      kind: 'method',
      scriptPath: gateScriptPath,
      symbolName: 'CanInteract',
      typeName: 'Gate',
      position: new FakePosition(4, 14)
    });
    assert.strictEqual(lenses[2].command?.title, '1 UnityEvent references');
    assert.strictEqual(lenses[2].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[2].command?.arguments?.[0], {
      kind: 'field',
      scriptPath: gateScriptPath,
      symbolName: 'OnCheckEnable',
      typeName: 'Gate',
      position: new FakePosition(3, 20)
    });
    assert.strictEqual(lenses[3].command?.title, '1 UnityEvent targets');
    assert.strictEqual(lenses[3].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[3].command?.arguments?.[0], {
      kind: 'fieldTarget',
      scriptPath: gateScriptPath,
      symbolName: 'OnCheckEnable',
      typeName: 'Gate',
      position: new FakePosition(3, 20)
    });

    const methodHover = await runtime.provideHover(csharpDocument, new FakePosition(4, 16) as unknown as vscode.Position);
    assert.ok(methodHover);
    const methodHoverText = (methodHover.contents[0] as vscode.MarkdownString).value;
    assert.strictEqual(methodHoverText.includes('Assets/Gate\\.prefab'), true);
    assert.strictEqual(methodHoverText.includes('OnCheckEnable'), true);
    assert.strictEqual(methodHoverText.includes('North Gate'), true);

    const fieldHover = await runtime.provideHover(csharpDocument, new FakePosition(3, 22) as unknown as vscode.Position);
    assert.ok(fieldHover);
    const fieldHoverText = (fieldHover.contents[0] as vscode.MarkdownString).value;
    assert.strictEqual(fieldHoverText.includes('CanInteract'), true);

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[0].command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].position, new FakePosition(1, 13));
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(7, 37));

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[1].command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 2);
    assert.strictEqual(runtime.referenceCommands[1].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[1].position, new FakePosition(4, 14));
    assert.strictEqual(runtime.referenceCommands[1].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[1].locations[0].range.start, new FakePosition(13, 22));

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[3].command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 3);
    assert.strictEqual(runtime.referenceCommands[2].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[2].position, new FakePosition(3, 20));
    assert.strictEqual(runtime.referenceCommands[2].locations[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[2].locations[0].range.start, new FakePosition(4, 14));
  });

  it('schedules one background index build after repeated CodeLens requests', async () => {
    let assetScans = 0;
    let releaseBuild: (() => void) | undefined;
    let markBuildStarted: (() => void) | undefined;
    const buildStarted = new Promise<void>(resolve => {
      markBuildStarted = resolve;
    });
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => {
        assetScans += 1;
        markBuildStarted?.();
        await new Promise<void>(resolve => {
          releaseBuild = resolve;
        });
        return [];
      },
      readTextFile: async () => ''
    });

    const document = createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;');
    assert.deepStrictEqual(
      (await runtime.provideCodeLenses(document)).map(lens => lens.command?.title),
      ['- Unity serialized instances', '- UnityEvent references', '- UnityEvent targets']
    );
    assert.deepStrictEqual(
      (await runtime.provideCodeLenses(document)).map(lens => lens.command?.title),
      ['- Unity serialized instances', '- UnityEvent references', '- UnityEvent targets']
    );
    assert.strictEqual(assetScans, 0);

    await buildStarted;
    assert.strictEqual(assetScans, 1);

    releaseBuild?.();
    await runtime.waitForCodeLensChange();
  });

  it('invalidates ready CodeLens results when serialized assets change', async () => {
    const runtime = createEventReferenceRuntime();
    const prefabUri = createUri('/Project/Assets/Gate.prefab');
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'public class Gate',
      '{',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    let prefabContent = createPrefabYaml(2);
    let scanCount = 0;
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => {
        scanCount += 1;
        return [prefabUri];
      },
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : prefabContent,
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);
    await runtime.waitForCodeLensChange();
    assert.strictEqual((await runtime.provideCodeLenses(csharpDocument)).some(lens =>
      lens.command?.title === '1 UnityEvent references'
    ), true);

    const invalidationChangeCount = runtime.codeLensChangeCount;
    prefabContent = createSerializedScriptInstanceYaml(gateGuid);
    runtime.fireSerializedAssetChange(prefabUri);
    await runtime.waitForCodeLensChangeAfter(invalidationChangeCount);

    const rebuildChangeCount = runtime.codeLensChangeCount;
    await assertPendingCodeLenses(runtime, csharpDocument);
    await runtime.waitForCodeLensChangeAfter(rebuildChangeCount);
    const refreshedLenses = await runtime.provideCodeLenses(csharpDocument);

    assert.strictEqual(scanCount, 2);
    assert.strictEqual(refreshedLenses.some(lens => lens.command?.title === '1 UnityEvent references'), false);
    assert.strictEqual(refreshedLenses.some(lens => lens.command?.title === '1 Unity serialized instances'), true);
  });

  it('shows and hides status bar progress for background index builds', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async () => createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    assert.deepStrictEqual(
      (await runtime.provideCodeLenses(createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;'))).map(lens => lens.command?.title),
      ['- Unity serialized instances', '- UnityEvent references', '- UnityEvent targets']
    );
    await runtime.waitForCodeLensChange();

    assert.strictEqual(runtime.statusBarItems.length, 1);
    assert.strictEqual(runtime.statusBarItems[0].showCount > 0, true);
    assert.strictEqual(runtime.statusBarItems[0].hideCount, 0);
    assert.strictEqual(runtime.statusBarItems[0].text.startsWith('$(check) Unity refs: project'), true);
    assert.strictEqual(runtime.statusBarItems[0].tooltip?.includes('References:'), true);
  });

  it('prefilters full scans after stable asset enumeration without proposed text search', async () => {
    const readPaths: string[] = [];
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Unrelated.prefab'),
        createUri('/Project/Assets/Gate.prefab')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async uri => {
        readPaths.push(uri.fsPath);
        return uri.fsPath.endsWith('Unrelated.prefab')
          ? '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Filler'
          : createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    assert.deepStrictEqual(readPaths, ['/Project/Assets/Unrelated.prefab', '/Project/Assets/Gate.prefab']);
    assert.strictEqual(index.getDiagnostics().candidateAssetCount, 2);
    assert.strictEqual(index.getDiagnostics().textCandidateSearchCount, 0);
    assert.strictEqual(index.getDiagnostics().parsedYamlAssetCount, 1);
  });

  it('does not call proposed text search from the default asset scan path', async () => {
    const excludes: unknown[] = [];
    const runtime = createEventReferenceRuntime({
      findTextInFiles: async () => {
        throw new Error('findTextInFiles must not be called');
      },
      findFiles: async (_pattern, exclude) => {
        excludes.push(exclude);
        return [createUri('/Project/Assets/Gate.prefab')];
      }
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async (root, runtimeVscode) =>
        await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, 'Assets/**/*.prefab'), null),
      findCSharpFiles: async () => [],
      readTextFile: async () => createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    }, createMetadataIndex());

    assert.deepStrictEqual(excludes, [null]);
    assert.strictEqual(index.getReferenceCount(gateScriptPath, 'CanInteract'), 1);
  });

  it('uses sidecar metadata and text candidates for the current-file priority path', async () => {
    let metadataIndexBuilds = 0;
    const searchedTexts: string[] = [];
    let assetReads = 0;
    let metaReads = 0;
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract() => true;',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => {
        const baseIndex = createMetadataIndex();
        return {
          ...baseIndex,
          rebuild: async () => {
            metadataIndexBuilds += 1;
          },
          dispose: () => baseIndex.dispose()
        };
      }
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      searchAssetFilesContainingText: async (_root, _runtimeVscode, texts) => {
        searchedTexts.push(...texts);
        return {
          backend: 'ripgrep',
          files: [createUri('/Project/Assets/Gate.prefab')],
          searchCount: texts.length,
          elapsedMilliseconds: 1
        };
      },
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('Gate.cs.meta')) {
          metaReads += 1;
          return `guid: ${gateGuid}`;
        }

        assetReads += 1;
        return createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    const pendingLenses = await runtime.provideCodeLenses(csharpDocument);

    assert.deepStrictEqual(pendingLenses.map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    await runtime.waitForCodeLensChange();

    const lenses = await runtime.provideCodeLenses(csharpDocument);
    assert.strictEqual(metadataIndexBuilds, 0);
    assert.deepStrictEqual(searchedTexts, [gateGuid]);
    assert.strictEqual(metaReads, 1);
    assert.strictEqual(assetReads, 1);
    assert.strictEqual(lenses.length, 4);
    assert.strictEqual(lenses[0].command?.title, '1 Unity serialized instances');
    assert.strictEqual(lenses[1].command?.title, '1 UnityEvent references');
    assert.strictEqual(lenses[2].command?.title, '1 UnityEvent references');
    assert.strictEqual(lenses[3].command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[0].command?.arguments?.[0]);
    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[1].command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 2);
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(7, 37));
    assert.strictEqual(runtime.referenceCommands[1].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[1].locations[0].range.start, new FakePosition(13, 22));
    assert.strictEqual(runtime.statusBarItems[0].text.startsWith('$(check) Unity refs: current'), true);
  });

  it('counts current-file priority targets from target assembly type without full metadata', async () => {
    let csharpScans = 0;
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      searchAssetFilesContainingText: async (_root, _runtimeVscode, texts) => ({
        backend: 'ripgrep',
        files: [createUri('/Project/Assets/Gate.prefab')],
        searchCount: texts.length,
        elapsedMilliseconds: 1
      }),
      readTextFile: async uri => uri.fsPath.endsWith('Gate.cs.meta')
        ? `guid: ${gateGuid}`
        : createUnresolvedTargetAssemblyYaml(2),
      findCSharpFiles: async () => {
        csharpScans += 1;
        return [createUri('/Project/Assets/IronDoor.cs')];
      },
      resolveCSharpType: async () => undefined
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 0);
    assert.strictEqual(csharpScans, 0);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('shows zero CodeLens feedback when the current script has no metadata GUID', async () => {
    let candidateSearches = 0;
    const output = createMemoryOutput();
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const logger = createLogger({
      output,
      getLevel: () => 'debug'
    });

    registerEventReferenceFeature(logger, {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [],
      searchAssetFilesContainingText: async () => {
        candidateSearches += 1;
        return {
          backend: 'ripgrep',
          files: [],
          searchCount: 1,
          elapsedMilliseconds: 1
        };
      },
      readTextFile: async () => ''
    });

    const document = createTextDocument('/Project/Assets/Unknown.cs', 'public class Unknown {}');
    const pendingLenses = await runtime.provideCodeLenses(document);
    assert.deepStrictEqual(pendingLenses.map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    assert.strictEqual(pendingLenses.every(lens => lens.range.start.line === 0 && lens.range.start.character === 13), true);
    await runtime.waitForCodeLensChange();

    const readyLenses = await runtime.provideCodeLenses(document);
    assert.deepStrictEqual(readyLenses.map(lens => lens.command?.title), [
      '0 Unity serialized instances',
      '0 UnityEvent references',
      '0 UnityEvent targets'
    ]);
    assert.strictEqual(readyLenses.every(lens => lens.range.start.line === 0 && lens.range.start.character === 13), true);
    assert.strictEqual(candidateSearches, 0);
    assert.strictEqual(output.lines.some(line => line.includes('script GUID not found in metadata index')), true);
  });

  it('keeps pending CodeLens placeholders when the CodeLens request is already canceled', async () => {
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const token = new FakeCancellationToken();

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      readTextFile: async () => ''
    });

    token.cancel();

    assert.deepStrictEqual(
      (await runtime.provideCodeLenses(
        createTextDocument('/Project/Assets/Gate.cs', 'public class Gate {}'),
        token as unknown as vscode.CancellationToken
      )).map(lens => lens.command?.title),
      ['- Unity serialized instances', '- UnityEvent references', '- UnityEvent targets']
    );
  });

  it('keeps CodeLens placeholders when C# symbols are unavailable', async () => {
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      },
      throwDocumentSymbols: true
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const document = createTextDocument('/Project/Assets/Unknown.cs', 'public class Unknown {}');

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      readTextFile: async () => ''
    });

    assert.deepStrictEqual((await runtime.provideCodeLenses(document)).map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    await runtime.waitForCodeLensChange();

    assert.deepStrictEqual((await runtime.provideCodeLenses(document)).map(lens => lens.command?.title), [
      '0 Unity serialized instances',
      '0 UnityEvent references',
      '0 UnityEvent targets'
    ]);
  });

  it('reuses one in-flight priority scan for repeated CodeLens requests on the same script', async () => {
    let candidateSearches = 0;
    let releaseSearch: (() => void) | undefined;
    const searchStarted = new Promise<void>(resolve => {
      releaseSearch = resolve;
    });
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract() => true;',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      searchAssetFilesContainingText: async (_root, _runtimeVscode, texts) => {
        candidateSearches += 1;
        assert.deepStrictEqual(texts, [gateGuid]);
        await searchStarted;
        return {
          backend: 'ripgrep',
          files: [createUri('/Project/Assets/Gate.prefab')],
          searchCount: texts.length,
          elapsedMilliseconds: 1
        };
      },
      readTextFile: async uri => uri.fsPath.endsWith('Gate.cs.meta')
        ? `guid: ${gateGuid}`
        : createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    const first = runtime.provideCodeLenses(csharpDocument);
    const second = runtime.provideCodeLenses(csharpDocument);
    await waitForTimers();

    assert.strictEqual(candidateSearches, 1);
    assert.deepStrictEqual((await first).map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    assert.deepStrictEqual((await second).map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);

    releaseSearch?.();
    await runtime.waitForCodeLensChange();
    const readyLenses = await runtime.provideCodeLenses(csharpDocument);

    assert.strictEqual(readyLenses.length, 4);
  });

  it('does not reuse priority scan results after switching to another script', async () => {
    const searchedTexts: string[] = [];
    const runtime = createEventReferenceRuntime({
      configuration: {
        'eventReferences.autoScan': false
      }
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      searchAssetFilesContainingText: async (_root, _runtimeVscode, texts) => {
        searchedTexts.push(...texts);
        return {
          backend: 'ripgrep',
          files: texts[0] === gateGuid
            ? [createUri('/Project/Assets/Gate.prefab')]
            : [createUri('/Project/Assets/GateController.prefab')],
          searchCount: texts.length,
          elapsedMilliseconds: 1
        };
      },
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('Gate.cs.meta')) {
          return `guid: ${gateGuid}`;
        }

        if (uri.fsPath.endsWith('IronDoor.cs.meta')) {
          return `guid: ${ironDoorGuid}`;
        }

        return uri.fsPath.endsWith('Gate.prefab')
          ? createPrefabYaml(2)
          : createGateControllerYaml(2);
      },
      resolveCSharpType: async fullTypeName => {
        if (fullTypeName === 'Amlos.Fixtures.IronDoor') {
          return ironDoorScriptPath;
        }

        return createTypeResolver()(fullTypeName);
      }
    });

    const gateDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract() => true;',
      '}'
    ].join('\n'));
    assert.deepStrictEqual((await runtime.provideCodeLenses(gateDocument)).map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    await runtime.waitForCodeLensChangeAfter(0);
    const gateLenses = await runtime.provideCodeLenses(gateDocument);

    const ironDoorDocument = createTextDocument('/Project/Assets/IronDoor.cs', [
      'public class IronDoor',
      '{',
      '  public void Open() {}',
      '  public void Close() {}',
      '}'
    ].join('\n'));
    const previousChangeCount = runtime.codeLensChangeCount;
    assert.deepStrictEqual((await runtime.provideCodeLenses(ironDoorDocument)).map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    await runtime.waitForCodeLensChangeAfter(previousChangeCount);
    const ironDoorLenses = await runtime.provideCodeLenses(ironDoorDocument);

    assert.deepStrictEqual(searchedTexts, [gateGuid, ironDoorGuid]);
    assert.strictEqual(gateLenses.some(lens => lens.command?.title === '1 Unity serialized instances'), true);
    assert.strictEqual(ironDoorLenses.some(lens => lens.command?.title === '2 Unity serialized instances'), true);
    assert.strictEqual(ironDoorLenses.filter(lens => lens.command?.title === '2 UnityEvent references').length, 2);
  });

  it('shows placeholders without scheduling a background build for canceled CodeLens requests', async () => {
    let assetScans = 0;
    const runtime = createEventReferenceRuntime();
    const cancellationToken = new FakeCancellationToken();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => {
        assetScans += 1;
        return [];
      },
      readTextFile: async () => ''
    });

    cancellationToken.cancel();
    const lenses = await runtime.provideCodeLenses(
      createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;'),
      cancellationToken as unknown as vscode.CancellationToken
    );

    assert.deepStrictEqual(lenses.map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);
    await waitForTimers();
    assert.strictEqual(assetScans, 0);
  });

  it('does not synchronously scan while providing hover before the index is ready', async () => {
    let assetScans = 0;
    let releaseBuild: (() => void) | undefined;
    let markBuildStarted: (() => void) | undefined;
    const buildStarted = new Promise<void>(resolve => {
      markBuildStarted = resolve;
    });
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => {
        assetScans += 1;
        markBuildStarted?.();
        await new Promise<void>(resolve => {
          releaseBuild = resolve;
        });
        return [];
      },
      readTextFile: async () => ''
    });

    const hover = await runtime.provideHover(
      createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;'),
      new FakePosition(0, 14) as unknown as vscode.Position
    );

    assert.strictEqual(hover, undefined);
    await buildStarted;
    assert.strictEqual(assetScans, 1);

    releaseBuild?.();
    await runtime.waitForCodeLensChange();
  });

  it('shows reference locations from UnityEvent field CodeLens commands', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async () => createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    const document = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '}'
    ].join('\n'));
    await assertPendingCodeLenses(runtime, document);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(document);
    const fieldLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(13, 22));
  });

  it('shows UnityEvent field CodeLens for non-override package assets', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Packages/com.example/Runtime/Interactable.cs', [
      'using UnityEngine.Events;',
      'namespace LibraryOfMeialia',
      '{',
      '  public class Interactable',
      '  {',
      '    public UnityEvent OnInteract = new();',
      '    public void Interact()',
      '    {',
      '    }',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Packages/com.example/Prefabs/Button.prefab')],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('Interactable.cs')) {
          return csharpDocument.getText();
        }

        return createPackagePrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
  });

  it('uses m_EditorClassIdentifier to show field references when owner script GUID is not indexed', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/UI_Tutorial_Inventory_EquipedCheck.cs', [
      'using UnityEngine.Events;',
      'namespace Amlos.UI.Tutorial',
      '{',
      '  public class UI_Tutorial_Inventory_EquipedCheck',
      '  {',
      '    public UnityEvent OnBookPagePasted = new();',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Tutorial.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createEditorClassIdentifierOwnerYaml(2),
      resolveCSharpType: async () => undefined
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '0 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldReferenceLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].locations.length, 2);

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('uses m_EditorClassIdentifier to show serialized instances when script GUID is not indexed', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/UI_Tutorial_Inventory_EquipedCheck.cs', [
      'namespace Amlos.UI.Tutorial',
      '{',
      '  public class UI_Tutorial_Inventory_EquipedCheck',
      '  {',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/TutorialConfig.asset')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createEditorClassIdentifierAssetYaml(),
      resolveCSharpType: async () => undefined
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const serializedInstanceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'serializedInstance');

    assert.strictEqual(serializedInstanceLens?.command?.title, '1 Unity serialized instances');
  });

  it('shows zero field targets for Unity built-in methods', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/TutorialCheck.cs', [
      'using UnityEngine.Events;',
      'public class TutorialCheck',
      '{',
      '  public UnityEvent OnEquipMagicBook = new();',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Tutorial.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createBuiltinTargetYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '0 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldReferenceLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].locations.length, 2);
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(19, 22));
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[1].range.start, new FakePosition(26, 22));

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('detects simple and nested generic UnityEvent fields', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using System.Collections.Generic;',
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent<int> OnCheckEnable = new();',
      '  public UnityEvent<List<Amlos.Fixtures.Gate>, int[]> OnBookCooldownStart;',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '  public void Interact()',
      '  {',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/GateCooldown.prefab')
      ],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('.cs')) {
          return csharpDocument.getText();
        }

        return uri.fsPath.endsWith('GateCooldown.prefab') ? createInstanceTargetYaml(2) : createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldLenses = lenses.filter(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLenses = lenses.filter(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    // Both fields should be visible even when the UnityEvent type has generic arguments.
    assert.strictEqual(fieldLenses.length, 2);
    assert.strictEqual(fieldTargetLenses.length, 2);
    assert.strictEqual(fieldLenses.every(lens => lens.command?.title === '1 UnityEvent references'), true);
    assert.strictEqual(fieldTargetLenses.every(lens => lens.command?.title === '1 UnityEvent targets'), true);

    const checkTargetLens = fieldTargetLenses.find(lens => lens.command?.arguments?.[0]?.symbolName === 'OnCheckEnable');
    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', checkTargetLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].position, new FakePosition(4, 25));
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(6, 14));
  });

  it('projects field targets from YAML target methods instead of C# invocation call sites', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool InvokeFromCode()',
      '  {',
      '    OnCheckEnable.Invoke();',
      '    return CanInteract();',
      '  }',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].position, new FakePosition(3, 20));
    assert.strictEqual(runtime.referenceCommands[0].locations.length, 1);
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(9, 14));
  });

  it('does not use field Invoke call sites when a YAML target declaration cannot be found', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool InvokeFromCode()',
      '  {',
      '    OnCheckEnable.Invoke();',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 0);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('ignores same-name methods outside the YAML target type', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '}'
    ].join('\n'));
    const targetDocument = createTextDocument('/Project/Assets/IronDoor.cs', [
      'public class WrongType',
      '{',
      '  public void Open()',
      '  {',
      '  }',
      '}',
      'public class IronDoor',
      '{',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('Gate.cs')) {
          return csharpDocument.getText();
        }

        return uri.fsPath.endsWith('IronDoor.cs')
          ? targetDocument.getText()
          : createUnresolvedTargetAssemblyYaml(2);
      },
      resolveCSharpType: async typeName => typeName === 'Amlos.Fixtures.IronDoor' ? ironDoorScriptPath : createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 0);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('deduplicates UnityEvent field target CodeLens locations across normal and override bindings', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/GateVariant.prefab')
      ],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('Gate.cs')) {
          return csharpDocument.getText();
        }

        return uri.fsPath.endsWith('GateVariant.prefab') ? createPrefabOverrideYaml(2) : createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldReferenceLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands[0].locations.length, 2);
    assert.strictEqual(runtime.referenceCommands[0].locations[1].uri.fsPath, '/Project/Assets/GateVariant.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[1].range.start, new FakePosition(22, 13));

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', fieldTargetLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands[1].locations.length, 1);
    assert.strictEqual(runtime.referenceCommands[1].locations[0].uri.fsPath, '/Project/Assets/Gate.cs');
    assert.deepStrictEqual(runtime.referenceCommands[1].locations[0].range.start, new FakePosition(4, 14));
  });

  it('counts all field references but only resolvable field targets for mixed UnityEvent calls', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'using UnityEngine.Events;',
      'public class Gate',
      '{',
      '  public UnityEvent OnCheckEnable;',
      '  public bool CanInteract()',
      '  {',
      '    return true;',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createMixedTargetYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const fieldReferenceLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const fieldTargetLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

    assert.strictEqual(fieldReferenceLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
  });

  it('counts field targets from target assembly type even when the target fileID cannot resolve', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      findCSharpFiles: async () => [],
      readTextFile: async () => createUnresolvedTargetAssemblyYaml(2),
      resolveCSharpType: async () => undefined
    }, createMetadataIndex());
    const targets = index.getFieldTargets(gateScriptPath, 'OnCheckEnable', 'Gate');

    assert.strictEqual(index.getFieldReferenceCount(gateScriptPath, 'OnCheckEnable', 'Gate'), 1);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0].targetTypeName, 'Amlos.Fixtures.IronDoor');
    assert.strictEqual(targets[0].methodName, 'Open');
    assert.strictEqual(targets[0].scriptPath, undefined);
  });

  it('keeps method CodeLens when target script path resolves but target type name mismatches the C# namespace', async () => {
    const runtime = createEventReferenceRuntime();
    const csharpDocument = createTextDocument('/Project/Assets/Gate.cs', [
      'namespace Actual.Gameplay',
      '{',
      '  public class Gate',
      '  {',
      '    public bool CanInteract()',
      '    {',
      '      return true;',
      '    }',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      readTextFile: async uri => uri.fsPath.endsWith('.cs') ? csharpDocument.getText() : createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, csharpDocument);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    const methodLens = lenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');

    assert.strictEqual(methodLens?.command?.title, '1 UnityEvent references');
  });

  it('resolves UnityEvent target scripts from target assembly type names', async () => {
    const runtime = createEventReferenceRuntime();
    const controllerDocument = createTextDocument('/Project/Assets/GateController.cs', [
      'using UnityEngine.Events;',
      'public class GateController',
      '{',
      '  public UnityEvent OpenGate;',
      '  public UnityEvent CloseGate;',
      '  public UnityEvent OnBookPagePasted;',
      '}'
    ].join('\n'));
    const doorDocument = createTextDocument('/Project/Assets/IronDoor.cs', [
      'public class IronDoor',
      '{',
      '  public void Open()',
      '  {',
      '  }',
      '  public void Close()',
      '  {',
      '  }',
      '}'
    ].join('\n'));
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/GateController.prefab')],
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('GateController.cs')) {
          return controllerDocument.getText();
        }

        if (uri.fsPath.endsWith('IronDoor.cs')) {
          return doorDocument.getText();
        }

        return createGateControllerYaml(2);
      },
      resolveCSharpType: async typeName => typeName === 'Amlos.Fixtures.IronDoor' ? ironDoorScriptPath : createTypeResolver()(typeName)
    });

    await assertPendingCodeLenses(runtime, controllerDocument);

    await runtime.waitForCodeLensChange();
    const controllerLenses = await runtime.provideCodeLenses(controllerDocument);
    const openFieldLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field' && lens.command.arguments[0].symbolName === 'OpenGate');
    const openTargetLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget' && lens.command.arguments[0].symbolName === 'OpenGate');
    const closeFieldLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field' && lens.command.arguments[0].symbolName === 'CloseGate');
    const closeTargetLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget' && lens.command.arguments[0].symbolName === 'CloseGate');
    const pastedFieldLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field' && lens.command.arguments[0].symbolName === 'OnBookPagePasted');
    const pastedTargetLens = controllerLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget' && lens.command.arguments[0].symbolName === 'OnBookPagePasted');

    assert.strictEqual(openFieldLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(openTargetLens?.command?.title, '1 UnityEvent targets');
    assert.strictEqual(closeFieldLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(closeTargetLens?.command?.title, '1 UnityEvent targets');
    assert.strictEqual(pastedFieldLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(pastedTargetLens?.command?.title, '0 UnityEvent targets');

    const doorLenses = await runtime.provideCodeLenses(doorDocument);
    const openMethodLens = doorLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method' && lens.command.arguments[0].symbolName === 'Open');
    const closeMethodLens = doorLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method' && lens.command.arguments[0].symbolName === 'Close');

    assert.strictEqual(openMethodLens?.command?.title, '2 UnityEvent references');
    assert.strictEqual(closeMethodLens?.command?.title, '2 UnityEvent references');

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', openTargetLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].uri.fsPath, '/Project/Assets/GateController.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].position, new FakePosition(3, 20));
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/IronDoor.cs');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(2, 14));

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', pastedTargetLens?.command?.arguments?.[0]);
    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.infoMessages.at(-1), 'Unity Plus: no UnityEvent target methods found for this field.');
  });

  it('shows an informational message when a reference location command has no matches', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [],
      findCSharpFiles: async () => [],
      readTextFile: async () => ''
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');
    runtime.infoMessages.length = 0;

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', {
      kind: 'method',
      scriptPath: gateScriptPath,
      symbolName: 'Missing',
      position: new FakePosition(0, 0)
    });

    assert.strictEqual(runtime.referenceCommands.length, 0);
    assert.strictEqual(runtime.infoMessages[0], 'Unity Plus: no UnityEvent references found for this symbol.');
  });

  it('does not block reference location commands while the index is building', async () => {
    let releaseBuild: (() => void) | undefined;
    let markBuildStarted: (() => void) | undefined;
    const buildStarted = new Promise<void>(resolve => {
      markBuildStarted = resolve;
    });
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => {
        markBuildStarted?.();
        await new Promise<void>(resolve => {
          releaseBuild = resolve;
        });
        return [];
      },
      readTextFile: async () => ''
    });

    const lenses = await runtime.provideCodeLenses(createTextDocument('/Project/Assets/Gate.cs', 'public void Missing() {}'));
    assert.deepStrictEqual(lenses.map(lens => lens.command?.title), [
      '- Unity serialized instances',
      '- UnityEvent references',
      '- UnityEvent targets'
    ]);

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', {
      kind: 'method',
      scriptPath: gateScriptPath,
      symbolName: 'Missing',
      position: new FakePosition(0, 0)
    });

    assert.strictEqual(runtime.infoMessages[0], 'Unity Plus: UnityEvent reference index is still building.');
    await buildStarted;
    releaseBuild?.();
    await runtime.waitForCodeLensChange();
  });

  it('resolves instance target calls by target type name when fileID is only a Unity instance reference', async () => {
    const references = await parseUnityEventReferences(createInstanceTargetYaml(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].eventFieldName, 'OnBookCooldownStart');
    assert.strictEqual(references[0].methodName, 'Interact');
    assert.strictEqual(references[0].scriptPath, gateScriptPath);
  });

  it('falls back to C# language server symbols when workspace symbols do not resolve a target type', async () => {
    const runtime = createEventReferenceRuntime();
    let csharpFileScans = 0;
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      findCSharpFiles: async () => {
        csharpFileScans += 1;
        return [createUri('/Project/Assets/Scripts/Gate.cs')];
      },
      readTextFile: async uri => uri.fsPath.endsWith('.cs')
        ? ['namespace Amlos.Fixtures;', 'public class Gate', '{', '  public void Interact() {}', '}'].join('\n')
        : createInstanceTargetYaml(2),
      csharpLanguageService: createFakeCSharpSymbolLanguageService({
        '/Project/Assets/Scripts/Gate.cs': [{
          name: 'Gate',
          fullName: 'Amlos.Fixtures.Gate',
          range: {
            start: { line: 1, character: 13 },
            end: { line: 1, character: 17 }
          }
        }]
      })
    }, createMetadataIndex());

    assert.strictEqual(index.getReferenceCount('Assets/Scripts/Gate.cs', 'Interact'), 1);
    assert.strictEqual(index.getDiagnostics().resolvedByTargetTypeNameCount, 1);
    assert.strictEqual(csharpFileScans, 1);
  });

  it('parses source C# types for UnityEvent target resolution without language-server symbols', async () => {
    const runtime = createEventReferenceRuntime();
    let csharpFileScans = 0;
    const output = createMemoryOutput();
    const logger = createLogger({
      output,
      getLevel: () => 'debug'
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger,
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [createUri('/Project/Assets/Gate.prefab')],
      findCSharpFiles: async () => {
        csharpFileScans += 1;
        return [createUri('/Project/Assets/Scripts/Gate.cs')];
      },
      readTextFile: async uri => uri.fsPath.endsWith('.cs')
        ? [
          'namespace Amlos.Fixtures;',
          'public sealed partial class Gate',
          '{',
          '  public bool CanInteract() => true;',
          '}'
        ].join('\n')
        : createPrefabYaml(2),
      csharpLanguageService: createFakeCSharpSymbolLanguageService({})
    }, createMetadataIndex());

    assert.strictEqual(index.getReferenceCount('Assets/Scripts/Gate.cs', 'CanInteract', 'Amlos.Fixtures.Gate'), 1);
    assert.strictEqual(index.getFieldTargets(gateScriptPath, 'OnCheckEnable', 'Amlos.Fixtures.Gate').length, 1);
    assert.strictEqual(index.getDiagnostics().resolvedByTargetTypeNameCount, 1);
    assert.strictEqual(csharpFileScans, 1);
    assert.strictEqual(output.lines.some(line =>
      line.includes('1 C# file(s), 0 C# server type(s), 1 source fallback type(s), 2 resolvable type key(s).')
    ), true);
  });

  it('extracts source type names from real Unity C# declaration shapes', () => {
    assert.deepStrictEqual(findSourceTypes([
      'namespace Amlos.Control.Interact',
      '{',
      '  public sealed class Interactable : MonoBehaviour {}',
      '}',
      'namespace Amlos.Fixtures;',
      'public abstract partial class Cannon : Fixture {}',
      'public readonly record struct CannonState(int Value);',
      'class Outside {}'
    ].join('\n')).map(type => type.fullName), [
      'Amlos.Control.Interact.Interactable',
      'Amlos.Fixtures.Cannon',
      'Amlos.Fixtures.CannonState',
      'Amlos.Fixtures.Outside'
    ]);
  });

  it('does not scan for CodeLens when UnityEvent references are disabled', async () => {
    let scans = 0;
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => false,
      findAssetFiles: async () => {
        scans += 1;
        return [createUri('/Project/Assets/Gate.prefab')];
      },
      readTextFile: async () => createPrefabYaml(2)
    });

    const lenses = await runtime.provideCodeLenses(createTextDocument('/Project/Assets/Gate.cs', 'public bool CanInteract() => true;'));

    assert.strictEqual(lenses.length, 0);
    assert.strictEqual(scans, 0);
  });

  it('shows diagnostic summary from the command when no references resolve', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => [createUri('/Project/Assets/Main.unity')],
      findCSharpFiles: async () => [],
      readTextFile: async () => createMissingTargetTypeYaml(),
      resolveCSharpType: async () => undefined
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(runtime.infoMessages[0].includes('scanned 0 prefab(s), 1 scene(s), and 0 asset file(s)'), true);
    assert.strictEqual(runtime.infoMessages[0].includes('found 0 serialized instance(s)'), true);
    assert.strictEqual(runtime.infoMessages[0].includes('found 0 UnityEvent reference(s)'), true);
    assert.strictEqual(runtime.infoMessages[0].includes('resolved 0 UnityEvent target method(s)'), true);
  });

  it('scans all prefab and scene assets by default', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/Scenes/Main.unity'),
        createUri('/Project/Assets/Scenes/Extra.unity')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async () => createMissingTargetTypeYaml(),
      resolveCSharpType: async () => undefined
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();
    assert.strictEqual(diagnostics.discoveredAssetCount, 3);
    assert.strictEqual(diagnostics.prefabCount, 1);
    assert.strictEqual(diagnostics.sceneCount, 2);
    assert.strictEqual(diagnostics.skippedAssetCount, 0);
  });

  it('keeps prefabs and filters scenes to Build Settings when configured', async () => {
    const runtime = createEventReferenceRuntime({
      configuration: {
        'scan.includeScenesOutsideBuildSettings': false
      }
    });
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });

    const index = await buildUnityEventReferenceIndex({
      runtimeVscode: runtime.runtime,
      logger: createTestLogger(),
      metadataIndex: lazyIndex,
      getCacheVersion: () => 0,
      findAssetFiles: async () => [
        createUri('/Project/Assets/Gate.prefab'),
        createUri('/Project/Assets/Scenes/Main.unity'),
        createUri('/Project/Assets/Scenes/Extra.unity')
      ],
      findCSharpFiles: async () => [],
      readTextFile: async uri => uri.fsPath.endsWith('EditorBuildSettings.asset')
        ? createBuildSettingsYaml(['Assets/Scenes/Main.unity'])
        : createMissingTargetTypeYaml(),
      resolveCSharpType: async () => undefined
    }, createMetadataIndex());

    const diagnostics = index.getDiagnostics();
    assert.strictEqual(diagnostics.discoveredAssetCount, 3);
    assert.strictEqual(diagnostics.prefabCount, 1);
    assert.strictEqual(diagnostics.sceneCount, 1);
    assert.strictEqual(diagnostics.skippedAssetCount, 1);
  });

  it('shows progress and preserves the ready index when an interactive scan is canceled', async () => {
    const runtime = createEventReferenceRuntime();
    const lazyIndex = createLazyUnityMetadataIndex({
      root: createUri('/Project'),
      logger: createTestLogger(),
      createIndex: () => createMetadataIndex()
    });
    let assetFiles = [createUri('/Project/Assets/Gate.prefab')];
    let cancelDuringRead = false;
    let assetReads = 0;

    registerEventReferenceFeature(createTestLogger(), {
      runtimeVscode: runtime.runtime,
      metadataIndex: lazyIndex,
      isEnabled: () => true,
      findAssetFiles: async () => assetFiles,
      readTextFile: async uri => {
        if (uri.fsPath.endsWith('.prefab')) {
          assetReads += 1;

          if (cancelDuringRead) {
            runtime.progressTokens.at(-1)?.cancel();
          }
        }

        return createPrefabYaml(2);
      },
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    await runtime.runCommand('unityPlus.showUnityEventReferences');
    assert.strictEqual(runtime.progressOptions.length, 1);
    assert.strictEqual(runtime.progressReports.length > 0, true);

    runtime.infoMessages.length = 0;
    assetReads = 0;
    cancelDuringRead = true;
    assetFiles = Array.from({ length: 8 }, (_value, index) => createUri(`/Project/Assets/Gate${index}.prefab`));

    await runtime.runCommand('unityPlus.showUnityEventReferences');

    assert.strictEqual(runtime.infoMessages.includes('Unity Plus: UnityEvent reference scan canceled.'), true);
    assert.strictEqual(assetReads < assetFiles.length, true);

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', {
      kind: 'method',
      scriptPath: gateScriptPath,
      symbolName: 'CanInteract',
      position: new FakePosition(4, 14)
    });

    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
  });
});

interface EventReferenceRuntime {
  runtime: typeof vscode;
  infoMessages: string[];
  statusBarItems: FakeStatusBarItem[];
  progressReports: Array<{ message?: string; increment?: number }>;
  progressOptions: vscode.ProgressOptions[];
  progressTokens: FakeCancellationToken[];
  referenceCommands: Array<{ uri: vscode.Uri; position: vscode.Position; locations: vscode.Location[] }>;
  codeLensChangeCount: number;
  runCommand(command: string, ...args: unknown[]): Promise<void>;
  provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]>;
  provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<vscode.Hover | undefined>;
  fireSerializedAssetChange(uri: vscode.Uri): void;
  waitForCodeLensChange(): Promise<void>;
  waitForCodeLensChangeAfter(count: number): Promise<void>;
}

interface EventReferenceRuntimeOptions {
  configuration?: Record<string, unknown>;
  findFiles?: (pattern: unknown, exclude?: unknown) => Promise<readonly vscode.Uri[]>;
  findTextInFiles?: () => Thenable<void>;
  throwDocumentSymbols?: boolean;
}

function createEventReferenceRuntime(options: EventReferenceRuntimeOptions = {}): EventReferenceRuntime {
  const configuration = {
    'eventReferences.autoScan': true,
    ...(options.configuration ?? {})
  };
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const codeLensProviders: vscode.CodeLensProvider[] = [];
  const hoverProviders: vscode.HoverProvider[] = [];
  const infoMessages: string[] = [];
  const statusBarItems: FakeStatusBarItem[] = [];
  const progressReports: Array<{ message?: string; increment?: number }> = [];
  const progressOptions: vscode.ProgressOptions[] = [];
  const progressTokens: FakeCancellationToken[] = [];
  const referenceCommands: Array<{ uri: vscode.Uri; position: vscode.Position; locations: vscode.Location[] }> = [];
  const codeLensChangeResolvers: Array<() => void> = [];
  const fileSystemWatchers: FakeFileSystemWatcher[] = [];
  const textDocuments = new Map<string, vscode.TextDocument>();
  let codeLensChangeCount = 0;
  const runtime = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
        commands.set(command, callback);
        return createDisposable();
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === 'editor.action.showReferences') {
          const [uri, position, locations] = args as [vscode.Uri, vscode.Position, vscode.Location[]];
          referenceCommands.push({ uri, position, locations });
        }

        if (command === 'vscode.executeDocumentSymbolProvider') {
          if (options.throwDocumentSymbols) {
            throw new Error('document symbols unavailable');
          }

          const [uri] = args as [vscode.Uri];
          const document = textDocuments.get(uri.fsPath);
          return document ? createFakeDocumentSymbols(runtime as unknown as typeof vscode, document) : [];
        }
      }
    },
    languages: {
      registerCodeLensProvider(_selector: unknown, provider: vscode.CodeLensProvider): vscode.Disposable {
        codeLensProviders.push(provider);
        provider.onDidChangeCodeLenses?.(() => {
          codeLensChangeCount += 1;
          codeLensChangeResolvers.splice(0).forEach(resolve => resolve());
        });
        return createDisposable();
      },
      registerHoverProvider(_selector: unknown, provider: vscode.HoverProvider): vscode.Disposable {
        hoverProviders.push(provider);
        return createDisposable();
      }
    },
    workspace: {
      openTextDocument: async (uri: vscode.Uri) =>
        textDocuments.get(uri.fsPath) ?? createTextDocument(uri.fsPath, ''),
      findFiles: async (pattern: unknown, exclude?: unknown) =>
        await options.findFiles?.(pattern, exclude) ?? [],
      findTextInFiles: options.findTextInFiles,
      createFileSystemWatcher: () => {
        const watcher = new FakeFileSystemWatcher();
        fileSystemWatchers.push(watcher);
        return watcher as unknown as vscode.FileSystemWatcher;
      },
      getConfiguration: () => ({
        get: (key: string, defaultValue?: unknown) => Object.prototype.hasOwnProperty.call(configuration, key)
          ? configuration[key as keyof typeof configuration]
          : defaultValue
      })
    },
    window: {
      showInformationMessage: (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showWarningMessage: () => undefined,
      createStatusBarItem: () => {
        const item = new FakeStatusBarItem();
        statusBarItems.push(item);
        return item as unknown as vscode.StatusBarItem;
      },
      withProgress: async <R>(
        progressOptionsValue: vscode.ProgressOptions,
        task: (
          progress: vscode.Progress<{ message?: string; increment?: number }>,
          token: vscode.CancellationToken
        ) => Thenable<R>
      ): Promise<R> => {
        const token = new FakeCancellationToken();
        progressOptions.push(progressOptionsValue);
        progressTokens.push(token);
        return await task({
          report: value => {
            progressReports.push(value);
          }
        }, token as unknown as vscode.CancellationToken);
      }
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    },
    Position: FakePosition,
    Range: FakeRange,
    CodeLens: FakeCodeLens,
    EventEmitter: FakeEventEmitter,
    Location: FakeLocation,
    StatusBarAlignment: {
      Left: 1
    },
    SymbolKind: {
      Class: 4,
      Method: 5,
      Field: 7,
      Interface: 10,
      Namespace: 3,
      Struct: 22,
      Enum: 9
    },
    ProgressLocation: {
      Notification: 15
    },
    Hover: FakeHover,
    MarkdownString: FakeMarkdownString,
    Uri: {
      file: createUri
    },
    RelativePattern: class FakeRelativePattern {
      /** Stores VS Code relative pattern inputs for tests that inspect glob behavior. */
      constructor(public readonly baseUri: vscode.Uri, public readonly pattern: string) {}
    },
    l10n: {
      t: localize
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    infoMessages,
    statusBarItems,
    progressReports,
    progressOptions,
    progressTokens,
    referenceCommands,
    get codeLensChangeCount() {
      return codeLensChangeCount;
    },
    async runCommand(command: string, ...args: unknown[]): Promise<void> {
      await Promise.resolve(commands.get(command)?.(...args));
    },
    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken = new FakeCancellationToken() as unknown as vscode.CancellationToken): Promise<vscode.CodeLens[]> {
      textDocuments.set(document.uri.fsPath, document);
      const results = await Promise.all(codeLensProviders.map(async provider =>
        await provider.provideCodeLenses(document, token) ?? []
      ));
      return results.flat();
    },
    async provideHover(
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken = new FakeCancellationToken() as unknown as vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
      textDocuments.set(document.uri.fsPath, document);
      return await hoverProviders[0]?.provideHover(document, position, token) ?? undefined;
    },
    fireSerializedAssetChange(uri: vscode.Uri): void {
      for (const watcher of fileSystemWatchers) {
        watcher.fireChange(uri);
      }
    },
    async waitForCodeLensChange(): Promise<void> {
      if (codeLensChangeCount > 0) {
        return;
      }

      await new Promise<void>(resolve => {
        codeLensChangeResolvers.push(resolve);
      });
    },
    async waitForCodeLensChangeAfter(count: number): Promise<void> {
      if (codeLensChangeCount > count) {
        return;
      }

      await new Promise<void>(resolve => {
        codeLensChangeResolvers.push(resolve);
      });
    }
  };
}

function createPrefabYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: North Gate',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '  OnCheckEnable:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 460066068064628344}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.Gate, Amlos.Gameplay.Core',
    '        m_MethodName: CanInteract',
    '        m_Mode: 0',
    '        m_Arguments:',
    '          m_ObjectArgument: {fileID: 0}',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createPrefabYamlWithNestedTarget(callState: number): string {
  return createPrefabYaml(callState).replace(
    '- m_Target: {fileID: 460066068064628344}',
    ['- m_Target:', '    fileID: 460066068064628344'].join('\n')
  );
}

/** Creates one parsed MonoBehaviour script instance without UnityEvent call fields. */
function createSerializedScriptInstanceYaml(scriptGuid: string): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: Counted Gate',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${scriptGuid}, type: 3}`
  ].join('\n');
}

function createLooseScriptReferenceYaml(): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &7001',
    'MonoBehaviour:',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '--- !u!199 &7002',
    'UnknownSerializedObject:',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '--- !u!114 &7003',
    'MonoBehaviour:',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '--- !u!114 &7004',
    'MonoBehaviour:',
    '  m_Script: {fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}'
  ].join('\n');
}

function createScriptableObjectAssetYaml(): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &11400000',
    'MonoBehaviour:',
    '  m_Name: Gate Config',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '--- !u!114 &11400001',
    'MonoBehaviour:',
    '  m_Name: Package Config',
    `  m_Script: {fileID: 11500000, guid: ${interactableGuid}, type: 3}`
  ].join('\n');
}

function createPrefabOverrideYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: North Gate Variant',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '--- !u!1001 &223344',
    'PrefabInstance:',
    '  m_Modification:',
    '    m_Modifications:',
    '    - target: {fileID: 460066068064628344}',
    '      propertyPath: OnCheckEnable.m_PersistentCalls.m_Calls.Array.data[0].m_Target',
    '      value: ',
    '      objectReference: {fileID: 460066068064628344}',
    '    - target: {fileID: 460066068064628344}',
    '      propertyPath: OnCheckEnable.m_PersistentCalls.m_Calls.Array.data[0].m_TargetAssemblyTypeName',
    '      value: Amlos.Fixtures.Gate, Amlos.Gameplay.Core',
    '      objectReference: {fileID: 0}',
    '    - target: {fileID: 460066068064628344}',
    '      propertyPath: OnCheckEnable.m_PersistentCalls.m_Calls.Array.data[0].m_MethodName',
    '      value: CanInteract',
    '      objectReference: {fileID: 0}',
    '    - target: {fileID: 460066068064628344}',
    '      propertyPath: OnCheckEnable.m_PersistentCalls.m_Calls.Array.data[0].m_CallState',
    `      value: ${callState}`,
    '      objectReference: {fileID: 0}'
  ].join('\n');
}

function createManyEmptyYamlDocuments(count: number): string {
  return Array.from({ length: count }, (_value, index) => [
    `--- !u!1 &${index + 1}`,
    'GameObject:',
    `  m_Name: Filler ${index}`
  ].join('\n')).join('\n');
}

function countNewlines(value: string): number {
  return value.match(/\n/g)?.length ?? 0;
}

function createInstanceTargetYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: North Gate',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '  OnBookCooldownStart:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 777777}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.Gate, Amlos.Gameplay.Core',
    '        m_MethodName: Interact',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createPackagePrefabYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &2000',
    'GameObject:',
    '  m_Name: Package Button',
    '--- !u!114 &560066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 2000}',
    `  m_Script: {fileID: 11500000, guid: ${interactableGuid}, type: 3}`,
    '  OnInteract:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 560066068064628344}',
    '        m_TargetAssemblyTypeName: LibraryOfMeialia.Interactable, LibraryOfMeialia',
    '        m_MethodName: Interact',
    '        m_Mode: 0',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createBuiltinTargetYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &7022818226384243533',
    'GameObject:',
    '  m_Name: Tutorial Check',
    '--- !u!1 &3861731173795288140',
    'GameObject:',
    '  m_Name: Disabled Target',
    '--- !u!1 &1324802612482997380',
    'GameObject:',
    '  m_Name: Enabled Target',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 7022818226384243533}',
    `  m_Script: {fileID: 11500000, guid: ${tutorialGuid}, type: 3}`,
    '  OnEquipMagicBook:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 3861731173795288140}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    '        m_Arguments:',
    '          m_BoolArgument: 0',
    `        m_CallState: ${callState}`,
    '      - m_Target: {fileID: 1324802612482997380}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    '        m_Arguments:',
    '          m_BoolArgument: 1',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createEditorClassIdentifierOwnerYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &7022818226384243533',
    'GameObject:',
    '  m_Name: Tutorial Check',
    '--- !u!1 &2594932129069825706',
    'GameObject:',
    '  m_Name: Book Page',
    '--- !u!1 &5566378938482836897',
    'GameObject:',
    '  m_Name: Pasted Page',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 7022818226384243533}',
    '  m_Script: {fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}',
    '  m_EditorClassIdentifier: Amlos.UI::Amlos.UI.Tutorial.UI_Tutorial_Inventory_EquipedCheck',
    '  OnBookPagePasted:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 2594932129069825706}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    `        m_CallState: ${callState}`,
    '      - m_Target: {fileID: 5566378938482836897}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createEditorClassIdentifierAssetYaml(): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &11400000',
    'MonoBehaviour:',
    '  m_Name: Tutorial Config',
    '  m_Script: {fileID: 11500000, guid: 99999999999999999999999999999999, type: 3}',
    '  m_EditorClassIdentifier: Amlos.UI::Amlos.UI.Tutorial.UI_Tutorial_Inventory_EquipedCheck'
  ].join('\n');
}

function createMixedTargetYaml(callState: number): string {
  return createPrefabYaml(callState).replace(
    `        m_CallState: ${callState}`,
    [
      `        m_CallState: ${callState}`,
      '      - m_Target: {fileID: 1000}',
      '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
      '        m_MethodName: SetActive',
      '        m_Mode: 6',
      `        m_CallState: ${callState}`
    ].join('\n')
  );
}

function createGateControllerYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!1 &1000',
    'GameObject:',
    '  m_Name: Gate Controller',
    '--- !u!1 &2000',
    'GameObject:',
    '  m_Name: West Door',
    '--- !u!1 &3000',
    'GameObject:',
    '  m_Name: East Door',
    '--- !u!1 &4000',
    'GameObject:',
    '  m_Name: Book Page',
    '--- !u!1 &5000',
    'GameObject:',
    '  m_Name: Pasted Page',
    '--- !u!114 &1111',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 1000}',
    `  m_Script: {fileID: 11500000, guid: ${gateControllerGuid}, type: 3}`,
    '  OpenGate:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 249930800342422913}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.IronDoor, Amlos.Gameplay.Impl.Fixtures',
    '        m_MethodName: Open',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`,
    '      - m_Target: {fileID: 3184087781896535932}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.IronDoor, Amlos.Gameplay.Impl.Fixtures',
    '        m_MethodName: Open',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`,
    '  CloseGate:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 249930800342422913}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.IronDoor, Amlos.Gameplay.Impl.Fixtures',
    '        m_MethodName: Close',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`,
    '      - m_Target: {fileID: 3184087781896535932}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.IronDoor, Amlos.Gameplay.Impl.Fixtures',
    '        m_MethodName: Close',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`,
    '  OnBookPagePasted:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 4000}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    `        m_CallState: ${callState}`,
    '      - m_Target: {fileID: 5000}',
    '        m_TargetAssemblyTypeName: UnityEngine.GameObject, UnityEngine',
    '        m_MethodName: SetActive',
    '        m_Mode: 6',
    `        m_CallState: ${callState}`,
    '--- !u!114 &249930800342422913',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 2000}',
    `  m_Script: {fileID: 11500000, guid: ${ironDoorGuid}, type: 3}`,
    '--- !u!114 &3184087781896535932',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 3000}',
    `  m_Script: {fileID: 11500000, guid: ${ironDoorGuid}, type: 3}`
  ].join('\n');
}

function createMissingTargetTypeYaml(): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    '  OnCheckEnable:',
    '    m_PersistentCalls:',
      '      m_Calls:',
      '      - m_Target: {fileID: 460066068064628344}',
      '        m_MethodName: CanInteract',
      '        m_CallState: 2'
  ].join('\n');
}

function createUnresolvedTargetAssemblyYaml(callState: number): string {
  return [
    '%YAML 1.1',
    '--- !u!114 &460066068064628344',
    'MonoBehaviour:',
    `  m_Script: {fileID: 11500000, guid: ${gateGuid}, type: 3}`,
    '  OnCheckEnable:',
    '    m_PersistentCalls:',
    '      m_Calls:',
    '      - m_Target: {fileID: 999999999}',
    '        m_TargetAssemblyTypeName: Amlos.Fixtures.IronDoor, Amlos.Gameplay.Impl.Fixtures',
    '        m_MethodName: Open',
    '        m_Mode: 1',
    `        m_CallState: ${callState}`
  ].join('\n');
}

function createBuildSettingsYaml(scenePaths: readonly string[]): string {
  return [
    '%YAML 1.1',
    '--- !u!1045 &1',
    'EditorBuildSettings:',
    '  m_Scenes:',
    ...scenePaths.flatMap(scenePath => [
      '  - enabled: 1',
      `    path: ${scenePath}`,
      '    guid: 00000000000000000000000000000000'
    ])
  ].join('\n');
}

function createTypeResolver(): (fullTypeName: string) => string | undefined {
  return fullTypeName => {
    if (fullTypeName === 'Amlos.Fixtures.Gate') {
      return gateScriptPath;
    }

    return fullTypeName === 'LibraryOfMeialia.Interactable' ? interactableScriptPath : undefined;
  };
}

function createMetadataIndex(): UnityMetadataIndex {
  return {
    rebuild: async () => undefined,
    getAssetPath: guid => {
      if (guid === gateGuid) {
        return gateScriptPath;
      }

      if (guid === gateControllerGuid) {
        return gateControllerScriptPath;
      }

      if (guid === ironDoorGuid) {
        return ironDoorScriptPath;
      }

      if (guid === interactableGuid) {
        return interactableScriptPath;
      }

      return guid === tutorialGuid ? tutorialScriptPath : undefined;
    },
    getGuid: assetPath => {
      if (assetPath === gateScriptPath) {
        return gateGuid;
      }

      if (assetPath === gateControllerScriptPath) {
        return gateControllerGuid;
      }

      if (assetPath === ironDoorScriptPath) {
        return ironDoorGuid;
      }

      if (assetPath === interactableScriptPath) {
        return interactableGuid;
      }

      return assetPath === tutorialScriptPath ? tutorialGuid : undefined;
    },
    dispose: () => undefined
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

function createTextDocument(fsPath: string, text: string): vscode.TextDocument {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    uri: createUri(fsPath),
    getText: () => text,
    positionAt: (offset: number) => {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) {
        line += 1;
      }

      return new FakePosition(line, offset - lineStarts[line]);
    }
  } as vscode.TextDocument;
}

/** Builds language-server-like C# document symbols for UnityEvent feature tests. */
function createFakeDocumentSymbols(runtimeVscode: typeof vscode, document: vscode.TextDocument): vscode.DocumentSymbol[] {
  const text = document.getText();
  const namespaceMatch = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:;|\{)/m.exec(text);
  const namespaceName = namespaceMatch?.[1];
  const classSymbols = findFakeClassSymbols(runtimeVscode, document, text);

  if (!namespaceName) {
    return classSymbols;
  }

  const namespaceOffset = namespaceMatch?.index ?? 0;
  return [
    new FakeDocumentSymbol(
      namespaceName,
      '',
      runtimeVscode.SymbolKind.Namespace,
      createRangeFromOffsets(runtimeVscode, document, namespaceOffset, namespaceOffset + namespaceName.length),
      createRangeFromOffsets(runtimeVscode, document, namespaceOffset, namespaceOffset + namespaceName.length),
      classSymbols
    ) as unknown as vscode.DocumentSymbol
  ];
}

/** Finds top-level fake class symbols and attaches member symbols from their bodies. */
function findFakeClassSymbols(runtimeVscode: typeof vscode, document: vscode.TextDocument, text: string): vscode.DocumentSymbol[] {
  const symbols: vscode.DocumentSymbol[] = [];
  const classPattern = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = classPattern.exec(text))) {
    const name = match[1];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const bodyStart = text.indexOf('{', classPattern.lastIndex);
    const bodyEnd = bodyStart === -1 ? text.length : findFakeMatchingBrace(text, bodyStart) ?? text.length;
    const children = findFakeMemberSymbols(runtimeVscode, document, text, bodyStart, bodyEnd);
    symbols.push(new FakeDocumentSymbol(
      name,
      '',
      runtimeVscode.SymbolKind.Class,
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length),
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length),
      children
    ) as unknown as vscode.DocumentSymbol);
  }

  return symbols;
}

/** Finds fake method and UnityEvent field symbols inside a class body. */
function findFakeMemberSymbols(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  text: string,
  bodyStart: number,
  bodyEnd: number
): vscode.DocumentSymbol[] {
  const symbols: vscode.DocumentSymbol[] = [];
  const body = text.slice(bodyStart, bodyEnd);
  const methodPattern = /\b(?:void|bool|int|string|float|double|Task|IEnumerator)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const fieldPattern = /\b((?:UnityEngine\.Events\.)?UnityEvent(?:<[^;\n]+>)?)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = methodPattern.exec(body))) {
    const name = match[1];
    const nameStart = bodyStart + match.index + match[0].lastIndexOf(name);
    symbols.push(new FakeDocumentSymbol(
      name,
      '',
      runtimeVscode.SymbolKind.Method,
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length),
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length)
    ) as unknown as vscode.DocumentSymbol);
  }

  while ((match = fieldPattern.exec(body))) {
    const detail = match[1];
    const name = match[2];
    const nameStart = bodyStart + match.index + match[0].lastIndexOf(name);
    symbols.push(new FakeDocumentSymbol(
      name,
      detail,
      runtimeVscode.SymbolKind.Field,
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length),
      createRangeFromOffsets(runtimeVscode, document, nameStart, nameStart + name.length)
    ) as unknown as vscode.DocumentSymbol);
  }

  return symbols.sort((left, right) =>
    left.selectionRange.start.line - right.selectionRange.start.line ||
    left.selectionRange.start.character - right.selectionRange.start.character
  );
}

/** Creates a VS Code range from source offsets in the fake text document. */
function createRangeFromOffsets(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  start: number,
  end: number
): vscode.Range {
  return new runtimeVscode.Range(document.positionAt(start), document.positionAt(end));
}

/** Finds the matching class-body brace for fake symbol nesting. */
function findFakeMatchingBrace(text: string, openBrace: number): number | undefined {
  let depth = 0;
  for (let index = openBrace; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

function localize(message: string, args?: Record<string, string | number | boolean>): string {
  return Object.entries(args ?? {}).reduce((current, [key, value]) =>
    current.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)), message
  );
}

/** Creates a narrow C# symbol service mock for tests that call index builders directly. */
function createFakeCSharpSymbolLanguageService(typesByPath: Record<string, CSharpTypeSymbolSnapshot[]>): CSharpSymbolLanguageService {
  return {
    async getPrimaryTopLevelType() {
      return undefined;
    },
    async findMethods() {
      return [];
    },
    async findTypes(uri) {
      return typesByPath[uri.fsPath] ?? [];
    },
    async findUnityEventFields() {
      return [];
    },
    async findMethodAtPosition() {
      return undefined;
    },
    async findUnityEventFieldAtPosition() {
      return undefined;
    },
    async findTargetMethodPosition() {
      return [];
    },
    async findReferences() {
      return [];
    },
    async buildRenameEdit() {
      return undefined;
    }
  };
}

/** Asserts the visible CodeLens feedback shown while Unity references are still scanning. */
async function assertPendingCodeLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument
): Promise<void> {
  assert.deepStrictEqual((await runtime.provideCodeLenses(document)).map(lens => lens.command?.title), [
    '- Unity serialized instances',
    '- UnityEvent references',
    '- UnityEvent targets'
  ]);
}

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}

async function waitForTimers(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class FakeRange {
  constructor(
    public readonly start: vscode.Position,
    public readonly end: vscode.Position
  ) {}
}

class FakeCodeLens {
  constructor(
    public readonly range: vscode.Range,
    public readonly command?: vscode.Command
  ) {}
}

/** Represents the subset of VS Code DocumentSymbol used by the fake C# language server. */
class FakeDocumentSymbol {
  constructor(
    public readonly name: string,
    public readonly detail: string,
    public readonly kind: vscode.SymbolKind,
    public readonly range: vscode.Range,
    public readonly selectionRange: vscode.Range,
    public readonly children: vscode.DocumentSymbol[] = []
  ) {}
}

/** Records status bar calls made by background scan reporting tests. */
class FakeStatusBarItem {
  text = '';
  tooltip: string | undefined;
  showCount = 0;
  hideCount = 0;
  disposeCount = 0;

  /** Records a visible status bar update. */
  show(): void {
    this.showCount += 1;
  }

  /** Records that the status bar item was hidden. */
  hide(): void {
    this.hideCount += 1;
  }

  /** Records that the feature disposed the status bar item. */
  dispose(): void {
    this.disposeCount += 1;
  }
}

/** Captures file watcher callbacks so tests can trigger serialized asset changes. */
class FakeFileSystemWatcher {
  private readonly createListeners: Array<(uri: vscode.Uri) => unknown> = [];
  private readonly changeListeners: Array<(uri: vscode.Uri) => unknown> = [];
  private readonly deleteListeners: Array<(uri: vscode.Uri) => unknown> = [];

  /** Registers a create listener. */
  onDidCreate(listener: (uri: vscode.Uri) => unknown): vscode.Disposable {
    this.createListeners.push(listener);
    return createDisposable();
  }

  /** Registers a change listener. */
  onDidChange(listener: (uri: vscode.Uri) => unknown): vscode.Disposable {
    this.changeListeners.push(listener);
    return createDisposable();
  }

  /** Registers a delete listener. */
  onDidDelete(listener: (uri: vscode.Uri) => unknown): vscode.Disposable {
    this.deleteListeners.push(listener);
    return createDisposable();
  }

  /** Fires the change callbacks used by cache invalidation tests. */
  fireChange(uri: vscode.Uri): void {
    for (const listener of this.changeListeners) {
      listener(uri);
    }
  }

  /** Disposes the watcher listeners. */
  dispose(): void {
    this.createListeners.length = 0;
    this.changeListeners.length = 0;
    this.deleteListeners.length = 0;
  }
}

class FakeCancellationToken {
  private readonly listeners: Array<() => unknown> = [];
  isCancellationRequested = false;

  onCancellationRequested = (listener: () => unknown): vscode.Disposable => {
    this.listeners.push(listener);
    return createDisposable();
  };

  cancel(): void {
    this.isCancellationRequested = true;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

class FakeEventEmitter<T> {
  private readonly listeners: Array<(event: T) => unknown> = [];

  event = (listener: (event: T) => unknown): vscode.Disposable => {
    this.listeners.push(listener);
    return createDisposable();
  };

  fire(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

class FakeLocation {
  constructor(
    public readonly uri: vscode.Uri,
    position: vscode.Position
  ) {
    this.range = new FakeRange(position, position) as unknown as vscode.Range;
  }

  public readonly range: vscode.Range;
}

class FakeMarkdownString {
  value = '';

  appendMarkdown(value: string): void {
    this.value += value;
  }
}

class FakeHover {
  constructor(
    contents: FakeMarkdownString | FakeMarkdownString[],
    public readonly range?: vscode.Range
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents];
  }

  public readonly contents: FakeMarkdownString[];
}
