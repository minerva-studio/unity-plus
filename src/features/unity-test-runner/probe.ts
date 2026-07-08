/**
 * Probe v2 — discovers tests THEN tries to execute one.
 * Usage: node out/features/unity-test-runner/probe.js "C:/path/to/UnityProject"
 */

import * as dgram from "node:dgram";
import * as net from "node:net";

const PROJECT_ROOT = process.argv[2];
if (!PROJECT_ROOT) {
  console.error('Usage: node probe.js "C:/path/to/UnityProject"');
  process.exit(1);
}

const TYPE: Record<string, number> = {
  Ping: 1,
  Pong: 2,
  Tcp: 17,
  RunStarted: 18,
  RunFinished: 19,
  TestStarted: 20,
  TestFinished: 21,
  TestListRetrieved: 22,
  RetrieveTestList: 23,
  ExecuteTests: 24,
  ProjectPath: 16,
};

const TYPE_NAME: Record<number, string> = {};
for (const [k, v] of Object.entries(TYPE)) {
  TYPE_NAME[v] = k;
}

function encode(type: number, value: string): Buffer {
  const val = Buffer.from(value, "utf8");
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
  return { type, value: buffer.subarray(8, 8 + len).toString("utf8") };
}

function typeName(t: number): string {
  return TYPE_NAME[t] ?? `UNKNOWN(${t})`;
}
function preview(val: string): string {
  return val.length > 500
    ? val.substring(0, 500) + `... (${val.length} chars)`
    : val;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- TCP fallback reader ---
function readTcp(host: string, port: number, length: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    sock.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= length) {
        const d = decode(buffer);
        sock.end();
        resolve(d ? d.value : `<undecodable ${buffer.length}B>`);
      }
    });
    sock.on("error", () => resolve("<tcp-error>"));
    setTimeout(() => {
      sock.end();
      resolve("<tcp-timeout>");
    }, 10000);
  });
}

// --- Port scan ---
async function findPort(projectRoot: string): Promise<number> {
  const normalized = projectRoot
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const probe = encode(TYPE.ProjectPath, "");
    let found = false;
    sock.on("message", (msg, rinfo) => {
      const d = decode(msg);
      if (!d || d.type !== TYPE.ProjectPath) return;
      if (
        d.value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
        normalized
      ) {
        found = true;
        console.log(`[SCAN] Found Unity at port ${rinfo.port}`);
        sock.close();
        resolve(rinfo.port);
      }
    });
    sock.bind(() => {
      for (let port = 56002; port <= 57001; port++)
        sock.send(probe, port, "127.0.0.1");
      setTimeout(() => {
        if (!found) {
          sock.close();
          reject(new Error("Not found"));
        }
      }, 2000);
    });
  });
}

// --- Main ---
async function main() {
  console.log(`[PROBE] Project: ${PROJECT_ROOT}`);
  const port = await findPort(PROJECT_ROOT);
  console.log(`[PROBE] Connected to 127.0.0.1:${port}`);

  const sock = dgram.createSocket("udp4");
  let recvCount = 0;
  const tcpData: string[] = [];

  sock.on("message", (msg) => {
    const d = decode(msg);
    if (!d) {
      console.log(`[RECV #${++recvCount}] <undecodable>`);
      return;
    }
    console.log(
      `[RECV #${recvCount}] type=${d.type} (${typeName(d.type)}) value=${preview(d.value)}`,
    );
    recvCount++;

    if (d.type === TYPE.Tcp) {
      const parts = d.value.split(":");
      const tcpPort = parseInt(parts[0]),
        length = parseInt(parts[1]);
      if (!isNaN(tcpPort) && !isNaN(length)) {
        console.log(`[TCP] Reading ${length}B from :${tcpPort}...`);
        readTcp("127.0.0.1", tcpPort, length).then((data) => {
          console.log(`[TCP-DATA] ${preview(data)}`);
          tcpData.push(data);
        });
      }
    }
  });

  sock.on("error", (e) => console.error("[ERR]", e.message));
  await new Promise<void>((r) => sock.bind(r));

  // 1. Ping
  console.log("[SEND] Ping");
  sock.send(encode(TYPE.Ping, ""), port, "127.0.0.1");
  await sleep(300);

  // 2. Get test lists
  console.log("[SEND] RetrieveTestList EditMode");
  sock.send(encode(TYPE.RetrieveTestList, "EditMode"), port, "127.0.0.1");
  await sleep(300);
  console.log("[SEND] RetrieveTestList PlayMode");
  sock.send(encode(TYPE.RetrieveTestList, "PlayMode"), port, "127.0.0.1");

  // 3. Wait for TCP data — retry if nothing arrives
  console.log("[WAIT] Collecting test lists (15s)...");
  await sleep(5000);

  if (tcpData.length === 0) {
    console.log("[RETRY] No response yet — re-sending RetrieveTestList...");
    sock.send(encode(TYPE.RetrieveTestList, "EditMode"), port, "127.0.0.1");
    sock.send(encode(TYPE.RetrieveTestList, "PlayMode"), port, "127.0.0.1");
    await sleep(10000);
  }

  // Find a leaf test from TCP data
  interface TestNode { Id: string; Name: string; FullName: string; Method: string; Parent: number; }
  let leafFullName = '';
  let leafMode = 'EditMode';

  for (const raw of tcpData) {
    const idx = raw.indexOf(':');
    const mode = idx >= 0 ? raw.substring(0, idx) : '';
    const json = idx >= 0 ? raw.substring(idx + 1) : raw;
    if (mode !== 'EditMode' && mode !== 'PlayMode') continue;

    try {
      const tests: TestNode[] = JSON.parse(json).TestAdaptors || [];
      console.log(`[PARSE] ${mode}: ${tests.length} nodes`);
      for (const t of tests) {
        if (t.Method && t.FullName.includes('.') && !t.FullName.endsWith('.dll')) {
          leafFullName = t.FullName;
          leafMode = mode;
          console.log(`[PICK] ${mode} leaf: "${t.FullName}" (Name="${t.Name}" Method="${t.Method}")`);
          break;
        }
      }
    } catch {}
    if (leafFullName) break;
  }

  // Show sample nodes if no leaf found
  if (!leafFullName) {
    console.log('[DUMP] No leaf found. Sample nodes:');
    for (const raw of tcpData) {
      const idx = raw.indexOf(':');
      const json = idx >= 0 ? raw.substring(idx + 1) : raw;
      try {
        const tests: TestNode[] = JSON.parse(json).TestAdaptors || [];
        tests.slice(0, 10).forEach(t => {
          console.log(`  Id=${t.Id} FullName="${t.FullName}" Method="${t.Method}" Parent=${t.Parent}`);
        });
      } catch {}
    }
  }

  if (leafFullName) {
    // 4. Execute the real test
    console.log(`\n[SEND] ExecuteTests ${leafMode}:${leafFullName}`);
    sock.send(encode(TYPE.ExecuteTests, `${leafMode}:${leafFullName}`), port, '127.0.0.1');
    console.log('[WAIT] Listening for execution results (25s)...');
    await sleep(25000);
  } else {
    console.log('[SKIP] No test to execute.');
  }

  console.log(`\n[DONE] Total messages: ${recvCount}`);
  sock.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
