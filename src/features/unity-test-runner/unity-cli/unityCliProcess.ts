import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { UnityPlusLogger } from '../../../unity/logger';

const execFile = promisify(execFileCallback);
const defaultMaxBuffer = 16 * 1024 * 1024;

/** Error raised when the Unity CLI executable cannot be found on PATH. */
export class UnityCliUnavailableError extends Error {
  /** Creates the user-facing installation/PATH diagnostic for Unity CLI. */
  constructor() {
    super('Unity CLI was not found on PATH. Install Unity CLI or reload VS Code after updating PATH.');
    this.name = 'UnityCliUnavailableError';
  }
}

/** Error raised when Unity CLI returns a non-zero exit code or unusable output. */
export class UnityCliCommandError extends Error {
  /** Creates a command-specific diagnostic without exposing full command arguments. */
  constructor(message: string) {
    super(message);
    this.name = 'UnityCliCommandError';
  }
}

/** Runs one Unity CLI command without a shell and returns its bounded stdout. */
export async function runUnityCliCommand(
  projectRoot: string,
  args: readonly string[],
  logger: UnityPlusLogger
): Promise<string> {
  const commandName = getCommandName(args);
  const startedAt = Date.now();

  try {
    const result = await execFile('unity', [...args], {
      cwd: projectRoot,
      windowsHide: true,
      maxBuffer: defaultMaxBuffer,
      encoding: 'utf8'
    });
    const stdout = String(result.stdout);
    logger.info(`Unity CLI ${commandName} exited code=0 elapsedMs=${Date.now() - startedAt}`);
    if (stdout.trim().length === 0) {
      throw new UnityCliCommandError(`Unity CLI ${commandName} returned empty stdout.`);
    }
    return stdout;
  } catch (error) {
    const commandError = error as NodeJS.ErrnoException & {
      code?: string | number;
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const exitCode = typeof commandError.code === 'number' ? commandError.code : 'error';
    logger.warn(`Unity CLI ${commandName} exited code=${exitCode} elapsedMs=${Date.now() - startedAt}`);

    if (commandError.code === 'ENOENT') {
      throw new UnityCliUnavailableError();
    }
    if (error instanceof UnityCliCommandError) {
      throw error;
    }

    const stderr = typeof commandError.stderr === 'string'
      ? commandError.stderr.trim()
      : '';
    const detail = stderr.length > 0 ? ` ${stderr}` : '';
    throw new UnityCliCommandError(
      `Unity CLI ${commandName} failed with exit code ${String(commandError.code ?? 'unknown')}.${detail}`
    );
  }
}

/** Identifies the Pipeline command for diagnostics without logging test filters. */
function getCommandName(args: readonly string[]): string {
  const commands = ['list_tests', 'run_tests', 'test_status', 'cancel_tests'];
  return commands.find(command => args.includes(command)) ?? 'command';
}
