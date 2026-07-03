import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package manifest', () => {
  it('activates only from explicit Unity Plus commands', () => {
    const manifest = readPackageManifest();

    assert.deepStrictEqual(manifest.activationEvents, [
      'workspaceContains:**/ProjectSettings/ProjectVersion.txt',
      'onCommand:unityPlus.refreshProjectFiles',
      'onCommand:unityPlus.syncScriptFilename',
      'onCommand:unityPlus.syncClassName',
      'onCommand:unityPlus.showUnityEventReferences',
      'onCommand:unityPlus.openMetaFile',
      'onCommand:unityPlus.rescanUnityProject'
    ]);
  });

  it('keeps C# language providers as explicit extension dependencies', () => {
    const manifest = readPackageManifest();

    assert.deepStrictEqual(manifest.extensionDependencies, [
      'ms-dotnettools.csdevkit',
      'ms-dotnettools.csharp'
    ]);
  });

  it('enables Unity workflow defaults without broad workspace activation', () => {
    const manifest = readPackageManifest();
    const properties = manifest.contributes.configuration.properties;

    assert.strictEqual(properties['unityPlus.rename.overrideF2'].default, true);
    assert.strictEqual(properties['unityPlus.rename.classFileSyncMode'].default, 'on');
    assert.deepStrictEqual(properties['unityPlus.rename.classFileSyncMode'].enum, ['on', 'off']);
    assert.strictEqual(properties['unityPlus.projectFiles.autoRefresh'].default, true);
    assert.strictEqual(properties['unityPlus.eventReferences.enabled'].default, true);
    assert.strictEqual(properties['unityPlus.metaFiles.hideInExplorer'].default, true);
  });

  it('contributes an explicit command for opening Unity meta files', () => {
    const manifest = readPackageManifest();
    const command = manifest.contributes.commands.find((item: { command: string }) =>
      item.command === 'unityPlus.openMetaFile'
    );

    assert.strictEqual(command?.title, 'Unity Plus: Open Meta File');
  });

  it('enables optional F2 override for C# rename by default', () => {
    const manifest = readPackageManifest();
    const property = manifest.contributes.configuration.properties['unityPlus.rename.overrideF2'];

    assert.strictEqual(property.type, 'boolean');
    assert.strictEqual(property.default, true);
  });

  it('binds F2 in C# editors to the Unity Plus type rename command when override is enabled', () => {
    const manifest = readPackageManifest();
    const keybinding = manifest.contributes.keybindings.find((item: { command: string }) =>
      item.command === 'unityPlus.syncClassName'
    );

    assert.strictEqual(keybinding?.key, 'f2');
    assert.strictEqual(
      keybinding?.when,
      'editorTextFocus && editorLangId == csharp && config.unityPlus.rename.overrideF2'
    );
  });
});

function readPackageManifest() {
  return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
}
