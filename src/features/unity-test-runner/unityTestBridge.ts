import * as dgram from 'node:dgram';
import * as net from 'node:net';
import {
  decodeUnityIdeMessage,
  encodeUnityIdeMessage,
  findUnityIdeMessagingEndpoint,
  unityIdeMessageTypeTcp,
  unityIdeMessageTypePing,
  type UnityIdeMessage
} from '../../unity/visualStudioMessaging';

/** Interval in ms between keep-alive Ping messages. */
const pingIntervalMs = 1500;

/** Maximum bytes for a single UDP datagram payload before TCP fallback kicks in. */
const maxUdpPayload = 50000;

export type BridgeMessageHandler = (message: UnityIdeMessage) => void;
export type BridgeErrorHandler = (error: Error) => void;

export interface UnityTestBridgeClient {
  /** Start the connection to Unity's messaging port. Resolves once the port is found. */
  connect(projectRoot: string): Promise<void>;
  /** Send a typed message to Unity. */
  send(type: number, value?: string): void;
  /** Register a handler for incoming messages. */
  onMessage(handler: BridgeMessageHandler): void;
  /** Register a handler for socket errors. */
  onError(handler: BridgeErrorHandler): void;
  /** Close the persistent socket and stop keep-alive. */
  disconnect(): void;
  /** Whether the bridge has an active connection. */
  readonly connected: boolean;
}

/**
 * Creates a persistent UDP client that talks to com.unity.ide.visualstudio's
 * messaging bridge.  It keeps the socket open, sends periodic Ping messages
 * so Unity doesn't drop the client from its broadcast list, and implements
 * TCP fallback for messages that exceed the UDP datagram size.
 */
export function createUnityTestBridge(): UnityTestBridgeClient {
  let socket: dgram.Socket | undefined;
  let port: number | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let messageHandler: BridgeMessageHandler | undefined;
  let errorHandler: BridgeErrorHandler | undefined;

  // Accumulate partial UDP reads for TCP-fallback reassembly.
  let tcpFallbackBuffer: Buffer | undefined;

  function startPing(): void {
    stopPing();
    pingTimer = setInterval(() => {
      try {
        sendRaw(unityIdeMessageTypePing, '');
      } catch {
        // Ping failures are non-fatal; Unity may have closed.
      }
    }, pingIntervalMs);
  }

  function stopPing(): void {
    if (pingTimer !== undefined) {
      clearInterval(pingTimer);
      pingTimer = undefined;
    }
  }

  function sendRaw(type: number, value: string): void {
    if (!socket || port === undefined) {
      return;
    }

    const fullMessage = encodeUnityIdeMessage(type, value);
    if (fullMessage.length <= maxUdpPayload) {
      socket.send(fullMessage, port, '127.0.0.1');
    } else {
      // Unity side uses Tcp marker for large payloads.
      // We emit the Tcp marker + the full payload via TCP so the Unity
      // Messager can reconstruct the original message.
      sendViaTcpFallback(fullMessage);
    }
  }

  function sendViaTcpFallback(payload: Buffer): void {
    if (port === undefined) {
      return;
    }

    const tcpSocket = net.createConnection({ host: '127.0.0.1', port });
    tcpSocket.on('error', err => {
      errorHandler?.(err);
    });
    tcpSocket.on('connect', () => {
      // Unity Messager protocol: send Tcp marker "{listeningPort}:{length}"
      // then the raw payload on the TCP socket so the receiver can reassemble.
      tcpSocket.write(payload);
      tcpSocket.end();
    });
  }

  function receiveTcpFallback(host: string, tcpPort: number, length: number): void {
    const tcpSocket = net.createConnection({ host, port: tcpPort });
    tcpFallbackBuffer = Buffer.alloc(0);

    tcpSocket.on('data', (chunk: Buffer) => {
      tcpFallbackBuffer = Buffer.concat([tcpFallbackBuffer!, chunk]);
      if (tcpFallbackBuffer.length >= length) {
        const decoded = decodeUnityIdeMessage(tcpFallbackBuffer);
        if (decoded) {
          messageHandler?.(decoded);
        }
        tcpFallbackBuffer = undefined;
        tcpSocket.end();
      }
    });

    tcpSocket.on('error', err => {
      errorHandler?.(err);
      tcpFallbackBuffer = undefined;
    });
  }

  function handleMessage(buffer: Buffer): void {
    const decoded = decodeUnityIdeMessage(buffer);
    if (!decoded) {
      return;
    }

    // TCP fallback marker: body is "listeningPort:length"
    if (decoded.type === unityIdeMessageTypeTcp) {
      const parts = decoded.value.split(':');
      const tcpPort = parseInt(parts[0], 10);
      const length = parseInt(parts[1], 10);
      if (!isNaN(tcpPort) && !isNaN(length)) {
        receiveTcpFallback('127.0.0.1', tcpPort, length);
      }
      return;
    }

    messageHandler?.(decoded);
  }

  return {
    connected: false,

    async connect(projectRoot: string): Promise<void> {
      // Tear down any previous connection before establishing a new one.
      stopPing();
      if (socket) {
        try { socket.close(); } catch { /* already closed */ }
        socket = undefined;
      }
      port = undefined;
      tcpFallbackBuffer = undefined;

      const discoveredPort = await findUnityIdeMessagingEndpoint(projectRoot);
      if (discoveredPort === undefined) {
        throw new Error(
          'Could not find Unity IDE messaging endpoint. Make sure Unity Editor is open with this project.'
        );
      }

      socket = dgram.createSocket('udp4');
      port = discoveredPort;

      socket.on('message', (msg: Buffer) => handleMessage(msg));
      socket.on('error', err => errorHandler?.(err));

      // Bind to an ephemeral port so we can receive responses.
      await new Promise<void>((resolve, reject) => {
        socket!.bind(() => resolve());
        socket!.once('error', reject);
      });

      (this as { connected: boolean }).connected = true;
      startPing();
    },

    send(type: number, value = ''): void {
      sendRaw(type, value);
    },

    onMessage(handler: BridgeMessageHandler): void {
      messageHandler = handler;
    },

    onError(handler: BridgeErrorHandler): void {
      errorHandler = handler;
    },

    disconnect(): void {
      stopPing();
      if (socket) {
        try {
          socket.close();
        } catch {
          // Socket may already be closed.
        }
        socket = undefined;
      }
      port = undefined;
      tcpFallbackBuffer = undefined;
      (this as { connected: boolean }).connected = false;
    }
  };
}

function disconnect(client: UnityTestBridgeClient): void {
  client.disconnect();
}
