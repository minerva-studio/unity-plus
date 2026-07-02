import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package manifest', () => {
  it('enables optional F2 override for C# rename by default', () => {
    const manifest = readPackageManifest();
    const property = manifest.contributes.configuration.properties['unityPlus.rename.overrideF2'];

    assert.strictEqual(property.type, 'boolean');
    assert.strictEqual(property.default, true);
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
