import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import { createUnityTestBridge, type UnityTestBridgeClient } from './unityTestBridge';
import { createUnityTestController } from './testController';
import { discoverUnityTests } from './testDiscovery';
import { executeUnityTests } from './testExecution';
import type { UnityTestMode } from './testModel';

export interface UnityTestRunnerFeatureOptions {
  /** The root URI of the Unity project workspace. */
  root?: vscode.Uri;
}

/**
 * Registers the Unity Test Runner feature.
 *
 * Creates a persistent UDP bridge to com.unity.ide.visualstudio, hooks into
 * the VS Code Testing API, and exposes commands for test discovery / execution.
 */
export function registerUnityTestRunnerFeature(
  logger: UnityPlusLogger,
  options: UnityTestRunnerFeatureOptions = {}
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let bridge: UnityTestBridgeClient | undefined;

  // --- Test Controller ---
  const { controller, editModeProfile, updateTestTree, createTestRun, dispose: disposeController } =
    createUnityTestController(
      () => refreshTests(logger, options.root),
      (request, token) => runTests(logger, options.root, request, token)
    );

  disposables.push({ dispose: disposeController });

  // --- Commands ---
  disposables.push(
    vscode.commands.registerCommand('unityPlus.refreshUnityTests', async () => {
      await refreshTests(logger, options.root);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('unityPlus.runAllUnityTests', async () => {
      // Trigger the EditMode run profile.
      await controller.refreshHandler?.(new vscode.CancellationTokenSource().token);
      const runReq = new vscode.TestRunRequest();
      await editModeProfile.runHandler(runReq, new vscode.CancellationTokenSource().token);
    })
  );

  // --- Bridge lifecycle ---
  async function ensureBridge(): Promise<UnityTestBridgeClient> {
    if (bridge?.connected) {
      return bridge;
    }

    bridge = createUnityTestBridge();

    bridge.onError(err => {
      logger.warn(`Unity test bridge error: ${err.message}`);
    });

    return bridge;
  }

  async function refreshTests(
    log: UnityPlusLogger,
    root?: vscode.Uri
  ): Promise<void> {
    if (!root) {
      log.warn('Cannot refresh Unity tests: no Unity project root detected.');
      return;
    }

    const projectRoot = root.fsPath;

    try {
      const client = await ensureBridge();
      await client.connect(projectRoot);

      log.info('Discovering Unity tests...');
      const { editModeTests, playModeTests } = await discoverUnityTests(client);

      updateTestTree(editModeTests, playModeTests);
      log.info(
        `Unity test discovery complete: ${editModeTests.length} EditMode, ${playModeTests.length} PlayMode tests.`
      );
    } catch (error) {
      log.warn(`Unity test discovery failed: ${errorMessage(error)}`);
    }
  }

  async function runTests(
    log: UnityPlusLogger,
    root: vscode.Uri | undefined,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!root) {
      log.warn('Cannot run Unity tests: no Unity project root detected.');
      return;
    }

    const projectRoot = root.fsPath;

    try {
      const client = await ensureBridge();
      await client.connect(projectRoot);

      // Determine mode from profile tags or default to EditMode.
      // VS Code Testing API attaches the profile info to the request indirectly.
      // We infer mode from which items are requested. For now, default to EditMode.
      const mode: UnityTestMode = 'EditMode';

      // Collect test FullNames from the request.
      const testItems = collectTestItems(request);
      const run = createTestRun(request, `Unity ${mode} Tests`);

      if (testItems.length === 0) {
        // If no specific items are requested, discover all and run all.
        const { editModeTests } = await discoverUnityTests(client);
        const allNames = editModeTests.map(t => t.FullName);

        // Enqueue all items.
        for (const test of editModeTests) {
          run.enqueued({
            id: `unity:${test.Id}`,
            label: test.Name
          } as vscode.TestItem);
        }

        await executeUnityTests(client, run, mode, allNames, token);
      } else {
        // Enqueue the requested items.
        for (const item of testItems) {
          run.enqueued(item);
        }

        const fullNames = testItems
          .map(item => item.id.replace(/^unity:/, ''))
          .filter(Boolean);

        // Also discover to get FullName mapping if needed.
        await discoverUnityTests(client);

        await executeUnityTests(client, run, mode, fullNames, token);
      }
    } catch (error) {
      log.warn(`Unity test execution failed: ${errorMessage(error)}`);
    }
  }

  // --- Cleanup ---
  disposables.push({
    dispose: () => {
      bridge?.disconnect();
    }
  });

  return vscode.Disposable.from(...disposables);
}

// --- Internal helpers ---

function collectTestItems(request: vscode.TestRunRequest): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];

  if (request.include) {
    for (const item of request.include) {
      items.push(item);
      collectChildren(item, items);
    }
  }

  return items;
}

function collectChildren(parent: vscode.TestItem, out: vscode.TestItem[]): void {
  parent.children.forEach(child => {
    out.push(child);
    collectChildren(child, out);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
