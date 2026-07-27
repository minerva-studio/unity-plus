import * as assert from 'assert';
import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import { IdePackageUnityTestBackend } from '../../features/unity-test-runner/ide-package/idePackageTestBackend';
import {
  executeUnityTests,
  UnityTestStartTimeoutError
} from '../../features/unity-test-runner/ide-package/testExecution';
import { UnityTestRunScheduler } from '../../features/unity-test-runner/unityTestRunner';
import type {
  UnityTestBridgeClient
} from '../../features/unity-test-runner/ide-package/unityTestBridge';
import {
  unityIdeMessageTypeExecuteTests,
  unityIdeMessageTypeRunFinished,
  unityIdeMessageTypeRunStarted,
  unityIdeMessageTypeTestFinished,
  unityIdeMessageTypeTestListRetrieved,
  unityIdeMessageTypeRetrieveTestList
} from '../../unity/visualStudioMessaging';

class MockExecutionBridge implements UnityTestBridgeClient {
  readonly connected = true;
  readonly sent: Array<{ type: number; value: string }> = [];
  readonly connectedProjectRoots: string[] = [];
  disconnectCount = 0;
  private readonly messageHandlers = new Set<(message: { type: number; value: string }) => void>();

  /** Creates a fixture that may fail endpoint validation when requested by a test. */
  constructor(private readonly connectError?: Error) {}

