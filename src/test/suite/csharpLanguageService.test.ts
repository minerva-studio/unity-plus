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
 * - Real VS Code document symbol provider (if C# extension is installed)
 *
 * Tests validate both:
 * 1. Source-text parsing fallback (always works, no C# extension needed)
 * 2. Document symbol integration (requires C# extension)
 */

let tempDir: string;

suite('csharpLanguageService — Source Text Parsing (No C# Extension Required)', () => {
  let service: ReturnType<typeof createVscodeCSharpLanguageService>;

  suiteSetup(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unity-plus-csharp-'));
    service = createVscodeCSharpLanguageService(vscode);
  });

  suiteTeardown(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function writeAndOpenCsFile(
    filename: string,
    content: string
  ): Promise<vscode.TextDocument> {
    const filePath = join(tempDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    const uri = vscode.Uri.file(filePath);
    return await vscode.workspace.openTextDocument(uri);
  }

  test('extracts a single class from C# source text', async () => {
    const doc = await writeAndOpenCsFile('PlayerController.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public class PlayerController : MonoBehaviour',
      '{',
      '    void Start() { }',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'PlayerController');
    assert.strictEqual(primaryType?.kind, 'class');
    assert.strictEqual(primaryType?.namespace, 'Minerva.Gameplay');
  });

  test('extracts a struct from C# source text', async () => {
    const doc = await writeAndOpenCsFile('HeroStats.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public struct HeroStats',
      '{',
      '    public int Health;',
      '    public int Mana;',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'HeroStats');
    assert.strictEqual(primaryType?.kind, 'struct');
  });

  test('extracts an enum from C# source text', async () => {
    const doc = await writeAndOpenCsFile('CombatState.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public enum CombatState',
      '{',
      '    Idle,',
      '    Attacking,',
      '    Defending',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'CombatState');
    assert.strictEqual(primaryType?.kind, 'enum');
  });

  test('extracts an interface from C# source text', async () => {
    const doc = await writeAndOpenCsFile('IQuestRule.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public interface IQuestRule',
      '{',
      '    bool Evaluate(QuestContext context);',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'IQuestRule');
    assert.strictEqual(primaryType?.kind, 'interface');
  });

  test('extracts a record from C# source text', async () => {
    const doc = await writeAndOpenCsFile('QuestDefinition.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public record QuestDefinition(string Title, string Description);',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'QuestDefinition');
    assert.strictEqual(primaryType?.kind, 'record');
  });

  test('returns undefined when source text contains multiple top-level types', async () => {
    const doc = await writeAndOpenCsFile('MultiType.cs', [
      'public class FirstType { }',
      'public class SecondType { }',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType, undefined);
  });

  test('returns undefined for a file with no top-level type', async () => {
    const doc = await writeAndOpenCsFile('Empty.cs', [
      '// Just a comment',
      'using UnityEngine;',
      '',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType, undefined);
  });

  test('skips types inside comments and strings', async () => {
    const doc = await writeAndOpenCsFile('WithComments.cs', [
      '// public class CommentedOut { }',
      '/* public struct AlsoCommented { } */',
      'public class RealClass { }',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'RealClass');
    assert.strictEqual(primaryType?.kind, 'class');
  });

  test('returns type with position when source text is parsed', async () => {
    const doc = await writeAndOpenCsFile('Positioned.cs', [
      '',
      'namespace Minerva.Gameplay;',
      '',
      'public class Positioned',
      '{',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'Positioned');
    assert.ok(primaryType?.position, 'position should be defined');
    assert.ok(primaryType?.nameRange, 'nameRange should be defined');
  });

  test('handles file-scoped namespace declaration', async () => {
    const doc = await writeAndOpenCsFile('FileScoped.cs', [
      'namespace Minerva.Gameplay;',
      '',
      'public class FileScopedClass',
      '{',
      '}',
    ].join('\n'));

    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    assert.strictEqual(primaryType?.name, 'FileScopedClass');
    assert.strictEqual(primaryType?.namespace, 'Minerva.Gameplay');
  });
});

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

    // Open the document so the language service can read it
    const doc = await vscode.workspace.openTextDocument(uri);

    // This should use source text fallback (which always works)
    // or document symbols if the C# extension is available
    const primaryType = await service.getPrimaryTopLevelType(doc.uri);

    // At minimum, source-text parsing should find the class
    assert.strictEqual(primaryType?.name, 'SymbolTest');
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
});
