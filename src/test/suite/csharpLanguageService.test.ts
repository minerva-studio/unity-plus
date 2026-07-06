import * as assert from 'assert';
import * as vscode from 'vscode';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';

/**
 * Integration tests for CSharpLanguageService.
 *
 * These tests use:
 * - Real vscode APIs (workspace.openTextDocument, commands.executeCommand)
 * - Real .cs files written to temp directories
 * - Real VS Code document symbol provider from the configured C# extension
 */

let tempDir: string;

/** Writes a temporary C# file and returns its VS Code URI. */
function writeCsFile(filename: string, lines: string[]): vscode.Uri {
  const filePath = join(tempDir, filename);
  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return vscode.Uri.file(filePath);
}

suite('csharpLanguageService — VS Code Document Symbol Integration', () => {
  let service: ReturnType<typeof createVscodeCSharpLanguageService>;

  suiteSetup(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unity-plus-csharp-symbols-'));
    service = createVscodeCSharpLanguageService(vscode);
  });

  suiteTeardown(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('can call executeDocumentSymbolProvider on a .cs file', async () => {
    const filePath = join(tempDir, 'SymbolTest.cs');
    writeFileSync(filePath, [
      'namespace Minerva.Gameplay;',
      'public class SymbolTest { }',
    ].join('\n'), 'utf-8');
    const uri = vscode.Uri.file(filePath);

    // Open the document so the C# provider can load it before symbol requests.
    const doc = await vscode.workspace.openTextDocument(uri);

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'SymbolTest');
  });

  test('findTypes and primary type work for an unopened .cs file', async () => {
    const uri = writeCsFile('UnopenedGate.cs', [
      'namespace Amlos.Fixtures;',
      'public class UnopenedGate',
      '{',
      '    public void Open() { }',
      '}',
    ]);

    const types = await service.findTypes(uri);
    const primaryType = await service.getPrimaryTopLevelType(uri);

    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Fixtures.UnopenedGate']);
    assert.strictEqual(primaryType?.name, 'UnopenedGate');
    assert.strictEqual(primaryType?.namespace, 'Amlos.Fixtures');
    assert.ok(primaryType?.nameRange, 'primary type range should come from C# provider symbols');
  });

  test('findReferences returns an array (may be empty)', async () => {
    const filePath = join(tempDir, 'RefTest.cs');
    writeFileSync(filePath, [
      'namespace Minerva.Gameplay;',
      'public class RefTest { }',
    ].join('\n'), 'utf-8');
    const uri = vscode.Uri.file(filePath);

    const refs = await service.findReferences(uri, { line: 1, character: 13 });

    assert.ok(Array.isArray(refs), 'findReferences should return an array');
  });

  test('returns provider symbol positions for types, UnityEvent fields, and methods', async () => {
    const lines = [
      'using UnityEngine.Events;',
      'namespace Amlos.Control.Interact',
      '{',
      '    public sealed class Interactable : MonoBehaviour',
      '    {',
      '        public UnityEvent<ResultArg<bool>> OnCheckEnable = new();',
      '        [DisplayIf(nameof(overrideDefaultHighlight))] public UnityEvent OnHighlighting = new();',
      '        public void Interact() {}',
      '    }',
      '}'
    ];
    const filePath = join(tempDir, 'Interactable.cs');
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    const uri = vscode.Uri.file(filePath);

    const types = await service.findTypes(uri);
    const fields = await service.findUnityEventFields(uri);
    const methods = await service.findMethods(uri);
    const targets = await service.findTargetMethodPosition(uri, 'Amlos.Control.Interact.Interactable', 'Interact');

    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Control.Interact.Interactable']);
    assert.ok(types[0].range, 'type range should come from C# provider symbols');
    assert.ok(fields.find(field => field.name === 'OnCheckEnable')?.range, 'UnityEvent field range should come from C# provider symbols');
    assert.ok(fields.find(field => field.name === 'OnHighlighting')?.range, 'attribute-adjacent UnityEvent field range should come from C# provider symbols');
    assert.ok(methods.find(method => method.name === 'Interact')?.range, 'method range should come from C# provider symbols');
    assert.ok(targets.length > 0, 'target method positions should come from C# provider symbols');
  });

  test('throws when C# document symbols are unavailable', async () => {
    const uri = vscode.Uri.file(join(tempDir, 'MissingFile.cs'));

    await assert.rejects(async () => await service.findTypes(uri));
  });
});
