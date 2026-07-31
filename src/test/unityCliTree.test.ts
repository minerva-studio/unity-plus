import * as assert from 'assert';
import { buildUnityCliTestTree } from '../features/unity-test-runner/unity-cli/unityCliTree';
import {
  parseUnityCliDiscovery
} from '../features/unity-test-runner/unity-cli/unityCliProtocol';

describe('Unity CLI test tree', () => {
  it('uses parameter text to distinguish cases under one method', () => {
    const firstFullName = 'Amlos.Stories.PropertyBagTests.PropertyBagAudit(Amlos.Stories.DeathSpeakerData)';
    const secondFullName = 'Amlos.Stories.PropertyBagTests.PropertyBagAudit(Amlos.Stories.SoulShepherdData)';
    const discovery = parseUnityCliDiscovery(createDiscoveryEnvelope([
      discoveryRecord(firstFullName),
      discoveryRecord(secondFullName)
    ]));
    const tree = buildUnityCliTestTree('C:/Projects/Amlos', 'EditMode', discovery.cases);

    const method = tree[0].children[0].children[0].children[0].children[0].children[0];
    assert.strictEqual(method.label, 'PropertyBagAudit');
    assert.strictEqual(method.children.length, 2);
    assert.deepStrictEqual(method.children.map(child => ({ label: child.label, fullName: child.fullName })), [
      { label: 'Amlos.Stories.DeathSpeakerData', fullName: firstFullName },
      { label: 'Amlos.Stories.SoulShepherdData', fullName: secondFullName }
    ]);
  });
});

/** Creates a successful CLI discovery envelope with the supplied test records. */
function createDiscoveryEnvelope(tests: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    success: true,
    data: {
      success: true,
      result: {
        success: true,
        Tests: tests
      }
    }
  });
}

/** Creates a raw Pipeline parameterized-test record with its repeated method name. */
function discoveryRecord(fullName: string): Record<string, unknown> {
  return {
    Mode: 'EditMode',
    Assembly: 'Amlos.Tests',
    FullName: fullName,
    Name: 'PropertyBagAudit',
    Categories: [],
    Explicit: false
  };
}
