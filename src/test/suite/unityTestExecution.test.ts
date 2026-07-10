import * as assert from 'assert';
import * as vscode from 'vscode';
import { executeUnityTests, UnityTestStartTimeoutError } from '../../features/unity-test-runner/testExecution';
import type { UnityTestBridgeClient } from '../../features/unity-test-runner/unityTestBridge';
import {
  unityIdeMessageTypeRunStarted,
  unityIdeMessageTypeTestFinished
} from '../../unity/visualStudioMessaging';

class MockExecutionBridge implements UnityTestBridgeClient {
  readonly connected = true;
  readonly sent: Array<{ type: number; value: string }> = [];
  private messageHandler?: (message: { type: number; value: string }) => void;

  /** Simulates an already connected protocol fixture. */
  async connect(): Promise<void> {
    return;
  }

  /** Records each command sent by the execution workflow. */
  send(type: number, value = ''): void {
    this.sent.push({ type, value });
  }

  /** Registers the fixture's active message handler. */
  onMessage(handler: (message: { type: number; value: string }) => void): void {
    this.messageHandler = handler;
  }

  /** Accepts error handlers because this fixture emits no socket errors. */
  onError(): void {
    return;
  }

  /** Disconnects the no-op protocol fixture. */
  disconnect(): void {
    return;
  }

  /** Delivers a Unity protocol message to the execution workflow. */
  emit(type: number, value = ''): void {
    this.messageHandler?.({ type, value });
  }
}

interface MockRunState {
  ended: number;
  errored: string[];
  passed: string[];
}

/** Creates the smallest TestRun fixture needed to verify lifecycle behavior. */
function createMockRun(state: MockRunState): vscode.TestRun {
  return {
    end: () => { state.ended += 1; },
    errored: (item: vscode.TestItem) => { state.errored.push(item.id); },
    passed: (item: vscode.TestItem) => { state.passed.push(item.id); },
    started: () => undefined,
    failed: () => undefined,
    skipped: () => undefined
  } as unknown as vscode.TestRun;
}

/** Creates a stable TestItem identity for result reporting checks. */
function createTestItem(fullName: string): vscode.TestItem {
  return { id: `unity:${fullName}`, label: fullName } as vscode.TestItem;
}

suite('unityTestExecution - protocol fixture', () => {
  test('resolves only after the requested test finishes', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };
    const name = 'Tests.Sample.Passes';
    const item = createTestItem(name);

    try {
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        'EditMode',
        [name],
        cancellation.token,
        undefined,
        new Map([[name, item]]),
        [name],
        1000
      );
      let resolved = false;
      void execution.then(() => { resolved = true; });

      await Promise.resolve();
      assert.strictEqual(resolved, false);
      bridge.emit(unityIdeMessageTypeRunStarted);
      bridge.emit(unityIdeMessageTypeTestFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: name, Name: 'Passes', TestStatus: 0 }]
      }));
      await execution;

      assert.deepStrictEqual(state.passed, [item.id]);
      assert.strictEqual(state.ended, 1);
    } finally {
      cancellation.dispose();
    }
  });

  test('ends after cancellation without waiting for Unity', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };

    try {
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        'EditMode',
        ['Tests.Sample.Cancelled'],
        cancellation.token,
        undefined,
        undefined,
        undefined,
        1000
      );
      cancellation.cancel();
      await execution;

      assert.strictEqual(state.ended, 1);
      assert.deepStrictEqual(state.errored, []);
    } finally {
      cancellation.dispose();
    }
  });

  test('marks pending tests errored and rejects after startup timeout', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };
    const name = 'Tests.Sample.Timeout';
    const item = createTestItem(name);

    try {
      await assert.rejects(
        executeUnityTests(
          bridge,
          createMockRun(state),
          'PlayMode',
          [name],
          cancellation.token,
          undefined,
          new Map([[name, item]]),
          [name],
          5
        ),
        UnityTestStartTimeoutError
      );

      assert.deepStrictEqual(state.errored, [item.id]);
      assert.strictEqual(state.ended, 1);
    } finally {
      cancellation.dispose();
    }
  });
});
