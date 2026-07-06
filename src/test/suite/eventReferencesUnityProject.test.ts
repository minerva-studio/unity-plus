import * as assert from 'assert';
import * as vscode from 'vscode';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUnityEventReferenceIndex } from '../../features/event-references/eventReferences';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';
import { createLazyUnityMetadataIndex, createUnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityPlusLogger } from '../../unity/logger';

const gateGuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectRoot = 'unity-plus-real-unity-event-';

let tempDir: string;

suite('eventReferences - Real Unity Project Shape', () => {
  suiteSetup(() => {
    tempDir = createUnityProjectFixture();
  });

  suiteTeardown(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('resolves UnityEvent target methods from real .meta, prefab YAML, and C# source', async () => {
    const root = vscode.Uri.file(tempDir);
    const gateScript = vscode.Uri.file(join(tempDir, 'Assets', 'Scripts', 'Gate.cs'));
    const gatePrefab = vscode.Uri.file(join(tempDir, 'Assets', 'Prefabs', 'Gate.prefab'));
    const metadataIndex = createLazyUnityMetadataIndex({
      root,
      logger: createMemoryLogger(),
      createIndex: options => createUnityMetadataIndex({
        ...options,
        findMetaFiles: async () => [
          vscode.Uri.file(join(tempDir, 'Assets', 'Scripts', 'Gate.cs.meta'))
        ],
        watchMetaFiles: () => createDisposable()
      })
    });
    try {
      const index = await buildUnityEventReferenceIndex({
        runtimeVscode: vscode,
        logger: createMemoryLogger(),
        metadataIndex,
        getCacheVersion: () => 0,
        findAssetFiles: async () => [gatePrefab],
        findCSharpFiles: async () => [gateScript],
        readTextFile: async uri => new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri)),
        csharpLanguageService: createVscodeCSharpLanguageService(vscode)
      }, await metadataIndex.getOrBuild(), { mode: 'interactive' });

      const diagnostics = index.getDiagnostics();
      const methodReferences = index.getReferences('Assets/Scripts/Gate.cs', 'CanInteract', 'Amlos.Fixtures.Gate');
      const fieldReferences = index.getFieldReferences('Assets/Scripts/Gate.cs', 'OnCheckEnable', 'Amlos.Fixtures.Gate');
      const fieldTargets = index.getFieldTargets('Assets/Scripts/Gate.cs', 'OnCheckEnable', 'Amlos.Fixtures.Gate');

      assert.strictEqual(diagnostics.persistentCallCount, 1);
      assert.strictEqual(diagnostics.resolvedByTargetTypeNameCount, 1);
      assert.strictEqual(diagnostics.resolvedReferenceCount, 1);
      assert.strictEqual(methodReferences.length, 1);
      assert.strictEqual(fieldReferences.length, 1);
      assert.strictEqual(fieldTargets.length, 1);
      assert.strictEqual(fieldTargets[0].scriptPath, 'Assets/Scripts/Gate.cs');
    } finally {
      metadataIndex.dispose();
    }
  });
});

/** Creates a minimal on-disk Unity project with script metadata and prefab YAML. */
function createUnityProjectFixture(): string {
  const root = mkProjectDir();

  mkdirSync(join(root, 'Assets', 'Scripts'), { recursive: true });
  mkdirSync(join(root, 'Assets', 'Prefabs'), { recursive: true });
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true });
  mkdirSync(join(root, 'Packages'), { recursive: true });

  writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 2022.3.0f1\n', 'utf-8');
  writeFileSync(join(root, 'Packages', 'manifest.json'), '{"dependencies":{}}\n', 'utf-8');
  writeFileSync(join(root, 'Assets', 'Scripts', 'Gate.cs'), createGateScript(), 'utf-8');
  writeFileSync(join(root, 'Assets', 'Scripts', 'Gate.cs.meta'), createMonoScriptMeta(gateGuid), 'utf-8');
  writeFileSync(join(root, 'Assets', 'Prefabs', 'Gate.prefab'), createGatePrefab(), 'utf-8');

  return root;
}

/** Allocates a clean temporary directory for a Unity project fixture. */
function mkProjectDir(): string {
  const root = join(tmpdir(), `${projectRoot}${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Creates a C# script containing both the UnityEvent field and target method. */
function createGateScript(): string {
  return [
    'using UnityEngine;',
    'using UnityEngine.Events;',
    '',
    'namespace Amlos.Fixtures',
    '{',
    '    public sealed class Gate : MonoBehaviour',
    '    {',
    '        public UnityEvent OnCheckEnable = new();',
    '',
    '        public void CanInteract()',
    '        {',
    '        }',
    '    }',
    '}'
  ].join('\n');
}

/** Creates a Unity MonoScript .meta file with a stable script GUID. */
function createMonoScriptMeta(guid: string): string {
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'MonoImporter:',
    '  externalObjects: {}',
    '  serializedVersion: 2',
    '  defaultReferences: []'
  ].join('\n');
}

/** Creates prefab YAML with a persistent UnityEvent call targeting the same MonoBehaviour. */
function createGatePrefab(): string {
  return [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
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
    '        m_CallState: 2'
  ].join('\n');
}

/** Creates a test logger that records messages without touching the UI. */
function createMemoryLogger(): UnityPlusLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    dispose: () => undefined
  };
}

/** Creates a disposable for test-only services that should not keep file watchers alive. */
function createDisposable(): vscode.Disposable {
  return { dispose: () => undefined };
}
