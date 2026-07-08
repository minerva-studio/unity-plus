import * as vscode from 'vscode';
import type { UnityTestInfo, UnityTestMode, UnityTestTree } from './testModel';
import { buildUnityTestTree } from './testModel';

/** Label shown in the VS Code Testing panel. */
export const testControllerId = 'unity-plus-tests';
export const testControllerLabel = 'Unity Tests';

/**
 * Creates and configures a VS Code TestController for Unity tests.
 *
 * Returns the controller plus helpers to refresh the test tree and to
 * create TestRun instances bound to the controller.
 */
export function createUnityTestController(
  onRefresh: () => Promise<void>,
  onRun: (request: vscode.TestRunRequest, token: vscode.CancellationToken) => Promise<void>
): {
  controller: vscode.TestController;
  editModeProfile: vscode.TestRunProfile;
  playModeProfile: vscode.TestRunProfile;
  /** Rebuild the TestItem tree from a flat Unity test list. */
  updateTestTree: (editModeTests: UnityTestInfo[], playModeTests: UnityTestInfo[]) => void;
  /** Create a VS Code TestRun bound to this controller. */
  createTestRun: (request: vscode.TestRunRequest, name: string) => vscode.TestRun;
  dispose: () => void;
} {
  const controller = vscode.tests.createTestController(testControllerId, testControllerLabel);

  // --- Run profiles ---
  const editModeProfile = controller.createRunProfile(
    'EditMode',
    vscode.TestRunProfileKind.Run,
    (request, token) => onRun(request, token),
    true
  );

  const playModeProfile = controller.createRunProfile(
    'PlayMode',
    vscode.TestRunProfileKind.Run,
    (request, token) => onRun(request, token),
    false
  );

  editModeProfile.tag = new vscode.TestTag('editMode');
  playModeProfile.tag = new vscode.TestTag('playMode');

  // --- Resolve handler ---
  controller.resolveHandler = async (item) => {
    if (item) {
      // Children are pre-built; nothing to resolve lazily for now.
      return;
    }
    // Root resolve: trigger full refresh.
    await onRefresh();
  };

  /**
   * Rebuild the full TestItem tree shown in the Testing panel.
   */
  function updateTestTree(editModeTests: UnityTestInfo[], playModeTests: UnityTestInfo[]): void {
    // Clear existing items by replacing the collection.
    controller.items.replace([]);

    const editTree = buildUnityTestTree(editModeTests);
    const playTree = buildUnityTestTree(playModeTests);

    const editRoot = buildTestItemTree(controller, 'EditMode', editTree);
    controller.items.add(editRoot);

    const playRoot = buildTestItemTree(controller, 'PlayMode', playTree);
    controller.items.add(playRoot);
  }

  function createTestRun(request: vscode.TestRunRequest, name: string): vscode.TestRun {
    return controller.createTestRun(request, name);
  }

  return { controller, editModeProfile, playModeProfile, updateTestTree, createTestRun, dispose: () => controller.dispose() };
}

// --- Internal helpers ---

function buildTestItemTree(
  controller: vscode.TestController,
  mode: UnityTestMode,
  tree: UnityTestTree
): vscode.TestItem {
  const rootItem = controller.createTestItem(`unity:${mode}`, mode, undefined);

  for (const node of tree.roots) {
    rootItem.children.add(createTestItemRecursive(controller, node, tree));
  }

  return rootItem;
}

function createTestItemRecursive(
  controller: vscode.TestController,
  info: UnityTestInfo,
  tree: UnityTestTree
): vscode.TestItem {
  const item = controller.createTestItem(
    `unity:${info.Id}`,
    info.Name,
    undefined // no source file URI — Unity doesn't provide it in TestAdaptor
  );

  const children = tree.childrenByParent.get(info.Id);
  if (children) {
    for (const child of children) {
      item.children.add(createTestItemRecursive(controller, child, tree));
    }
  }

  return item;
}
