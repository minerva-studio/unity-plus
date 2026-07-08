/**
 * Data model types for Unity test discovery and execution.
 *
 * Mirrors the JSON structures that com.unity.ide.visualstudio's
 * TestRunnerCallbacks serializes via TestAdaptor / TestResultAdaptor.
 * Source: Editor/Testing/TestAdaptor.cs and TestResultAdaptor.cs
 */

/** Test execution mode matching Unity Test Framework's TestMode enum. */
export type UnityTestMode = 'EditMode' | 'PlayMode';

/**
 * A single test node as serialized by Unity's TestAdaptor.
 * The tree is flattened; Parent is the index into the flat array (-1 for root).
 */
export interface UnityTestInfo {
  Id: string;
  Name: string;
  FullName: string;
  Type: string;
  Method: string;
  Assembly: string;
  /** Index into the flat TestAdaptors array (-1 for root nodes). */
  Parent: number;
}

/** Payload wrapper for a TestListRetrieved or RunStarted message. */
export interface UnityTestAdaptorContainer {
  TestAdaptors: UnityTestInfo[];
}

/** A built test tree with O(1) lookup by Id. */
export interface UnityTestTree {
  roots: UnityTestInfo[];
  byId: Map<string, UnityTestInfo>;
  childrenByParent: Map<number, UnityTestInfo[]>;
  /** Children keyed by parent Id (string) for recursive tree walking. */
  childrenById: Map<string, UnityTestInfo[]>;
}

/** Describes the scope of a test run received in RunStarted. */
export interface UnityTestRunStartedPayload {
  TestMode: UnityTestMode;
  TestAdaptors: UnityTestInfo[];
}

/**
 * A single test result as serialized by Unity's TestResultAdaptor.
 * TestStatus: 0=Passed, 1=Skipped, 2=Inconclusive, 3=Failed
 */
export interface UnityTestResultPayload {
  Name: string;
  FullName: string;
  PassCount: number;
  FailCount: number;
  InconclusiveCount: number;
  SkipCount: number;
  ResultState: string;
  StackTrace: string;
  TestStatus: number | string;
  Parent: number;
}

/** TestFinished / RunFinished wrap results in this container. */
export interface UnityTestResultContainer {
  TestResultAdaptors: UnityTestResultPayload[];
}

/** Summary received in RunFinished. */
export interface UnityTestRunFinishedPayload {
  TestMode: UnityTestMode;
  PassCount: number;
  FailCount: number;
  SkipCount: number;
  InconclusiveCount: number;
  Duration: number;
}

/** Builds a look-up tree from a flat array of UnityTestInfo items.
 *  Parent is an integer index into the array; -1 marks a root. */
export function buildUnityTestTree(tests: UnityTestInfo[]): UnityTestTree {
  const byId = new Map<string, UnityTestInfo>();
  const childrenByParent = new Map<number, UnityTestInfo[]>();
  const childrenById = new Map<string, UnityTestInfo[]>();
  const roots: UnityTestInfo[] = [];

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    byId.set(test.Id, test);
  }

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const parentIndex = test.Parent;

    if (parentIndex < 0 || parentIndex >= tests.length) {
      roots.push(test);
    } else {
      // Index-based lookup
      const siblings = childrenByParent.get(parentIndex) ?? [];
      siblings.push(test);
      childrenByParent.set(parentIndex, siblings);

      // Id-based lookup (for recursive tree walking)
      const parentId = tests[parentIndex].Id;
      const idSiblings = childrenById.get(parentId) ?? [];
      idSiblings.push(test);
      childrenById.set(parentId, idSiblings);
    }
  }

  return { roots, byId, childrenByParent, childrenById };
}

/** Maps Unity TestResultAdaptor.TestStatus to a VS Code-friendly status label. */
export function mapTestStatus(status: unknown): 'passed' | 'failed' | 'skipped' | 'errored' {
  const n = Number(status);
  if (n === 0) return 'passed';
  if (n === 1) return 'skipped';
  if (n === 2) return 'skipped'; // Inconclusive
  if (n === 3) return 'failed';
  return 'errored';
}
