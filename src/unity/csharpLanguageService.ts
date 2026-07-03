import type * as vscode from 'vscode';

export type CSharpTopLevelTypeKind = 'class' | 'struct' | 'enum' | 'interface' | 'record';

export interface CSharpTopLevelTypeSnapshot {
  name: string;
  kind: CSharpTopLevelTypeKind;
  namespace?: string;
  position?: CSharpPosition;
  nameRange?: CSharpRange;
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

export interface CSharpLanguageService {
  getPrimaryTopLevelType(uri: vscode.Uri): Promise<CSharpTopLevelTypeSnapshot | undefined>;
  findReferences(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpReferenceLocation[]>;
  buildRenameEdit(uri: vscode.Uri, position: CSharpPosition, newName: string): Promise<vscode.WorkspaceEdit | undefined>;
}

interface TopLevelTypeSymbolCandidate {
  name: string;
  kind: CSharpTopLevelTypeKind;
  namespace?: string;
  position: vscode.Position;
  range: vscode.Range;
}

interface SourceTypeCandidate {
  name: string;
  kind: CSharpTopLevelTypeKind;
  namespace?: string;
  nameStart: number;
  nameEnd: number;
}

interface NamespaceRange {
  name: string;
  start: number;
  end: number;
  depth: number;
}

export function createVscodeCSharpLanguageService(runtimeVscode: typeof vscode): CSharpLanguageService {
  return {
    async getPrimaryTopLevelType(uri) {
      const sourceType = await getPrimaryTopLevelTypeFromSource(runtimeVscode, uri);
      if (sourceType !== 'fallback') {
        return sourceType;
      }

      const providerType = await getPrimaryTopLevelTypeFromSymbols(runtimeVscode, uri);
      return providerType === 'fallback' ? undefined : providerType;
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

async function getPrimaryTopLevelTypeFromSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTopLevelTypeSnapshot | 'fallback' | undefined> {
  let symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;

  try {
    symbols = await runtimeVscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );
  } catch {
    return 'fallback';
  }

  if (!symbols || symbols.length === 0) {
    return 'fallback';
  }

  const candidates: TopLevelTypeSymbolCandidate[] = [];
  for (const symbol of symbols) {
    collectTopLevelTypeSymbols(runtimeVscode, symbol, [], candidates);
  }

  if (candidates.length !== 1) {
    return undefined;
  }

  return createTypeSnapshot(candidates[0]);
}

function createTypeSnapshot(candidate: TopLevelTypeSymbolCandidate): CSharpTopLevelTypeSnapshot {
  return {
    name: candidate.name,
    kind: candidate.kind,
    namespace: candidate.namespace,
    position: {
      line: candidate.position.line,
      character: candidate.position.character
    },
    nameRange: {
      start: {
        line: candidate.range.start.line,
        character: candidate.range.start.character
      },
      end: {
        line: candidate.range.end.line,
        character: candidate.range.end.character
      }
    }
  };
}

function collectTopLevelTypeSymbols(
  runtimeVscode: typeof vscode,
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
  ancestors: readonly vscode.DocumentSymbol[],
  candidates: TopLevelTypeSymbolCandidate[]
): void {
  if (isSymbolInformation(symbol)) {
    const kind = getTopLevelTypeKind(runtimeVscode, symbol.kind);
    if (kind) {
      candidates.push({
        name: symbol.name,
        kind,
        namespace: symbol.containerName,
        position: symbol.location.range.start,
        range: symbol.location.range
      });
    }
    return;
  }

  const hasTypeAncestor = ancestors.some(ancestor => getTopLevelTypeKind(runtimeVscode, ancestor.kind));
  const kind = getTopLevelTypeKind(runtimeVscode, symbol.kind);
  if (kind && !hasTypeAncestor) {
    candidates.push({
      name: symbol.name,
      kind,
      namespace: findNearestNamespace(runtimeVscode, ancestors),
      position: symbol.selectionRange.start,
      range: symbol.selectionRange
    });
    return;
  }

  for (const child of symbol.children) {
    collectTopLevelTypeSymbols(runtimeVscode, child, [...ancestors, symbol], candidates);
  }
}

function getTopLevelTypeKind(
  runtimeVscode: typeof vscode,
  kind: vscode.SymbolKind
): CSharpTopLevelTypeKind | undefined {
  if (kind === runtimeVscode.SymbolKind.Class) {
    return 'class';
  }

  if (kind === runtimeVscode.SymbolKind.Struct) {
    return 'struct';
  }

  if (kind === runtimeVscode.SymbolKind.Enum) {
    return 'enum';
  }

  if (kind === runtimeVscode.SymbolKind.Interface) {
    return 'interface';
  }

  return undefined;
}

async function getPrimaryTopLevelTypeFromSource(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTopLevelTypeSnapshot | 'fallback' | undefined> {
  let source: string;

  try {
    const document = await runtimeVscode.workspace.openTextDocument(uri);
    source = document.getText();
  } catch {
    return 'fallback';
  }

  const masked = maskCommentsAndStrings(source);
  const lineStarts = buildLineStarts(source);
  const candidates = findSourceTopLevelTypes(masked);

  if (candidates.length !== 1) {
    return undefined;
  }

  const candidate = candidates[0];
  return {
    name: candidate.name,
    kind: candidate.kind,
    namespace: candidate.namespace,
    position: positionAt(lineStarts, candidate.nameStart),
    nameRange: {
      start: positionAt(lineStarts, candidate.nameStart),
      end: positionAt(lineStarts, candidate.nameEnd)
    }
  };
}

function findSourceTopLevelTypes(masked: string): SourceTypeCandidate[] {
  const namespaceRanges = findNamespaceRanges(masked);
  const typePattern = /\b(class|struct|enum|interface|record)\s+(?:(?:class|struct)\s+)?(@?[A-Za-z_][A-Za-z0-9_]*)/g;
  const candidates: SourceTypeCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(masked))) {
    const keyword = match[1] as CSharpTopLevelTypeKind;
    const kind = keyword === 'record' ? 'record' : keyword;
    const name = match[2];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const nameEnd = nameStart + name.length;
    const depth = getBraceDepthAt(masked, match.index);
    const activeNamespace = findActiveNamespace(namespaceRanges, match.index);

    // Only file-level or namespace-level types are allowed to drive file sync.
    if (activeNamespace) {
      if (depth !== activeNamespace.depth) {
        continue;
      }
    } else if (depth !== 0) {
      continue;
    }

    candidates.push({
      name: name.startsWith('@') ? name.slice(1) : name,
      kind,
      namespace: activeNamespace?.name,
      nameStart,
      nameEnd
    });
  }

  return candidates;
}

function findNamespaceRanges(masked: string): NamespaceRange[] {
  const ranges: NamespaceRange[] = [];
  const namespacePattern = /\bnamespace\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(\{|;)/g;
  let match: RegExpExecArray | null;

  while ((match = namespacePattern.exec(masked))) {
    const name = match[1].replace(/\s+/g, '');
    const delimiter = match[2];
    const namespaceStart = match.index + match[0].length;

    if (delimiter === ';') {
      ranges.push({
        name,
        start: namespaceStart,
        end: masked.length,
        depth: getBraceDepthAt(masked, namespaceStart)
      });
      continue;
    }

    const braceIndex = match.index + match[0].lastIndexOf('{');
    const closeBraceIndex = findMatchingBrace(masked, braceIndex);
    if (closeBraceIndex === undefined) {
      continue;
    }

    ranges.push({
      name,
      start: braceIndex + 1,
      end: closeBraceIndex,
      depth: getBraceDepthAt(masked, braceIndex + 1)
    });
  }

  return ranges;
}

function findActiveNamespace(ranges: readonly NamespaceRange[], index: number): NamespaceRange | undefined {
  return ranges
    .filter(range => range.start <= index && index < range.end)
    .sort((left, right) => right.start - left.start)[0];
}

function findMatchingBrace(text: string, openBraceIndex: number): number | undefined {
  let depth = 0;

  for (let index = openBraceIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function getBraceDepthAt(text: string, targetIndex: number): number {
  let depth = 0;

  for (let index = 0; index < targetIndex; index += 1) {
    const character = text[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth = Math.max(0, depth - 1);
    }
  }

  return depth;
}

function maskCommentsAndStrings(source: string): string {
  const characters = [...source];
  let index = 0;

  while (index < characters.length) {
    const current = characters[index];
    const next = characters[index + 1];

    if (current === '/' && next === '/') {
      index = maskUntilLineEnd(characters, index);
      continue;
    }

    if (current === '/' && next === '*') {
      index = maskBlockComment(characters, index);
      continue;
    }

    if (current === '@' && next === '"') {
      index = maskVerbatimString(characters, index);
      continue;
    }

    if (current === '$' && next === '@' && characters[index + 2] === '"') {
      index = maskVerbatimString(characters, index);
      continue;
    }

    if (current === '@' && next === '$' && characters[index + 2] === '"') {
      index = maskVerbatimString(characters, index);
      continue;
    }

    if (current === '"') {
      index = maskString(characters, index);
      continue;
    }

    if (current === '\'') {
      index = maskCharLiteral(characters, index);
      continue;
    }

    index += 1;
  }

  return characters.join('');
}

function maskUntilLineEnd(characters: string[], start: number): number {
  let index = start;
  while (index < characters.length && characters[index] !== '\n') {
    characters[index] = ' ';
    index += 1;
  }

  return index;
}

function maskBlockComment(characters: string[], start: number): number {
  let index = start;
  while (index < characters.length) {
    const current = characters[index];
    const next = characters[index + 1];
    characters[index] = current === '\n' ? '\n' : ' ';

    if (current === '*' && next === '/') {
      characters[index + 1] = ' ';
      return index + 2;
    }

    index += 1;
  }

  return index;
}

function maskString(characters: string[], start: number): number {
  let index = start + 1;
  characters[start] = ' ';

  while (index < characters.length) {
    const current = characters[index];
    characters[index] = current === '\n' ? '\n' : ' ';

    if (current === '\\') {
      if (index + 1 < characters.length) {
        characters[index + 1] = characters[index + 1] === '\n' ? '\n' : ' ';
      }
      index += 2;
      continue;
    }

    if (current === '"') {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function maskVerbatimString(characters: string[], start: number): number {
  let index = start;
  while (index < characters.length && characters[index] !== '"') {
    characters[index] = ' ';
    index += 1;
  }

  if (index < characters.length) {
    characters[index] = ' ';
    index += 1;
  }

  while (index < characters.length) {
    const current = characters[index];
    const next = characters[index + 1];
    characters[index] = current === '\n' ? '\n' : ' ';

    if (current === '"' && next === '"') {
      characters[index + 1] = ' ';
      index += 2;
      continue;
    }

    if (current === '"') {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function maskCharLiteral(characters: string[], start: number): number {
  let index = start + 1;
  characters[start] = ' ';

  while (index < characters.length) {
    const current = characters[index];
    characters[index] = current === '\n' ? '\n' : ' ';

    if (current === '\\') {
      if (index + 1 < characters.length) {
        characters[index + 1] = characters[index + 1] === '\n' ? '\n' : ' ';
      }
      index += 2;
      continue;
    }

    if (current === '\'') {
      return index + 1;
    }

    index += 1;
  }

  return index;
}

function buildLineStarts(source: string): number[] {
  const lineStarts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function positionAt(lineStarts: readonly number[], index: number): CSharpPosition {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const line = Math.max(0, high);
  return {
    line,
    character: index - lineStarts[line]
  };
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
