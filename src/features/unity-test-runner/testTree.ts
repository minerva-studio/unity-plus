import type * as vscode from 'vscode';
import type {
  UnityTestExecutionBatch,
  UnityTestMode,
  UnityTestNode
} from './testModel';

/** Flattens a backend-neutral test tree while preserving depth-first order. */
export function flattenUnityTestNodes(roots: readonly UnityTestNode[]): UnityTestNode[] {
  const nodes: UnityTestNode[] = [];

  function visit(node: UnityTestNode): void {
    nodes.push(node);
    for (const child of node.children) {
      visit(child);
    }
  }

  for (const root of roots) {
    visit(root);
  }
  return nodes;
}

/** Counts executable leaves without counting method-suite containers twice. */
export function countUnityTestLeaves(roots: readonly UnityTestNode[]): number {
  let count = 0;
  for (const node of roots) {
    if (node.children.length === 0) {
      if (node.kind !== 'container') {
        count += 1;
      }
      continue;
    }
    count += countUnityTestLeaves(node.children);
  }
  return count;
}

/** Collects executable leaf names below one backend-neutral test node. */
export function collectUnityTestLeafFullNames(node: UnityTestNode): string[] {
  if (node.children.length === 0) {
    return node.fullName && node.kind !== 'container' ? [node.fullName] : [];
  }

  const names: string[] = [];
  for (const child of node.children) {
    names.push(...collectUnityTestLeafFullNames(child));
  }
  return names;
}

/** Builds logical backend-neutral selections without prematurely splitting parent scopes. */
export function createUnityTestExecutionBatches(
  testItems: readonly vscode.TestItem[],
  testLookup: ReadonlyMap<string, UnityTestNode>,
  editTests: readonly UnityTestNode[],
  playTests: readonly UnityTestNode[]
): UnityTestExecutionBatch[] {
  const batches: UnityTestExecutionBatch[] = [];
  const topItems = testItems.filter(item => {
    const parent = item.parent;
    return !parent || !testItems.includes(parent);
  });

  for (const item of topItems) {
    const rootMode = getModeRoot(item);
    if (rootMode) {
      appendModeRootBatches(
        batches,
        rootMode,
        rootMode === 'EditMode' ? editTests : playTests
      );
      continue;
    }

    const unityId = item.id.startsWith('unity:') ? item.id.slice(6) : item.id;
    const node = testLookup.get(unityId);
    if (!node) {
      continue;
    }

    const mode = inferUnityTestMode(item);
    appendUnityTestExecutionBatches(batches, mode, node);
  }

  if (batches.length === 0) {
    appendModeRootBatches(batches, 'EditMode', editTests);
    appendModeRootBatches(batches, 'PlayMode', playTests);
  }

  return batches;
}

/** Adds the smallest native scopes available below one selected VS Code mode root. */
function appendModeRootBatches(
  batches: UnityTestExecutionBatch[],
  mode: UnityTestMode,
  roots: readonly UnityTestNode[]
): void {
  for (const root of roots) {
    appendUnityTestExecutionBatches(batches, mode, root);
  }
}

/** Identifies the synthetic VS Code mode root, which has no discovery node. */
function getModeRoot(item: vscode.TestItem): UnityTestMode | undefined {
  if (item.id === 'unity:EditMode') {
    return 'EditMode';
  }
  if (item.id === 'unity:PlayMode') {
    return 'PlayMode';
  }
  return undefined;
}

/** Walks up the VS Code item tree to determine its Unity test mode. */
function inferUnityTestMode(item: vscode.TestItem): UnityTestMode {
  let current: vscode.TestItem | undefined = item;
  while (current) {
    if (current.id === 'unity:EditMode') {
      return 'EditMode';
    }
    if (current.id === 'unity:PlayMode') {
      return 'PlayMode';
    }
    current = current.parent;
  }
  return 'EditMode';
}

/** Preserves an executable parent scope, descending only through visual containers. */
function appendUnityTestExecutionBatches(
  batches: UnityTestExecutionBatch[],
  mode: UnityTestMode,
  node: UnityTestNode
): void {
  const expectedFullNames = collectUnityTestLeafFullNames(node);
  if (node.executionScope && expectedFullNames.length > 0) {
    batches.push({ mode, scope: node.executionScope, expectedFullNames });
    return;
  }

  if (!node.executionScope) {
    for (const child of node.children) {
      appendUnityTestExecutionBatches(batches, mode, child);
    }
  }
}
