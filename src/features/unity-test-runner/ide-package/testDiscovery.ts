import {
  unityIdeMessageTypeRetrieveTestList,
  unityIdeMessageTypeTestListRetrieved
} from '../../../unity/visualStudioMessaging';
import type { UnityTestDiscoveryResult } from '../testModel';
import type { UnityTestBridgeClient } from './unityTestBridge';
import type { UnityTestInfo, UnityTestAdaptorContainer } from './testModel';
import { mapUnityTestAdaptorsToNodes } from './testTree';

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
    const payload: UnityTestAdaptorContainer = JSON.parse(value.substring(colonIndex + 1));
    return {
      mode,
      tests: payload.TestAdaptors ?? []
    };
  } catch {
    return undefined;
  }
}

/**
 * Sends RetrieveTestList to Unity and waits for both EditMode and PlayMode
 * test lists.  The message handler is registered BEFORE sending to avoid the
 * race where Unity responds faster than we can subscribe.
 */
export function discoverUnityTests(
  bridge: UnityTestBridgeClient,
  timeoutMs = 8000
): Promise<UnityTestDiscoveryResult> {
  return new Promise((resolve, reject) => {
    const editModeTests: UnityTestInfo[] = [];
    const playModeTests: UnityTestInfo[] = [];
    let editReceived = false;
    let playReceived = false;
    let settled = false;

    const timeout = setTimeout(() => {
      cleanup();
      if (!editReceived && !playReceived) {
        reject(new Error('Unity did not respond with a test list.'));
        return;
      }

      // Preserve a valid partial response if only one test mode is available.
      resolve({
        editModeTests: mapUnityTestAdaptorsToNodes(editModeTests),
        playModeTests: mapUnityTestAdaptorsToNodes(playModeTests)
      });
    }, timeoutMs);

    function cleanup(): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      messageSubscription?.dispose();
    }

    function checkDone(): void {
      if (editReceived && playReceived) {
        cleanup();
        resolve({
          editModeTests: mapUnityTestAdaptorsToNodes(editModeTests),
          playModeTests: mapUnityTestAdaptorsToNodes(playModeTests)
        });
      }
    }

    // IMPORTANT: register the message handler BEFORE sending requests.
    // UDP responses can arrive before the send() call completes.
    const messageSubscription = bridge.onMessage((message) => {
      if (settled) {
        return;
      }

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

    // Now send — handler is already listening.
    bridge.send(unityIdeMessageTypeRetrieveTestList, 'EditMode');
    bridge.send(unityIdeMessageTypeRetrieveTestList, 'PlayMode');
  });
}
