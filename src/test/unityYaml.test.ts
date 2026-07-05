import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getUnityYamlDocumentFileId,
  getUnityYamlDocumentScalar,
  getUnityYamlDocumentScriptReference,
  getUnityYamlPersistentCalls,
  getUnityYamlPrefabOverridePersistentCalls,
  parseUnityYamlAsset,
  writeUnityYaml
} from '../unity/unityYaml';

describe('unityYaml adapter', () => {
  it('parses Unity documents, script references, editor class identifiers, and persistent calls', () => {
    const asset = parseUnityYamlAsset(createUnityYamlFixture());
    const gameObject = asset.documentsByFileId.get('100');
    const behaviour = asset.documentsByFileId.get('-9223372036854775808');
    const prefabInstance = asset.documentsByFileId.get('300');

    assert.strictEqual(asset.documents.length, 3);
    assert.strictEqual(gameObject?.classId, 1);
    assert.strictEqual(behaviour?.classId, 114);
    assert.strictEqual(behaviour?.stripped, true);
    assert.strictEqual(prefabInstance?.typeName, 'PrefabInstance');
    assert.strictEqual(getUnityYamlDocumentScalar(behaviour!, 'm_EditorClassIdentifier'), 'Gameplay::Amlos.Gameplay.Gate');
    assert.strictEqual(getUnityYamlDocumentFileId(behaviour!, 'm_GameObject'), '100');

    const script = getUnityYamlDocumentScriptReference(behaviour!);
    assert.strictEqual(script?.guid, gateScriptGuid);
    assert.strictEqual(typeof script?.line, 'number');
    assert.strictEqual(typeof script?.character, 'number');

    const calls = getUnityYamlPersistentCalls(behaviour!);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].eventFieldName, 'OnBookPagePasted');
    assert.strictEqual(calls[0].targetFileId, '200');
    assert.strictEqual(calls[0].targetTypeName, 'Amlos.Gameplay.GateTarget, Assembly-CSharp');
    assert.strictEqual(calls[0].methodName, 'OpenGate');
    assert.strictEqual(calls[0].callState, 2);
  });

  it('parses PrefabInstance UnityEvent override modifications', () => {
    const asset = parseUnityYamlAsset(createUnityYamlFixture());
    const prefabInstance = asset.documentsByFileId.get('300');
    const calls = getUnityYamlPrefabOverridePersistentCalls(prefabInstance!);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].ownerFileId, '-9223372036854775808');
    assert.strictEqual(calls[0].eventFieldName, 'OnBookPagePasted');
    assert.strictEqual(calls[0].targetFileId, '200');
    assert.strictEqual(calls[0].targetTypeName, 'Amlos.Gameplay.GateTarget, Assembly-CSharp');
    assert.strictEqual(calls[0].methodName, 'CloseGate');
    assert.strictEqual(calls[0].callState, 1);
  });

  it('writer smoke preserves CodeLens-relevant semantic fields after reparsing', () => {
    const asset = parseUnityYamlAsset(createUnityYamlFixture());
    const rewritten = writeUnityYaml(asset.file);
    const reparsed = parseUnityYamlAsset(rewritten);
    const behaviour = reparsed.documentsByFileId.get('-9223372036854775808');
    const prefabInstance = reparsed.documentsByFileId.get('300');

    assert.strictEqual(reparsed.documents.length, asset.documents.length);
    assert.strictEqual(getUnityYamlDocumentScriptReference(behaviour!)?.guid, gateScriptGuid);
    assert.strictEqual(getUnityYamlDocumentScalar(behaviour!, 'm_EditorClassIdentifier'), 'Gameplay::Amlos.Gameplay.Gate');
    assert.strictEqual(getUnityYamlPersistentCalls(behaviour!)[0].methodName, 'OpenGate');
    assert.strictEqual(getUnityYamlPrefabOverridePersistentCalls(prefabInstance!)[0].methodName, 'CloseGate');
  });

  it('projects event reference fields without materializing unrelated large fields', () => {
    const full = parseUnityYamlAsset(createUnityYamlFixture());
    const projected = parseUnityYamlAsset(createUnityYamlFixture(), { profile: 'eventReferences' });
    const fullBehaviour = full.documentsByFileId.get('-9223372036854775808');
    const projectedBehaviour = projected.documentsByFileId.get('-9223372036854775808');

    assert.ok(fullBehaviour?.properties.unrelatedLargeField);
    assert.strictEqual(projectedBehaviour?.properties.unrelatedLargeField, undefined);
    assert.strictEqual(getUnityYamlDocumentScriptReference(projectedBehaviour!)?.guid, gateScriptGuid);
    assert.strictEqual(getUnityYamlPersistentCalls(projectedBehaviour!)[0].methodName, 'OpenGate');
    assert.strictEqual(getUnityYamlDocumentScalar(projectedBehaviour!, 'm_EditorClassIdentifier'), 'Gameplay::Amlos.Gameplay.Gate');

    const explicitlyRequested = parseUnityYamlAsset(createUnityYamlFixture(), {
      profile: 'eventReferences',
      sourcePaths: [['unrelatedLargeField']]
    }).documentsByFileId.get('-9223372036854775808');
    assert.ok(explicitlyRequested?.properties.unrelatedLargeField);
  });

  it('parses 20k script-only documents in eventReferences profile without full source trees', function () {
    this.timeout(5000);

    const asset = parseUnityYamlAsset(createManyScriptOnlyDocuments(20_000), { profile: 'eventReferences' });
    const first = asset.documents[0];
    const last = asset.documents[asset.documents.length - 1];

    assert.strictEqual(asset.documents.length, 20_000);
    assert.strictEqual(getUnityYamlDocumentScriptReference(first)?.guid, gateScriptGuid);
    assert.strictEqual(getUnityYamlDocumentScriptReference(last)?.guid, gateScriptGuid);
    assert.strictEqual(first.properties.unrelatedLargeField, undefined);
    assert.deepStrictEqual(Object.keys(first.source?.properties ?? {}).sort(), ['m_Script'].sort());
  });

  it('keeps parser runtime away from legacy split and second-pass source map helpers', () => {
    const parserSource = readFileSync(join(__dirname, '../../src/vendor/unity-yaml-bridge/unity-yaml-parser.ts'), 'utf8');

    assert.strictEqual(parserSource.includes("content.split('\\n')"), false);
    assert.strictEqual(parserSource.includes('bodyLines'), false);
    assert.strictEqual(parserSource.includes('bodyLineOffsets'), false);
    assert.strictEqual(parserSource.includes('buildDocumentPropertySource'), false);
    assert.strictEqual(parserSource.includes('smartSplitWithPositions'), false);
  });
});

const gateScriptGuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const basePrefabGuid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Creates a compact Unity YAML fixture with multiline flow mappings and prefab overrides. */
function createUnityYamlFixture(): string {
  return `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: -9223372036854775808}
  m_Layer: 0
  m_Name: Gate
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 1
--- !u!114 &-9223372036854775808 stripped
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_EditorHideFlags: 0
  m_Script: {fileID: 11500000, guid: ${gateScriptGuid},
    type: 3}
  m_Name:
  m_EditorClassIdentifier: Gameplay::Amlos.Gameplay.Gate
  nestedReference: {target: {fileID: 200, guid: ${basePrefabGuid}, type: 3}, enabled: 1}
  unrelatedLargeField:
    nestedValue: this should not be materialized by the event reference projection
  OnBookPagePasted:
    m_PersistentCalls:
      m_Calls:
      - m_Target: {fileID: 200}
        m_TargetAssemblyTypeName: Amlos.Gameplay.GateTarget, Assembly-CSharp
        m_MethodName: OpenGate
        m_CallState: 2
--- !u!1001 &300
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 0}
    m_Modifications:
    - target: {fileID: -9223372036854775808, guid: ${basePrefabGuid}, type: 3}
      propertyPath: OnBookPagePasted.m_PersistentCalls.m_Calls.Array.data[0].m_MethodName
      value: CloseGate
      objectReference: {fileID: 0}
    - target: {fileID: -9223372036854775808, guid: ${basePrefabGuid}, type: 3}
      propertyPath: OnBookPagePasted.m_PersistentCalls.m_Calls.Array.data[0].m_TargetAssemblyTypeName
      value: Amlos.Gameplay.GateTarget, Assembly-CSharp
      objectReference: {fileID: 0}
    - target: {fileID: -9223372036854775808, guid: ${basePrefabGuid}, type: 3}
      propertyPath: OnBookPagePasted.m_PersistentCalls.m_Calls.Array.data[0].m_Target
      value:
      objectReference: {fileID: 200}
    - target: {fileID: -9223372036854775808, guid: ${basePrefabGuid}, type: 3}
      propertyPath: OnBookPagePasted.m_PersistentCalls.m_Calls.Array.data[0].m_CallState
      value: 1
      objectReference: {fileID: 0}
    m_RemovedComponents: []
    m_RemovedGameObjects: []
    m_AddedGameObjects: []
    m_AddedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: ${basePrefabGuid}, type: 3}
`;
}

/** Creates many script-only documents for parser projection regression coverage. */
function createManyScriptOnlyDocuments(count: number): string {
  const documents: string[] = ['%YAML 1.1', '%TAG !u! tag:unity3d.com,2011:'];

  for (let index = 0; index < count; index++) {
    documents.push([
      `--- !u!114 &${index + 1}`,
      'MonoBehaviour:',
      '  unrelatedLargeField:',
      '    nestedValue: skipped',
      `  m_Script: {fileID: 11500000, guid: ${gateScriptGuid}, type: 3}`
    ].join('\n'));
  }

  return documents.join('\n');
}
