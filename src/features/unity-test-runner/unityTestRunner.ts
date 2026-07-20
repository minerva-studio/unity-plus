import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import { createUnityTestBridge, type UnityTestBridgeClient } from './unityTestBridge';
import { createUnityTestController } from './testController';
import { discoverUnityTests } from './testDiscovery';
import { executeUnityTests, type UnityTestExecutionBatch } from './testExecution';
import type { UnityTestInfo, UnityTestMode } from './testModel';

export interface UnityTestRunnerFeatureOptions {
  root?: vscode.Uri;
  createBridge?: () => UnityTestBridgeClient;
}

export class UnityTestRunScheduler {
  private scheduledRun: Promise<void> | undefined;

  /** Creates a serial scheduler for Unity's run-id-free test protocol. */
  constructor(private readonly showQueuedMessage: () => void = () => {
    void vscode.window.showInformationMessage(vscode.l10n.t(
      'Unity Plus: Unity tests are queued until the current run finishes.'
    ));
  }) {}

  /** Keeps a TestRun enqueued until every earlier Unity protocol owner has released the bridge. */
  schedule(
    run: vscode.TestRun,
    token: vscode.CancellationToken,
    execute: () => Promise<void>
  ): Promise<void> {
    const previousRun = this.scheduledRun;
    if (previousRun) {
      this.showQueuedMessage();
    }

    const currentRun = (async () => {
      if (previousRun) {
        await previousRun.catch(() => undefined);
      }
      if (token.isCancellationRequested) {
        run.end();
        return;
      }
      await execute();
    })();

    this.scheduledRun = currentRun;
    const clearCurrentRun = (): void => {
      if (this.scheduledRun === currentRun) {
        this.scheduledRun = undefined;
      }
    };
    void currentRun.then(clearCurrentRun, clearCurrentRun);
    return currentRun;
  }
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
  const testRunScheduler = new UnityTestRunScheduler();

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
    const testItems = collectTestItems(request);
    const batches = createExecutionBatches(testItems, testLookup, editTests, playTests);
    const run = createTestRun(request, 'Unity Tests');
    const itemByFullName = new Map<string, vscode.TestItem>();
    for (const item of testItems) {
      run.enqueued(item);
      const info = testLookup.get(item.id.startsWith('unity:') ? item.id.slice(6) : item.id);
      if (info) itemByFullName.set(info.FullName, item);
    }

    await testRunScheduler.schedule(run, token, async () => {
      let executionStarted = false;
      try {
        // Do not send ExecuteTests until ProjectPath confirms a responsive Unity endpoint.
        const client = await getBridge(root.fsPath);
        if (token.isCancellationRequested) {
          run.end();
          return;
        }
        executionStarted = true;
        await executeUnityTests(client, run, batches, token, logger, itemByFullName);
      } catch (error) {
        if (!executionStarted) {
          run.end();
        }
        log.warn(`Unity test execution failed: ${errorMessage(error)}`);
        showUnityUnavailableWarning();
      }
    });
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

/** Builds independent Unity commands while preserving the leaf results expected from each command. */
function createExecutionBatches(
  testItems: readonly vscode.TestItem[],
  testLookup: ReadonlyMap<string, UnityTestInfo>,
  editTests: UnityTestInfo[],
  playTests: UnityTestInfo[]
): UnityTestExecutionBatch[] {
  const batches: UnityTestExecutionBatch[] = [];

  // Keep only top-level selections because a parent command already covers all selected descendants.
  const topItems = testItems.filter(item => {
    const parent = item.parent;
    return !parent || !testItems.includes(parent);
  });

  for (const item of topItems) {
    const unityId = item.id.startsWith('unity:') ? item.id.slice(6) : item.id;
    const info = testLookup.get(unityId);
    if (!info) continue;
    const mode = inferMode(item);
    appendExecutionBatches(batches, mode, info, mode === 'EditMode' ? editTests : playTests);
  }

  if (batches.length === 0) {
    for (const info of testLookup.values()) {
      if (!info.Method) continue;
      const mode: UnityTestMode = editTests.includes(info) ? 'EditMode' : 'PlayMode';
      batches.push({ mode, fullName: info.FullName, expectedFullNames: [info.FullName] });
    }
  }

  return batches;
}

/** Expands one selected tree item into the minimum independent Unity execution batches. */
function appendExecutionBatches(
  batches: UnityTestExecutionBatch[],
  mode: UnityTestMode,
  info: UnityTestInfo,
  tests: UnityTestInfo[]
): void {
  const index = tests.indexOf(info);
  if (index < 0) return;

  if (info.Method) {
    batches.push({ mode, fullName: info.FullName, expectedFullNames: [info.FullName] });
    return;
  }

  const directChildren = tests.filter(test => test.Parent === index);
  if (directChildren.some(test => Boolean(test.Method))) {
    const expectedFullNames: string[] = [];
    collectLeafFullNames(tests, index, expectedFullNames);
    batches.push({ mode, fullName: info.FullName, expectedFullNames });
    return;
  }

  for (const child of directChildren) {
    const expectedFullNames: string[] = [];
    collectLeafFullNames(tests, tests.indexOf(child), expectedFullNames);
    batches.push({ mode, fullName: child.FullName, expectedFullNames });
  }
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
