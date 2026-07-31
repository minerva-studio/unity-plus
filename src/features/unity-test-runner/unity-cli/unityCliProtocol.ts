import type { UnityTestExecutionBatch, UnityTestMode } from '../testModel';
import { UnityCliCommandError } from './unityCliProcess';

/** One deduplicated CLI discovery record used for Pipeline substring validation. */
export interface UnityCliTestCase {
  readonly mode: UnityTestMode;
  readonly assembly: string;
  readonly fullName: string;
  readonly label: string;
  readonly categories: readonly string[];
  readonly explicit: boolean;
  readonly parameterizedMethodFullName?: string;
}

/** Parsed CLI discovery for one Unity test mode. */
export interface UnityCliDiscoveryData {
  readonly cases: readonly UnityCliTestCase[];
}

/** Parsed terminal status returned by Pipeline's JSON-in-JSON test_status contract. */
export interface UnityCliTestStatus {
  readonly status: 'running' | 'completed' | 'cancelled' | 'error' | 'no_tests';
  readonly message?: string;
  readonly results: readonly UnityCliTestResult[];
}

/** One raw test result reported by Pipeline test_status. */
export interface UnityCliTestResult {
  readonly fullName: string;
  readonly label: string;
  readonly status: string;
  readonly durationSeconds: number;
  readonly message?: string;
  readonly stackTrace?: string;
}

/** Result of converting shared selections into safe Pipeline filter batches. */
export interface UnityCliBatchPreparation {
  readonly batches: readonly UnityCliExecutionBatch[];
  readonly error?: string;
}

/** A CLI-ready batch with Pipeline-specific filter and explicit-test options. */
export interface UnityCliExecutionBatch {
  readonly mode: UnityTestMode;
  readonly filter?: string;
  readonly filterType?: 'assembly' | 'testName';
  readonly expectedFullNames: readonly string[];
  readonly includeExplicit: boolean;
}

/** Parses a successful list_tests envelope and its exact data.result.Tests array. */
export function parseUnityCliDiscovery(raw: string): UnityCliDiscoveryData {
  const result = parseSuccessfulResult(raw, 'list_tests');
  const tests = result.Tests;
  if (!Array.isArray(tests)) {
    throw new UnityCliCommandError('Unity CLI list_tests response is missing data.result.Tests.');
  }

  const cases = new Map<string, MutableCliTestCase>();
  for (const value of tests) {
    const record = asRecord(value, 'list_tests test');
    const mode = parseUnityTestMode(readRequiredString(record, 'Mode', 'list_tests test'));
    const fullName = readRequiredString(record, 'FullName', 'list_tests test');
    const assembly = normalizeAssembly(readRequiredString(record, 'Assembly', 'list_tests test'));
    const key = `${mode}\u0000${assembly}\u0000${fullName}`;
    const current = cases.get(key);
    if (current) {
      mergeCliTestCase(current, record);
      continue;
    }

    const parameterizedMethodFullName = getParameterizedMethodFullName(fullName);
    cases.set(key, {
      mode,
      assembly,
      fullName,
      label: parameterizedMethodFullName
        ? getParameterizedCaseLabel(fullName)
        : readOptionalString(record, 'Name') ?? getLeafLabel(fullName),
      categories: readCategories(record),
      explicit: readExplicit(record),
      parameterizedMethodFullName
    });
  }

  return { cases: [...cases.values()] };
}

/** Parses a successful run_tests envelope and its nested result object. */
export function parseUnityCliRunStarted(raw: string): void {
  parseSuccessfulResult(raw, 'run_tests');
}

