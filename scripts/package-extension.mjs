import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const shouldInstall = args.includes('--install');
const outIndex = args.indexOf('--out');
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const defaultVsixPath = resolve('dist', `${packageJson.name}-${packageJson.version}.vsix`);
const vsixPath = outIndex >= 0 && args[outIndex + 1] ? resolve(args[outIndex + 1]) : defaultVsixPath;
const vsixArgumentPath = toShellSafeWorkspacePath(vsixPath);

mkdirSync(dirname(vsixPath), { recursive: true });

run('npm', ['run', 'compile']);

run('npx', [
  'vsce',
  'package',
  '--no-dependencies',
  '--allow-missing-repository',
  '--out',
  vsixArgumentPath
]);

if (!existsSync(vsixPath)) {
  throw new Error(`Expected VSIX was not created: ${vsixPath}`);
}

console.log(`Packaged Unity Plus extension: ${vsixPath}`);

if (shouldInstall) {
  const codeCommand = process.env.CODE_CLI ?? 'code';
  run(codeCommand, ['--install-extension', vsixArgumentPath, '--force']);
  console.log('Installed Unity Plus extension into VS Code.');
}

function run(command, commandArgs) {
  // Windows resolves npm/npx/code through .cmd shims more reliably with shell execution.
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${commandArgs.join(' ')}`);
  }
}

function toShellSafeWorkspacePath(filePath) {
  const workspaceRelativePath = relative(process.cwd(), filePath);

  if (!workspaceRelativePath.startsWith('..')) {
    return workspaceRelativePath;
  }

  return filePath;
}
