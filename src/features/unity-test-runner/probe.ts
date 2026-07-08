/**
 * Standalone probe script — connects directly to Unity's messaging port
 * and prints every raw message sent/received.
 *
 * Usage: npx ts-node src/features/unity-test-runner/probe.ts "C:/path/to/UnityProject"
 *    or: npm run compile && node out/features/unity-test-runner/probe.js "C:/path/to/UnityProject"
 */

import * as dgram from 'node:dgram';
import * as net from 'node:net';

const PROJECT_ROOT = process.argv[2];
if (!PROJECT_ROOT) {
  console.error('Usage: node probe.js "C:/path/to/UnityProject"');
  process.exit(1);
}

// --- Message types (must match com.unity.ide.visualstudio) ---
const TYPE: Record<string, number> = {
  Ping: 1, Pong: 2,
  Tcp: 17,
  RunStarted: 18, RunFinished: 19,
  TestStarted: 20, TestFinished: 21,
  TestListRetrieved: 22, RetrieveTestList: 23, ExecuteTests: 24,
  ProjectPath: 16,
};

const TYPE_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(TYPE)) { TYPE_NAME[v] = k; }

function encode(type: number, value: string): Buffer {
  const val = Buffer.from(value, 'utf8');
  const buf = Buffer.alloc(8 + val.length);
  buf.writeInt32LE(type, 0);
  buf.writeInt32LE(val.length, 4);
  val.copy(buf, 8);
  return buf;
}

function decode(buffer: Buffer): { type: number; value: string } | null {
  if (buffer.length < 8) return null;
  const type = buffer.readInt32LE(0);
  const len = buffer.readInt32LE(4);
  if (len < 0 || 8 + len > buffer.length) return null;
  return { type, value: buffer.subarray(8, 8 + len).toString('utf8') };
}

function typeName(t: number): string { return TYPE_NAME[t] ?? `UNKNOWN(${t})`; }

function preview(val: string): string {
  return val.length > 300 ? val.substring(0, 300) + `... (${val.length} chars)` : val;
}

// --- Port scan ---
async function findPort(projectRoot: string): Promise<number> {
  const normalized = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const PORT_START = 56002, PORT_END = 57001;

  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const probe = encode(TYPE.ProjectPath, '');
    let found = false;

    sock.on('message', (msg, rinfo) => {
      const d = decode(msg);
      if (!d || d.type !== TYPE.ProjectPath) return;
      const val = d.value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (val === normalized) {
        found = true;
        console.log(`[SCAN] Found Unity at port ${rinfo.port}, project matches`);
        sock.close();
        resolve(rinfo.port);
      }
    });

    sock.bind(() => {
      for (let port = PORT_START; port <= PORT_END; port++) {
        sock.send(probe, port, '127.0.0.1');
      }
      setTimeout(() => {
        if (!found) { sock.close(); reject(new Error('Unity not found in port range')); }
      }, 2000);
    });
  });
}

// --- Main probe ---
async function main() {
  console.log(`[PROBE] Project: ${PROJECT_ROOT}`);

  const port = await findPort(PROJECT_ROOT);
  console.log(`[PROBE] Connected to Unity on 127.0.0.1:${port}`);

  const sock = dgram.createSocket('udp4');
  let receivedCount = 0;

  sock.on('message', (msg) => {
    const d = decode(msg);
    if (!d) { console.log('[RECV] <undecodable>'); return; }
    receivedCount++;
    console.log(`[RECV #${receivedCount}] type=${d.type} (${typeName(d.type)}) value=${preview(d.value)}`);

    // TCP fallback: connect and read full payload
    if (d.type === TYPE.Tcp) {
      const parts = d.value.split(':');
      const tcpPort = parseInt(parts[0], 10);
      const length = parseInt(parts[1], 10);
      if (!isNaN(tcpPort) && !isNaN(length)) {
        console.log(`[TCP] Connecting to 127.0.0.1:${tcpPort} to read ${length} bytes...`);
        readTcpFallback('127.0.0.1', tcpPort, length);
      }
    }
  });

  sock.on('error', (err) => console.error('[ERR]', err.message));

  await new Promise<void>(resolve => sock.bind(resolve));

  // 1. Ping
  console.log('[SEND] Ping');
  sock.send(encode(TYPE.Ping, ''), port, '127.0.0.1');

  await sleep(500);

  // 2. Retrieve EditMode test list
  console.log('[SEND] RetrieveTestList EditMode');
  sock.send(encode(TYPE.RetrieveTestList, 'EditMode'), port, '127.0.0.1');

  await sleep(500);

  // 3. Retrieve PlayMode test list
  console.log('[SEND] RetrieveTestList PlayMode');
  sock.send(encode(TYPE.RetrieveTestList, 'PlayMode'), port, '127.0.0.1');

  // 4. Wait for responses
  console.log('[WAIT] Listening for 5 seconds...');
  await sleep(5000);

  console.log(`[DONE] Received ${receivedCount} messages total.`);
  sock.close();
  process.exit(0);
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function readTcpFallback(host: string, port: number, length: number): void {
  const sock = net.createConnection({ host, port });
  let buffer = Buffer.alloc(0);

  sock.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length >= length) {
      const d = decode(buffer);
      if (d) {
        console.log(`[TCP-DONE] type=${d.type} (${typeName(d.type)})`);
        console.log(`[TCP-DATA] ${preview(d.value)}`);
      } else {
        console.log(`[TCP-DONE] <undecodable ${buffer.length} bytes>`);
      }
      sock.end();
    }
  });

  sock.on('error', (err) => console.error('[TCP-ERR]', err.message));
}

main().catch(err => { console.error('[FATAL]', err.message); process.exit(1); });
