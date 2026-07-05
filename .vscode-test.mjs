import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/suite/**/*.test.js',
  mocha: {
    timeout: 30000,
    ui: 'bdd',
    color: true
  },
  version: '1.88.0',
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust'
  ]
});
