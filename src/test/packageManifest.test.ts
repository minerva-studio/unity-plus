import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package manifest', () => {
  it('activates only from explicit Unity Plus commands', () => {
    const manifest = readPackageManifest();

    assert.deepStrictEqual(manifest.activationEvents, [
      'onCommand:unityPlus.refreshProjectFiles',
      'onCommand:unityPlus.syncScriptFilename',
      'onCommand:unityPlus.syncClassName',
      'onCommand:unityPlus.showUnityEventReferences',
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

  it('keeps startup-heavy features opt-in by default', () => {
    const manifest = readPackageManifest();
    const properties = manifest.contributes.configuration.properties;

    assert.strictEqual(properties['unityPlus.rename.overrideF2'].default, false);
    assert.strictEqual(properties['unityPlus.rename.classFileSyncMode'].default, 'off');
    assert.strictEqual(properties['unityPlus.projectFiles.autoRefresh'].default, false);
    assert.strictEqual(properties['unityPlus.eventReferences.enabled'].default, false);
  });

  it('disables optional F2 override for C# rename by default', () => {
    const manifest = readPackageManifest();
    const property = manifest.contributes.configuration.properties['unityPlus.rename.overrideF2'];

    assert.strictEqual(property.type, 'boolean');
    assert.strictEqual(property.default, false);
  });

  it('binds F2 in C# editors to the Unity Plus class rename command when override is enabled', () => {
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
