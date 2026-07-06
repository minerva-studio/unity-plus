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

  test('findTypes and primary type work for an unopened .cs file', async () => {
    const filePath = join(tempDir, 'UnopenedGate.cs');
    writeFileSync(filePath, [
      'namespace Amlos.Fixtures;',
      'public class UnopenedGate',
      '{',
      '    public void Open() { }',
      '}',
    ].join('\n'), 'utf-8');
    const uri = vscode.Uri.file(filePath);

    const types = await service.findTypes(uri);
    const primaryType = await service.getPrimaryTopLevelType(uri);

    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Fixtures.UnopenedGate']);
    assert.strictEqual(primaryType?.name, 'UnopenedGate');
    assert.strictEqual(primaryType?.namespace, 'Amlos.Fixtures');
    assert.strictEqual(primaryType?.nameRange?.start.line, 1);
    assert.strictEqual(primaryType?.nameRange?.start.character, 'public class '.length);
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

  test('returns exact source name positions for types, UnityEvent fields, and methods', async () => {
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
    assert.strictEqual(types[0].range.start.line, 3);
    assert.strictEqual(types[0].range.start.character, lines[3].indexOf('Interactable'));
    assert.strictEqual(types[0].range.end.character, lines[3].indexOf('Interactable') + 'Interactable'.length);
    assert.strictEqual(fields.find(field => field.name === 'OnCheckEnable')?.range.start.character, lines[5].indexOf('OnCheckEnable'));
    assert.strictEqual(fields.find(field => field.name === 'OnHighlighting')?.range.start.character, lines[6].indexOf('OnHighlighting'));
    assert.strictEqual(methods.find(method => method.name === 'Interact')?.range.start.character, lines[7].indexOf('Interact'));
    assert.deepStrictEqual(targets[0], {
      line: 7,
      character: lines[7].indexOf('Interact')
    });
  });

  test('throws when neither document symbols nor source text are available', async () => {
    const uri = vscode.Uri.file(join(tempDir, 'MissingFile.cs'));

    await assert.rejects(
      async () => await service.findTypes(uri),
      /C# symbols and source text are unavailable/
    );
  });
});