/** Parses test_status.data.result after the required second JSON parse. */
export function parseUnityCliTestStatus(raw: string): UnityCliTestStatus {
  const outer = parseOuterSuccess(raw, 'test_status');
  if (typeof outer.result !== 'string') {
    throw new UnityCliCommandError('Unity CLI test_status response data.result is not a JSON string.');
  }

  const nested = parseJsonRecord(outer.result, 'test_status.data.result');
  const statusValue = readRequiredString(nested, 'status', 'test_status result').toLowerCase();
  if (!isUnityCliTestStatus(statusValue)) {
    throw new UnityCliCommandError(`Unity CLI test_status returned unsupported status "${statusValue}".`);
  }
  if (statusValue === 'completed' && !Array.isArray(nested.results)) {
    throw new UnityCliCommandError('Unity CLI completed test_status result is missing results.');
  }

  return {
    status: statusValue,
    message: readNullableString(nested, 'message'),
    results: parseTestResults(nested)
  };
}

/** Parses a successful cancel_tests envelope. */
export function parseUnityCliCancel(raw: string): void {
  const outer = parseOuterSuccess(raw, 'cancel_tests');
  const result = asRecord(outer.result, 'cancel_tests.data.result');
  const status = readRequiredString(result, 'status', 'cancel_tests result');
  if (status !== 'cancelled' && status !== 'no_tests') {
    throw new UnityCliCommandError(`Unity CLI cancel_tests returned unsupported status "${status}".`);
  }
}

/** Matches Pipeline's case-insensitive FullName substring filter exactly enough for preflight. */
export function matchPipelineFilter(
  tests: readonly UnityCliTestCase[],
  batch: UnityCliExecutionBatch
): readonly UnityCliTestCase[] {
  return tests.filter(test => {
    if (test.mode !== batch.mode || (!batch.includeExplicit && test.explicit)) {
      return false;
    }
    if (!batch.filter) {
      return true;
    }

    const value = batch.filter.toLocaleLowerCase();
    const candidate = batch.filterType === 'assembly' ? test.assembly : test.fullName;
    return candidate.toLocaleLowerCase().includes(value);
  });
}

/** Prepares safe Pipeline batches, splitting an over-broad parent scope into leaves. */
export function prepareUnityCliBatches(
  batches: readonly UnityTestExecutionBatch[],
  editTests: readonly UnityCliTestCase[],
  playTests: readonly UnityCliTestCase[]
): UnityCliBatchPreparation {
  const prepared: UnityCliExecutionBatch[] = [];
  for (const batch of batches) {
    const tests = batch.mode === 'EditMode' ? editTests : playTests;
    const expectedNames = new Set(batch.expectedFullNames);
    const expectedTests = tests.filter(test => expectedNames.has(test.fullName));
    if (expectedTests.length !== expectedNames.size) {
      const missing = batch.expectedFullNames.find(fullName => !tests.some(test => test.fullName === fullName));
      return {
        batches: [],
        error: `Unity CLI selection was rejected before dispatch because expected test "${missing}" was not present in the latest discovery snapshot.`
      };
    }

    const effectiveBatch = createCliExecutionBatch(batch, expectedTests.some(test => test.explicit));

    const parentMatch = compareBatchMatch(tests, effectiveBatch);
    if (parentMatch.safe) {
      prepared.push(effectiveBatch);
      continue;
    }

    if (batch.expectedFullNames.length === 0) {
      return { batches: [], error: parentMatch.message };
    }

    for (const fullName of batch.expectedFullNames) {
      const expectedTest = tests.find(test => test.fullName === fullName);
      if (!expectedTest) {
        return {
          batches: [],
          error: `Unity CLI selection was rejected before dispatch because expected test "${fullName}" was not present in the latest discovery snapshot.`
        };
      }

      const leafBatch: UnityCliExecutionBatch = {
        mode: batch.mode,
        filter: fullName,
        filterType: 'testName',
        expectedFullNames: [fullName],
        includeExplicit: expectedTest.explicit
      };
      const leafMatch = compareBatchMatch(tests, leafBatch);
      if (!leafMatch.safe) {
        return { batches: [], error: leafMatch.message };
      }
      prepared.push(leafBatch);
    }
  }

  return { batches: prepared };
}

