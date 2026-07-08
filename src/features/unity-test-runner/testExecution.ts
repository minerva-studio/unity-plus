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
  UnityTestRunFinishedPayload,
  UnityTestResultPayload
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
  // Build a set of requested test IDs for quick lookup during results.
  // We don't know IDs ahead of time so we track by FullName.
  const requestedNames = new Set(fullNames);
  let active = true;

  const cancelListener = token.onCancellationRequested(() => {
    active = false;
    run.end();
  });

  const messageHandler = (message: { type: number; value: string }): void => {
    if (!active) {
      return;
    }

    switch (message.type) {
      case unityIdeMessageTypeRunStarted:
        break; // TestAdaptors tree — informational, not needed mid-run
      case unityIdeMessageTypeTestStarted: {
        const name = extractFieldFromJson(message.value, 'Name');
        if (name) {
          run.started({ id: `unity:${name}`, label: name } as vscode.TestItem);
        }
        break;
      }
      case unityIdeMessageTypeTestFinished:
        handleTestFinished(run, message.value);
        break;
      case unityIdeMessageTypeRunFinished:
        handleRunFinished(run, message.value);
        active = false;
        break;
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
  }
}

// --- Internal helpers ---

function handleTestFinished(run: vscode.TestRun, raw: string): void {
  let payload: UnityTestResultPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const item = { id: `unity:${payload.FullName}`, label: payload.Name } as vscode.TestItem;
  const status = mapTestStatus(payload.TestStatus);

  switch (status) {
    case 'passed':
      run.passed(item);
      break;
    case 'failed': {
      const msg = new vscode.TestMessage(payload.ResultState || payload.StackTrace || 'Test failed.');
      run.failed(item, msg);
      break;
    }
    case 'skipped':
      run.skipped(item);
      break;
    case 'errored': {
      const msg = new vscode.TestMessage(payload.StackTrace || payload.ResultState || 'Unknown error.');
      run.errored(item, msg);
      break;
    }
  }
}

function handleRunFinished(run: vscode.TestRun, raw: string): void {
  try {
    const payload: UnityTestRunFinishedPayload = JSON.parse(raw);
    void payload;
  } catch {
    // Best-effort.
  }
  run.end();
}

function extractFieldFromJson(raw: string, field: string): string | undefined {
  try {
    const parsed: Record<string, unknown> = JSON.parse(raw);
    return typeof parsed[field] === 'string' ? (parsed[field] as string) : undefined;
  } catch {
    return undefined;
  }
}
