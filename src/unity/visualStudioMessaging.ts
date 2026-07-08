import * as dgram from 'node:dgram';

export const unityIdeMessageTypeProjectPath = 16;
export const unityIdeMessageTypeShowUsage = 25;

// Test runner message types used by com.unity.ide.visualstudio's TestRunnerApiListener.
export const unityIdeMessageTypePing = 1;
export const unityIdeMessageTypePong = 2;
export const unityIdeMessageTypeTcp = 17;
export const unityIdeMessageTypeRunStarted = 18;
export const unityIdeMessageTypeRunFinished = 19;
export const unityIdeMessageTypeTestStarted = 20;
export const unityIdeMessageTypeTestFinished = 21;
export const unityIdeMessageTypeTestListRetrieved = 22;
export const unityIdeMessageTypeRetrieveTestList = 23;
export const unityIdeMessageTypeExecuteTests = 24;
export const unityIdeMessagingPortStart = 56002;
export const unityIdeMessagingPortEnd = 57001;

export interface UnityIdeMessage {
  type: number;
  value: string;
}

export interface UnityIdeMessagingOptions {
  createSocket?: () => UnityIdeSocket;
  portStart?: number;
  portEnd?: number;
  timeoutMs?: number;
}

export interface UnityIdeSocket {
  bind(callback?: () => void): void;
  close(): void;
  on(event: 'message', listener: (message: Buffer, remoteInfo: Pick<dgram.RemoteInfo, 'port'>) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  send(message: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
}

const localhost = '127.0.0.1';
const defaultTimeoutMs = 250;
let cachedEndpoint: { projectRoot: string; port: number } | undefined;

export function encodeUnityIdeMessage(type: number, value: string): Buffer {
  const valueBytes = Buffer.from(value, 'utf8');
  const buffer = Buffer.allocUnsafe(8 + valueBytes.length);

  buffer.writeInt32LE(type, 0);
  buffer.writeInt32LE(valueBytes.length, 4);
  valueBytes.copy(buffer, 8);

  return buffer;
}

export function decodeUnityIdeMessage(buffer: Buffer): UnityIdeMessage | undefined {
  if (buffer.length < 8) {
    return undefined;
  }

  const type = buffer.readInt32LE(0);
  const valueLength = buffer.readInt32LE(4);
  const valueStart = 8;
  const valueEnd = valueStart + valueLength;

  if (valueLength < 0 || valueEnd > buffer.length) {
    return undefined;
  }

  return {
    type,
    value: buffer.subarray(valueStart, valueEnd).toString('utf8')
  };
}

export async function findUnityIdeMessagingEndpoint(
  projectRoot: string,
  options: UnityIdeMessagingOptions = {}
): Promise<number | undefined> {
  const normalizedProjectRoot = normalizeProjectPath(projectRoot);
  const cachedPort = cachedEndpoint?.projectRoot === normalizedProjectRoot ? cachedEndpoint.port : undefined;

  if (cachedPort !== undefined && await probeUnityIdeMessagingPort(normalizedProjectRoot, cachedPort, options)) {
    return cachedPort;
  }

  const portStart = options.portStart ?? unityIdeMessagingPortStart;
  const portEnd = options.portEnd ?? unityIdeMessagingPortEnd;
  const socket = options.createSocket?.() ?? dgram.createSocket('udp4');

  return await withSocket(socket, async () => await new Promise<number | undefined>(resolve => {
    let settled = false;
    const timeout = setTimeout(() => settle(undefined), options.timeoutMs ?? defaultTimeoutMs);
    const request = encodeUnityIdeMessage(unityIdeMessageTypeProjectPath, '');

    function settle(port: number | undefined): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      cachedEndpoint = port === undefined ? undefined : { projectRoot: normalizedProjectRoot, port };
      resolve(port);
    }

    socket.on('message', (message, remoteInfo) => {
      const decoded = decodeUnityIdeMessage(message);
      if (decoded?.type !== unityIdeMessageTypeProjectPath) {
        return;
      }

      if (normalizeProjectPath(decoded.value) === normalizedProjectRoot) {
        settle(remoteInfo.port);
      }
    });

    // Unity derives the IDE messaging port from the editor process ID, so scan the bounded official range.
    for (let port = portStart; port <= portEnd; port += 1) {
      socket.send(request, port, localhost, () => undefined);
    }
  }));
}

export async function sendUnityIdeShowUsage(
  projectRoot: string,
  assetPath: string,
  options: UnityIdeMessagingOptions = {}
): Promise<boolean> {
  const port = await findUnityIdeMessagingEndpoint(projectRoot, options);
  if (port === undefined) {
    return false;
  }

  const socket = options.createSocket?.() ?? dgram.createSocket('udp4');
  const payload = JSON.stringify({
    Path: assetPath,
    GameObjectPath: []
  });
  const message = encodeUnityIdeMessage(unityIdeMessageTypeShowUsage, payload);

  return await withSocket(socket, async () => await new Promise<boolean>(resolve => {
    socket.send(message, port, localhost, error => resolve(!error));
  }));
}

export function resetUnityIdeMessagingCache(): void {
  cachedEndpoint = undefined;
}

async function probeUnityIdeMessagingPort(
  normalizedProjectRoot: string,
  port: number,
  options: UnityIdeMessagingOptions
): Promise<boolean> {
  const socket = options.createSocket?.() ?? dgram.createSocket('udp4');

  return await withSocket(socket, async () => await new Promise<boolean>(resolve => {
    let settled = false;
    const timeout = setTimeout(() => settle(false), options.timeoutMs ?? defaultTimeoutMs);
    const request = encodeUnityIdeMessage(unityIdeMessageTypeProjectPath, '');

    function settle(result: boolean): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    socket.on('message', message => {
      const decoded = decodeUnityIdeMessage(message);
      settle(decoded?.type === unityIdeMessageTypeProjectPath &&
        normalizeProjectPath(decoded.value) === normalizedProjectRoot);
    });
    socket.send(request, port, localhost, error => {
      if (error) {
        settle(false);
      }
    });
  }));
}

async function withSocket<T>(socket: UnityIdeSocket, run: () => Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    socket.on('error', reject);
    socket.bind(async () => {
      try {
        resolve(await run());
      } catch (error) {
        reject(error);
      } finally {
        socket.close();
      }
    });
  });
}

function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