/** Converts a shared logical scope into the corresponding Pipeline command filter. */
function createCliExecutionBatch(
  batch: UnityTestExecutionBatch,
  includeExplicit: boolean
): UnityCliExecutionBatch {
  if (batch.scope.kind === 'mode') {
    return { mode: batch.mode, expectedFullNames: batch.expectedFullNames, includeExplicit };
  }
  if (batch.scope.kind === 'assembly') {
    return {
      mode: batch.mode,
      filter: batch.scope.value,
      filterType: 'assembly',
      expectedFullNames: batch.expectedFullNames,
      includeExplicit
    };
  }
  return {
    mode: batch.mode,
    filter: batch.scope.value,
    filterType: 'testName',
    expectedFullNames: batch.expectedFullNames,
    includeExplicit
  };
}

/** Returns a stable leaf label from a full test name. */
function getLeafLabel(fullName: string): string {
  const withoutArguments = fullName.includes('(') ? fullName.slice(0, fullName.indexOf('(')) : fullName;
  return withoutArguments.split('.').at(-1) ?? withoutArguments;
}

/** Returns the method-suite name when FullName contains a parameter list. */
function getParameterizedMethodFullName(fullName: string): string | undefined {
  const open = fullName.indexOf('(');
  if (open <= 0 || !fullName.endsWith(')')) {
    return undefined;
  }
  return fullName.slice(0, open);
}

/** Returns the argument text used to distinguish a parameterized test case. */
function getParameterizedCaseLabel(fullName: string): string {
  const open = fullName.indexOf('(');
  const argumentsText = fullName.slice(open + 1, -1);
  return argumentsText.length > 0 ? argumentsText : '()';
}

/** Appends `.dll` to CLI assembly labels without changing already-qualified names. */
function normalizeAssembly(assembly: string): string {
  return assembly.endsWith('.dll') ? assembly : `${assembly}.dll`;
}

/** Accepts only the two Unity Test Framework modes exposed by the shared model. */
function parseUnityTestMode(value: string): UnityTestMode {
  if (value === 'EditMode' || value === 'PlayMode') {
    return value;
  }
  throw new UnityCliCommandError(`Unity CLI list_tests returned unsupported test mode "${value}".`);
}

/** Reads a CLI category array while rejecting non-string category values. */
function readCategories(record: JsonRecord): string[] {
  const value = record.Categories;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some(category => typeof category !== 'string')) {
    throw new UnityCliCommandError('Unity CLI list_tests response contains invalid Categories.');
  }
  return [...value] as string[];
}

/** Reads the explicit marker used by the Pipeline test discovery contract. */
function readExplicit(record: JsonRecord): boolean {
  const value = record.Explicit;
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw new UnityCliCommandError('Unity CLI list_tests response contains invalid Explicit.');
  }
  return value;
}

/** Merges duplicate mode/assembly/FullName records without changing first-seen order. */
function mergeCliTestCase(current: MutableCliTestCase, record: JsonRecord): void {
  for (const category of readCategories(record)) {
    if (!current.categories.includes(category)) {
      current.categories.push(category);
    }
  }
  current.explicit ||= readExplicit(record);
}

/** Parses result records from a terminal status payload. */
function parseTestResults(record: JsonRecord): UnityCliTestResult[] {
  const values = record.results;
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new UnityCliCommandError('Unity CLI test_status result contains invalid Tests.');
  }

  return values.map(value => {
    const result = asRecord(value, 'test_status test');
    const duration = result.Duration;
    if (typeof duration !== 'number' || !Number.isFinite(duration)) {
      throw new UnityCliCommandError('Unity CLI test_status result contains invalid Duration.');
    }
    const fullName = readRequiredString(result, 'FullName', 'test_status test');
    return {
      fullName,
      label: getLeafLabel(fullName),
      status: readRequiredString(result, 'Status', 'test_status test'),
      durationSeconds: duration,
      message: readNullableString(result, 'Message'),
      stackTrace: readNullableString(result, 'StackTrace')
    };
  });
}

