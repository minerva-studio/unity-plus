import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import { createUnityTestBridge, type UnityTestBridgeClient } from './unityTestBridge';
import { createUnityTestController } from './testController';
import { discoverUnityTests } from './testDiscovery';
import { executeUnityTests } from './testExecution';
import type { UnityTestInfo, UnityTestMode } from './testModel';

export interface UnityTestRunnerFeatureOptions {
  root?: vscode.Uri;
  createBridge?: () => UnityTestBridgeClient;
}

export function registerUnityTestRunnerFeature(
  logger: UnityPlusLogger,
  options: UnityTestRunnerFeatureOptions = {}
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const testLookup = new Map<string, UnityTestInfo>();
  let editTests: UnityTestInfo[] = [];
  let playTests: UnityTestInfo[] = [];
  let bridge: UnityTestBridgeClient | undefined;

  const { updateTestTree, createTestRun, dispose: disposeController } =
    createUnityTestController(
      () => refreshTests(logger, options.root),
      (request, token) => runTests(logger, options.root, request, token)
    );
  disposables.push({ dispose: disposeController });

  disposables.push(vscode.commands.registerCommand('unityPlus.refreshUnityTests', () => refreshTests(logger, options.root)));

  async function getBridge(projectRoot: string): Promise<UnityTestBridgeClient> {
    if (!bridge) {
      bridge = options.createBridge?.() ?? createUnityTestBridge();
      bridge.onError(err => logger.warn(`Unity test bridge: ${err.message}`));
    }

    // ProjectPath validation runs before every refresh and test run, including connected sockets.
    await bridge.connect(projectRoot);
    return bridge;
  }

  async function refreshTests(log: UnityPlusLogger, root?: vscode.Uri): Promise<void> {
    if (!root) { log.warn('No Unity root'); return; }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Unity Plus: refreshing Unity tests'),
      cancellable: false
    }, async progress => {
      try {
        progress.report({ message: vscode.l10n.t('Connecting to Unity') });
        const client = await getBridge(root.fsPath);
        progress.report({ message: vscode.l10n.t('Discovering EditMode and PlayMode tests') });
        log.info('Discovering Unity tests...');
        const { editModeTests, playModeTests } = await discoverUnityTests(client);

        // Replace the visible tree only after discovery returns a valid response.
        testLookup.clear();
        editTests = editModeTests; playTests = playModeTests;
        for (const t of editModeTests) testLookup.set(t.Id, t);
        for (const t of playModeTests) testLookup.set(t.Id, t);
        updateTestTree(editModeTests, playModeTests);
        log.info(`Unity tests: ${editModeTests.length} EditMode, ${playModeTests.length} PlayMode`);
        void vscode.window.showInformationMessage(vscode.l10n.t(
          'Unity Plus: found {editModeCount} EditMode and {playModeCount} PlayMode tests.',
          { editModeCount: editModeTests.length, playModeCount: playModeTests.length }
        ));
      } catch (error) {
        log.warn(`Unity test discovery failed: ${errorMessage(error)}`);
        showUnityUnavailableWarning();
      }
    });
  }

  async function runTests(
    log: UnityPlusLogger,
    root: vscode.Uri | undefined,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
  ): Promise<void> {
    if (!root) { log.warn('No Unity root'); return; }
    try {
      // Do not send ExecuteTests until ProjectPath confirms a responsive Unity endpoint.
      const client = await getBridge(root.fsPath);
      const testItems = collectTestItems(request);
      let mode: UnityTestMode = 'EditMode';
      const sendNames: string[] = [];
      const pendingNames: string[] = [];

      // Keep only top-level selections: if a parent and its child are both selected,
      // skip the child. Sending the parent FullName to Unity runs all children via NUnit prefix match.
      const topItems = testItems.filter(item => {
        const p = item.parent;
        return !p || !testItems.includes(p);
      });

      for (const item of topItems) {
        const unityId = item.id.startsWith('unity:') ? item.id.slice(6) : item.id;
        const info = testLookup.get(unityId);
        if (!info) continue;
        mode = inferMode(item);
        const tests = mode === 'EditMode' ? editTests : playTests;
        const idx = tests.indexOf(info);
        if (idx < 0) continue;

        if (info.Method) {
          sendNames.push(info.FullName);
          pendingNames.push(info.FullName);
        } else {
          // Class level: immediate children are test methods → send class FullName (one call)
          let childIsMethod = false;
          for (let i = 0; i < tests.length && !childIsMethod; i++) {
            if (tests[i].Parent === idx && tests[i].Method) childIsMethod = true;
          }
          if (childIsMethod) {
            sendNames.push(info.FullName);
            collectLeafFullNames(tests, idx, pendingNames);
          } else {
            // Namespace/assembly: expand to immediate children
            for (let i = 0; i < tests.length; i++) {
              if (tests[i].Parent === idx) {
                sendNames.push(tests[i].FullName);
                collectLeafFullNames(tests, i, pendingNames);
              }
            }
          }
        }
      }
      if (sendNames.length === 0) {
        for (const info of testLookup.values()) {
          if (info.Method) { sendNames.push(info.FullName); pendingNames.push(info.FullName); }
        }
      }

      const run = createTestRun(request, `Unity ${mode} Tests`);
      const itemByFullName = new Map<string, vscode.TestItem>();
      for (const item of testItems) {
        run.enqueued(item);
        const info = testLookup.get(item.id.startsWith('unity:') ? item.id.slice(6) : item.id);
        if (info) itemByFullName.set(info.FullName, item);
      }
      await executeUnityTests(client, run, mode, sendNames, token, logger, itemByFullName, pendingNames);
    } catch (error) {
      log.warn(`Unity test execution failed: ${errorMessage(error)}`);
      showUnityUnavailableWarning();
    }
  }

  /** Shows one honest warning for protocol phases where Unity cannot report its exact busy state. */
  function showUnityUnavailableWarning(): void {
    void vscode.window.showWarningMessage(vscode.l10n.t(
      'Unity Plus: Unity is not responding; it may be refreshing, compiling, reloading the script domain, or the project may not be open.'
    ));
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

function collectLeafFullNames(tests: UnityTestInfo[], parentIdx: number, out: string[]): void {
  for (let i = 0; i < tests.length; i++) {
    if (tests[i].Parent === parentIdx) {
      if (tests[i].Method) out.push(tests[i].FullName);
      else collectLeafFullNames(tests, i, out);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
