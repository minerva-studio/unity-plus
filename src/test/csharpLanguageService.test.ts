import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createVscodeCSharpLanguageService } from '../unity/csharpLanguageService';

describe('csharpLanguageService', () => {
  it('returns the single top-level type from document symbols', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [
        namespaceSymbol('Minerva.Gameplay', [
          typeSymbol('PlayerController', 1, 4, 12)
        ])
      ]
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/PlayerController.cs'));

    assert.strictEqual(primaryType?.name, 'PlayerController');
    assert.strictEqual(primaryType?.kind, 'class');
    assert.strictEqual(primaryType?.namespace, 'Minerva.Gameplay');
    assert.deepStrictEqual(primaryType?.position, { line: 4, character: 12 });
  });

  it('returns undefined when document symbols contain multiple top-level types', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [
        typeSymbol('FirstUtility', 1, 1, 0),
        typeSymbol('SecondUtility', 1, 5, 0)
      ]
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/Utilities.cs'));

    assert.strictEqual(primaryType, undefined);
  });

  it('falls back to source scanning when document symbols are empty', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [],
      documents: new Map([
        ['/Project/Assets/HeroStats.cs', [
          'namespace Minerva.Gameplay;',
          '',
          'public struct HeroStats',
          '{',
          '  public int Health;',
          '}'
        ].join('\n')]
      ])
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/HeroStats.cs'));

    assert.strictEqual(primaryType?.name, 'HeroStats');
    assert.strictEqual(primaryType?.kind, 'struct');
    assert.strictEqual(primaryType?.namespace, 'Minerva.Gameplay');
    assert.deepStrictEqual(primaryType?.position, { line: 2, character: 14 });
  });

  it('falls back to source scanning when document symbols throw', async () => {
    const runtimeVscode = createFakeVscode({
      throwDocumentSymbols: true,
      documents: new Map([
        ['/Project/Assets/CombatState.cs', [
          'namespace Minerva.Gameplay',
          '{',
          '  public enum CombatState',
          '  {',
          '    Idle',
          '  }',
          '}'
        ].join('\n')]
      ])
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/CombatState.cs'));

    assert.strictEqual(primaryType?.name, 'CombatState');
    assert.strictEqual(primaryType?.kind, 'enum');
    assert.strictEqual(primaryType?.namespace, 'Minerva.Gameplay');
    assert.deepStrictEqual(primaryType?.position, { line: 2, character: 14 });
  });

  it('supports interface and record source fallback without matching comments or strings', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [],
      documents: new Map([
        ['/Project/Assets/QuestDefinition.cs', [
          '// public class CommentTrap',
          'var text = "public enum StringTrap";',
          'namespace Minerva.Quests',
          '{',
          '  public record QuestDefinition(int Id);',
          '}'
        ].join('\n')],
        ['/Project/Assets/IQuestRule.cs', [
          'namespace Minerva.Quests;',
          'public interface IQuestRule',
          '{',
          '}'
        ].join('\n')]
      ])
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const recordType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/QuestDefinition.cs'));
    const interfaceType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/IQuestRule.cs'));

    assert.strictEqual(recordType?.name, 'QuestDefinition');
    assert.strictEqual(recordType?.kind, 'record');
    assert.strictEqual(interfaceType?.name, 'IQuestRule');
    assert.strictEqual(interfaceType?.kind, 'interface');
  });

  it('does not return nested or multiple source fallback types', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [],
      documents: new Map([
        ['/Project/Assets/Outer.cs', [
          'public class Outer',
          '{',
          '  public class Nested',
          '  {',
          '  }',
          '}'
        ].join('\n')],
        ['/Project/Assets/Many.cs', [
          'public class First',
          '{',
          '}',
          'public struct Second',
          '{',
          '}'
        ].join('\n')]
      ])
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const outerType = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/Outer.cs'));
    const manyTypes = await service.getPrimaryTopLevelType(fakeUri('/Project/Assets/Many.cs'));

    assert.strictEqual(outerType?.name, 'Outer');
    assert.strictEqual(manyTypes, undefined);
  });

  it('delegates reference lookup to the VS Code reference provider command', async () => {
    const runtimeVscode = createFakeVscode({
      references: [{
        uri: fakeUri('/Project/Assets/PlayerController.cs'),
        range: fakeRange(10, 4, 10, 20)
      }]
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const references = await service.findReferences(fakeUri('/Project/Assets/PlayerController.cs'), {
      line: 4,
      character: 12
    });

    assert.deepStrictEqual(references, [{
      uriPath: '/Project/Assets/PlayerController.cs',
      range: {
        start: { line: 10, character: 4 },
        end: { line: 10, character: 20 }
      }
    }]);
    assert.strictEqual(runtimeVscode.commandCalls.some(call => call.command === 'vscode.executeReferenceProvider'), true);
  });

  it('delegates rename edit building to the VS Code rename provider command', async () => {
    const expectedEdit = { edits: [] };
    const runtimeVscode = createFakeVscode({
      renameEdit: expectedEdit
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const edit = await service.buildRenameEdit(fakeUri('/Project/Assets/PlayerController.cs'), {
      line: 4,
      character: 12
    }, 'HeroController');

    assert.strictEqual(edit, expectedEdit);
    assert.strictEqual(runtimeVscode.commandCalls.some(call => call.command === 'vscode.executeDocumentRenameProvider'), true);
  });
});

interface FakeVscodeOptions {
  documentSymbols?: FakeDocumentSymbol[];
  throwDocumentSymbols?: boolean;
  documents?: Map<string, string>;
  references?: FakeLocation[];
  renameEdit?: unknown;
}

interface FakeVscode extends vscodeLike {
  commandCalls: { command: string; args: unknown[] }[];
}

interface vscodeLike {
  SymbolKind: {
    Class: number;
    Struct: number;
    Enum: number;
    Interface: number;
    Namespace: number;
  };
  Position: typeof FakePosition;
  commands: {
    executeCommand<T>(command: string, ...args: unknown[]): Promise<T>;
  };
  workspace: {
    openTextDocument(uri: FakeUri): Promise<{ getText(): string }>;
  };
}

interface FakeDocumentSymbol {
  name: string;
  kind: number;
  selectionRange: FakeRange;
  children: FakeDocumentSymbol[];
}

interface FakeLocation {
  uri: FakeUri;
  range: FakeRange;
}

interface FakeUri {
  fsPath: string;
  path: string;
  toString(): string;
}

class FakePosition {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class FakeRange {
  constructor(
    public readonly start: FakePosition,
    public readonly end: FakePosition
  ) {}
}

function createFakeVscode(options: FakeVscodeOptions): FakeVscode & typeof vscode {
  const commandCalls: { command: string; args: unknown[] }[] = [];
  const fake = {
    commandCalls,
    SymbolKind: {
      Class: 1,
      Struct: 2,
      Enum: 3,
      Interface: 4,
      Namespace: 5
    },
    Position: FakePosition,
    commands: {
      async executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
        commandCalls.push({ command, args });

        if (command === 'vscode.executeDocumentSymbolProvider') {
          if (options.throwDocumentSymbols) {
            throw new Error('Document symbols are not ready.');
          }
          return (options.documentSymbols ?? []) as T;
        }

        if (command === 'vscode.executeReferenceProvider') {
          return (options.references ?? []) as T;
        }

        if (command === 'vscode.executeDocumentRenameProvider') {
          return options.renameEdit as T;
        }

        throw new Error(`Unexpected command: ${command}`);
      }
    },
    workspace: {
      async openTextDocument(uri: FakeUri) {
        const text = options.documents?.get(uri.fsPath);
        if (text === undefined) {
          throw new Error(`Missing fake document: ${uri.fsPath}`);
        }

        return {
          getText: () => text
        };
      }
    }
  };

  return fake as FakeVscode & typeof vscode;
}

function namespaceSymbol(name: string, children: FakeDocumentSymbol[]): FakeDocumentSymbol {
  return {
    name,
    kind: 5,
    selectionRange: fakeRange(0, 0, 0, 0),
    children
  };
}

function typeSymbol(name: string, kind: number, line: number, character: number): FakeDocumentSymbol {
  return {
    name,
    kind,
    selectionRange: fakeRange(line, character, line, character + name.length),
    children: []
  };
}

function fakeUri(path: string): FakeUri & vscode.Uri {
  const uri = {
    fsPath: path,
    path,
    toString: () => path
  };

  return uri as FakeUri & vscode.Uri;
}

function fakeRange(startLine: number, startCharacter: number, endLine: number, endCharacter: number): FakeRange {
  return new FakeRange(
    new FakePosition(startLine, startCharacter),
    new FakePosition(endLine, endCharacter)
  );
}
