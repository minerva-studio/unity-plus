import * as vscode from 'vscode';
import type { UnityTestInfo, UnityTestMode, UnityTestTree } from './testModel';
import { buildUnityTestTree } from './testModel';

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

  function updateTestTree(editModeTests: UnityTestInfo[], playModeTests: UnityTestInfo[]): void {
    controller.items.replace([]);
    controller.items.add(buildRoot(controller, 'EditMode', buildUnityTestTree(editModeTests)));
    controller.items.add(buildRoot(controller, 'PlayMode', buildUnityTestTree(playModeTests)));
  }

  return {
    controller, updateTestTree,
    createTestRun: (r: vscode.TestRunRequest, n: string) => controller.createTestRun(r, n),
    dispose: () => controller.dispose(),
  };
}

function buildRoot(ctrl: vscode.TestController, mode: UnityTestMode, tree: UnityTestTree): vscode.TestItem {
  const root = ctrl.createTestItem(`unity:${mode}`, mode, undefined);
  for (const n of tree.roots) root.children.add(buildItem(ctrl, n, tree));
  return root;
}

function buildItem(ctrl: vscode.TestController, info: UnityTestInfo, tree: UnityTestTree): vscode.TestItem {
  const item = ctrl.createTestItem(`unity:${info.Id}`, info.Name, undefined);
  const kids = tree.childrenById.get(info.Id);
  if (kids) for (const k of kids) item.children.add(buildItem(ctrl, k, tree));
  return item;
}
