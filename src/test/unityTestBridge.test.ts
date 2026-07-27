import * as assert from 'assert';
import { EventEmitter } from 'node:events';
import {
  unityIdeMessageTypePing,
  unityIdeMessageTypePong,
  unityIdeMessageTypeTcp,
  unityIdeMessageTypeRunStarted,
  unityIdeMessageTypeRunFinished,
  unityIdeMessageTypeTestStarted,
  unityIdeMessageTypeTestFinished,
  unityIdeMessageTypeTestListRetrieved,
  unityIdeMessageTypeRetrieveTestList,
  unityIdeMessageTypeExecuteTests,
  encodeUnityIdeMessage,
  decodeUnityIdeMessage
} from '../unity/visualStudioMessaging';
import {
  buildUnityTestTree,
  type UnityTestInfo
} from '../features/unity-test-runner/ide-package/testModel';
import { parseTestListResponse } from '../features/unity-test-runner/ide-package/testDiscovery';
import { discoverUnityTests } from '../features/unity-test-runner/ide-package/testDiscovery';
import {
  createUnityTestBridge,
  type UnityTestBridgeClient
} from '../features/unity-test-runner/ide-package/unityTestBridge';

class MockPersistentSocket extends EventEmitter {
  readonly sends: Array<{ port: number; value: Buffer }> = [];
  closed = false;

  /** Simulates an immediately bound UDP socket. */
  bind(callback?: () => void): void {
    callback?.();
  }

  /** Records that the persistent bridge socket was closed. */
  close(): void {
    this.closed = true;
  }

  /** Records UDP payloads and their destination ports. */
  send(message: Buffer, port: number, _address: string, callback?: (error: Error | null) => void): void {
    this.sends.push({ port, value: message });
    callback?.(null);
  }
}

describe('unityTestBridge', () => {
  it('delivers messages to active subscribers and stops after disposal', async () => {
    const socket = new MockPersistentSocket();
    const bridge = createUnityTestBridge({
      findEndpoint: async () => 56002,
      createSocket: () => socket as unknown as import('node:dgram').Socket
    });
    const firstMessages: number[] = [];
    const secondMessages: number[] = [];

    try {
      await bridge.connect('C:/Project');
      const first = bridge.onMessage(message => firstMessages.push(message.type));
      const second = bridge.onMessage(message => secondMessages.push(message.type));

      socket.emit('message', encodeUnityIdeMessage(unityIdeMessageTypePong, ''));
      first.dispose();
      socket.emit('message', encodeUnityIdeMessage(unityIdeMessageTypeRunStarted, '{}'));
      second.dispose();
      socket.emit('message', encodeUnityIdeMessage(unityIdeMessageTypeRunFinished, '{}'));

      assert.deepStrictEqual(firstMessages, [unityIdeMessageTypePong]);
      assert.deepStrictEqual(secondMessages, [unityIdeMessageTypePong, unityIdeMessageTypeRunStarted]);
    } finally {
      bridge.disconnect();
    }
  });

  it('rebuilds the persistent socket when endpoint validation finds a new port', async () => {
    const ports = [56002, 56003];
    const sockets: MockPersistentSocket[] = [];
    const bridge = createUnityTestBridge({
      findEndpoint: async () => ports.shift(),
      createSocket: () => {
        const socket = new MockPersistentSocket();
        sockets.push(socket);
        return socket as unknown as import('node:dgram').Socket;
      }
    });

    try {
      await bridge.connect('C:/Project');
      await bridge.connect('C:/Project');
      bridge.send(unityIdeMessageTypePing);

      assert.strictEqual(sockets.length, 2);
      assert.strictEqual(sockets[0].closed, true);
      assert.strictEqual(sockets[1].closed, false);
      assert.strictEqual(sockets[1].sends.at(-1)?.port, 56003);
    } finally {
      bridge.disconnect();
    }
  });

  describe('message type constants', () => {
    it('has the correct values matching com.unity.ide.visualstudio MessageType enum', () => {
      assert.strictEqual(unityIdeMessageTypePing, 1);
      assert.strictEqual(unityIdeMessageTypePong, 2);
      assert.strictEqual(unityIdeMessageTypeTcp, 17);
      assert.strictEqual(unityIdeMessageTypeRunStarted, 18);
      assert.strictEqual(unityIdeMessageTypeRunFinished, 19);
      assert.strictEqual(unityIdeMessageTypeTestStarted, 20);
      assert.strictEqual(unityIdeMessageTypeTestFinished, 21);
      assert.strictEqual(unityIdeMessageTypeTestListRetrieved, 22);
      assert.strictEqual(unityIdeMessageTypeRetrieveTestList, 23);
      assert.strictEqual(unityIdeMessageTypeExecuteTests, 24);
    });
  });

  describe('ping/pong encoding', () => {
    it('encodes a Ping message correctly', () => {
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypePing, '');

      assert.strictEqual(buffer.readInt32LE(0), 1); // Ping type
      assert.strictEqual(buffer.readInt32LE(4), 0); // empty payload
      assert.strictEqual(buffer.length, 8); // header only
    });

    it('round-trips Ping through decode', () => {
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypePing, '');
      const decoded = decodeUnityIdeMessage(buffer);

      assert.ok(decoded);
      assert.strictEqual(decoded!.type, unityIdeMessageTypePing);
      assert.strictEqual(decoded!.value, '');
    });
  });

  describe('RetrieveTestList encoding', () => {
    it('encodes EditMode request', () => {
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypeRetrieveTestList, 'EditMode');

      assert.strictEqual(buffer.readInt32LE(0), unityIdeMessageTypeRetrieveTestList);
      assert.strictEqual(buffer.readInt32LE(4), 'EditMode'.length);

      const decoded = decodeUnityIdeMessage(buffer);
      assert.ok(decoded);
      assert.strictEqual(decoded!.type, unityIdeMessageTypeRetrieveTestList);
      assert.strictEqual(decoded!.value, 'EditMode');
    });

    it('encodes PlayMode request', () => {
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypeRetrieveTestList, 'PlayMode');

      const decoded = decodeUnityIdeMessage(buffer);
      assert.ok(decoded);
      assert.strictEqual(decoded!.type, unityIdeMessageTypeRetrieveTestList);
      assert.strictEqual(decoded!.value, 'PlayMode');
    });
  });

  describe('ExecuteTests encoding', () => {
    it('encodes EditMode:FullName format', () => {
      const value = 'EditMode:MyNamespace.MyClass.MyMethod';
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypeExecuteTests, value);

      assert.strictEqual(buffer.readInt32LE(0), unityIdeMessageTypeExecuteTests);
      const decoded = decodeUnityIdeMessage(buffer);
      assert.ok(decoded);
      assert.strictEqual(decoded!.value, value);
    });

    it('encodes PlayMode:FullName format', () => {
      const value = 'PlayMode:MyNamespace.MyClass.MyMethod';
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypeExecuteTests, value);

      const decoded = decodeUnityIdeMessage(buffer);
      assert.ok(decoded);
      assert.strictEqual(decoded!.value, value);
    });
  });

  describe('TCP fallback marker', () => {
    it('encodes Tcp marker message with port:length format', () => {
      const value = '56042:12345';
      const buffer = encodeUnityIdeMessage(unityIdeMessageTypeTcp, value);

      assert.strictEqual(buffer.readInt32LE(0), unityIdeMessageTypeTcp);

      const decoded = decodeUnityIdeMessage(buffer);
      assert.ok(decoded);
      assert.strictEqual(decoded!.type, unityIdeMessageTypeTcp);
      assert.strictEqual(decoded!.value, value);
    });
  });
});

