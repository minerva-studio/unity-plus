/** Test execution mode matching Unity Test Framework's TestMode enum. */
export type UnityTestMode = 'EditMode' | 'PlayMode';

/** Selectable Unity test backend. */
export type UnityTestBackendKind = 'idePackage' | 'unityCli';

/** Node kind used by backend-neutral execution planning. */
export type UnityTestNodeKind = 'container' | 'method' | 'case';

/**
 * Backend-neutral user selection preserved until a concrete backend prepares
 * its native command line or IDE protocol request.
 */
export type UnityTestExecutionScope =
  | { readonly kind: 'mode' }
  | { readonly kind: 'assembly'; readonly value: string }
  | { readonly kind: 'testName'; readonly value: string };

/** Backend-neutral node consumed directly by the VS Code Test Controller. */
export interface UnityTestNode {
  readonly id: string;
  readonly label: string;
  readonly fullName?: string;
  readonly assembly?: string;
  readonly categories?: readonly string[];
  readonly explicit?: boolean;
  readonly executionScope?: UnityTestExecutionScope;
  readonly kind?: UnityTestNodeKind;
  readonly children: readonly UnityTestNode[];
}

/** One logical user selection and the exact visible leaves expected from it. */
export interface UnityTestExecutionBatch {
  readonly mode: UnityTestMode;
  readonly scope: UnityTestExecutionScope;
  readonly expectedFullNames: readonly string[];
}

/** Complete test trees returned by one backend. */
export interface UnityTestDiscoveryResult {
  readonly editModeTests: readonly UnityTestNode[];
  readonly playModeTests: readonly UnityTestNode[];
}
