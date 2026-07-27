import type * as vscode from 'vscode';
import type { UnityTestExecutionBatch } from './ide-package/testExecution';
import type { UnityTestInfo } from './ide-package/testModel';

/** Result returned by the active Unity test backend after discovery. */
export interface UnityTestDiscoveryResult {
  editModeTests: UnityTestInfo[];
  playModeTests: UnityTestInfo[];
}

/** Existing execution context passed to one complete backend. */
export interface UnityTestBackendRunRequest {
  readonly projectRoot: string;
  readonly run: vscode.TestRun;
  readonly batches: readonly UnityTestExecutionBatch[];
  readonly token: vscode.CancellationToken;
  readonly itemByFullName?: Map<string, vscode.TestItem>;
}

/** Complete discovery, execution, cancellation, result parsing, and transport lifecycle. */
export interface UnityTestBackend extends vscode.Disposable {
  /** Discovers the tests currently exposed by the exact Unity project. */
  discover(projectRoot: string): Promise<UnityTestDiscoveryResult>;

  /** Executes the requested batches and reports their results to the supplied VS Code run. */
  run(request: UnityTestBackendRunRequest): Promise<void>;
}
