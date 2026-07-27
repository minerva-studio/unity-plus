import type { UnityTestNode } from '../testModel';
import type { UnityTestInfo } from './testModel';

/** Maps the IDE package's flat Parent indexes to backend-neutral tree nodes. */
export function mapUnityTestAdaptorsToNodes(tests: readonly UnityTestInfo[]): UnityTestNode[] {
  const childrenByIndex: UnityTestNode[][] = tests.map(() => []);
  const nodes = tests.map((test, index) => ({
    id: test.Id,
    label: test.Name,
    fullName: test.FullName || undefined,
    assembly: test.Assembly || undefined,
    executionScope: undefined as UnityTestNode['executionScope'],
    kind: (test.Method ? 'method' : undefined) as UnityTestNode['kind'],
    children: childrenByIndex[index]
  }));
  const roots: UnityTestNode[] = [];

  for (let index = 0; index < tests.length; index += 1) {
    const parentIndex = tests[index].Parent;
    if (parentIndex < 0 || parentIndex >= tests.length) {
      roots.push(nodes[index]);
      continue;
    }
    childrenByIndex[parentIndex].push(nodes[index]);
  }

  for (const node of nodes) {
    if (node.children.length === 0 && !node.kind) {
      node.kind = 'case';
    }
  }

  for (const node of nodes) {
    // Unity's testNames filter accepts methods and fixtures, but not namespace containers.
    if (node.fullName && (node.kind === 'method' || node.children.some(child => child.kind === 'method'))) {
      node.executionScope = { kind: 'testName', value: node.fullName };
    }
  }

  return roots;
}
