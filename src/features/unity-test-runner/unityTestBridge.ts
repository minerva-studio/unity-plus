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

const maxUdpPayload = 50000;
const pingIntervalMs = 3000;

export type BridgeMessageHandler = (message: UnityIdeMessage) => void;
export type BridgeErrorHandler = (error: Error) => void;

export interface UnityTestBridgeDependencies {
  /** Finds and validates the current Unity IDE messaging endpoint. */
  findEndpoint?: (projectRoot: string) => Promise<number | undefined>;
  /** Creates the persistent UDP socket after endpoint validation succeeds. */
  createSocket?: () => dgram.Socket;
}

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
 * Creates a UDP client that talks to com.unity.ide.visualstudio's
 * messaging bridge with endpoint revalidation, keep-alive pings, and TCP
 * fallback for large messages.
 */
export function createUnityTestBridge(dependencies: UnityTestBridgeDependencies = {}): UnityTestBridgeClient {
  let socket: dgram.Socket | undefined;
  let port: number | undefined;
  let messageHandler: BridgeMessageHandler | undefined;
  let errorHandler: BridgeErrorHandler | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let connectInFlight: Promise<void> | undefined;

  function startPing(): void {
    stopPing();
    pingTimer = setInterval(() => { try { sendRaw(unityIdeMessageTypePing, ''); } catch { /* ignore */ } }, pingIntervalMs);
  }
  function stopPing(): void { if (pingTimer) { clearInterval(pingTimer); pingTimer = undefined; } }

  /** Closes the persistent socket and clears all endpoint state. */
  function closeConnection(): void {
    stopPing();
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
      socket = undefined;
    }
    port = undefined;
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
    let buffer = Buffer.alloc(0);

    // Safety timeout: abort TCP read after 30s to prevent hanging connections.
    const safety = setTimeout(() => {
      try { tcpSocket.end(); } catch { /* ignore */ }
    }, 30000);

    tcpSocket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        clearTimeout(safety);
        const decoded = decodeUnityIdeMessage(buffer);
        if (decoded) {
          messageHandler?.(decoded);
        }
        tcpSocket.end();
      }
    });

    tcpSocket.on('error', err => {
      clearTimeout(safety);
      errorHandler?.(err);
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
      // Coalesce concurrent callers while validating the endpoint for each operation.
      if (connectInFlight) {
        return await connectInFlight;
      }

      connectInFlight = (async () => {
        try {
          const discoveredPort = await (dependencies.findEndpoint ?? findUnityIdeMessagingEndpoint)(projectRoot);
          if (discoveredPort === undefined) {
            throw new Error(
              'Could not find Unity IDE messaging endpoint. Make sure Unity Editor is open with this project.'
            );
          }

          // Keep the socket only when ProjectPath validation confirms the same endpoint.
          if (socket && port === discoveredPort) {
            (this as { connected: boolean }).connected = true;
            return;
          }

          // Unity restarts can change the PID-derived port, so rebuild on migration.
          closeConnection();
          socket = dependencies.createSocket?.() ?? dgram.createSocket('udp4');
          port = discoveredPort;

          socket.on('message', (msg: Buffer) => handleMessage(msg));
          socket.on('error', err => errorHandler?.(err));

          await new Promise<void>((resolve, reject) => {
            socket!.bind(() => resolve());
            socket!.once('error', reject);
          });

          (this as { connected: boolean }).connected = true;
          startPing();
        } catch (error) {
          // A failed validation or bind must not leave a stale endpoint marked connected.
          closeConnection();
          (this as { connected: boolean }).connected = false;
          throw error;
        }
      })();

      try {
        await connectInFlight;
      } finally {
        connectInFlight = undefined;
      }
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
      closeConnection();
      (this as { connected: boolean }).connected = false;
    }
  };
}
