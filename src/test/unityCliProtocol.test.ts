import * as assert from 'assert';
import type { UnityTestExecutionBatch } from '../features/unity-test-runner/testModel';
import {
  parseUnityCliCancel,
  parseUnityCliTestStatus,
  prepareUnityCliBatches,
  type UnityCliTestCase
} from '../features/unity-test-runner/unity-cli/unityCliProtocol';

describe('Unity CLI protocol', () => {
  it('parses the Pipeline JSON-in-JSON status contract', () => {
    const raw = createStatusEnvelope({
      status: 'completed',
      duration: 17,
      summary: { total: 4, passed: 1, failed: 1, skipped: 1, inconclusive: 1 },
      results: [
        {
          FullName: 'Tests.Passed',
          Status: 'Passed',
          Duration: 0.25,
          Message: null,
          StackTrace: null
        },
        {
          FullName: 'Tests.Failed',
          Status: 'Failed',
          Duration: 0.5,
          Message: 'failure',
          StackTrace: 'stack'
        },
        {
          FullName: 'Tests.Skipped',
          Status: 'Skipped',
          Duration: 0,
          Message: null,
          StackTrace: null
        },
        {
          FullName: 'Tests.Inconclusive',
          Status: 'Inconclusive',
          Duration: 0.1,
          Message: null,
          StackTrace: null
        }
      ]
    });

    const parsed = parseUnityCliTestStatus(raw);
    assert.strictEqual(parsed.status, 'completed');
    assert.strictEqual(parsed.results.length, 4);
    assert.deepStrictEqual(parsed.results[0], {
      fullName: 'Tests.Passed',
      label: 'Passed',
      status: 'Passed',
      durationSeconds: 0.25,
      message: undefined,
      stackTrace: undefined
    });
    assert.deepStrictEqual(parsed.results[1], {
      fullName: 'Tests.Failed',
      label: 'Failed',
      status: 'Failed',
      durationSeconds: 0.5,
      message: 'failure',
      stackTrace: 'stack'
    });
  });

  it('accepts non-terminal statuses without a result array', () => {
    for (const status of ['running', 'cancelled', 'error', 'no_tests'] as const) {
      const parsed = parseUnityCliTestStatus(createStatusEnvelope({ status, message: `${status} message` }));
      assert.strictEqual(parsed.status, status);
      assert.strictEqual(parsed.results.length, 0);
      assert.strictEqual(parsed.message, `${status} message`);
    }
  });

  it('rejects the old PascalCase status field', () => {
    assert.throws(
      () => parseUnityCliTestStatus(createStatusEnvelope({ Status: 'completed' })),
      /missing string field status/
    );
  });

  it('parses the Pipeline cancel response contract', () => {
    assert.doesNotThrow(() => parseUnityCliCancel(createObjectEnvelope({
      status: 'cancelled',
      message: 'Test run cancelled.'
    })));
    assert.doesNotThrow(() => parseUnityCliCancel(createObjectEnvelope({
      status: 'no_tests',
      message: 'No test run in progress.'
    })));
  });

  it('keeps a safe parent batch as one command', () => {
    const tests = [cliTest('Tests.Fixture.A'), cliTest('Tests.Fixture.B')];
    const result = prepareUnityCliBatches([parentBatch('Tests.Fixture', ['Tests.Fixture.A', 'Tests.Fixture.B'])], tests, []);

    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.batches, [{
      mode: 'EditMode',
      filter: 'Tests.Fixture',
      filterType: 'testName',
      expectedFullNames: ['Tests.Fixture.A', 'Tests.Fixture.B'],
      includeExplicit: false
    }]);
  });

  it('splits an unsafe parent batch into safe leaves in order', () => {
    const tests = [
      cliTest('Tests.Fixture.A'),
      cliTest('Tests.Fixture.B'),
      cliTest('Tests.Fixture.Other')
    ];
    const result = prepareUnityCliBatches([parentBatch('Tests.Fixture', ['Tests.Fixture.A', 'Tests.Fixture.B'])], tests, []);

    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.batches.map(batch => batch.filter), ['Tests.Fixture.A', 'Tests.Fixture.B']);
    assert.deepStrictEqual(result.batches.map(batch => batch.expectedFullNames), [
      ['Tests.Fixture.A'],
      ['Tests.Fixture.B']
    ]);
  });

  it('enables explicit tests and preserves mixed leaf options', () => {
    const tests = [cliTest('Tests.Fixture.Normal'), cliTest('Tests.Fixture.Explicit', true)];
    const parent = parentBatch('Tests.Fixture', ['Tests.Fixture.Normal', 'Tests.Fixture.Explicit']);
    const result = prepareUnityCliBatches([parent], tests, []);

    assert.strictEqual(result.error, undefined);
    assert.strictEqual(result.batches.length, 1);
    assert.strictEqual(result.batches[0].includeExplicit, true);

    const unsafe = prepareUnityCliBatches([
      parentBatch('Tests.Fixture', ['Tests.Fixture.Normal', 'Tests.Fixture.Explicit'])
    ], [...tests, cliTest('Tests.Fixture.Other')], []);
    assert.strictEqual(unsafe.error, undefined);
    assert.deepStrictEqual(unsafe.batches.map(batch => batch.includeExplicit), [false, true]);
  });

  it('rejects a leaf whose substring still matches an extra test', () => {
    const result = prepareUnityCliBatches([
      parentBatch('Tests.Fixture.A', ['Tests.Fixture.A'])
    ], [cliTest('Tests.Fixture.A'), cliTest('Tests.Fixture.AExtra')], []);

    assert.match(result.error ?? '', /unsafe set/);
    assert.strictEqual(result.batches.length, 0);
  });

  it('maps assembly and mode scopes to their native Pipeline filters', () => {
    const tests = [
      cliTest('Tests.One.A', false, 'One.dll'),
      cliTest('Tests.Two.B', false, 'Two.dll')
    ];
    const assembly = prepareUnityCliBatches([{
      mode: 'EditMode',
      scope: { kind: 'assembly', value: 'One.dll' },
      expectedFullNames: ['Tests.One.A']
    }], tests, []);
    const mode = prepareUnityCliBatches([{
      mode: 'EditMode',
      scope: { kind: 'mode' },
      expectedFullNames: ['Tests.One.A', 'Tests.Two.B']
    }], tests, []);

    assert.deepStrictEqual(assembly.batches[0], {
      mode: 'EditMode', filter: 'One.dll', filterType: 'assembly',
      expectedFullNames: ['Tests.One.A'], includeExplicit: false
    });
    assert.deepStrictEqual(mode.batches[0], {
      mode: 'EditMode', expectedFullNames: ['Tests.One.A', 'Tests.Two.B'], includeExplicit: false
    });
  });

  it('splits an ambiguous namespace while preserving its intended leaves', () => {
    const result = prepareUnityCliBatches([parentBatch('Tests.Combat', ['Tests.Combat.A'])], [
      cliTest('Tests.Combat.A'),
      cliTest('Tests.CombatExtra.A')
    ], []);

    assert.strictEqual(result.error, undefined);
    assert.deepStrictEqual(result.batches.map(batch => batch.filter), ['Tests.Combat.A']);
  });
});

function createStatusEnvelope(result: Record<string, unknown>): string {
  return JSON.stringify({
    success: true,
    data: {
      success: true,
      result: JSON.stringify(result)
    }
  });
}

function createObjectEnvelope(result: Record<string, unknown>): string {
  return JSON.stringify({
    success: true,
    data: {
      success: true,
      result
    }
  });
}

function cliTest(fullName: string, explicit = false, assembly = 'Tests.dll'): UnityCliTestCase {
  return {
    mode: 'EditMode',
    assembly,
    fullName,
    label: fullName.split('.').at(-1) ?? fullName,
    categories: [],
    explicit
  };
}

function parentBatch(fullName: string, expectedFullNames: readonly string[]): UnityTestExecutionBatch {
  return {
    mode: 'EditMode',
    scope: { kind: 'testName', value: fullName },
    expectedFullNames
  };
}
