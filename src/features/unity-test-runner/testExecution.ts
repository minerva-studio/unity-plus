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

/**
 * Executes Unity tests via the bridge.
 *
 * Sends ExecuteTests messages and listens for result callbacks,
 * reporting each test outcome to the provided VS Code TestRun.
 */
export async function executeUnityTests(
  bridge: UnityTestBridgeClient,
  run: vscode.TestRun,
  mode: UnityTestMode,
  fullNames: string[],
  token: vscode.CancellationToken
): Promise<void> {
  // Track which tests are still waiting for results.
  // Unity sends a cascade of TestFinished for ancestors too — we only count exact FullName matches.
  const pending = new Set(fullNames);
  let done = false;

  const cancelListener = token.onCancellationRequested(() => {
    done = true;
    run.end();
  });

  const messageHandler = (message: { type: number; value: string }): void => {
    if (done) return;

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
          if (pending.size === 0) {
            done = true;
            run.end();
          }
        });
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
  onAllDone: () => void
): void {
  let container: UnityTestResultContainer;
  try { container = JSON.parse(raw); } catch { return; }

  for (const payload of container.TestResultAdaptors ?? []) {
    // Only report results for tests we actually requested.
    if (!pending.has(payload.FullName)) continue;

    pending.delete(payload.FullName);

    const item = { id: `unity:${payload.FullName}`, label: payload.Name } as vscode.TestItem;
    const status = mapTestStatus(payload.TestStatus);

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
