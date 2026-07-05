import * as assert from 'assert';
import * as vscode from 'vscode';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';

/**
 * Integration tests for meta file operations.
 *
 * Uses real vscode APIs:
 * - workspace.fs for file existence checks
 * - workspace.applyEdit for real file renames
 * - Real files in temp directories
 */

let tempDir: string;

suite('metaFiles — File System Operations', () => {
  suiteSetup(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unity-plus-meta-'));
  });

  suiteTeardown(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('openMetaFile command is registered', async () => {
    const allCommands = await vscode.commands.getCommands(true);
    const hasCSharp = vscode.extensions.getExtension('ms-dotnettools.csharp') !== undefined;

    if (!allCommands.includes('unityPlus.openMetaFile') && !hasCSharp) {
      console.log('SKIP: openMetaFile may require C# extension dependencies.');
      return;
    }
    assert.ok(
      allCommands.includes('unityPlus.openMetaFile'),
      'openMetaFile command should be registered'
    );
  });

  test('can rename a .cs file and its .meta file together via WorkspaceEdit', async () => {
    const oldPath = join(tempDir, 'TestScript.cs');
    const oldMetaPath = `${oldPath}.meta`;
    const newPath = join(tempDir, 'RenamedScript.cs');
    const newMetaPath = `${newPath}.meta`;

    writeFileSync(oldPath, 'public class TestScript { }', 'utf-8');
    writeFileSync(oldMetaPath, 'guid: abc123def456', 'utf-8');

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
    edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath));

    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true);

    // Verify old files are gone
    assert.strictEqual(existsSync(oldPath), false, 'old .cs should not exist');
    assert.strictEqual(existsSync(oldMetaPath), false, 'old .meta should not exist');

    // Verify new files exist
    assert.strictEqual(existsSync(newPath), true, 'new .cs should exist');
    assert.strictEqual(existsSync(newMetaPath), true, 'new .meta should exist');
  });

  test('can rename a non-C# asset and its .meta file together', async () => {
    const oldPath = join(tempDir, 'icon.png');
    const oldMetaPath = `${oldPath}.meta`;
    const newPath = join(tempDir, 'icon-renamed.png');
    const newMetaPath = `${newPath}.meta`;

    writeFileSync(oldPath, 'fake-png-data', 'utf-8');
    writeFileSync(oldMetaPath, 'guid: png123guid456', 'utf-8');

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
    edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath));

    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true);

    assert.strictEqual(existsSync(oldPath), false);
    assert.strictEqual(existsSync(newPath), true);
    assert.strictEqual(existsSync(newMetaPath), true);
  });

  test('can rename a .prefab and its .meta together', async () => {
    const charsDir = join(tempDir, 'Characters');
    mkdirSync(charsDir, { recursive: true });

    const oldPath = join(tempDir, 'Player.prefab');
    const oldMetaPath = `${oldPath}.meta`;
    const newPath = join(charsDir, 'Player.prefab');
    const newMetaPath = `${newPath}.meta`;

    writeFileSync(oldPath, '%YAML 1.1\n---\n', 'utf-8');
    writeFileSync(oldMetaPath, 'guid: prefab123', 'utf-8');

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));
    edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath));

    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true);

    assert.strictEqual(existsSync(newPath), true);
    assert.strictEqual(existsSync(newMetaPath), true);
  });

  test('rejects rename when target .cs already exists', async () => {
    const oldPath = join(tempDir, 'Source.cs');
    const newPath = join(tempDir, 'Target.cs');

    writeFileSync(oldPath, 'class Source { }', 'utf-8');
    writeFileSync(newPath, 'class Target { }', 'utf-8'); // target exists!

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldPath), vscode.Uri.file(newPath));

    const applied = await vscode.workspace.applyEdit(edit);
    // VS Code should reject rename when target exists
    assert.strictEqual(applied, false);

    // Old file should still exist
    assert.strictEqual(existsSync(oldPath), true);
  });

  test('rejects rename when target .meta already exists', async () => {
    const oldPath = join(tempDir, 'Source2.cs');
    const oldMetaPath = `${oldPath}.meta`;
    const newPath = join(tempDir, 'Target2.cs');
    const newMetaPath = `${newPath}.meta`;

    writeFileSync(oldPath, 'class Source2 { }', 'utf-8');
    writeFileSync(oldMetaPath, 'guid: src2', 'utf-8');
    writeFileSync(newMetaPath, 'guid: already-here', 'utf-8'); // target meta exists!

    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(oldMetaPath), vscode.Uri.file(newMetaPath));

    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, false);
  });

  test('workspace.fs.stat can check file existence', async () => {
    const filePath = join(tempDir, 'ExistsCheck.txt');
    writeFileSync(filePath, 'hello', 'utf-8');
    const uri = vscode.Uri.file(filePath);

    // Should not throw for existing file
    let exists = true;
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      exists = false;
    }
    assert.strictEqual(exists, true);

    // Should throw for non-existing file
    const missingUri = vscode.Uri.file(join(tempDir, 'DoesNotExist.txt'));
    let missing = false;
    try {
      await vscode.workspace.fs.stat(missingUri);
    } catch {
      missing = true;
    }
    assert.strictEqual(missing, true);
  });
});
