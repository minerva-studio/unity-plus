import * as vscode from 'vscode';
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

/** Builds the smallest independent backend commands for the selected VS Code items. */
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
    const unityId = item.id.startsWith('unity:') ? item.id.slice(6) : item.id;
    const node = testLookup.get(unityId);
    if (!node) {
      continue;
    }

    const mode = inferUnityTestMode(item);
    appendUnityTestExecutionBatches(
      batches,
      mode,
      node
    );
  }

  if (batches.length === 0) {
    appendLeafBatches(batches, 'EditMode', editTests);
    appendLeafBatches(batches, 'PlayMode', playTests);
  }

  return batches;
}

/** Adds one direct batch for every executable node when the request selects the whole tree. */
function appendLeafBatches(
  batches: UnityTestExecutionBatch[],
  mode: UnityTestMode,
  roots: readonly UnityTestNode[]
): void {
  for (const node of flattenUnityTestNodes(roots)) {
    if ((node.kind !== 'method' && node.kind !== 'case') || !node.fullName) {
      continue;
    }
    batches.push({
      mode,
      fullName: node.fullName,
      expectedFullNames: [node.fullName],
      includeExplicit: false
    });
  }
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

/** Expands one selected node into independent commands while preserving visible leaves. */
function appendUnityTestExecutionBatches(
  batches: UnityTestExecutionBatch[],
  mode: UnityTestMode,
  node: UnityTestNode
): void {
  if (!node.fullName) {
    for (const child of node.children) {
      appendUnityTestExecutionBatches(batches, mode, child);
    }
    return;
  }

  if (node.kind === 'method') {
    const expectedFullNames = collectUnityTestLeafFullNames(node);
    batches.push({
      mode,
      fullName: node.fullName,
      expectedFullNames: expectedFullNames.length > 0 ? expectedFullNames : [node.fullName],
      includeExplicit: false
    });
    return;
  }

  if (node.kind === 'case' || node.children.length === 0) {
    batches.push({
      mode,
      fullName: node.fullName,
      expectedFullNames: [node.fullName],
      includeExplicit: false
    });
    return;
  }

  const directMethods = node.children.filter(child => child.kind === 'method');
  if (directMethods.length > 0) {
    const expectedFullNames = collectUnityTestLeafFullNames(node);
    batches.push({
      mode,
      fullName: node.fullName,
      expectedFullNames,
      includeExplicit: false
    });
    return;
  }

  for (const child of node.children) {
    appendUnityTestExecutionBatches(batches, mode, child);
  }
}
