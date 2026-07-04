import * as assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('package manifest', () => {
  it('activates from C# files and explicit Unity Plus commands', () => {
    const manifest = readPackageManifest();

    assert.deepStrictEqual(manifest.activationEvents, [
      'onLanguage:csharp',
      'workspaceContains:**/ProjectSettings/ProjectVersion.txt',
      'onCommand:unityPlus.refreshProjectFiles',
      'onCommand:unityPlus.createCSharpScript',
      'onCommand:unityPlus.createScriptableObject',
      'onCommand:unityPlus.syncScriptFilename',
      'onCommand:unityPlus.syncClassName',
      'onCommand:unityPlus.showUnityEventReferences',
      'onCommand:unityPlus.openMetaFile',
      'onCommand:unityPlus.openInUnity',
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
    assert.strictEqual(properties['unityPlus.templates.csharpScriptFile'].default, '');
    assert.strictEqual(properties['unityPlus.templates.scriptableObjectFile'].default, '');
    assert.strictEqual(properties['unityPlus.templates.csharpScript'].default, '');
    assert.strictEqual(properties['unityPlus.templates.scriptableObject'].default, '');
    assert.strictEqual(properties['unityPlus.eventReferences.enabled'].default, true);
    assert.strictEqual(properties['unityPlus.metaFiles.hideInExplorer'].default, true);
    assert.strictEqual(properties['unityPlus.metaFiles.moveWithAsset'].default, true);
  });

  it('uses VS Code native localization bundles', () => {
    const manifest = readPackageManifest();
    const packageNls = readJson<Record<string, string>>('package.nls.json');
    const chinesePackageNls = readJson<Record<string, string>>('package.nls.zh-cn.json');
    const placeholders = collectPackagePlaceholders(manifest);

    assert.strictEqual(manifest.l10n, './l10n');
    assert.ok(placeholders.has('extension.displayName'));
    assert.ok(placeholders.has('configuration.logging.level.description'));

    for (const key of placeholders) {
      assert.ok(packageNls[key], `Missing package.nls.json key: ${key}`);
      assert.ok(chinesePackageNls[key], `Missing package.nls.zh-cn.json key: ${key}`);
    }
  });

  it('provides zh-cn runtime localization entries for user-visible strings', () => {
    const bundle = readJson<Record<string, string>>(join('l10n', 'bundle.l10n.zh-cn.json'));

    assert.strictEqual(bundle['Open In Unity'], '在 Unity 中打开');
    assert.strictEqual(bundle['Unity Plus: UnityEvent references are disabled.'], 'Unity Plus: UnityEvent 引用已禁用。');
    assert.ok(bundle['Unity Plus: Open a Unity project before creating a C# script.']);
    assert.ok(bundle['UnityEvent references: {count}']);
  });

  it('contributes explicit commands for creating Unity C# scripts', () => {
    const manifest = readPackageManifest();
    const csharpScriptCommand = manifest.contributes.commands.find((item: { command: string }) =>
      item.command === 'unityPlus.createCSharpScript'
    );
    const scriptableObjectCommand = manifest.contributes.commands.find((item: { command: string }) =>
      item.command === 'unityPlus.createScriptableObject'
    );

    assert.strictEqual(csharpScriptCommand?.title, '%command.createCSharpScript.title%');
    assert.strictEqual(scriptableObjectCommand?.title, '%command.createScriptableObject.title%');
  });

  it('contributes an explicit command for opening Unity meta files', () => {
    const manifest = readPackageManifest();
    const command = manifest.contributes.commands.find((item: { command: string }) =>
      item.command === 'unityPlus.openMetaFile'
    );

    assert.strictEqual(command?.title, '%command.openMetaFile.title%');
    assert.strictEqual(command?.icon, '$(file-code)');
  });

  it('contributes an explicit command for opening resources in Unity', () => {
    const manifest = readPackageManifest();
    const command = manifest.contributes.commands.find((item: { command: string }) =>
      item.command === 'unityPlus.openInUnity'
    );

    assert.strictEqual(command?.title, '%command.openInUnity.title%');
    assert.strictEqual(command?.icon, '$(rocket)');
  });

  it('keeps Unity Plus command ownership through categories', () => {
    const manifest = readPackageManifest();
    const packageNls = readJson<Record<string, string>>('package.nls.json');
    const commands = manifest.contributes.commands as Array<{ category?: string }>;

    assert.strictEqual(packageNls['command.category'], 'Unity Plus');
    assert.ok(commands.every(command => command.category === '%command.category%'));
  });

  it('shows Unity resource commands in Explorer and editor title menus', () => {
    const manifest = readPackageManifest();
    const explorerCommand = manifest.contributes.menus['explorer/context'].find((item: { command: string }) =>
      item.command === 'unityPlus.openMetaFile'
    );
    const editorTitleCommand = manifest.contributes.menus['editor/title'].find((item: { command: string }) =>
      item.command === 'unityPlus.openMetaFile'
    );
    const explorerOpenInUnityCommand = manifest.contributes.menus['explorer/context'].find((item: { command: string }) =>
      item.command === 'unityPlus.openInUnity'
    );
    const explorerCreateScriptCommand = manifest.contributes.menus['explorer/context'].find((item: { command: string }) =>
      item.command === 'unityPlus.createCSharpScript'
    );
    const explorerCreateScriptableObjectCommand = manifest.contributes.menus['explorer/context'].find((item: { command: string }) =>
      item.command === 'unityPlus.createScriptableObject'
    );
    const editorTitleOpenInUnityCommand = manifest.contributes.menus['editor/title'].find((item: { command: string }) =>
      item.command === 'unityPlus.openInUnity'
    );

    assert.strictEqual(explorerCommand?.when, 'resourceScheme == file');
    assert.strictEqual(editorTitleCommand?.when, 'resourceScheme == file');
    assert.strictEqual(explorerOpenInUnityCommand?.when, 'resourceScheme == file');
    assert.strictEqual(editorTitleOpenInUnityCommand?.when, 'resourceScheme == file');
    assert.strictEqual(explorerCreateScriptCommand?.when, 'resourceScheme == file');
    assert.strictEqual(explorerCreateScriptableObjectCommand?.when, 'resourceScheme == file');
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as T;
}

function collectPackagePlaceholders(value: unknown, keys = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const match = /^%(.+)%$/.exec(value);
    if (match) {
      keys.add(match[1]);
    }
    return keys;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectPackagePlaceholders(item, keys));
    return keys;
  }

  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectPackagePlaceholders(item, keys));
  }

  return keys;
}
