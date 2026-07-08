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
  UnityTestRunStartedPayload,
  UnityTestRunFinishedPayload,
  UnityTestResultPayload
} from './testModel';

/** Test result statuses that map to VS Code TestResult states. */
const passedStatuses = new Set(['Passed']);
const failedStatuses = new Set(['Failed']);
const skippedStatuses = new Set(['Skipped', 'Inconclusive']);

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
        handleRunStarted(run, message.value);
        break;
      case unityIdeMessageTypeTestStarted: {
        const testId = extractTestIdFromJson(message.value);
        if (testId) {
          run.started(createTestItemForRun(testId));
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

function handleRunStarted(run: vscode.TestRun, raw: string): void {
  try {
    const payload: UnityTestRunStartedPayload = JSON.parse(raw);
    // The test tree can be used to pre-enqueue items if desired.
    void payload;
  } catch {
    // Best-effort parsing; ignore malformed payloads.
  }
}

function handleTestFinished(run: vscode.TestRun, raw: string): void {
  let payload: UnityTestResultPayload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const item = createTestItemForRun(payload.Id);
  const duration = Math.max(0, payload.Duration);

  if (passedStatuses.has(payload.Result)) {
    run.passed(item, duration);
  } else if (failedStatuses.has(payload.Result)) {
    const message = vscode.TestMessage
      ? new vscode.TestMessage(payload.Message || 'Test failed.')
      : new vscode.MarkdownString(payload.Message || 'Test failed.') as unknown as vscode.TestMessage;
    run.failed(item, message, duration);
  } else if (skippedStatuses.has(payload.Result)) {
    run.skipped(item);
  } else {
    // Unknown status — treat as errored.
    const message = vscode.TestMessage
      ? new vscode.TestMessage(payload.Message || 'Unknown test result.')
      : new vscode.MarkdownString(payload.Message || 'Unknown test result.') as unknown as vscode.TestMessage;
    run.errored(item, message, duration);
  }
}

function handleRunFinished(run: vscode.TestRun, raw: string): void {
  try {
    const payload: UnityTestRunFinishedPayload = JSON.parse(raw);
    void payload;
  } catch {
    // Best-effort parsing.
  }
  run.end();
}

function extractTestIdFromJson(raw: string): string | undefined {
  try {
    const parsed: { Id?: string } = JSON.parse(raw);
    return parsed.Id;
  } catch {
    return undefined;
  }
}

function createTestItemForRun(id: string): vscode.TestItem {
  // We use a simple TestItem with the Unity test Id.
  // The TestController will match it against the tree by ID.
  return {
    id: `unity:${id}`,
    label: id,
    uri: undefined,
    range: undefined,
    canResolveChildren: false,
    parent: undefined,
    children: {
      add: () => { /* noop */ },
      delete: () => { /* noop */ },
      forEach: () => { /* noop */ },
      get: () => undefined,
      replace: () => { /* noop */ },
      size: 0
    },
    error: undefined,
    busy: false,
    tags: [],
    description: undefined,
    sortText: undefined
  } as unknown as vscode.TestItem;
}
