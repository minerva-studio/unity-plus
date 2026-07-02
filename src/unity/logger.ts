import type * as vscode from 'vscode';
import { createRequire } from 'node:module';

export interface UnityPlusLogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export type UnityPlusLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export const unityPlusOutputChannelName = 'Unity Plus';

export interface UnityPlusLogOutput extends vscode.Disposable {
  appendLine(message: string): void;
}

export interface UnityPlusLoggerOptions {
  output?: UnityPlusLogOutput;
  getLevel?: () => UnityPlusLogLevel;
}

const logLevelWeights: Record<UnityPlusLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4
};

export function createLogger(options: UnityPlusLoggerOptions = {}): UnityPlusLogger {
  const output = options.output ?? createDefaultOutputChannel();
  const getLevel = options.getLevel ?? getConfiguredLogLevel;

  return {
    info: (message: string) => append(output, getLevel(), 'info', message),
    warn: (message: string) => append(output, getLevel(), 'warn', message),
    error: (message: string) => append(output, getLevel(), 'error', message),
    debug: (message: string) => append(output, getLevel(), 'debug', message),
    dispose: () => output.dispose()
  };
}

function append(
  output: UnityPlusLogOutput,
  configuredLevel: UnityPlusLogLevel,
  messageLevel: UnityPlusLogLevel,
  message: string
): void {
  if (!shouldLog(configuredLevel, messageLevel)) {
    return;
  }

  output.appendLine(`[${new Date().toISOString()}] [${messageLevel}] ${message}`);
}

function shouldLog(configuredLevel: UnityPlusLogLevel, messageLevel: UnityPlusLogLevel): boolean {
  return logLevelWeights[messageLevel] >= logLevelWeights[configuredLevel];
}

function createDefaultOutputChannel(): UnityPlusLogOutput {
  // Load VS Code only inside the extension host so Node-based unit tests can inject an output.
  return loadVscode().window.createOutputChannel(unityPlusOutputChannelName);
}

function getConfiguredLogLevel(): UnityPlusLogLevel {
  const level = loadVscode().workspace.getConfiguration('unityPlus').get<string>('logging.level', 'info');

  return isUnityPlusLogLevel(level) ? level : 'info';
}

function isUnityPlusLogLevel(level: string | undefined): level is UnityPlusLogLevel {
  return level === 'trace' || level === 'debug' || level === 'info' || level === 'warn' || level === 'error';
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
