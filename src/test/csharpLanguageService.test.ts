import * as assert from 'assert';
import type * as vscode from 'vscode';
import { createVscodeCSharpLanguageService } from '../unity/csharpLanguageService';

describe('csharpLanguageService', () => {
  it('opens a document before requesting document symbols', async () => {
    const calls: string[] = [];
    const runtime = createFakeVscodeRuntime(calls, [
      createDocumentSymbol('Gate', 4, 0, 13, 0, 17)
    ]);
    const service = createVscodeCSharpLanguageService(runtime);

    const types = await service.findTypes(createUri('/Project/Assets/Gate.cs'));

    assert.deepStrictEqual(types.map(type => type.fullName), ['Gate']);
    assert.deepStrictEqual(calls, [
      'workspace.openTextDocument:/Project/Assets/Gate.cs',
      'commands.executeCommand:vscode.executeDocumentSymbolProvider:/Project/Assets/Gate.cs'
    ]);
  });

  it('finds types from C# server symbols for an unopened file', async () => {
    const calls: string[] = [];
    const runtime = createFakeVscodeRuntime(calls, [
      createDocumentSymbol('Amlos.Fixtures', 3, 0, 10, 0, 24, [
        createDocumentSymbol('Gate', 4, 1, 13, 1, 17)
      ])
    ]);
    const service = createVscodeCSharpLanguageService(runtime);

    const types = await service.findTypes(createUri('/Project/Assets/Gate.cs'));

    assert.deepStrictEqual(types, [{
      name: 'Gate',
      fullName: 'Amlos.Fixtures.Gate',
      range: {
        start: { line: 1, character: 13 },
        end: { line: 1, character: 17 }
      }
    }]);
  });

  it('uses the shared symbol path for the primary top-level type', async () => {
    const calls: string[] = [];
    const runtime = createFakeVscodeRuntime(calls, [
      createDocumentSymbol('Gate', 4, 0, 13, 0, 17)
    ]);
    const service = createVscodeCSharpLanguageService(runtime);

    const primaryType = await service.getPrimaryTopLevelType(createUri('/Project/Assets/Gate.cs'));

    assert.strictEqual(primaryType?.name, 'Gate');
    assert.deepStrictEqual(calls, [
      'workspace.openTextDocument:/Project/Assets/Gate.cs',
      'commands.executeCommand:vscode.executeDocumentSymbolProvider:/Project/Assets/Gate.cs'
    ]);
  });

  it('falls back to source symbols when the C# server returns no document symbols', async () => {
    const calls: string[] = [];
    const runtime = createFakeVscodeRuntime(calls, [], [
      'namespace Amlos.Control.Interact',
      '{',
      '  public sealed class Interactable : MonoBehaviour',
      '  {',
      '    public UnityEvent<ResultArg<bool>> OnCheckEnable = new();',
      '    public void Interact() {}',
      '  }',
      '}'
    ].join('\n'));
    const service = createVscodeCSharpLanguageService(runtime);
    const uri = createUri('/Project/Assets/Interactable.cs');

    const types = await service.findTypes(uri);
    const methods = await service.findMethods(uri);
    const fields = await service.findUnityEventFields(uri);
    const targets = await service.findTargetMethodPosition(uri, 'Amlos.Control.Interact.Interactable', 'Interact');

    assert.deepStrictEqual(types.map(type => type.fullName), ['Amlos.Control.Interact.Interactable']);
    assert.deepStrictEqual(methods.map(method => method.name), ['Interact']);
    assert.deepStrictEqual(fields.map(field => field.name), ['OnCheckEnable']);
    assert.deepStrictEqual(targets, [{ line: 5, character: 16 }]);
  });

  it('throws when neither C# server symbols nor source text are available', async () => {
    const calls: string[] = [];
    const runtime = createFakeVscodeRuntime(calls, undefined, '', true);
    const service = createVscodeCSharpLanguageService(runtime);

    await assert.rejects(
      async () => await service.findTypes(createUri('/Project/Assets/Missing.cs')),
      /C# symbols and source text are unavailable/
    );
  });
});

/** Creates the smallest VS Code runtime surface needed by the C# language service. */
function createFakeVscodeRuntime(
  calls: string[],
  symbols: vscode.DocumentSymbol[] | undefined,
  sourceText = '',
  throwOpenTextDocument = false
): typeof vscode {
  return {
    workspace: {
      openTextDocument: async (uri: vscode.Uri) => {
        if (throwOpenTextDocument) {
          throw new Error('document unavailable');
        }

        calls.push(`workspace.openTextDocument:${uri.fsPath}`);
        return {
          uri,
          getText: () => sourceText
        } as vscode.TextDocument;
      }
    },
    commands: {
      executeCommand: async (command: string, ...args: unknown[]) => {
        const [uri] = args as [vscode.Uri];
        calls.push(`commands.executeCommand:${command}:${uri.fsPath}`);
        assert.strictEqual(calls.at(-2), `workspace.openTextDocument:${uri.fsPath}`);
        if (symbols === undefined) {
          throw new Error('symbols unavailable');
        }

        return symbols;
      }
    },
    Position: FakePosition,
    Range: FakeRange,
    SymbolKind: {
      Namespace: 3,
      Class: 4,
      Method: 5,
      Field: 7,
      Enum: 9,
      Interface: 10,
      Struct: 22
    }
  } as unknown as typeof vscode;
}

/** Creates a fake DocumentSymbol with VS Code-like range properties. */
function createDocumentSymbol(
  name: string,
  kind: number,
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
  children: vscode.DocumentSymbol[] = []
): vscode.DocumentSymbol {
  const range = new FakeRange(
    new FakePosition(startLine, startCharacter) as unknown as vscode.Position,
    new FakePosition(endLine, endCharacter) as unknown as vscode.Position
  ) as unknown as vscode.Range;

  return {
    name,
    detail: '',
    kind,
    range,
    selectionRange: range,
    children
  } as vscode.DocumentSymbol;
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

class FakePosition {
  /** Stores the zero-based line and character used by symbol snapshots. */
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

class FakeRange {
  /** Stores the start and end positions used by symbol snapshots. */
  constructor(
    public readonly start: vscode.Position,
    public readonly end: vscode.Position
  ) {}
}
