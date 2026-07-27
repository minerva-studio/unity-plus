import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { UnityTestBridgeClient } from './ide-package/unityTestBridge';
import { createUnityTestController } from './testController';
import { IdePackageUnityTestBackend } from './ide-package/idePackageTestBackend';
import {
  createUnityTestExecutionBatches,
  flattenUnityTestNodes
} from './testTree';
import type { UnityTestNode } from './testModel';
import type { UnityTestBackend } from './unityTestBackend';

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
  const testLookup = new Map<string, UnityTestNode>();
  let editTests: readonly UnityTestNode[] = [];
  let playTests: readonly UnityTestNode[] = [];
  const testRunScheduler = new UnityTestRunScheduler();
  const backend: UnityTestBackend = new IdePackageUnityTestBackend(logger, options.createBridge);

  const { updateTestTree, createTestRun, dispose: disposeController } =
    createUnityTestController(
      () => refreshTests(logger, options.root),
      (request, token) => runTests(logger, options.root, request, token)
    );
  disposables.push({ dispose: disposeController });

  disposables.push(vscode.commands.registerCommand('unityPlus.refreshUnityTests', () => refreshTests(logger, options.root)));

  async function refreshTests(log: UnityPlusLogger, root?: vscode.Uri): Promise<void> {
    if (!root) { log.warn('No Unity root'); return; }
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('Unity Plus: refreshing Unity tests'),
      cancellable: false
    }, async progress => {
      try {
        progress.report({ message: vscode.l10n.t('Connecting to Unity') });
        progress.report({ message: vscode.l10n.t('Discovering EditMode and PlayMode tests') });
        log.info('Discovering Unity tests...');
        const { editModeTests, playModeTests } = await backend.discover(root.fsPath);

        // Replace the visible tree only after discovery returns a valid response.
        testLookup.clear();
        editTests = editModeTests; playTests = playModeTests;
        for (const t of flattenUnityTestNodes(editModeTests)) testLookup.set(t.id, t);
        for (const t of flattenUnityTestNodes(playModeTests)) testLookup.set(t.id, t);
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
    const batches = createUnityTestExecutionBatches(testItems, testLookup, editTests, playTests);
    const run = createTestRun(request, 'Unity Tests');
    const itemByFullName = new Map<string, vscode.TestItem>();
    for (const item of testItems) {
      run.enqueued(item);
      const node = testLookup.get(item.id.startsWith('unity:') ? item.id.slice(6) : item.id);
      if (node?.fullName) itemByFullName.set(node.fullName, item);
    }

    await testRunScheduler.schedule(run, token, async () => {
      try {
        await backend.run({
          projectRoot: root.fsPath,
          run,
          batches,
          token,
          itemByFullName
        });
      } catch (error) {
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

  disposables.push(backend);
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
