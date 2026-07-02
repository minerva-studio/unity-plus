import * as assert from 'assert';
import { createLogger, UnityPlusLogLevel, UnityPlusLogOutput, unityPlusOutputChannelName } from '../unity/logger';

describe('logger', () => {
  it('uses the Unity Plus output channel name', () => {
    assert.strictEqual(unityPlusOutputChannelName, 'Unity Plus');
  });

  it('writes info, warn, and error messages at the default info level', () => {
    const output = createMemoryOutput();
    const logger = createLogger({
      output,
      getLevel: () => 'info'
    });

    logger.debug('debug hidden');
    logger.info('info visible');
    logger.warn('warn visible');
    logger.error('error visible');

    assert.strictEqual(output.lines.length, 3);
    assert.strictEqual(output.lines.some(line => line.includes('[debug] debug hidden')), false);
    assert.strictEqual(output.lines.some(line => line.includes('[info] info visible')), true);
    assert.strictEqual(output.lines.some(line => line.includes('[warn] warn visible')), true);
    assert.strictEqual(output.lines.some(line => line.includes('[error] error visible')), true);
  });

  it('respects debug and warn logging thresholds', () => {
    const debugOutput = createMemoryOutput();
    const debugLogger = createLogger({
      output: debugOutput,
      getLevel: () => 'debug'
    });

    debugLogger.debug('debug visible');

    const warnOutput = createMemoryOutput();
    const warnLogger = createLogger({
      output: warnOutput,
      getLevel: () => 'warn'
    });

    warnLogger.info('info hidden');
    warnLogger.warn('warn visible');
    warnLogger.error('error visible');

    assert.strictEqual(debugOutput.lines.some(line => line.includes('[debug] debug visible')), true);
    assert.strictEqual(warnOutput.lines.length, 2);
    assert.strictEqual(warnOutput.lines.some(line => line.includes('[info] info hidden')), false);
    assert.strictEqual(warnOutput.lines.some(line => line.includes('[warn] warn visible')), true);
    assert.strictEqual(warnOutput.lines.some(line => line.includes('[error] error visible')), true);
  });

  it('reads the current logging level for each message', () => {
    const output = createMemoryOutput();
    let level: UnityPlusLogLevel = 'error';
    const logger = createLogger({
      output,
      getLevel: () => level
    });

    logger.info('hidden before level change');
    level = 'info';
    logger.info('visible after level change');

    assert.strictEqual(output.lines.length, 1);
    assert.strictEqual(output.lines[0].includes('[info] visible after level change'), true);
  });
});

interface MemoryLogOutput extends UnityPlusLogOutput {
  lines: string[];
}

function createMemoryOutput(): MemoryLogOutput {
  return {
    lines: [],
    appendLine(message: string): void {
      this.lines.push(message);
    },
    dispose(): void {
      this.lines = [];
    }
  };
}
