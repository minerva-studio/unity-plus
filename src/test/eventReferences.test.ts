import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  buildUnityEventReferenceIndex,
  parseUnityEventReferences,
  registerEventReferenceFeature
} from '../features/event-references/eventReferences';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';
import { createLazyUnityMetadataIndex, UnityMetadataIndex } from '../unity/metadataIndex';

const gateGuid = '11111111111111111111111111111111';
const gateScriptPath = 'Assets/Gate.cs';

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

  it('parses m_Target fileID from nested YAML lines', async () => {
    const references = await parseUnityEventReferences(createPrefabYamlWithNestedTarget(2), 'Assets/Gate.prefab', 'prefab', createMetadataIndex(), createTypeResolver());

    assert.strictEqual(references.length, 1);
    assert.strictEqual(references[0].methodName, 'CanInteract');
    assert.strictEqual(references[0].line, 14);
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
      readTextFile: async () => createPrefabYaml(2),
      resolveCSharpType: async typeName => createTypeResolver()(typeName)
    });

    const initialLenses = await runtime.provideCodeLenses(csharpDocument);
    assert.deepStrictEqual(initialLenses, []);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(csharpDocument);
    assert.strictEqual(lenses.length, 2);
    assert.strictEqual(lenses[0].command?.title, 'UnityEvent references: 1');
    assert.strictEqual(lenses[0].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[0].command?.arguments?.[0], {
      kind: 'method',
      scriptPath: gateScriptPath,
      symbolName: 'CanInteract',
      position: new FakePosition(4, 14)
    });
    assert.strictEqual(lenses[1].command?.title, 'UnityEvent references: 1');
    assert.strictEqual(lenses[1].command?.command, 'unityPlus.showUnityEventReferenceLocations');
    assert.deepStrictEqual(lenses[1].command?.arguments?.[0], {
      kind: 'field',
      scriptPath: gateScriptPath,
      symbolName: 'OnCheckEnable',
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
    assert.deepStrictEqual(runtime.referenceCommands[0].position, new FakePosition(4, 14));
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(13, 22));
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
    assert.deepStrictEqual(await runtime.provideCodeLenses(document), []);
    assert.deepStrictEqual(await runtime.provideCodeLenses(document), []);
    assert.strictEqual(assetScans, 0);

    await buildStarted;
    assert.strictEqual(assetScans, 1);

    releaseBuild?.();
    await runtime.waitForCodeLensChange();
  });

  it('does not schedule a background index build for canceled CodeLens requests', async () => {
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

    assert.deepStrictEqual(lenses, []);
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
    const initialLenses = await runtime.provideCodeLenses(document);
    assert.deepStrictEqual(initialLenses, []);

    await runtime.waitForCodeLensChange();
    const lenses = await runtime.provideCodeLenses(document);

    await runtime.runCommand('unityPlus.showUnityEventReferenceLocations', lenses[0].command?.arguments?.[0]);

    assert.strictEqual(runtime.referenceCommands.length, 1);
    assert.strictEqual(runtime.referenceCommands[0].locations[0].uri.fsPath, '/Project/Assets/Gate.prefab');
    assert.deepStrictEqual(runtime.referenceCommands[0].locations[0].range.start, new FakePosition(13, 22));
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
    assert.deepStrictEqual(lenses, []);

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

  it('falls back to C# source scanning when workspace symbols do not resolve a target type', async () => {
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
        : createInstanceTargetYaml(2)
    }, createMetadataIndex());

    assert.strictEqual(index.getReferenceCount('Assets/Scripts/Gate.cs', 'Interact'), 1);
    assert.strictEqual(index.getDiagnostics().resolvedByTargetTypeNameCount, 1);
    assert.strictEqual(csharpFileScans, 1);
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

    assert.strictEqual(runtime.infoMessages[0].includes('scanned 0 prefab(s) and 1 scene(s)'), true);
    assert.strictEqual(runtime.infoMessages[0].includes('resolved 0 UnityEvent reference(s)'), true);
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
  progressReports: Array<{ message?: string; increment?: number }>;
  progressOptions: vscode.ProgressOptions[];
  progressTokens: FakeCancellationToken[];
  referenceCommands: Array<{ uri: vscode.Uri; position: vscode.Position; locations: vscode.Location[] }>;
  codeLensChangeCount: number;
  runCommand(command: string, ...args: unknown[]): Promise<void>;
  provideCodeLenses(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<vscode.CodeLens[]>;
  provideHover(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<vscode.Hover | undefined>;
  waitForCodeLensChange(): Promise<void>;
}

interface EventReferenceRuntimeOptions {
  configuration?: Record<string, unknown>;
}

function createEventReferenceRuntime(options: EventReferenceRuntimeOptions = {}): EventReferenceRuntime {
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const codeLensProviders: vscode.CodeLensProvider[] = [];
  const hoverProviders: vscode.HoverProvider[] = [];
  const infoMessages: string[] = [];
  const progressReports: Array<{ message?: string; increment?: number }> = [];
  const progressOptions: vscode.ProgressOptions[] = [];
  const progressTokens: FakeCancellationToken[] = [];
  const referenceCommands: Array<{ uri: vscode.Uri; position: vscode.Position; locations: vscode.Location[] }> = [];
  const codeLensChangeResolvers: Array<() => void> = [];
  let codeLensChangeCount = 0;
  const runtime = {
    commands: {
      registerCommand(command: string, callback: (...args: unknown[]) => unknown): vscode.Disposable {
        commands.set(command, callback);
        return createDisposable();
      },
      executeCommand: async (command: string, uri: vscode.Uri, position: vscode.Position, locations: vscode.Location[]) => {
        if (command === 'editor.action.showReferences') {
          referenceCommands.push({ uri, position, locations });
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
      getConfiguration: () => ({
        get: (key: string, defaultValue?: unknown) => Object.prototype.hasOwnProperty.call(options.configuration ?? {}, key)
          ? options.configuration?.[key]
          : defaultValue
      })
    },
    window: {
      showInformationMessage: (message: string) => {
        infoMessages.push(message);
        return undefined;
      },
      showWarningMessage: () => undefined,
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
    ProgressLocation: {
      Notification: 15
    },
    Hover: FakeHover,
    MarkdownString: FakeMarkdownString,
    Uri: {
      file: createUri
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    infoMessages,
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
      return await hoverProviders[0]?.provideHover(document, position, token) ?? undefined;
    },
    async waitForCodeLensChange(): Promise<void> {
      if (codeLensChangeCount > 0) {
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
  return fullTypeName => fullTypeName === 'Amlos.Fixtures.Gate' ? gateScriptPath : undefined;
}

function createMetadataIndex(): UnityMetadataIndex {
  return {
    rebuild: async () => undefined,
    getAssetPath: guid => guid === gateGuid ? gateScriptPath : undefined,
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

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
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
