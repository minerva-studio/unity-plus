import * as assert from 'assert';
import {
  decodeUnityIdeMessage,
  encodeUnityIdeMessage,
  findUnityIdeMessagingEndpoint,
  resetUnityIdeMessagingCache,
  sendUnityIdeShowUsage,
  unityIdeMessageTypeProjectPath,
  unityIdeMessageTypeShowUsage,
  UnityIdeSocket
} from '../unity/visualStudioMessaging';

describe('visualStudioMessaging', () => {
  afterEach(() => {
    resetUnityIdeMessagingCache();
  });

  it('encodes and decodes Unity IDE messages using the Unity serializer layout', () => {
    const buffer = encodeUnityIdeMessage(unityIdeMessageTypeShowUsage, '{"Path":"Assets/Icon.png"}');

    assert.strictEqual(buffer.readInt32LE(0), unityIdeMessageTypeShowUsage);
    assert.strictEqual(buffer.readInt32LE(4), Buffer.byteLength('{"Path":"Assets/Icon.png"}', 'utf8'));
    assert.deepStrictEqual(decodeUnityIdeMessage(buffer), {
      type: unityIdeMessageTypeShowUsage,
      value: '{"Path":"Assets/Icon.png"}'
    });
  });

  it('finds the Unity IDE messaging endpoint by matching ProjectPath responses', async () => {
    const socket = new FakeUnityIdeSocket({
      projectRoot: 'C:/Project',
      projectPort: 56042
    });

    const port = await findUnityIdeMessagingEndpoint('C:\\Project', {
      createSocket: () => socket,
      portStart: 56040,
      portEnd: 56044,
      timeoutMs: 10
    });

    assert.strictEqual(port, 56042);
    assert.deepStrictEqual(socket.sentPorts, [56040, 56041, 56042, 56043, 56044]);
  });

  it('sends ShowUsage after resolving the matching Unity project', async () => {
    const discoverySocket = new FakeUnityIdeSocket({
      projectRoot: 'C:/Project',
      projectPort: 56042
    });
    const showUsageSocket = new FakeUnityIdeSocket();
    const sockets = [discoverySocket, showUsageSocket];

    const sent = await sendUnityIdeShowUsage('C:/Project', 'Assets/Icon.png', {
      createSocket: () => sockets.shift() ?? new FakeUnityIdeSocket(),
      portStart: 56042,
      portEnd: 56042,
      timeoutMs: 10
    });

    const sentMessage = decodeUnityIdeMessage(showUsageSocket.sentMessages[0]);

    assert.strictEqual(sent, true);
    assert.strictEqual(showUsageSocket.sentPorts[0], 56042);
    assert.strictEqual(sentMessage?.type, unityIdeMessageTypeShowUsage);
    assert.deepStrictEqual(JSON.parse(sentMessage?.value ?? ''), {
      Path: 'Assets/Icon.png',
      GameObjectPath: []
    });
  });

  it('returns undefined when no ProjectPath response matches', async () => {
    const socket = new FakeUnityIdeSocket({
      projectRoot: 'C:/OtherProject',
      projectPort: 56042
    });

    const port = await findUnityIdeMessagingEndpoint('C:/Project', {
      createSocket: () => socket,
      portStart: 56042,
      portEnd: 56042,
      timeoutMs: 10
    });

    assert.strictEqual(port, undefined);
  });
});

interface FakeUnityIdeSocketOptions {
  projectRoot?: string;
  projectPort?: number;
}

class FakeUnityIdeSocket implements UnityIdeSocket {
  public readonly sentPorts: number[] = [];
  public readonly sentMessages: Buffer[] = [];
  private messageListener?: (message: Buffer, remoteInfo: { port: number }) => void;
  private errorListener?: (error: Error) => void;

  constructor(private readonly options: FakeUnityIdeSocketOptions = {}) {}

  bind(callback?: () => void): void {
    callback?.();
  }

  close(): void {
    // Test socket has no native resources.
  }

  on(event: 'message', listener: (message: Buffer, remoteInfo: { port: number }) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'message' | 'error',
    listener: ((message: Buffer, remoteInfo: { port: number }) => void) | ((error: Error) => void)
  ): this {
    if (event === 'message') {
      this.messageListener = listener as (message: Buffer, remoteInfo: { port: number }) => void;
    } else {
      this.errorListener = listener as (error: Error) => void;
    }

    return this;
  }

  send(message: Buffer, port: number, _address: string, callback?: (error: Error | null) => void): void {
    this.sentPorts.push(port);
    this.sentMessages.push(message);
    callback?.(null);

    const decoded = decodeUnityIdeMessage(message);
    if (decoded?.type === unityIdeMessageTypeProjectPath && port === this.options.projectPort) {
      const response = encodeUnityIdeMessage(unityIdeMessageTypeProjectPath, this.options.projectRoot ?? '');
      this.messageListener?.(response, { port });
    }
  }
}
