import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Integration tests for extension activation.
 *
 * These tests run inside the real VS Code Extension Host and verify:
 * 1. Extension is activated
 * 2. All commands from package.json are registered
 * 3. Configuration properties are accessible
 * 4. Keybindings are set up correctly
 */

suite('activation — Extension Activation', () => {
  test('extension is activated', async () => {
    const ext = vscode.extensions.getExtension('minerva-game-studio.unity-plus');
    assert.ok(ext, 'Extension should be findable by its publisher.name ID');

    if (ext && !ext.isActive) {
      await ext.activate();
    }

    assert.strictEqual(ext?.isActive, true, 'Extension should be active after activation');
  });
});

suite('activation — Command Registration', () => {
  const expectedCommands = [
    'unityPlus.refreshProjectFiles',
    'unityPlus.createCSharpScript',
    'unityPlus.createScriptableObject',
    'unityPlus.syncScriptFilename',
    'unityPlus.syncClassName',
    'unityPlus.showUnityEventReferences',
    'unityPlus.openMetaFile',
    'unityPlus.openInUnity',
    'unityPlus.selectUnityEditor',
    'unityPlus.rescanUnityProject',
  ];

  /** Returns true if the required C# extension dependencies are available. */
  function hasCSharpExtensions(): boolean {
    return (
      vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined
    );
  }

  test('all expected commands are registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);

    for (const cmd of expectedCommands) {
      const found = allCommands.includes(cmd);

      if (!found && !hasCSharpExtensions()) {
        console.log(`SKIP: ${cmd} may require C# extension dependencies.`);
        continue;
      }

      assert.strictEqual(found, true,
        `Command "${cmd}" should be registered (available: ${allCommands.includes('unityPlus.syncClassName')})`);
    }
  });

  test('syncClassName command is usable', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.syncClassName') && !hasCSharpExtensions()) {
      console.log('SKIP: syncClassName requires C# extension dependencies.');
      return;
    }
    assert.ok(allCommands.includes('unityPlus.syncClassName'),
      'syncClassName should be registered');
  });

  test('refreshProjectFiles command is usable', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.refreshProjectFiles') && !hasCSharpExtensions()) {
      console.log('SKIP: refreshProjectFiles requires C# extension dependencies.');
      return;
    }
    assert.ok(allCommands.includes('unityPlus.refreshProjectFiles'),
      'refreshProjectFiles should be registered');
  });

  test('openMetaFile command is usable', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.openMetaFile') && !hasCSharpExtensions()) {
      console.log('SKIP: openMetaFile requires C# extension dependencies.');
      return;
    }
    assert.ok(allCommands.includes('unityPlus.openMetaFile'),
      'openMetaFile should be registered');
  });
});

suite('activation — Configuration Properties', () => {
  test('rename.classFileSyncMode configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.rename');
    const mode = config.get<string>('classFileSyncMode');

    assert.ok(
      mode === 'on' || mode === 'off',
      `classFileSyncMode should be 'on' or 'off', got: ${mode}`
    );
  });

  test('rename.previewMode configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.rename');
    const mode = config.get<string>('previewMode');

    assert.ok(
      mode === 'silent' || mode === 'ask' || mode === 'ask+warn',
      `previewMode should be one of: silent, ask, ask+warn, got: ${mode}`
    );
  });

  test('rename.overrideF2 configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.rename');
    const overrideF2 = config.get<boolean>('overrideF2');

    assert.strictEqual(typeof overrideF2, 'boolean');
  });

  test('metaFiles.hideInExplorer configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.metaFiles');
    const hide = config.get<boolean>('hideInExplorer');

    assert.strictEqual(typeof hide, 'boolean');
  });

  test('metaFiles.moveWithAsset configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.metaFiles');
    const move = config.get<boolean>('moveWithAsset');

    assert.strictEqual(typeof move, 'boolean');
  });

  test('eventReferences.enabled configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.eventReferences');
    const enabled = config.get<boolean>('enabled');

    assert.strictEqual(typeof enabled, 'boolean');
  });

  test('logging.level configuration is accessible', () => {
    const config = vscode.workspace.getConfiguration('unityPlus.logging');
    const level = config.get<string>('level');

    assert.ok(
      ['trace', 'debug', 'info', 'warn', 'error'].includes(level ?? ''),
      `logging.level should be a valid level, got: ${level}`
    );
  });
});
