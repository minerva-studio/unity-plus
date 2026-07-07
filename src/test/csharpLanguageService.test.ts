import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createVscodeCSharpLanguageService } from '../unity/csharpLanguageService';

const symbolKind = {
  Namespace: 2,
  Class: 4,
  Method: 5,
  Field: 7,
  Enum: 9,
  Interface: 10,
  Struct: 22
};

/** Creates the minimal VS Code-like range shape used by the C# service. */
function fakeRange(line: number, startCharacter: number, endCharacter: number): vscode.Range {
  return {
    start: { line, character: startCharacter },
    end: { line, character: endCharacter }
  } as vscode.Range;
}

/** Creates a fake DocumentSymbol with only the provider fields consumed by the service. */
function fakeDocumentSymbol(
  name: string,
  kind: number,
  range: vscode.Range,
  children: vscode.DocumentSymbol[] = [],
  detail = ''
): vscode.DocumentSymbol {
  return {
    name,
    kind,
    detail,
    range,
    selectionRange: range,
    children
  } as vscode.DocumentSymbol;
}

/** Creates a fake SymbolInformation with only the provider fields consumed by the service. */
function fakeSymbolInformation(
  name: string,
  kind: number,
  containerName: string | undefined,
  range: vscode.Range
): vscode.SymbolInformation {
  return {
    name,
    kind,
    containerName,
    location: {
      uri: { fsPath: '/Project/Assets/Scripts/Interactable.cs' },
      range
    }
  } as vscode.SymbolInformation;
}

/** Creates a C# service backed by fixed fake document symbols. */
function createServiceWithSymbols(
  symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  workspaceSymbols: vscode.SymbolInformation[] = [],
  hoverTextByName: Record<string, string> = {}
) {
  return createVscodeCSharpLanguageService({
    SymbolKind: symbolKind,
    workspace: {
      openTextDocument: async (uri: vscode.Uri) => ({ uri })
    },
    Position: class {
      constructor(public readonly line: number, public readonly character: number) {}
    },
    Range: class {
      constructor(public readonly start: vscode.Position, public readonly end: vscode.Position) {}
    },
    MarkdownString: class {
      constructor(public readonly value: string) {}
    },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        if (command === 'vscode.executeDocumentSymbolProvider') {
          return symbols;
        }

        if (command === 'vscode.executeWorkspaceSymbolProvider') {
          const [query] = args as [string];
          return workspaceSymbols.filter(symbol => symbol.name.toLowerCase().includes(query.toLowerCase()));
        }

        if (command === 'vscode.executeHoverProvider') {
          const [uri, position] = args as [vscode.Uri, vscode.Position];
          const symbol = workspaceSymbols.find(candidate =>
            candidate.location.uri.fsPath === uri.fsPath &&
            candidate.location.range.start.line === position.line &&
            candidate.location.range.start.character === position.character
          );
          const value = symbol ? hoverTextByName[symbol.name] : undefined;
          return value ? [{ contents: [{ value }] }] : [];
        }

        if (command === 'vscode.prepareTypeHierarchy') {
          const [, position] = args as [vscode.Uri, vscode.Position];
          const symbol = workspaceSymbols.find(candidate =>
            candidate.location.range.start.line === position.line &&
            candidate.location.range.start.character === position.character
          );
          return symbol ? [{
            name: symbol.name,
            detail: 'Amlos.Control.Interact',
            uri: symbol.location.uri,
            range: symbol.location.range,
            selectionRange: symbol.location.range
          }] : [];
        }

        if (command === 'vscode.provideSupertypes') {
          const [item] = args as [vscode.TypeHierarchyItem];
          return item.name === 'Interactable' ? [{
            name: 'Object',
            detail: 'UnityEngine',
            uri: item.uri,
            range: item.range,
            selectionRange: item.selectionRange
          }] : [];
        }

        assert.fail(`Unexpected VS Code command: ${command}`);
      }
    }
  } as unknown as typeof vscode);
}

describe('csharpLanguageService', () => {
  it('normalizes DocumentSymbol snapshots from C# provider namespace trees', async () => {
    const methodRange = fakeRange(7, 20, 28);
    const symbols = [
      fakeDocumentSymbol('Amlos.Control.Interact.', symbolKind.Namespace, fakeRange(1, 0, 24), [
        fakeDocumentSymbol('Interactable', symbolKind.Class, fakeRange(3, 24, 36), [
          fakeDocumentSymbol('OnCheckEnable', symbolKind.Field, fakeRange(5, 26, 39), [], 'UnityEvent'),
          fakeDocumentSymbol('Interact(bool value)', symbolKind.Method, methodRange)
        ])
      ])
    ];
    const service = createServiceWithSymbols(symbols);
    const uri = { fsPath: '/Project/Assets/Scripts/Interactable.cs' } as vscode.Uri;

    const primaryType = await service.getPrimaryTopLevelType(uri);
    const types = await service.findTypes(uri);
    const fields = await service.findUnityEventFields(uri);
    const methods = await service.findMethods(uri);
    const targets = await service.findTargetMethodPosition(uri, 'Amlos.Control.Interact.Interactable', 'Interact');

    assert.strictEqual(primaryType?.namespace, 'Amlos.Control.Interact');
    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Control.Interact.Interactable']);
    assert.strictEqual(fields[0]?.typeName, 'Amlos.Control.Interact.Interactable');
    assert.strictEqual(methods[0]?.name, 'Interact');
    assert.strictEqual(methods[0]?.typeName, 'Amlos.Control.Interact.Interactable');
    assert.deepStrictEqual(targets, [{ line: 7, character: 20 }]);
  });

  it('normalizes SymbolInformation snapshots from C# provider containers', async () => {
    const symbols = [
      fakeSymbolInformation('Interactable', symbolKind.Class, 'Amlos.Control.Interact.', fakeRange(3, 24, 36)),
      fakeSymbolInformation('Interact(bool value)', symbolKind.Method, 'Amlos.Control.Interact.Interactable.', fakeRange(7, 20, 28))
    ];
    const service = createServiceWithSymbols(symbols);
    const uri = { fsPath: '/Project/Assets/Scripts/Interactable.cs' } as vscode.Uri;

    const types = await service.findTypes(uri);
    const methods = await service.findMethods(uri);
    const targets = await service.findTargetMethodPosition(uri, 'Amlos.Control.Interact.Interactable', 'Interact');

    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Control.Interact.Interactable']);
    assert.strictEqual(methods[0]?.name, 'Interact');
    assert.strictEqual(methods[0]?.typeName, 'Amlos.Control.Interact.Interactable');
    assert.deepStrictEqual(targets, [{ line: 7, character: 20 }]);
  });

  it('rejects namespace-only provider symbols as incomplete C# semantics', async () => {
    const symbols = [
      fakeDocumentSymbol('Amlos.Control.Interact.', symbolKind.Namespace, fakeRange(1, 0, 24))
    ];
    const service = createServiceWithSymbols(symbols);
    const uri = { fsPath: '/Project/Assets/Scripts/Interactable.cs' } as vscode.Uri;

    await assert.rejects(
      async () => await service.findTypes(uri),
      /namespace-only symbols/
    );
  });

});
