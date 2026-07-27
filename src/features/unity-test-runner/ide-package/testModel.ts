/**
 * Unity IDE package protocol DTOs for discovery and execution.
 *
 * These types mirror the JSON structures serialized by TestAdaptor and
 * TestResultAdaptor. They intentionally do not describe the shared VS Code tree.
 */

import type { UnityTestMode } from '../testModel';

/** A single test node serialized by Unity's flattened TestAdaptor list. */
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

/** Describes the scope of a test run received in RunStarted. */
export interface UnityTestRunStartedPayload {
  TestMode: UnityTestMode;
  TestAdaptors: UnityTestInfo[];
}

/** A single test result serialized by Unity's TestResultAdaptor. */
export interface UnityTestResultPayload {
  Name: string;
  FullName: string;
  PassCount: number;
  FailCount: number;
  InconclusiveCount: number;
  SkipCount: number;
  ResultState: string;
  StackTrace: string;
  /** TestStatus: 0=Passed, 1=Skipped, 2=Inconclusive, 3=Failed. */
  TestStatus: number | string;
  Parent: number;
}

/** TestFinished and RunFinished both wrap flattened result trees in this container. */
export interface UnityTestResultContainer {
  TestResultAdaptors: UnityTestResultPayload[];
}

/** Maps Unity TestResultAdaptor.TestStatus to a VS Code-friendly status label. */
export function mapTestStatus(status: unknown): 'passed' | 'failed' | 'skipped' | 'errored' {
  const n = Number(status);
  if (n === 0) return 'passed';
  if (n === 1) return 'skipped';
  if (n === 2) return 'skipped';
  if (n === 3) return 'failed';
  return 'errored';
}