describe('testModel', () => {
  describe('buildUnityTestTree', () => {
    it('builds a tree from flat test list', () => {
      const tests: UnityTestInfo[] = [
        { Id: '1', Name: 'RootSuite', FullName: 'RootSuite', Type: '', Method: '', Assembly: 'Test.dll', Parent: -1 },
        { Id: '2', Name: 'ChildTest', FullName: 'RootSuite.ChildTest', Type: '', Method: 'ChildTest', Assembly: 'Test.dll', Parent: 0 },
        { Id: '3', Name: 'LeafTest', FullName: 'RootSuite.ChildTest.LeafTest', Type: '', Method: 'LeafTest', Assembly: 'Test.dll', Parent: 1 }
      ];

      const tree = buildUnityTestTree(tests);

      assert.strictEqual(tree.roots.length, 1);
      assert.strictEqual(tree.roots[0].Id, '1');
      assert.strictEqual(tree.byId.size, 3);
      assert.strictEqual(tree.childrenByParent.get(0)?.length, 1);
      assert.strictEqual(tree.childrenByParent.get(0)?.[0].Id, '2');
      assert.strictEqual(tree.childrenByParent.get(1)?.length, 1);
      assert.strictEqual(tree.childrenByParent.get(1)?.[0].Id, '3');
    });

    it('handles multiple root items', () => {
      const tests: UnityTestInfo[] = [
        { Id: '1', Name: 'SuiteA', FullName: 'SuiteA', Type: '', Method: '', Assembly: 'Test.dll', Parent: -1 },
        { Id: '2', Name: 'SuiteB', FullName: 'SuiteB', Type: '', Method: '', Assembly: 'Test.dll', Parent: -1 },
        { Id: '3', Name: 'TestA', FullName: 'SuiteA.TestA', Type: '', Method: 'TestA', Assembly: 'Test.dll', Parent: 0 },
        { Id: '4', Name: 'TestB', FullName: 'SuiteB.TestB', Type: '', Method: 'TestB', Assembly: 'Test.dll', Parent: 1 }
      ];

      const tree = buildUnityTestTree(tests);

      assert.strictEqual(tree.roots.length, 2);
      assert.strictEqual(tree.childrenByParent.get(0)?.length, 1);
      assert.strictEqual(tree.childrenByParent.get(1)?.length, 1);
    });

    it('handles empty list', () => {
      const tree = buildUnityTestTree([]);
      assert.strictEqual(tree.roots.length, 0);
      assert.strictEqual(tree.byId.size, 0);
    });

    it('handles orphan items (out-of-range parent index) by placing them at root', () => {
      const tests: UnityTestInfo[] = [
        { Id: '1', Name: 'Orphan', FullName: 'Orphan', Type: '', Method: '', Assembly: 'Test.dll', Parent: 999 }
      ];

      const tree = buildUnityTestTree(tests);

      assert.strictEqual(tree.roots.length, 1);
      assert.strictEqual(tree.roots[0].Id, '1');
    });
  });
});

