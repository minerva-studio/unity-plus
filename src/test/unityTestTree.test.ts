import * as assert from 'assert';
import type * as vscode from 'vscode';
import type { UnityTestNode } from '../features/unity-test-runner/testModel';
import { createUnityTestExecutionBatches } from '../features/unity-test-runner/testTree';

describe('Unity test execution planner', () => {
  it('keeps a namespace scope as one logical batch instead of expanding its fixtures', () => {
    const namespace = testNode('Tests.Combat', 'testName', [
      testNode('Tests.Combat.First.Passes', 'testName'),
      testNode('Tests.Combat.Second.Passes', 'testName')
    ]);
    const root = testNode('Tests', 'mode', [namespace]);
    const item = testItem('unity:Tests.Combat');

    const batches = createUnityTestExecutionBatches([item], new Map([['Tests.Combat', namespace]]), [root], []);

    assert.deepStrictEqual(batches, [{
      mode: 'EditMode',
      scope: { kind: 'testName', value: 'Tests.Combat' },
      expectedFullNames: ['Tests.Combat.First.Passes', 'Tests.Combat.Second.Passes']
    }]);
  });

  it('preserves assembly and mode roots, selection order, and parent-child de-duplication', () => {
    const first = testNode('Tests.One.A', 'testName');
    const second = testNode('Tests.One.B', 'testName');
    const assembly = testNode('One.dll', 'assembly', [first, second]);
    const root = testNode('Tests', 'mode', [assembly]);
    const assemblyItem = testItem('unity:One.dll');
    const childItem = testItem('unity:Tests.One.A', assemblyItem);
    const modeItem = testItem('unity:EditMode');
    const batches = createUnityTestExecutionBatches(
      [assemblyItem, childItem, modeItem],
      new Map([['One.dll', assembly], ['Tests.One.A', first]]),
      [root], []
    );

    assert.deepStrictEqual(batches, [
      { mode: 'EditMode', scope: { kind: 'assembly', value: 'One.dll' }, expectedFullNames: ['Tests.One.A', 'Tests.One.B'] },
      { mode: 'EditMode', scope: { kind: 'mode' }, expectedFullNames: ['Tests.One.A', 'Tests.One.B'] }
    ]);
  });
});

/** Creates one leaf or container node for planner-only tests. */
function testNode(fullName: string, kind: 'mode' | 'assembly' | 'testName', children: readonly UnityTestNode[] = []): UnityTestNode {
  return {
    id: `unity:${fullName}`,
    label: fullName,
    fullName,
    kind: children.length > 0 ? 'container' : 'case',
    executionScope: kind === 'mode' ? { kind } : { kind, value: fullName },
    children
  };
}

/** Creates the minimal VS Code TestItem shape consumed by the selection planner. */
function testItem(id: string, parent?: vscode.TestItem): vscode.TestItem {
  return { id, parent } as vscode.TestItem;
}
