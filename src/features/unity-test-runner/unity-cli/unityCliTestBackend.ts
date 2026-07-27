import * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../../unity/logger';
import type {
  UnityTestBackend,
  UnityTestBackendRunRequest,
  UnityTestDiscoveryResult
} from '../unityTestBackend';
import type { UnityTestExecutionBatch } from '../testModel';
import { buildUnityCliTestTree } from './unityCliTree';
import {
  matchPipelineFilter,
  parseUnityCliCancel,
  parseUnityCliDiscovery,
  parseUnityCliRunStarted,
  parseUnityCliTestStatus,
  type UnityCliTestCase,
  type UnityCliTestResult,
  type UnityCliTestStatus
} from './unityCliProtocol';
import {
  runUnityCliCommand,
  UnityCliCommandError
} from './unityCliProcess';

const discoveryTimeoutSeconds = '30';
const statusPollDelayMs = 250;

/** Runs Unity tests through the experimental Unity CLI/Pipeline command backend. */
export class UnityCliTestBackend implements UnityTestBackend {
  private recentDiscovery: CliDiscoverySnapshot | undefined;

  /** Creates a CLI backend with no process state or persisted availability state. */
  constructor(private readonly logger: UnityPlusLogger) {}

  /** Discovers tests through list_tests and stores only the latest successful scope snapshot. */
  async discover(projectRoot: string): Promise<UnityTestDiscoveryResult> {
    const raw = await runUnityCliCommand(projectRoot, buildGlobalArgs(projectRoot, [
      '--timeout',
      discoveryTimeoutSeconds,
      'list_tests',
      '--mode',
      'all'
    ]), this.logger);
    const discovery = parseUnityCliDiscovery(raw);
    const edit = discovery.cases.filter(test => test.mode === 'EditMode');
    const play = discovery.cases.filter(test => test.mode === 'PlayMode');
    const editModeTests = buildUnityCliTestTree(projectRoot, 'EditMode', edit);
    const playModeTests = buildUnityCliTestTree(projectRoot, 'PlayMode', play);

    this.recentDiscovery = {
      projectRoot,
      edit,
      play
    };
    return { editModeTests, playModeTests };
  }

  /** Validates every requested Pipeline substring scope before sending the first run command. */
  async run(request: UnityTestBackendRunRequest): Promise<void> {
    if (request.token.isCancellationRequested) {
      request.run.end();
      return;
    }

    const snapshot = this.recentDiscovery;
    if (!snapshot) {
      request.run.end();
      throw new UnityCliCommandError('Refresh Unity CLI tests before running a selection.');
    }

    const validationError = validateBatches(request.projectRoot, request.batches, snapshot);
    if (validationError) {
      markAllItemsErrored(request.run, request.itemByFullName, validationError);
      request.run.end();
      return;
    }

    let cancellationRequested = false;
    let cancelSent = false;
    const cancellation = request.token.onCancellationRequested(() => {
      cancellationRequested = true;
    });

    try {
      for (const batch of request.batches) {
        if (cancellationRequested || request.token.isCancellationRequested) {
          break;
        }

        await runCliBatch(request, batch, this.logger, () => cancellationRequested || request.token.isCancellationRequested, {
          sendCancel: async () => {
            if (cancelSent) {
              return;
            }
            cancelSent = true;
            const raw = await runUnityCliCommand(
              request.projectRoot,
              buildGlobalArgs(request.projectRoot, ['cancel_tests']),
              this.logger
            );
            parseUnityCliCancel(raw);
          }
        });
      }
    } finally {
      cancellation.dispose();
      request.run.end();
    }
  }

  /** Releases the backend's latest discovery snapshot. */
  dispose(): void {
    this.recentDiscovery = undefined;
  }
}

/** Builds global CLI arguments before the command subcommand and project-specific arguments after it. */
function buildGlobalArgs(projectRoot: string, commandArgs: readonly string[]): string[] {
  return [
    '--format',
    'json',
    '--no-banner',
    '--non-interactive',
    'command',
    '--project-path',
    projectRoot,
    ...commandArgs
  ];
}

