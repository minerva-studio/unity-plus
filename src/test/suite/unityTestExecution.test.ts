import * as assert from 'assert';
import * as vscode from 'vscode';
import { executeUnityTests, UnityTestStartTimeoutError } from '../../features/unity-test-runner/testExecution';
import { UnityTestRunScheduler } from '../../features/unity-test-runner/unityTestRunner';
import type { UnityTestBridgeClient } from '../../features/unity-test-runner/unityTestBridge';
import {
  unityIdeMessageTypeRunFinished,
  unityIdeMessageTypeRunStarted,
  unityIdeMessageTypeTestFinished
} from '../../unity/visualStudioMessaging';

class MockExecutionBridge implements UnityTestBridgeClient {
  readonly connected = true;
  readonly sent: Array<{ type: number; value: string }> = [];
  private readonly messageHandlers = new Set<(message: { type: number; value: string }) => void>();

  /** Simulates an already connected protocol fixture. */
  async connect(): Promise<void> {
    return;
  }

  /** Records each command sent by the execution workflow. */
  send(type: number, value = ''): void {
    this.sent.push({ type, value });
  }

  /** Registers the fixture's active message handler. */
  onMessage(handler: (message: { type: number; value: string }) => void): { dispose(): void } {
    this.messageHandlers.add(handler);
    return { dispose: () => this.messageHandlers.delete(handler) };
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
    for (const handler of this.messageHandlers) {
      handler({ type, value });
    }
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
        [{ mode: 'EditMode', fullName: name, expectedFullNames: [name] }],
        cancellation.token,
        undefined,
        new Map([[name, item]]),
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
      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: name, Name: 'Passes', TestStatus: 0 }]
      }));
      await execution;

      assert.deepStrictEqual(state.passed, [item.id]);
      assert.strictEqual(state.ended, 1);
    } finally {
      cancellation.dispose();
    }
  });

  test('ends without sending when cancellation was already requested', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };

    try {
      cancellation.cancel();
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        [{
          mode: 'EditMode',
          fullName: 'Tests.Sample.Cancelled',
          expectedFullNames: ['Tests.Sample.Cancelled']
        }],
        cancellation.token,
        undefined,
        undefined,
        1000
      );
      await execution;

      assert.strictEqual(state.ended, 1);
      assert.deepStrictEqual(state.errored, []);
      assert.deepStrictEqual(bridge.sent, []);
    } finally {
      cancellation.dispose();
    }
  });

  test('accepts a successful RunFinished tree when the start signal was lost', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };
    const name = 'Tests.Sample.FinishedWithoutStart';
    const item = createTestItem(name);

    try {
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        [{ mode: 'EditMode', fullName: name, expectedFullNames: [name] }],
        cancellation.token,
        undefined,
        new Map([[name, item]]),
        1000
      );

      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: name, Name: 'FinishedWithoutStart', TestStatus: 0 }]
      }));
      await execution;

      assert.deepStrictEqual(state.passed, [item.id]);
      assert.deepStrictEqual(state.errored, []);
      assert.strictEqual(state.ended, 1);
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
          [{ mode: 'PlayMode', fullName: name, expectedFullNames: [name] }],
          cancellation.token,
          undefined,
          new Map([[name, item]]),
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

  test('waits for RunFinished before sending the next Unity batch', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };
    const firstName = 'Tests.Sample.First';
    const secondName = 'Tests.Sample.Second';
    const firstItem = createTestItem(firstName);
    const secondItem = createTestItem(secondName);

    try {
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        [
          { mode: 'EditMode', fullName: firstName, expectedFullNames: [firstName] },
          { mode: 'EditMode', fullName: secondName, expectedFullNames: [secondName] }
        ],
        cancellation.token,
        undefined,
        new Map([[firstName, firstItem], [secondName, secondItem]]),
        1000
      );

      assert.deepStrictEqual(bridge.sent.map(message => message.value), [`EditMode:${firstName}`]);
      bridge.emit(unityIdeMessageTypeTestFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: 'Tests.Sample.First.Parent', Name: 'Parent', TestStatus: 0 }]
      }));
      assert.deepStrictEqual(bridge.sent.map(message => message.value), [`EditMode:${firstName}`]);
      assert.strictEqual(state.ended, 0);

      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: firstName, Name: 'First', TestStatus: 0 }]
      }));
      assert.deepStrictEqual(
        bridge.sent.map(message => message.value),
        [`EditMode:${firstName}`, `EditMode:${secondName}`]
      );
      assert.deepStrictEqual(state.errored, []);

      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: secondName, Name: 'Second', TestStatus: 0 }]
      }));
      await execution;

      assert.deepStrictEqual(state.passed, [firstItem.id, secondItem.id]);
      assert.deepStrictEqual(state.errored, []);
      assert.strictEqual(state.ended, 1);
    } finally {
      cancellation.dispose();
    }
  });

  test('does not send later batches after an active run is cancelled', async () => {
    const bridge = new MockExecutionBridge();
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };
    const firstName = 'Tests.Sample.Active';
    const secondName = 'Tests.Sample.Queued';

    try {
      const execution = executeUnityTests(
        bridge,
        createMockRun(state),
        [
          { mode: 'EditMode', fullName: firstName, expectedFullNames: [firstName] },
          { mode: 'EditMode', fullName: secondName, expectedFullNames: [secondName] }
        ],
        cancellation.token,
        undefined,
        undefined,
        1000
      );

      cancellation.cancel();
      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: firstName, Name: 'Active', TestStatus: 0 }]
      }));
      await execution;

      assert.deepStrictEqual(bridge.sent.map(message => message.value), [`EditMode:${firstName}`]);
      assert.strictEqual(state.ended, 1);
    } finally {
      cancellation.dispose();
    }
  });

  test('queues overlapping VS Code runs and skips a queued run cancelled before execution', async () => {
    let queuedMessages = 0;
    const scheduler = new UnityTestRunScheduler(() => { queuedMessages += 1; });
    const firstCancellation = new vscode.CancellationTokenSource();
    const secondCancellation = new vscode.CancellationTokenSource();
    const firstState: MockRunState = { ended: 0, errored: [], passed: [] };
    const secondState: MockRunState = { ended: 0, errored: [], passed: [] };
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondExecuted = false;

    try {
      const firstRun = scheduler.schedule(
        createMockRun(firstState),
        firstCancellation.token,
        async () => {
          await firstGate;
          firstState.ended += 1;
        }
      );
      const secondRun = scheduler.schedule(
        createMockRun(secondState),
        secondCancellation.token,
        async () => { secondExecuted = true; }
      );

      secondCancellation.cancel();
      assert.strictEqual(queuedMessages, 1);
      assert.strictEqual(secondExecuted, false);
      assert.strictEqual(secondState.ended, 0);

      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);

      assert.strictEqual(secondExecuted, false);
      assert.strictEqual(secondState.ended, 1);
    } finally {
      firstCancellation.dispose();
      secondCancellation.dispose();
    }
  });

  test('starts the next queued VS Code run only after the active run finishes', async () => {
    const scheduler = new UnityTestRunScheduler(() => undefined);
    const firstCancellation = new vscode.CancellationTokenSource();
    const secondCancellation = new vscode.CancellationTokenSource();
    const firstState: MockRunState = { ended: 0, errored: [], passed: [] };
    const secondState: MockRunState = { ended: 0, errored: [], passed: [] };
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondExecuted = false;

    try {
      const firstRun = scheduler.schedule(
        createMockRun(firstState),
        firstCancellation.token,
        async () => { await firstGate; }
      );
      const secondRun = scheduler.schedule(
        createMockRun(secondState),
        secondCancellation.token,
        async () => { secondExecuted = true; }
      );

      assert.strictEqual(secondExecuted, false);
      releaseFirst?.();
      await Promise.all([firstRun, secondRun]);

      assert.strictEqual(secondExecuted, true);
    } finally {
      firstCancellation.dispose();
      secondCancellation.dispose();
    }
  });
});
