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

export async function executeUnityTests(
  bridge: UnityTestBridgeClient,
  run: vscode.TestRun,
  mode: UnityTestMode,
  fullNames: string[],
  token: vscode.CancellationToken,
  log?: UnityPlusLogger,
  /** FullName → real TestItem from the controller tree for result reporting. */
  itemByFullName?: Map<string, vscode.TestItem>
): Promise<void> {
  const pending = new Set(fullNames);
  log?.info(`executeTests mode=${mode} pending=${pending.size} names=[${[...pending].slice(0, 3).join(', ')}...]`);
  let done = false;

  const cancelListener = token.onCancellationRequested(() => {
    done = true;
    run.end();
  });

  const messageHandler = (message: { type: number; value: string }): void => {
    if (done) return;

    const tname = ['','Ping','Pong','','','','','','','','','','','','','','','Tcp','RunStarted','RunFinished','TestStarted','TestFinished','TestListRetrieved','RetrieveTestList','ExecuteTests'][message.type] || `?${message.type}`;
    log?.info(`recv ${tname}(${message.type}) len=${message.value.length}`);

    switch (message.type) {
      case unityIdeMessageTypeRunStarted:
        break;
      case unityIdeMessageTypeTestStarted: {
        // Only report started for leaf tests we actually requested.
        const name = extractFieldFromJson(message.value, 'FullName');
        if (name && pending.has(name)) {
          run.started({ id: `unity:${name}`, label: name.split('.').pop() || name } as vscode.TestItem);
        }
        break;
      }
      case unityIdeMessageTypeTestFinished:
        handleTestFinished(run, message.value, pending, () => {
          if (pending.size === 0) { done = true; run.end(); }
        }, log, itemByFullName);
        break;
      case unityIdeMessageTypeRunFinished:
        break; // Cascade; end is driven by pending set exhaustion
    }
  };

  bridge.onMessage(messageHandler);

  try {
    // Send execute commands for every requested test.
    for (const fullName of fullNames) {
      if (token.isCancellationRequested) {
        break;
      }
      bridge.send(unityIdeMessageTypeExecuteTests, `${mode}:${fullName}`);
    }
  } finally {
    cancelListener.dispose();
    // Safety: end the run after 60s if some tests never report back.
    setTimeout(() => {
      if (!done) {
        done = true;
        run.end();
      }
    }, 60000);
  }
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
    log?.info(`TestFinished: FullName="${payload.FullName}" TestStatus=${payload.TestStatus}(${typeof payload.TestStatus}) pending=${pending.has(payload.FullName)}`);
    if (!pending.has(payload.FullName)) continue;

    pending.delete(payload.FullName);

    // MUST use the real TestItem from the tree — VS Code matches by object reference.
    const item = itemByFullName?.get(payload.FullName)
      ?? { id: `unity:${payload.FullName}`, label: payload.Name } as vscode.TestItem;
    const status = mapTestStatus(payload.TestStatus);
    log?.info(`→ reporting as "${status}" pendingLeft=${pending.size}`);

    switch (status) {
      case 'passed': run.passed(item); break;
      case 'failed': {
        run.failed(item, new vscode.TestMessage(payload.ResultState || payload.StackTrace || 'Test failed.'));
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