/** Validates every batch against the latest discovery snapshot without dispatching any command. */
function validateBatches(
  projectRoot: string,
  batches: readonly UnityTestExecutionBatch[],
  snapshot: CliDiscoverySnapshot
): string | undefined {
  if (snapshot.projectRoot !== projectRoot) {
    return 'Unity CLI discovery belongs to a different Unity project; refresh the test tree before running.';
  }

  for (const batch of batches) {
    const tests = batch.mode === 'EditMode' ? snapshot.edit : snapshot.play;
    const matched = matchPipelineFilter(tests, batch);
    const expected = new Set(batch.expectedFullNames);
    const actual = new Set(matched.map(test => test.fullName));
    const extra = [...actual].filter(fullName => !expected.has(fullName));
    const missing = [...expected].filter(fullName => !actual.has(fullName));
    if (extra.length === 0 && missing.length === 0) {
      continue;
    }

    const examples = extra.slice(0, 3);
    const extraText = examples.length > 0
      ? ` Extra matches: ${examples.join(', ')}${extra.length > examples.length ? ', ...' : ''}.`
      : '';
    const missingText = missing.length > 0
      ? ` Missing expected leaves: ${missing.slice(0, 3).join(', ')}.`
      : '';
    return `Unity CLI selection was rejected before dispatch because Pipeline substring filter "${batch.fullName}" matched an unsafe set.${extraText}${missingText}`;
  }
  return undefined;
}

/** Runs one validated batch and polls its run-free Pipeline status to a terminal state. */
async function runCliBatch(
  request: UnityTestBackendRunRequest,
  batch: UnityTestExecutionBatch,
  logger: UnityPlusLogger,
  isCancelled: () => boolean,
  cancellation: { sendCancel: () => Promise<void> }
): Promise<void> {
  const mode = batch.mode === 'EditMode' ? 'editor' : 'playmode';
  const runRaw = await runUnityCliCommand(request.projectRoot, buildGlobalArgs(request.projectRoot, [
    'run_tests',
    '--mode',
    mode,
    '--filter',
    batch.fullName,
    '--filter_type',
    'testName',
    '--include_explicit',
    String(batch.includeExplicit),
    '--async_tests',
    'true'
  ]), logger);
  parseUnityCliRunStarted(runRaw);

  let cancelIssued = false;
  let status: UnityCliTestStatus;
  do {
    if (isCancelled() && !cancelIssued) {
      cancelIssued = true;
      await cancellation.sendCancel();
    }

    const statusRaw = await runUnityCliCommand(
      request.projectRoot,
      buildGlobalArgs(request.projectRoot, ['test_status']),
      logger
    );
    status = parseUnityCliTestStatus(statusRaw);
    if (status.status === 'running') {
      await delay(statusPollDelayMs);
    }
  } while (status.status === 'running');
  reportCliTerminalStatus(request.run, request.itemByFullName, batch, status);
}

/** Reports terminal Pipeline results using the real VS Code TestItems from the controller tree. */
function reportCliTerminalStatus(
  run: vscode.TestRun,
  itemByFullName: ReadonlyMap<string, vscode.TestItem> | undefined,
  batch: UnityTestExecutionBatch,
  status: UnityCliTestStatus
): void {
  if (status.status === 'cancelled') {
    for (const fullName of batch.expectedFullNames) {
      const item = itemByFullName?.get(fullName);
      if (item) {
        run.skipped(item);
      }
    }
    return;
  }

  if (status.status === 'error' || status.status === 'no_tests') {
    markNamesErrored(run, itemByFullName, batch.expectedFullNames, status.message ?? `Unity CLI test status was ${status.status}.`);
    return;
  }

  const results = aggregateResults(status.results);
  const reported = new Set<string>();
  for (const result of results.values()) {
    if (!batch.expectedFullNames.includes(result.fullName)) {
      continue;
    }
    const item = itemByFullName?.get(result.fullName);
    if (!item) {
      continue;
    }
    reportCliResult(run, item, result);
    reported.add(result.fullName);
  }

  const missing = batch.expectedFullNames.filter(fullName => !reported.has(fullName));
  markNamesErrored(run, itemByFullName, missing, 'Unity CLI finished without reporting this expected test result.');
}

