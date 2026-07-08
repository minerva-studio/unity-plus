import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import { createUnityTestBridge, type UnityTestBridgeClient } from './unityTestBridge';
import { createUnityTestController } from './testController';
import { discoverUnityTests } from './testDiscovery';
import { executeUnityTests } from './testExecution';
import type { UnityTestInfo, UnityTestMode } from './testModel';

export interface UnityTestRunnerFeatureOptions { root?: vscode.Uri; }

export function registerUnityTestRunnerFeature(
  logger: UnityPlusLogger,
  options: UnityTestRunnerFeatureOptions = {}
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const testLookup = new Map<string, UnityTestInfo>();
  let bridge: UnityTestBridgeClient | undefined;

  const { controller, updateTestTree, createTestRun, dispose: disposeController } =
    createUnityTestController(
      () => refreshTests(logger, options.root),
      (request, token) => runTests(logger, options.root, request, token)
    );
  disposables.push({ dispose: disposeController });

  disposables.push(vscode.commands.registerCommand('unityPlus.refreshUnityTests', () => refreshTests(logger, options.root)));

  async function getBridge(projectRoot: string): Promise<UnityTestBridgeClient> {
    if (bridge?.connected) return bridge;
    bridge = createUnityTestBridge();
    bridge.onError(err => logger.warn(`Unity test bridge: ${err.message}`));
    await bridge.connect(projectRoot);
    return bridge;
  }

  async function refreshTests(log: UnityPlusLogger, root?: vscode.Uri): Promise<void> {
    if (!root) { log.warn('No Unity root'); return; }
    try {
      const client = await getBridge(root.fsPath);
      log.info('Discovering Unity tests...');
      const { editModeTests, playModeTests } = await discoverUnityTests(client);
      testLookup.clear();
      for (const t of editModeTests) testLookup.set(t.Id, t);
      for (const t of playModeTests) testLookup.set(t.Id, t);
      updateTestTree(editModeTests, playModeTests);
      log.info(`Unity tests: ${editModeTests.length} EditMode, ${playModeTests.length} PlayMode`);
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
    if (!root) { log.warn('No Unity root'); return; }
    try {
      const client = await getBridge(root.fsPath);
      const testItems = collectTestItems(request);
      let mode: UnityTestMode = 'EditMode';
      const fullNames: string[] = [];

      for (const item of testItems) {
        const unityId = item.id.startsWith('unity:') ? item.id.slice(6) : item.id;
        const info = testLookup.get(unityId);
        if (info) { fullNames.push(info.FullName); mode = inferMode(item); }
      }
      if (fullNames.length === 0) {
        for (const info of testLookup.values()) {
          if (info.Method) fullNames.push(info.FullName);
        }
      }

      const run = createTestRun(request, `Unity ${mode} Tests`);
      for (const item of testItems) run.enqueued(item);
      await executeUnityTests(client, run, mode, fullNames, token);
    } catch (error) {
      log.warn(`Unity test execution failed: ${errorMessage(error)}`);
    }
  }

  disposables.push({ dispose: () => bridge?.disconnect() });
  return vscode.Disposable.from(...disposables);
}

// --- Internal helpers ---

/** Walk up the TestItem tree to find if it belongs to EditMode or PlayMode root. */
function inferMode(item: vscode.TestItem): UnityTestMode {
  let current: vscode.TestItem | undefined = item;
  while (current) {
    if (current.id === 'unity:EditMode') return 'EditMode';
    if (current.id === 'unity:PlayMode') return 'PlayMode';
    current = current.parent;
  }
  return 'EditMode';
}

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
