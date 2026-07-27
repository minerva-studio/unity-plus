import * as vscode from 'vscode';
import type { UnityTestMode, UnityTestNode } from './testModel';

export const testControllerId = 'unity-plus-tests';
export const testControllerLabel = 'Unity Tests';

export function createUnityTestController(
  onRefresh: () => Promise<void>,
  onRun: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>
) {
  const controller = vscode.tests.createTestController(testControllerId, testControllerLabel);

  controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (r, t) => onRun(r, t), true);

  controller.resolveHandler = async (item) => {
    if (item) return; // children pre-built
    await onRefresh();
  };
  // Route the Testing view's native refresh action through the same visible workflow.
  controller.refreshHandler = onRefresh;

  function updateTestTree(
    editModeTests: readonly UnityTestNode[],
    playModeTests: readonly UnityTestNode[]
  ): void {
    controller.items.replace([]);
    controller.items.add(buildRoot(controller, 'EditMode', editModeTests));
    controller.items.add(buildRoot(controller, 'PlayMode', playModeTests));
  }

  return {
    controller, updateTestTree,
    createTestRun: (r: vscode.TestRunRequest, n: string) => controller.createTestRun(r, n),
    dispose: () => controller.dispose(),
  };
}

function buildRoot(
  ctrl: vscode.TestController,
  mode: UnityTestMode,
  nodes: readonly UnityTestNode[]
): vscode.TestItem {
  const root = ctrl.createTestItem(`unity:${mode}`, mode, undefined);
  for (const node of nodes) root.children.add(buildItem(ctrl, node));
  return root;
}

function buildItem(ctrl: vscode.TestController, node: UnityTestNode): vscode.TestItem {
  const item = ctrl.createTestItem(`unity:${node.id}`, node.label, undefined);
  for (const child of node.children) item.children.add(buildItem(ctrl, child));
  return item;
}