describe('testDiscovery', () => {
  describe('parseTestListResponse', () => {
    const sampleTests: UnityTestInfo[] = [
      { Id: '1', Name: 'MyTest', FullName: 'NS.MyClass.MyTest', Type: 'NS.MyClass', Method: 'MyTest', Assembly: 'Test.dll', Parent: -1 }
    ];

    it('parses a valid EditMode response', () => {
      const value = `EditMode:${JSON.stringify({ TestAdaptors: sampleTests })}`;
      const result = parseTestListResponse(value);

      assert.ok(result);
      assert.strictEqual(result!.mode, 'EditMode');
      assert.strictEqual(result!.tests.length, 1);
      assert.strictEqual(result!.tests[0].FullName, 'NS.MyClass.MyTest');
    });

    it('parses a valid PlayMode response', () => {
      const value = `PlayMode:${JSON.stringify({ TestAdaptors: sampleTests })}`;
      const result = parseTestListResponse(value);

      assert.ok(result);
      assert.strictEqual(result!.mode, 'PlayMode');
      assert.strictEqual(result!.tests.length, 1);
    });

    it('returns undefined for unknown mode', () => {
      const value = `Unknown:${JSON.stringify({ TestAdaptors: sampleTests })}`;
      assert.strictEqual(parseTestListResponse(value), undefined);
    });

    it('returns undefined for missing colon', () => {
      const value = 'InvalidFormat';
      assert.strictEqual(parseTestListResponse(value), undefined);
    });

    it('returns undefined for malformed JSON', () => {
      const value = 'EditMode:{broken json';
      assert.strictEqual(parseTestListResponse(value), undefined);
    });

    it('handles empty tests array', () => {
      const value = 'EditMode:{"TestAdaptors":[]}';
      const result = parseTestListResponse(value);

      assert.ok(result);
      assert.strictEqual(result!.tests.length, 0);
    });

    it('rejects when Unity sends no test-list response before the timeout', async () => {
      const bridge: UnityTestBridgeClient = {
        connected: true,
        connect: async () => undefined,
        send: () => undefined,
        onMessage: () => ({ dispose: () => undefined }),
        onError: () => undefined,
        disconnect: () => undefined
      };

      await assert.rejects(discoverUnityTests(bridge, 5), /did not respond/i);
    });
  });
});

describe('RunStarted / RunFinished encoding', () => {
  it('round-trips RunStarted payload', () => {
    const payload = JSON.stringify({
      TestMode: 'EditMode',
      TestAdaptors: [
        { Id: '1', Name: 'MyTest', FullName: 'NS.MyTest', Type: 'NS', Method: 'MyTest', Assembly: 'Asm.dll', Parent: -1 }
      ]
    });

    const buffer = encodeUnityIdeMessage(unityIdeMessageTypeRunStarted, payload);
    const decoded = decodeUnityIdeMessage(buffer);

    assert.ok(decoded);
    assert.strictEqual(decoded!.type, unityIdeMessageTypeRunStarted);

    const parsed = JSON.parse(decoded!.value);
    assert.strictEqual(parsed.TestMode, 'EditMode');
    assert.strictEqual(parsed.TestAdaptors.length, 1);
  });

  it('round-trips RunFinished payload', () => {
    const payload = JSON.stringify({
      TestMode: 'EditMode',
      PassCount: 5,
      FailCount: 1,
      SkipCount: 0,
      InconclusiveCount: 0,
      Duration: 1234
    });

    const buffer = encodeUnityIdeMessage(unityIdeMessageTypeRunFinished, payload);
    const decoded = decodeUnityIdeMessage(buffer);

    assert.ok(decoded);
    assert.strictEqual(decoded!.type, unityIdeMessageTypeRunFinished);

    const parsed = JSON.parse(decoded!.value);
    assert.strictEqual(parsed.PassCount, 5);
    assert.strictEqual(parsed.FailCount, 1);
    assert.strictEqual(parsed.Duration, 1234);
  });

  it('round-trips TestFinished payload', () => {
    const payload = JSON.stringify({
      Name: 'Method',
      FullName: 'NS.Class.Method',
      PassCount: 1,
      FailCount: 0,
      InconclusiveCount: 0,
      SkipCount: 0,
      ResultState: 'Passed',
      StackTrace: '',
      TestStatus: 0,
      Parent: -1
    });

    const buffer = encodeUnityIdeMessage(unityIdeMessageTypeTestFinished, payload);
    const decoded = decodeUnityIdeMessage(buffer);

    assert.ok(decoded);
    assert.strictEqual(decoded!.type, unityIdeMessageTypeTestFinished);
  });
});
