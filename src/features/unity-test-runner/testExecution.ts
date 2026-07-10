import * as vscode from 'vscode';
import {
  unityIdeMessageTypeExecuteTests,
  unityIdeMessageTypeRunStarted,
  unityIdeMessageTypeRunFinished,
  unityIdeMessageTypeTestStarted,
  unityIdeMessageTypeTestFinished
} from '../../unity/visualStudioMessaging';
import type { UnityTestBridgeClient } from './unityTestBridge';
import type {
  UnityTestMode,
  UnityTestResultContainer
} from './testModel';
import { mapTestStatus } from './testModel';
import type { UnityPlusLogger } from '../../unity/logger';

const defaultTestStartTimeoutMs = 8000;

export class UnityTestStartTimeoutError extends Error {
  /** Creates the explicit failure used when Unity accepts no test-run activity. */
  constructor() {
    super('Unity did not report that the test run started.');
    this.name = 'UnityTestStartTimeoutError';
  }
}

export async function executeUnityTests(
  bridge: UnityTestBridgeClient,
  run: vscode.TestRun,
  mode: UnityTestMode,
  fullNames: string[],
  token: vscode.CancellationToken,
  log?: UnityPlusLogger,
  /** FullName → real TestItem from the controller tree for result reporting. */
  itemByFullName?: Map<string, vscode.TestItem>,
  /** FullNames to match in TestFinished (defaults to fullNames if omitted). */
  pendingNames?: string[],
  /** Startup timeout override used by the protocol mock fixture. */
  startTimeoutMs = defaultTestStartTimeoutMs
): Promise<void> {
  // fullNames: what we send to Unity. pendingNames: what we wait for in results.
  // When running a parent (class), fullNames=[parent], pendingNames=[all leaf children].
  const pending = new Set(pendingNames ?? fullNames);
  log?.info(`executeTests mode=${mode} send=${fullNames.length} pending=${pending.size}`);
  await new Promise<void>((resolve, reject) => {
    let done = false;
    let started = false;
    let startTimer: ReturnType<typeof setTimeout> | undefined;

    /** Ends the VS Code run exactly once and releases its cancellation listener. */
    function settle(error?: Error): void {
      if (done) {
        return;
      }

      done = true;
      if (startTimer) {
        clearTimeout(startTimer);
      }
      cancelListener.dispose();
      run.end();
      if (error) reject(error); else resolve();
    }

    /** Records the first protocol activity that proves Unity started the run. */
    function markStarted(): void {
      if (started) {
        return;
      }

      started = true;
      if (startTimer) {
        clearTimeout(startTimer);
        startTimer = undefined;
      }
    }

    const cancelListener = token.onCancellationRequested(() => queueMicrotask(settle));
    const messageHandler = (message: { type: number; value: string }): void => {
      if (done) return;

      const tname = ['','Ping','Pong','','','','','','','','','','','','','','','Tcp','RunStarted','RunFinished','TestStarted','TestFinished','TestListRetrieved','RetrieveTestList','ExecuteTests'][message.type] || `?${message.type}`;
      log?.info(`recv ${tname}(${message.type}) len=${message.value.length}`);

      switch (message.type) {
        case unityIdeMessageTypeRunStarted:
          markStarted();
          break;
        case unityIdeMessageTypeTestStarted: {
          markStarted();
          // Only report started for leaf tests we actually requested.
          const name = extractFieldFromJson(message.value, 'FullName');
          if (name && pending.has(name)) {
            const item = itemByFullName?.get(name)
              ?? { id: `unity:${name}`, label: name.split('.').pop() || name } as vscode.TestItem;
            run.started(item);
          }
          break;
        }
        case unityIdeMessageTypeTestFinished:
          // A completion callback proves Unity started even if its UDP start message was lost.
          markStarted();
          handleTestFinished(run, message.value, pending, () => {
            if (pending.size === 0) settle();
            else log?.info(`pendingLeft=${pending.size} [${[...pending].slice(0,5).join(', ')}]`);
          }, log, itemByFullName);
          break;
        case unityIdeMessageTypeRunFinished:
          // Unity serializes RunFinished as the same complete result tree as TestFinished.
          markStarted();
          handleTestFinished(run, message.value, pending, () => undefined, log, itemByFullName);
          // Only results absent even from the final tree remain genuinely unreported.
          markPendingErrored(run, pending, itemByFullName, 'Unity finished without reporting this test result.');
          settle();
          break;
      }
    };

    bridge.onMessage(messageHandler);
    startTimer = setTimeout(() => {
      const error = new UnityTestStartTimeoutError();
      markPendingErrored(run, pending, itemByFullName, error.message);
      settle(error);
    }, startTimeoutMs);

    // Send after handlers and timeout are installed so fast responses cannot race setup.
    for (const fullName of fullNames) {
      if (token.isCancellationRequested) {
        settle();
        break;
      }
      bridge.send(unityIdeMessageTypeExecuteTests, `${mode}:${fullName}`);
    }

    if (fullNames.length === 0) {
      settle();
    }
  });
}

