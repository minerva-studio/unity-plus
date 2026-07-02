import * as vscode from 'vscode';

export interface UnityPlusLogger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function createLogger(): UnityPlusLogger {
  const output = vscode.window.createOutputChannel('Unity Plus');

  return {
    info: (message: string) => append(output, 'info', message),
    warn: (message: string) => append(output, 'warn', message),
    error: (message: string) => append(output, 'error', message),
    debug: (message: string) => {
      const level = vscode.workspace.getConfiguration('unityPlus').get<string>('logging.level', 'info');
      if (level === 'trace' || level === 'debug') {
        append(output, 'debug', message);
      }
    },
    dispose: () => output.dispose()
  };
}

function append(output: vscode.OutputChannel, level: string, message: string): void {
  output.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
}
