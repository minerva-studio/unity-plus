/**
 * Data model types for Unity test discovery and execution.
 *
 * Mirrors the JSON structures that com.unity.ide.visualstudio's
 * TestRunnerApiListener serializes from UnityEditor.TestTools.TestRunner.Api.
 */

/** Test execution mode matching Unity Test Framework's TestMode enum. */
export type UnityTestMode = 'EditMode' | 'PlayMode';

/**
 * A single test node as serialized by Unity's TestAdaptor.
 * The tree is flattened; ParentId links child to parent.
 */
export interface UnityTestInfo {
  Id: string;
  Name: string;
  FullName: string;
  Type: string;
  Method: string;
  Assembly: string;
  Parent: string; // parent test Id, empty for root nodes
}

/** Payload of a TestListRetrieved message. */
export interface UnityTestListPayload {
  tests: UnityTestInfo[];
}

/** A built test tree keyed by Id for O(1) lookup. */
export interface UnityTestTree {
  roots: UnityTestInfo[];
  byId: Map<string, UnityTestInfo>;
  childrenByParent: Map<string, UnityTestInfo[]>;
}

/** Describes the scope of a test run received in RunStarted. */
export interface UnityTestRunStartedPayload {
  TestMode: UnityTestMode;
  // The test tree that is about to run (may be a subset for filtered runs).
  Tests: UnityTestInfo[];
}

/** A single test result received in TestFinished. */
export interface UnityTestResultPayload {
  Id: string;
  FullName: string;
  Result: UnityTestResultStatus;
  Duration: number; // milliseconds
  Message: string;
  StackTrace: string;
}

export type UnityTestResultStatus =
  | 'Passed'
  | 'Failed'
  | 'Skipped'
  | 'Inconclusive';

/** Summary received in RunFinished. */
export interface UnityTestRunFinishedPayload {
  TestMode: UnityTestMode;
  PassCount: number;
  FailCount: number;
  SkipCount: number;
  InconclusiveCount: number;
  Duration: number;
}

/** Builds a look-up tree from a flat array of UnityTestInfo items. */
export function buildUnityTestTree(tests: UnityTestInfo[]): UnityTestTree {
  const byId = new Map<string, UnityTestInfo>();
  const childrenByParent = new Map<string, UnityTestInfo[]>();
  const roots: UnityTestInfo[] = [];

  for (const test of tests) {
    byId.set(test.Id, test);
  }

  for (const test of tests) {
    if (test.Parent && byId.has(test.Parent)) {
      const siblings = childrenByParent.get(test.Parent) ?? [];
      siblings.push(test);
      childrenByParent.set(test.Parent, siblings);
    } else {
      roots.push(test);
    }
  }

  return { roots, byId, childrenByParent };
}
