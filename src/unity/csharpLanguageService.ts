import type * as vscode from 'vscode';

export interface CSharpClassSnapshot {
  name: string;
  namespace?: string;
  position?: CSharpPosition;
  nameRange?: CSharpRange;
  isUnityObject?: boolean;
}

export interface CSharpPosition {
  line: number;
  character: number;
}

export interface CSharpRange {
  start: CSharpPosition;
  end: CSharpPosition;
}

export interface CSharpReferenceLocation {
  uriPath: string;
  range?: {
    start: CSharpPosition;
    end: CSharpPosition;
  };
}

export interface CSharpPrimaryClassOptions {
  includeUnityObject?: boolean;
}

export interface CSharpLanguageService {
  getPrimaryClass(uri: vscode.Uri, options?: CSharpPrimaryClassOptions): Promise<CSharpClassSnapshot | undefined>;
  findReferences(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpReferenceLocation[]>;
  buildRenameEdit(uri: vscode.Uri, position: CSharpPosition, newName: string): Promise<vscode.WorkspaceEdit | undefined>;
}

interface ClassSymbolCandidate {
  name: string;
  namespace?: string;
  position: vscode.Position;
  range: vscode.Range;
}

export function createVscodeCSharpLanguageService(runtimeVscode: typeof vscode): CSharpLanguageService {
  return {
    async getPrimaryClass(uri, options) {
      const classes = await getTopLevelClassSymbols(runtimeVscode, uri);
      if (classes.length !== 1) {
        return undefined;
      }

      const primaryClass = classes[0];
      const snapshot: CSharpClassSnapshot = {
        name: primaryClass.name,
        namespace: primaryClass.namespace,
        position: {
          line: primaryClass.position.line,
          character: primaryClass.position.character
        },
        nameRange: {
          start: {
            line: primaryClass.range.start.line,
            character: primaryClass.range.start.character
          },
          end: {
            line: primaryClass.range.end.line,
            character: primaryClass.range.end.character
          }
        }
      };

      if (options?.includeUnityObject) {
        snapshot.isUnityObject = await hasUnityObjectSupertype(runtimeVscode, uri, primaryClass.position);
      }

      return snapshot;
    },
    async findReferences(uri, position) {
      const references = await runtimeVscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        new runtimeVscode.Position(position.line, position.character)
      );

      return (references ?? []).map(reference => ({
        uriPath: reference.uri.fsPath,
        range: {
          start: {
            line: reference.range.start.line,
            character: reference.range.start.character
          },
          end: {
            line: reference.range.end.line,
            character: reference.range.end.character
          }
        }
      }));
    },
    async buildRenameEdit(uri, position, newName) {
      return await runtimeVscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
        'vscode.executeDocumentRenameProvider',
        uri,
        new runtimeVscode.Position(position.line, position.character),
        newName
      );
    }
  };
}

async function getTopLevelClassSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<ClassSymbolCandidate[]> {
  const symbols = await runtimeVscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
    'vscode.executeDocumentSymbolProvider',
    uri
  );

  const classes: ClassSymbolCandidate[] = [];
  for (const symbol of symbols ?? []) {
    collectTopLevelClassSymbols(runtimeVscode, symbol, [], classes);
  }

  return classes;
}

function collectTopLevelClassSymbols(
  runtimeVscode: typeof vscode,
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
  ancestors: readonly vscode.DocumentSymbol[],
  classes: ClassSymbolCandidate[]
): void {
  if (isSymbolInformation(symbol)) {
    if (symbol.kind === runtimeVscode.SymbolKind.Class) {
      classes.push({
        name: symbol.name,
        namespace: symbol.containerName,
        position: symbol.location.range.start,
        range: symbol.location.range
      });
    }
    return;
  }

  const hasClassAncestor = ancestors.some(ancestor => ancestor.kind === runtimeVscode.SymbolKind.Class);
  if (symbol.kind === runtimeVscode.SymbolKind.Class && !hasClassAncestor) {
    classes.push({
      name: symbol.name,
      namespace: findNearestNamespace(runtimeVscode, ancestors),
      position: symbol.selectionRange.start,
      range: symbol.selectionRange
    });
    return;
  }

  for (const child of symbol.children) {
    collectTopLevelClassSymbols(runtimeVscode, child, [...ancestors, symbol], classes);
  }
}

async function hasUnityObjectSupertype(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  position: vscode.Position
): Promise<boolean> {
  const items = await runtimeVscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    'vscode.prepareTypeHierarchy',
    uri,
    position
  );

  const queue = [...(items ?? [])];
  const visited = new Set<string>();

  // Walk the provider-owned hierarchy instead of guessing from source text.
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      continue;
    }

    const key = `${item.uri.toString()}:${item.range.start.line}:${item.range.start.character}:${item.name}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);

    if (isUnityObjectType(item)) {
      return true;
    }

    const supertypes = await runtimeVscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      'vscode.provideSupertypes',
      item
    );
    queue.push(...(supertypes ?? []));
  }

  return false;
}

function isUnityObjectType(item: vscode.TypeHierarchyItem): boolean {
  const detail = item.detail ?? '';
  return item.name === 'UnityEngine.Object' ||
    item.name === 'Object' && detail.includes('UnityEngine') ||
    item.name === 'MonoBehaviour' ||
    item.name === 'ScriptableObject';
}

function findNearestNamespace(runtimeVscode: typeof vscode, ancestors: readonly vscode.DocumentSymbol[]): string | undefined {
  const namespaceSymbol = [...ancestors]
    .reverse()
    .find(ancestor => ancestor.kind === runtimeVscode.SymbolKind.Namespace);
  return namespaceSymbol?.name;
}

function isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
  return 'location' in symbol;
}