/** Aggregates duplicate FullName results into one logical VS Code leaf result. */
function aggregateResults(results: readonly UnityCliTestResult[]): Map<string, AggregatedCliResult> {
  const aggregated = new Map<string, AggregatedCliResult>();
  for (const result of results) {
    const current = aggregated.get(result.fullName);
    if (!current) {
      aggregated.set(result.fullName, {
        ...result,
        durationSeconds: result.durationSeconds,
        status: normalizeResultStatus(result.status),
        messages: combineMessages(result)
      });
      continue;
    }
    current.durationSeconds += result.durationSeconds;
    current.status = strongerStatus(current.status, normalizeResultStatus(result.status));
    current.messages = combineText(current.messages, combineMessages(result));
  }
  return aggregated;
}

/** Maps Pipeline result statuses to the VS Code result categories. */
function normalizeResultStatus(status: string): 'passed' | 'failed' | 'skipped' | 'errored' {
  if (status === 'Passed') {
    return 'passed';
  }
  if (status === 'Failed') {
    return 'failed';
  }
  if (status === 'Skipped' || status === 'Inconclusive') {
    return 'skipped';
  }
  return 'errored';
}

/** Chooses the most severe status when duplicate logical results disagree. */
function strongerStatus(
  first: AggregatedCliResult['status'],
  second: AggregatedCliResult['status']
): AggregatedCliResult['status'] {
  const rank = { passed: 0, skipped: 1, failed: 2, errored: 3 };
  return rank[second] > rank[first] ? second : first;
}

/** Reports one result and combines failure message with stack trace when available. */
function reportCliResult(run: vscode.TestRun, item: vscode.TestItem, result: AggregatedCliResult): void {
  const duration = Math.max(0, Math.round(result.durationSeconds * 1000));
  if (result.status === 'passed') {
    run.passed(item, duration);
  } else if (result.status === 'skipped') {
    run.skipped(item);
  } else if (result.status === 'failed') {
    run.failed(item, new vscode.TestMessage(result.messages || `${result.fullName} failed.`), duration);
  } else {
    run.errored(item, new vscode.TestMessage(result.messages || `${result.fullName} errored.`), duration);
  }
}

/** Marks selected real TestItems as errored without producing a backend-unavailable warning. */
function markAllItemsErrored(
  run: vscode.TestRun,
  itemByFullName: ReadonlyMap<string, vscode.TestItem> | undefined,
  message: string
): void {
  markNamesErrored(run, itemByFullName, itemByFullName ? [...itemByFullName.keys()] : [], message);
}

/** Marks a finite set of visible test names as errored. */
function markNamesErrored(
  run: vscode.TestRun,
  itemByFullName: ReadonlyMap<string, vscode.TestItem> | undefined,
  names: readonly string[],
  message: string
): void {
  const reported = new Set<vscode.TestItem>();
  for (const name of names) {
    const item = itemByFullName?.get(name);
    if (item && !reported.has(item)) {
      run.errored(item, new vscode.TestMessage(message));
      reported.add(item);
    }
  }
}

/** Combines a result state message and stack trace into one VS Code diagnostic. */
function combineMessages(result: UnityCliTestResult): string {
  return combineText(result.message, result.stackTrace);
}

/** Joins non-empty diagnostic fragments without duplicating separators. */
function combineText(first: string | undefined, second: string | undefined): string {
  return [first, second].filter(value => value && value.length > 0).join('\n');
}

/** Waits without blocking the extension host while polling Pipeline status. */
function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

interface CliDiscoverySnapshot {
  readonly projectRoot: string;
  readonly edit: readonly UnityCliTestCase[];
  readonly play: readonly UnityCliTestCase[];
}

interface AggregatedCliResult extends UnityCliTestResult {
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  messages: string;
  durationSeconds: number;
}