// --- Internal helpers ---

function handleTestFinished(
  run: vscode.TestRun,
  raw: string,
  pending: Set<string>,
  onAllDone: () => void,
  log?: UnityPlusLogger,
  itemByFullName?: Map<string, vscode.TestItem>
): void {
  let container: UnityTestResultContainer;
  try { container = JSON.parse(raw); } catch { return; }

  for (const payload of container.TestResultAdaptors ?? []) {
    const matched = pending.has(payload.FullName);
    log?.info(`TestFinished: "${payload.FullName}" status=${payload.TestStatus} match=${matched}`);
    if (!matched) {
      // Also try to report parent items that were enqueued
      const parentItem = itemByFullName?.get(payload.FullName);
      if (parentItem && payload.TestStatus !== undefined) {
        const st = mapTestStatus(payload.TestStatus);
        if (st === 'passed') run.passed(parentItem);
        else if (st === 'failed') run.failed(parentItem, new vscode.TestMessage(payload.ResultState || ''));
        else if (st === 'skipped') run.skipped(parentItem);
      }
      continue;
    }

    pending.delete(payload.FullName);

    // MUST use the real TestItem from the tree — VS Code matches by object reference.
    const item = itemByFullName?.get(payload.FullName)
      ?? { id: `unity:${payload.FullName}`, label: payload.Name } as vscode.TestItem;
    const status = mapTestStatus(payload.TestStatus);
    log?.info(`→ reporting as "${status}" pendingLeft=${pending.size}`);

    switch (status) {
      case 'passed': run.passed(item); break;
      case 'failed': {
        const reason = payload.ResultState || `TestStatus=${payload.TestStatus}`;
        const stack = payload.StackTrace ? '\n' + payload.StackTrace.trim() : '';
        run.failed(item, new vscode.TestMessage(`${payload.FullName}: ${reason}${stack}`));
        break;
      }
      case 'skipped': run.skipped(item); break;
      case 'errored': {
        run.errored(item, new vscode.TestMessage(payload.StackTrace || payload.ResultState || 'Unknown error.'));
        break;
      }
    }
  }

  onAllDone();
}

function extractFieldFromJson(raw: string, field: string): string | undefined {
  try {
    const parsed: Record<string, unknown> = JSON.parse(raw);
    return typeof parsed[field] === 'string' ? (parsed[field] as string) : undefined;
  } catch {
    return undefined;
  }
}

/** Marks every pending leaf as errored before a failed or incomplete run ends. */
function markPendingErrored(
  run: vscode.TestRun,
  pending: Set<string>,
  itemByFullName: Map<string, vscode.TestItem> | undefined,
  message: string
): void {
  for (const name of pending) {
    const item = itemByFullName?.get(name)
      ?? { id: `unity:${name}`, label: name.split('.').pop() || name } as vscode.TestItem;
    run.errored(item, new vscode.TestMessage(message));
  }
  pending.clear();
}