/** Compares one Pipeline substring filter with the exact expected logical leaves. */
function compareBatchMatch(
  tests: readonly UnityCliTestCase[],
  batch: UnityCliExecutionBatch
): { safe: boolean; message: string } {
  const matched = matchPipelineFilter(tests, batch);
  const expected = new Set(batch.expectedFullNames);
  const actual = new Set(matched.map(test => test.fullName));
  const extra = [...actual].filter(fullName => !expected.has(fullName));
  const missing = [...expected].filter(fullName => !actual.has(fullName));
  if (extra.length === 0 && missing.length === 0) {
    return { safe: true, message: '' };
  }

  const examples = extra.slice(0, 3);
  const extraText = examples.length > 0
    ? ` Extra matches: ${examples.join(', ')}${extra.length > examples.length ? ', ...' : ''}.`
    : '';
  const missingText = missing.length > 0
    ? ` Missing expected leaves: ${missing.slice(0, 3).join(', ')}.`
    : '';
  return {
    safe: false,
    message: `Unity CLI selection was rejected before dispatch because Pipeline ${batch.filterType ?? 'mode'} filter "${batch.filter ?? '(none)'}" matched an unsafe set.${extraText}${missingText}`
  };
}

/** Validates top-level/data/result success fields and returns the object result. */
function parseSuccessfulResult(raw: string, operation: string): JsonRecord {
  const outer = parseOuterSuccess(raw, operation);
  if (!isRecord(outer.result)) {
    throw new UnityCliCommandError(`Unity CLI ${operation} response data.result is not an object.`);
  }
  if (outer.result.success !== true) {
    throw new UnityCliCommandError(`Unity CLI ${operation} response data.result.success was not true.`);
  }
  return outer.result;
}

/** Validates the outer success envelope before an operation-specific parse. */
function parseOuterSuccess(raw: string, operation: string): JsonRecord {
  const parsed = parseJsonRecord(raw, `${operation} response`);
  if (parsed.success !== true) {
    throw new UnityCliCommandError(`Unity CLI ${operation} response success was not true.`);
  }
  const data = asRecord(parsed.data, `${operation} response data`);
  if (data.success !== true) {
    throw new UnityCliCommandError(`Unity CLI ${operation} response data.success was not true.`);
  }
  return data;
}

/** Parses one JSON object and reports a protocol-specific error. */
function parseJsonRecord(raw: string, description: string): JsonRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UnityCliCommandError(`Unity CLI returned invalid JSON for ${description}.`);
  }
  return asRecord(value, description);
}

/** Converts an unknown value into a JSON record or raises a strict protocol error. */
function asRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) {
    throw new UnityCliCommandError(`Unity CLI returned a non-object ${description}.`);
  }
  return value;
}

/** Reads a required string field from a strict protocol record. */
function readRequiredString(record: JsonRecord, field: string, description: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new UnityCliCommandError(`Unity CLI ${description} is missing string field ${field}.`);
  }
  return value;
}

/** Reads an optional string field without accepting coercion. */
function readOptionalString(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new UnityCliCommandError(`Unity CLI response contains invalid string field ${field}.`);
  }
  return value;
}

/** Reads a nullable optional string from Pipeline result records. */
function readNullableString(record: JsonRecord, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new UnityCliCommandError(`Unity CLI response contains invalid string field ${field}.`);
  }
  return value;
}

/** Tests whether a parsed value is a JSON record. */
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tests whether a status string belongs to the supported Pipeline status contract. */
function isUnityCliTestStatus(value: string): value is UnityCliTestStatus['status'] {
  return value === 'running' || value === 'completed' || value === 'cancelled' || value === 'error' || value === 'no_tests';
}

type JsonRecord = Record<string, unknown>;

type MutableCliTestCase = {
  -readonly [Key in keyof UnityCliTestCase]: UnityCliTestCase[Key] extends readonly string[] ? string[] : UnityCliTestCase[Key];
};