  /** Records each project endpoint validation performed by the backend. */
  async connect(projectRoot: string): Promise<void> {
    this.connectedProjectRoots.push(projectRoot);
    if (this.connectError) {
      throw this.connectError;
    }
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

  /** Records backend ownership release for the persistent protocol fixture. */
  disconnect(): void {
    this.disconnectCount += 1;
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
  passedItems?: vscode.TestItem[];
}

/** Creates the smallest TestRun fixture needed to verify lifecycle behavior. */
function createMockRun(state: MockRunState): vscode.TestRun {
  return {
    end: () => { state.ended += 1; },
    errored: (item: vscode.TestItem) => { state.errored.push(item.id); },
    passed: (item: vscode.TestItem) => {
      state.passed.push(item.id);
      state.passedItems?.push(item);
    },
    started: () => undefined,
    failed: () => undefined,
    skipped: () => undefined
  } as unknown as vscode.TestRun;
}

/** Creates a stable TestItem identity for result reporting checks. */
function createTestItem(fullName: string): vscode.TestItem {
  return { id: `unity:${fullName}`, label: fullName } as vscode.TestItem;
}

/** Creates the logger surface consumed by the backend and execution helper. */
function createMockLogger(): UnityPlusLogger {
  return {
    info: () => undefined,
    warn: () => undefined
  } as unknown as UnityPlusLogger;
}

/** Lets async backend setup reach the expected number of protocol sends. */
async function waitForSentCount(bridge: MockExecutionBridge, count: number): Promise<void> {
  for (let attempt = 0; attempt < 10 && bridge.sent.length < count; attempt += 1) {
    await Promise.resolve();
  }
  assert.strictEqual(bridge.sent.length, count);
}

suite('IdePackageUnityTestBackend - protocol fixture', () => {
  test('revalidates the exact project and preserves IDE package discovery', async () => {
    const bridge = new MockExecutionBridge();
    const backend = new IdePackageUnityTestBackend(createMockLogger(), () => bridge);
    const editTest = {
      Id: 'edit',
      Name: 'EditTest',
      FullName: 'Tests.EditTest',
      Type: 'Tests',
      Method: 'EditTest',
      Assembly: 'Tests.dll',
      Parent: -1
    };
    const playTest = {
      Id: 'play',
      Name: 'PlayTest',
      FullName: 'Tests.PlayTest',
      Type: 'Tests',
      Method: 'PlayTest',
      Assembly: 'Tests.dll',
      Parent: -1
    };

    try {
      const discovery = backend.discover('C:/Unity/Project');
      await waitForSentCount(bridge, 2);

      assert.deepStrictEqual(
        bridge.sent,
        [
          { type: unityIdeMessageTypeRetrieveTestList, value: 'EditMode' },
          { type: unityIdeMessageTypeRetrieveTestList, value: 'PlayMode' }
        ]
      );
      bridge.emit(
        unityIdeMessageTypeTestListRetrieved,
        `EditMode:${JSON.stringify({ TestAdaptors: [editTest] })}`
      );
      bridge.emit(
        unityIdeMessageTypeTestListRetrieved,
        `PlayMode:${JSON.stringify({ TestAdaptors: [playTest] })}`
      );

      assert.deepStrictEqual(await discovery, {
        editModeTests: [editTest],
        playModeTests: [playTest]
      });
      assert.deepStrictEqual(bridge.connectedProjectRoots, ['C:/Unity/Project']);
    } finally {
      backend.dispose();
    }

    assert.strictEqual(bridge.disconnectCount, 1);
  });

  test('reuses the bridge and reports results with the real TestItem identity', async () => {
    const bridge = new MockExecutionBridge();
    let bridgeCreationCount = 0;
    const backend = new IdePackageUnityTestBackend(createMockLogger(), () => {
      bridgeCreationCount += 1;
      return bridge;
    });
    const cancellation = new vscode.CancellationTokenSource();
    const cancelled = new vscode.CancellationTokenSource();
    const name = 'Tests.Sample.BackendPasses';
    const item = createTestItem(name);
    const state: MockRunState = {
      ended: 0,
      errored: [],
      passed: [],
      passedItems: []
    };

    try {
      const execution = backend.run({
        projectRoot: 'C:/Unity/First',
        run: createMockRun(state),
        batches: [{ mode: 'EditMode', fullName: name, expectedFullNames: [name] }],
        token: cancellation.token,
        itemByFullName: new Map([[name, item]])
      });
      await waitForSentCount(bridge, 1);

      assert.deepStrictEqual(bridge.sent, [
        { type: unityIdeMessageTypeExecuteTests, value: `EditMode:${name}` }
      ]);
      bridge.emit(unityIdeMessageTypeRunFinished, JSON.stringify({
        TestResultAdaptors: [{ FullName: name, Name: 'BackendPasses', TestStatus: 0 }]
      }));
      await execution;

      cancelled.cancel();
      await backend.run({
        projectRoot: 'C:/Unity/Second',
        run: createMockRun(state),
        batches: [{ mode: 'PlayMode', fullName: name, expectedFullNames: [name] }],
        token: cancelled.token,
        itemByFullName: new Map([[name, item]])
      });

      assert.strictEqual(bridgeCreationCount, 1);
      assert.deepStrictEqual(
        bridge.connectedProjectRoots,
        ['C:/Unity/First', 'C:/Unity/Second']
      );
      assert.deepStrictEqual(state.passed, [item.id]);
      assert.strictEqual(state.passedItems?.[0], item);
      assert.strictEqual(state.ended, 2);
      assert.strictEqual(bridge.sent.length, 1);
    } finally {
      cancellation.dispose();
      cancelled.dispose();
      backend.dispose();
    }

    assert.strictEqual(bridge.disconnectCount, 1);
  });

  test('ends the TestRun once when project connection fails before execution', async () => {
    const bridge = new MockExecutionBridge(new Error('Project endpoint unavailable.'));
    const backend = new IdePackageUnityTestBackend(createMockLogger(), () => bridge);
    const cancellation = new vscode.CancellationTokenSource();
    const state: MockRunState = { ended: 0, errored: [], passed: [] };

    try {
      await assert.rejects(
        backend.run({
          projectRoot: 'C:/Unity/Unavailable',
          run: createMockRun(state),
          batches: [{
            mode: 'EditMode',
            fullName: 'Tests.Sample.Unavailable',
            expectedFullNames: ['Tests.Sample.Unavailable']
          }],
          token: cancellation.token
        }),
        /Project endpoint unavailable/
      );

      assert.strictEqual(state.ended, 1);
      assert.deepStrictEqual(bridge.sent, []);
      assert.deepStrictEqual(bridge.connectedProjectRoots, ['C:/Unity/Unavailable']);
    } finally {
      cancellation.dispose();
      backend.dispose();
    }
  });
});

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
