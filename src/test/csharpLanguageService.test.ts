import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createVscodeCSharpLanguageService } from '../unity/csharpLanguageService';

describe('csharpLanguageService', () => {
  it('returns the single top-level class from document symbols', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [
        namespaceSymbol('Minerva.Gameplay', [
          classSymbol('PlayerController', 4, 12)
        ])
      ]
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryClass = await service.getPrimaryClass(fakeUri('/Project/Assets/PlayerController.cs'));

    assert.strictEqual(primaryClass?.name, 'PlayerController');
    assert.strictEqual(primaryClass?.namespace, 'Minerva.Gameplay');
    assert.deepStrictEqual(primaryClass?.position, { line: 4, character: 12 });
  });

  it('returns undefined when document symbols contain multiple top-level classes', async () => {
    const runtimeVscode = createFakeVscode({
      documentSymbols: [
        classSymbol('FirstUtility', 1, 0),
        classSymbol('SecondUtility', 5, 0)
      ]
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryClass = await service.getPrimaryClass(fakeUri('/Project/Assets/Utilities.cs'));

    assert.strictEqual(primaryClass, undefined);
  });

  it('marks a class as a Unity object when type hierarchy reaches UnityEngine.Object', async () => {
    const classItem = typeHierarchyItem('PlayerController', '');
    const monoBehaviourItem = typeHierarchyItem('MonoBehaviour', 'UnityEngine');
    const objectItem = typeHierarchyItem('Object', 'UnityEngine');
    const runtimeVscode = createFakeVscode({
      documentSymbols: [classSymbol('PlayerController', 4, 12)],
      typeHierarchyItems: [classItem],
      supertypesByName: new Map([
        ['PlayerController', [monoBehaviourItem]],
        ['MonoBehaviour', [objectItem]]
      ])
    });
    const service = createVscodeCSharpLanguageService(runtimeVscode);

    const primaryClass = await service.getPrimaryClass(fakeUri('/Project/Assets/PlayerController.cs'), {
      includeUnityObject: true
    });

    assert.strictEqual(primaryClass?.isUnityObject, true);
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
  typeHierarchyItems?: FakeTypeHierarchyItem[];
  supertypesByName?: Map<string, FakeTypeHierarchyItem[]>;
  references?: FakeLocation[];
  renameEdit?: unknown;
}

interface FakeVscode extends vscodeLike {
  commandCalls: { command: string; args: unknown[] }[];
}

interface vscodeLike {
  SymbolKind: {
    Class: number;
    Namespace: number;
  };
  Position: typeof FakePosition;
  commands: {
    executeCommand<T>(command: string, ...args: unknown[]): Promise<T>;
  };
}

interface FakeDocumentSymbol {
  name: string;
  kind: number;
  selectionRange: FakeRange;
  children: FakeDocumentSymbol[];
}

interface FakeTypeHierarchyItem {
  name: string;
  detail: string;
  uri: FakeUri;
  range: FakeRange;
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
      Namespace: 2
    },
    Position: FakePosition,
    commands: {
      async executeCommand<T>(command: string, ...args: unknown[]): Promise<T> {
        commandCalls.push({ command, args });

        if (command === 'vscode.executeDocumentSymbolProvider') {
          return (options.documentSymbols ?? []) as T;
        }

        if (command === 'vscode.prepareTypeHierarchy') {
          return (options.typeHierarchyItems ?? []) as T;
        }

        if (command === 'vscode.provideSupertypes') {
          const item = args[0] as FakeTypeHierarchyItem;
          return (options.supertypesByName?.get(item.name) ?? []) as T;
        }

        if (command === 'vscode.executeReferenceProvider') {
          return (options.references ?? []) as T;
        }

        if (command === 'vscode.executeDocumentRenameProvider') {
          return options.renameEdit as T;
        }

        throw new Error(`Unexpected command: ${command}`);
      }
    }
  };

  return fake as FakeVscode & typeof vscode;
}

function namespaceSymbol(name: string, children: FakeDocumentSymbol[]): FakeDocumentSymbol {
  return {
    name,
    kind: 2,
    selectionRange: fakeRange(0, 0, 0, 0),
    children
  };
}

function classSymbol(name: string, line: number, character: number): FakeDocumentSymbol {
  return {
    name,
    kind: 1,
    selectionRange: fakeRange(line, character, line, character + name.length),
    children: []
  };
}

function typeHierarchyItem(name: string, detail: string): FakeTypeHierarchyItem {
  return {
    name,
    detail,
    uri: fakeUri(`/metadata/${name}.cs`),
    range: fakeRange(0, 0, 0, name.length)
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
