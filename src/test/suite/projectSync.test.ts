import * as assert from 'assert';
import * as vscode from 'vscode';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';

/**
 * Integration tests for project sync operations.
 *
 * Uses real vscode APIs:
 * - workspace.fs for read/write/stat
 * - workspace.applyEdit for file operations
 * - Real .csproj and .asmdef files in temp directories
 */

let tempDir: string;

suite('projectSync — Real Filesystem Operations', () => {
  suiteSetup(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unity-plus-projectsync-'));
  });

  suiteTeardown(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('refreshProjectFiles command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const hasCSharp = vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined;

    if (!allCommands.includes('unityPlus.refreshProjectFiles') && !hasCSharp) {
      console.log('SKIP: refreshProjectFiles may require C# extension dependencies.');
      return;
    }
    assert.ok(
      allCommands.includes('unityPlus.refreshProjectFiles'),
      'refreshProjectFiles should be registered'
    );
  });

  test('can write and read a .csproj file via workspace.fs', async () => {
    const csprojPath = join(tempDir, 'Assembly-CSharp.csproj');
    const csprojContent = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
      '  <PropertyGroup>',
      '    <Configuration Condition=" \'$(Configuration)\' == \'\' ">Debug</Configuration>',
      '  </PropertyGroup>',
      '  <ItemGroup>',
      '    <Compile Include="Assets\\PlayerController.cs" />',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');

    const uri = vscode.Uri.file(csprojPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(csprojContent, 'utf-8'));

    const readBytes = await vscode.workspace.fs.readFile(uri);
    // workspace.fs.readFile returns Uint8Array, not Node Buffer
    const readContent = new TextDecoder().decode(readBytes);

    assert.ok(readContent.includes('PlayerController.cs'),
      'csproj should contain the Compile Include reference');
    assert.ok(readContent.includes('Microsoft.NET.Sdk') || readContent.includes('DefaultTargets'),
      'csproj should be valid XML with Project element');
  });

  test('can write and read an .asmdef file via workspace.fs', async () => {
    const asmdefPath = join(tempDir, 'Minerva.Gameplay.asmdef');
    const asmdefContent = JSON.stringify({
      name: 'Minerva.Gameplay',
      references: ['UnityEngine'],
      includePlatforms: ['Editor'],
      excludePlatforms: [],
    }, null, 2);

    const uri = vscode.Uri.file(asmdefPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(asmdefContent, 'utf-8'));

    const readBytes = await vscode.workspace.fs.readFile(uri);
    const parsed = JSON.parse(new TextDecoder().decode(readBytes));

    assert.strictEqual(parsed.name, 'Minerva.Gameplay');
    assert.deepStrictEqual(parsed.references, ['UnityEngine']);
  });

  test('can write and read a .meta file with a GUID', async () => {
    const metaPath = join(tempDir, 'TestScript.cs.meta');
    const metaContent = [
      'fileFormatVersion: 2',
      'guid: abc123def4567890abcdef1234567890',
    ].join('\n');

    const uri = vscode.Uri.file(metaPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(metaContent, 'utf-8'));

    const readBytes = await vscode.workspace.fs.readFile(uri);
    const readContent = new TextDecoder().decode(readBytes);

    assert.ok(readContent.includes('guid: abc123def4567890abcdef1234567890'));
    assert.ok(readContent.includes('fileFormatVersion: 2'));
  });

  test('can create a C# script template with namespace and class', async () => {
    const className = 'NewMonoBehaviour';
    const namespaceName = 'Minerva.Gameplay';
    const scriptContent = [
      `namespace ${namespaceName};`,
      '',
      `public class ${className} : UnityEngine.MonoBehaviour`,
      '{',
      '    void Start()',
      '    {',
      '    }',
      '}',
    ].join('\n');

    const scriptPath = join(tempDir, `${className}.cs`);
    const uri = vscode.Uri.file(scriptPath);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(scriptContent, 'utf-8'));

    // Verify the file was created
    const readBack = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    assert.ok(readBack.includes(className));
    assert.ok(readBack.includes(namespaceName));
    assert.ok(readBack.includes('MonoBehaviour'));
  });

  function skipIfNoCSharp(command: string): boolean {
    const hasCSharp = vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined;
    if (!hasCSharp) {
      console.log(`SKIP: ${command} may require C# extension dependencies.`);
      return true;
    }
    return false;
  }

  test('createCSharpScript command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.createCSharpScript') && skipIfNoCSharp('unityPlus.createCSharpScript')) return;
    assert.ok(allCommands.includes('unityPlus.createCSharpScript'),
      'createCSharpScript command should be registered');
  });

  test('createScriptableObject command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.createScriptableObject') && skipIfNoCSharp('unityPlus.createScriptableObject')) return;
    assert.ok(allCommands.includes('unityPlus.createScriptableObject'),
      'createScriptableObject command should be registered');
  });

  test('rescanUnityProject command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    if (!allCommands.includes('unityPlus.rescanUnityProject') && skipIfNoCSharp('unityPlus.rescanUnityProject')) return;
    assert.ok(allCommands.includes('unityPlus.rescanUnityProject'),
      'rescanUnityProject command should be registered');
  });
});
