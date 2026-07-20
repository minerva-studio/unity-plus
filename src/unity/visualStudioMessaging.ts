import * as dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

export interface UnityIdeMessagingEndpoint {
  projectRoot: string;
  port: number;
  processId?: number;
}

export interface UnityIdeMessagingEndpointResolverOptions extends UnityIdeMessagingOptions {
  /** Lets the UI choose between multiple Editor endpoints for the same Unity project. */
  selectEndpoint?: (
    projectRoot: string,
    endpoints: readonly UnityIdeMessagingEndpoint[]
  ) => Promise<UnityIdeMessagingEndpoint | undefined>;
  /** Reads EditorInstance.json so a matching endpoint can expose its process id. */
  readEditorInstance?: (projectRoot: string) => UnityEditorInstanceInfo | undefined;
}

export interface UnityIdeMessagingEndpointResolver {
  /** Resolves one endpoint, reusing the session choice while that endpoint remains valid. */
  resolve(projectRoot: string, forceSelection?: boolean): Promise<number | undefined>;
  /** Discovers every responsive local Unity IDE messaging endpoint in one port-range scan. */
  discover(): Promise<readonly UnityIdeMessagingEndpoint[]>;
  /** Clears one project choice, or all session choices when no project is supplied. */
  forget(projectRoot?: string): void;
}

interface UnityEditorInstanceInfo {
  process_id?: number;
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
const defaultEndpointResolver = createUnityIdeMessagingEndpointResolver();

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
  if (Object.keys(options).length === 0) {
    return await defaultEndpointResolver.resolve(projectRoot);
  }

  return await createUnityIdeMessagingEndpointResolver(options).resolve(projectRoot);
}

/** Creates a session-scoped resolver that supports every local Unity Editor endpoint. */
export function createUnityIdeMessagingEndpointResolver(
  options: UnityIdeMessagingEndpointResolverOptions = {}
): UnityIdeMessagingEndpointResolver {
  const selectedPorts = new Map<string, number>();
  const resolutions = new Map<string, Promise<number | undefined>>();
  let discoveryInFlight: Promise<readonly UnityIdeMessagingEndpoint[]> | undefined;

  async function discover(): Promise<readonly UnityIdeMessagingEndpoint[]> {
    if (discoveryInFlight) {
      return await discoveryInFlight;
    }

    discoveryInFlight = discoverUnityIdeMessagingEndpoints(options);
    try {
      return await discoveryInFlight;
    } finally {
      discoveryInFlight = undefined;
    }
  }

  async function resolveProject(projectRoot: string, forceSelection: boolean): Promise<number | undefined> {
    const normalizedProjectRoot = normalizeProjectPath(projectRoot);
    const selectedPort = selectedPorts.get(normalizedProjectRoot);

    if (!forceSelection && selectedPort !== undefined &&
      await probeUnityIdeMessagingPort(normalizedProjectRoot, selectedPort, options)) {
      return selectedPort;
    }

    selectedPorts.delete(normalizedProjectRoot);
    const discovered = await discover();
    const candidates = addEditorProcessIdentity(projectRoot, discovered.filter(endpoint =>
      normalizeProjectPath(endpoint.projectRoot) === normalizedProjectRoot
    ), options.readEditorInstance ?? readUnityEditorInstance);

    if (candidates.length === 0) {
      return undefined;
    }

    // Production supplies a picker even for one endpoint so a newly started Editor is explicitly selected.
    if (!options.selectEndpoint && candidates.length === 1) {
      selectedPorts.set(normalizedProjectRoot, candidates[0].port);
      return candidates[0].port;
    }

    const selected = await options.selectEndpoint?.(projectRoot, candidates);
    if (!selected || !candidates.some(candidate => candidate.port === selected.port)) {
      return undefined;
    }

    selectedPorts.set(normalizedProjectRoot, selected.port);
    return selected.port;
  }

  return {
    async resolve(projectRoot, forceSelection = false) {
      const key = normalizeProjectPath(projectRoot);
      const existing = resolutions.get(key);
      if (existing) {
        return await existing;
      }

      const resolution = resolveProject(projectRoot, forceSelection);
      resolutions.set(key, resolution);
      try {
        return await resolution;
      } finally {
        resolutions.delete(key);
      }
    },
    discover,
    forget(projectRoot) {
      if (projectRoot === undefined) {
        selectedPorts.clear();
        return;
      }

      selectedPorts.delete(normalizeProjectPath(projectRoot));
    }
  };
}

/** Collects all ProjectPath responses instead of accepting the first matching Editor. */
export async function discoverUnityIdeMessagingEndpoints(
  options: UnityIdeMessagingOptions = {}
): Promise<readonly UnityIdeMessagingEndpoint[]> {
  const portStart = options.portStart ?? unityIdeMessagingPortStart;
  const portEnd = options.portEnd ?? unityIdeMessagingPortEnd;
  const socket = options.createSocket?.() ?? dgram.createSocket('udp4');

  return await withSocket(socket, async () => await new Promise<readonly UnityIdeMessagingEndpoint[]>(resolve => {
    const endpoints = new Map<number, UnityIdeMessagingEndpoint>();
    const request = encodeUnityIdeMessage(unityIdeMessageTypeProjectPath, '');
    setTimeout(() => {
      resolve([...endpoints.values()].sort((left, right) => left.port - right.port));
    }, options.timeoutMs ?? defaultTimeoutMs);

    socket.on('message', (message, remoteInfo) => {
      const decoded = decodeUnityIdeMessage(message);
      if (decoded?.type !== unityIdeMessageTypeProjectPath || !decoded.value) {
        return;
      }

      endpoints.set(remoteInfo.port, {
        projectRoot: decoded.value,
        port: remoteInfo.port
      });
    });

    // Unity derives the IDE messaging port from the Editor process ID, so scan the bounded official range.
    for (let port = portStart; port <= portEnd; port += 1) {
      socket.send(request, port, localhost, () => undefined);
    }
  }));
}

export async function sendUnityIdeShowUsage(
  projectRoot: string,
  assetPath: string,
  options: UnityIdeMessagingOptions & {
    findEndpoint?: (projectRoot: string) => Promise<number | undefined>;
  } = {}
): Promise<boolean> {
  const port = await (options.findEndpoint ?? (root => findUnityIdeMessagingEndpoint(root, options)))(projectRoot);
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
  defaultEndpointResolver.forget();
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

/** Adds the process id only when EditorInstance.json proves it owns the discovered messaging port. */
function addEditorProcessIdentity(
  projectRoot: string,
  endpoints: readonly UnityIdeMessagingEndpoint[],
  readEditorInstance: (projectRoot: string) => UnityEditorInstanceInfo | undefined
): UnityIdeMessagingEndpoint[] {
  const processId = readEditorInstance(projectRoot)?.process_id;
  if (!Number.isInteger(processId) || processId === undefined) {
    return [...endpoints];
  }

  const expectedPort = unityIdeMessagingPortStart + processId % 1000;
  return endpoints.map(endpoint => endpoint.port === expectedPort
    ? { ...endpoint, processId }
    : endpoint
  );
}

/** Reads Unity's per-project Editor identity without making it the source of endpoint discovery. */
function readUnityEditorInstance(projectRoot: string): UnityEditorInstanceInfo | undefined {
  try {
    return JSON.parse(readFileSync(join(projectRoot, 'Library', 'EditorInstance.json'), 'utf8')) as UnityEditorInstanceInfo;
  } catch {
    return undefined;
  }
}
