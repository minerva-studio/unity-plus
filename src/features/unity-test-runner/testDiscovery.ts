import {
  unityIdeMessageTypeRetrieveTestList,
  unityIdeMessageTypeTestListRetrieved
} from '../../unity/visualStudioMessaging';
import type { UnityTestBridgeClient } from './unityTestBridge';
import type { UnityTestInfo, UnityTestListPayload } from './testModel';

/** Sent to Unity to request the test list for one mode. */
export function requestTestList(bridge: UnityTestBridgeClient, modes: ('EditMode' | 'PlayMode')[]): void {
  for (const mode of modes) {
    bridge.send(unityIdeMessageTypeRetrieveTestList, mode);
  }
}

/**
 * Parses a TestListRetrieved message body.
 * Format: "EditMode:{json}" or "PlayMode:{json}"
 */
export function parseTestListResponse(value: string):
  { mode: 'EditMode' | 'PlayMode'; tests: UnityTestInfo[] } | undefined {

  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }

  const mode = value.substring(0, colonIndex);
  if (mode !== 'EditMode' && mode !== 'PlayMode') {
    return undefined;
  }

  try {
    const payload: UnityTestListPayload = JSON.parse(value.substring(colonIndex + 1));
    return {
      mode,
      tests: payload.tests ?? []
    };
  } catch {
    return undefined;
  }
}

/**
 * Waits for both EditMode and PlayMode test lists from Unity.
 * Returns a merged result once both are received (or after timeout).
 */
export function collectTestLists(
  bridge: UnityTestBridgeClient,
  timeoutMs = 8000
): Promise<{ editModeTests: UnityTestInfo[]; playModeTests: UnityTestInfo[] }> {
  return new Promise((resolve, reject) => {
    const editModeTests: UnityTestInfo[] = [];
    const playModeTests: UnityTestInfo[] = [];
    let editReceived = false;
    let playReceived = false;
    let settled = false;

    const timeout = setTimeout(() => {
      cleanup();
      // Resolve with whatever we received — partial results are better than none.
      resolve({ editModeTests, playModeTests });
    }, timeoutMs);

    function cleanup(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      bridge.onMessage(() => undefined); // clear handler
    }

    function checkDone(): void {
      if (editReceived && playReceived) {
        cleanup();
        resolve({ editModeTests, playModeTests });
      }
    }

    bridge.onMessage((message) => {
      if (message.type !== unityIdeMessageTypeTestListRetrieved) {
        return;
      }

      const parsed = parseTestListResponse(message.value);
      if (!parsed) {
        return;
      }

      if (parsed.mode === 'EditMode' && !editReceived) {
        editModeTests.push(...parsed.tests);
        editReceived = true;
      } else if (parsed.mode === 'PlayMode' && !playReceived) {
        playModeTests.push(...parsed.tests);
        playReceived = true;
      }

      checkDone();
    });

    bridge.onError((error) => {
      cleanup();
      reject(error);
    });
  });
}

/** Discovers Unity tests by sending RetrieveTestList and collecting responses. */
export async function discoverUnityTests(
  bridge: UnityTestBridgeClient
): Promise<{ editModeTests: UnityTestInfo[]; playModeTests: UnityTestInfo[] }> {
  requestTestList(bridge, ['EditMode', 'PlayMode']);
  return await collectTestLists(bridge);
}
