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

export interface CSharpMethodSymbolSnapshot {
  name: string;
  typeName?: string;
  range: CSharpRange;
}

export interface CSharpFieldSymbolSnapshot {
  name: string;
  typeName?: string;
  range: CSharpRange;
}

export interface CSharpTypeSymbolSnapshot {
  name: string;
  fullName: string;
  range: CSharpRange;
}

export interface CSharpLanguageService {
  getPrimaryTopLevelType(uri: vscode.Uri): Promise<CSharpTopLevelTypeSnapshot | undefined>;
  findReferences(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpReferenceLocation[]>;
  buildRenameEdit(uri: vscode.Uri, position: CSharpPosition, newName: string): Promise<vscode.WorkspaceEdit | undefined>;
}

export interface CSharpSymbolLanguageService extends CSharpLanguageService {
  findMethods(uri: vscode.Uri): Promise<CSharpMethodSymbolSnapshot[]>;
  findTypes(uri: vscode.Uri): Promise<CSharpTypeSymbolSnapshot[]>;
  findUnityEventFields(uri: vscode.Uri): Promise<CSharpFieldSymbolSnapshot[]>;
  findMethodAtPosition(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpMethodSymbolSnapshot | undefined>;
  findUnityEventFieldAtPosition(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpFieldSymbolSnapshot | undefined>;
  findTargetMethodPosition(uri: vscode.Uri, targetTypeName: string, methodName: string): Promise<CSharpPosition[]>;
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
  bodyStart?: number;
  bodyEnd?: number;
}

interface NamespaceRange {
  name: string;
  start: number;
  end: number;
  depth: number;
}

export function createVscodeCSharpLanguageService(runtimeVscode: typeof vscode): CSharpSymbolLanguageService {
  return {
    async getPrimaryTopLevelType(uri) {
      const providerType = await getPrimaryTopLevelTypeFromSymbols(runtimeVscode, uri);
      if (providerType !== 'fallback') {
        return providerType;
      }

      const sourceType = await getPrimaryTopLevelTypeFromSource(runtimeVscode, uri);
      return sourceType === 'fallback' ? undefined : sourceType;
    },
    async findMethods(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      if (!symbols?.length) {
        return await findSourceMethodsOrThrow(runtimeVscode, uri);
      }

      const methods: CSharpMethodSymbolSnapshot[] = [];
      collectCSharpMethodSymbols(runtimeVscode, symbols, [], methods);
      return await refineMethodRangesFromSource(runtimeVscode, uri, methods);
    },
    async findTypes(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      if (!symbols?.length) {
        return await findSourceTypesOrThrow(runtimeVscode, uri);
      }

      const types: CSharpTypeSymbolSnapshot[] = [];
      collectCSharpTypeSymbols(runtimeVscode, symbols, [], types);
      return await refineTypeRangesFromSource(runtimeVscode, uri, types);
    },
    async findUnityEventFields(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      if (!symbols?.length) {
        return await findSourceUnityEventFieldsOrThrow(runtimeVscode, uri);
      }

      const fields: CSharpFieldSymbolSnapshot[] = [];
      collectUnityEventFieldSymbols(runtimeVscode, symbols, [], fields);
      if (fields.length === 0) {
        return await findSourceUnityEventFieldsOrThrow(runtimeVscode, uri);
      }

      return await refineFieldRangesFromSource(runtimeVscode, uri, fields);
    },
    async findMethodAtPosition(uri, position) {
      return (await this.findMethods(uri)).find(method => containsCSharpPosition(method.range, position));
    },
    async findUnityEventFieldAtPosition(uri, position) {
      return (await this.findUnityEventFields(uri)).find(field => containsCSharpPosition(field.range, position));
    },
    async findTargetMethodPosition(uri, targetTypeName, methodName) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      if (!symbols?.length) {
        return await findSourceTargetMethodPositionsOrThrow(runtimeVscode, uri, targetTypeName, methodName);
      }

      const positions: CSharpPosition[] = [];
      collectTargetMethodSymbolPositions(runtimeVscode, symbols, targetTypeName, methodName, positions);
      const sourcePositions = await tryFindSourceTargetMethodPositions(runtimeVscode, uri, targetTypeName, methodName);
      if (sourcePositions?.length) {
        return sourcePositions;
      }

      return positions;
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

/** Reads C# symbols from the active language server after loading the document in VS Code. */
async function getDocumentSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined> {
  try {
    const document = await runtimeVscode.workspace.openTextDocument(uri);
    return await runtimeVscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    ) ?? [];
  } catch {
    return undefined;
  }
}

/** Collects method symbols and annotates each method with its nearest containing type. */
function collectCSharpMethodSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly vscode.DocumentSymbol[],
  methods: CSharpMethodSymbolSnapshot[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      if (symbol.kind === runtimeVscode.SymbolKind.Method) {
        methods.push({
          name: normalizeCSharpSymbolName(symbol.name),
          typeName: symbol.containerName,
          range: toCSharpRange(symbol.location.range)
        });
      }
      continue;
    }

    if (symbol.kind === runtimeVscode.SymbolKind.Method) {
      methods.push({
        name: normalizeCSharpSymbolName(symbol.name),
        typeName: findNearestTypeName(runtimeVscode, ancestors),
        range: toCSharpRange(symbol.selectionRange)
      });
    }

    collectCSharpMethodSymbols(runtimeVscode, symbol.children, [...ancestors, symbol], methods);
  }
}

/** Collects type symbols from language-server document symbols. */
function collectCSharpTypeSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly vscode.DocumentSymbol[],
  types: CSharpTypeSymbolSnapshot[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      if (getTopLevelTypeKind(runtimeVscode, symbol.kind)) {
        types.push({
          name: normalizeCSharpSymbolName(symbol.name),
          fullName: symbol.containerName
            ? `${symbol.containerName}.${normalizeCSharpSymbolName(symbol.name)}`
            : normalizeCSharpSymbolName(symbol.name),
          range: toCSharpRange(symbol.location.range)
        });
      }
      continue;
    }

    if (getTopLevelTypeKind(runtimeVscode, symbol.kind)) {
      const name = normalizeCSharpSymbolName(symbol.name);
      const namespaceName = findNearestNamespace(runtimeVscode, ancestors);
      types.push({
        name,
        fullName: namespaceName ? `${namespaceName}.${name}` : name,
        range: toCSharpRange(symbol.selectionRange)
      });
    }

    collectCSharpTypeSymbols(runtimeVscode, symbol.children, [...ancestors, symbol], types);
  }
}

/** Collects UnityEvent field symbols using the type/detail supplied by the C# language server. */
function collectUnityEventFieldSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly vscode.DocumentSymbol[],
  fields: CSharpFieldSymbolSnapshot[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      continue;
    }

    if (symbol.kind === runtimeVscode.SymbolKind.Field && isUnityEventSymbol(symbol)) {
      fields.push({
        name: normalizeCSharpSymbolName(symbol.name),
        typeName: findNearestTypeName(runtimeVscode, ancestors),
        range: toCSharpRange(symbol.selectionRange)
      });
    }

    collectUnityEventFieldSymbols(runtimeVscode, symbol.children, [...ancestors, symbol], fields);
  }
}

/** Collects ALL matching method positions inside the type named by Unity YAML
 *  metadata.  Avoiding the first overload / partial candidate prevents false
 *  locations when the target type declares multiple same-name methods. */
function collectTargetMethodSymbolPositions(
  runtimeVscode: typeof vscode,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  targetTypeName: string,
  methodName: string,
  positions: CSharpPosition[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      if (symbol.kind === runtimeVscode.SymbolKind.Method &&
        normalizeCSharpSymbolName(symbol.name) === methodName &&
        symbol.containerName &&
        matchesCSharpTypeName(symbol.containerName, targetTypeName)) {
        positions.push(toCSharpPosition(symbol.location.range.start));
      }
      continue;
    }

    if (getTopLevelTypeKind(runtimeVscode, symbol.kind) && matchesCSharpTypeName(symbol.name, targetTypeName)) {
      collectMethodSymbolsInType(runtimeVscode, symbol, methodName, positions);
      continue; // Found the target type — don't recurse further into other types
    }

    collectTargetMethodSymbolPositions(runtimeVscode, symbol.children, targetTypeName, methodName, positions);
  }
}

/** Collects all method symbols with the given name inside a type symbol subtree. */
function collectMethodSymbolsInType(
  runtimeVscode: typeof vscode,
  typeSymbol: vscode.DocumentSymbol,
  methodName: string,
  positions: CSharpPosition[]
): void {
  for (const child of typeSymbol.children) {
    if (child.kind === runtimeVscode.SymbolKind.Method && normalizeCSharpSymbolName(child.name) === methodName) {
      positions.push(toCSharpPosition(child.selectionRange.start));
    }

    collectMethodSymbolsInType(runtimeVscode, child, methodName, positions);
  }
}

/** Checks symbol metadata for UnityEvent-typed fields. */
function isUnityEventSymbol(symbol: vscode.DocumentSymbol): boolean {
  return /\bUnityEvent\b/.test(symbol.detail);
}

/** Finds the nearest type ancestor for method and field symbols. */
function findNearestTypeName(runtimeVscode: typeof vscode, ancestors: readonly vscode.DocumentSymbol[]): string | undefined {
  const typeSymbol = [...ancestors]
    .reverse()
    .find(ancestor => getTopLevelTypeKind(runtimeVscode, ancestor.kind));
  if (!typeSymbol) {
    return undefined;
  }

  const namespaceName = findNearestNamespace(runtimeVscode, ancestors);
  return namespaceName ? `${namespaceName}.${normalizeCSharpSymbolName(typeSymbol.name)}` : normalizeCSharpSymbolName(typeSymbol.name);
}

/** Converts VS Code ranges into the language-service-neutral range shape. */
function toCSharpRange(range: vscode.Range): CSharpRange {
  return {
    start: toCSharpPosition(range.start),
    end: toCSharpPosition(range.end)
  };
}

/** Converts VS Code positions into the language-service-neutral position shape. */
function toCSharpPosition(position: vscode.Position): CSharpPosition {
  return {
    line: position.line,
    character: position.character
  };
}

/** Checks whether a C# position lies within a symbol name range. */
function containsCSharpPosition(range: CSharpRange, position: CSharpPosition): boolean {
  return range.start.line === position.line &&
    range.start.character <= position.character &&
    position.character <= range.end.character;
}

/** Removes language-server display suffixes such as method parameter lists. */
function normalizeCSharpSymbolName(name: string): string {
  return name.replace(/\s*\(.*$/, '');
}

/** Compares full or short C# type names case-insensitively. */
function matchesCSharpTypeName(symbolTypeName: string, targetTypeName: string): boolean {
  return csharpSymbolKey(symbolTypeName) === csharpSymbolKey(targetTypeName) ||
    csharpSymbolKey(shortCSharpTypeName(symbolTypeName)) === csharpSymbolKey(shortCSharpTypeName(targetTypeName));
}

/** Returns the final segment of a namespace-qualified C# type name. */
function shortCSharpTypeName(typeName: string): string {
  return typeName.split('.').at(-1) ?? typeName;
}

/** Normalizes C# symbol names for case-insensitive comparisons. */
function csharpSymbolKey(value: string): string {
  return value.toLowerCase();
}

/** Parses source types when document symbols are unavailable but the text can still be read. */
async function findSourceTypesOrThrow(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTypeSymbolSnapshot[]> {
  const source = await readSourceTextOrThrow(runtimeVscode, uri);
  const masked = maskCommentsAndStrings(source);
  const lineStarts = buildLineStarts(source);
  return findSourceTopLevelTypes(masked).map(type => ({
    name: type.name,
    fullName: type.namespace ? `${type.namespace}.${type.name}` : type.name,
    range: sourceRangeAt(lineStarts, type.nameStart, type.nameEnd)
  }));
}

/** Parses source methods only after the C# server cannot provide document symbols. */
async function findSourceMethodsOrThrow(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpMethodSymbolSnapshot[]> {
  const source = await readSourceTextOrThrow(runtimeVscode, uri);
  const masked = maskCommentsAndStrings(source);
  const lineStarts = buildLineStarts(source);
  const methods: CSharpMethodSymbolSnapshot[] = [];

  for (const type of findSourceTopLevelTypes(masked)) {
    if (type.bodyStart === undefined || type.bodyEnd === undefined) {
      continue;
    }

    for (const member of findSourceMethodMembers(masked, type.bodyStart, type.bodyEnd)) {
      methods.push({
        name: member.name,
        typeName: type.namespace ? `${type.namespace}.${type.name}` : type.name,
        range: sourceRangeAt(lineStarts, member.nameStart, member.nameEnd)
      });
    }
  }

  return methods;
}

/** Parses UnityEvent fields from source when symbol metadata is not available. */
async function findSourceUnityEventFieldsOrThrow(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpFieldSymbolSnapshot[]> {
  const source = await readSourceTextOrThrow(runtimeVscode, uri);
  const masked = maskCommentsAndStrings(source);
  const lineStarts = buildLineStarts(source);
  const fields: CSharpFieldSymbolSnapshot[] = [];

  for (const type of findSourceTopLevelTypes(masked)) {
    if (type.bodyStart === undefined || type.bodyEnd === undefined) {
      continue;
    }

    for (const member of findSourceUnityEventFieldMembers(masked, type.bodyStart, type.bodyEnd)) {
      fields.push({
        name: member.name,
        typeName: type.namespace ? `${type.namespace}.${type.name}` : type.name,
        range: sourceRangeAt(lineStarts, member.nameStart, member.nameEnd)
      });
    }
  }

  return fields;
}

/** Parses target method declarations from source after server symbols fail. */
async function findSourceTargetMethodPositionsOrThrow(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  targetTypeName: string,
  methodName: string
): Promise<CSharpPosition[]> {
  const source = await readSourceTextOrThrow(runtimeVscode, uri);
  const masked = maskCommentsAndStrings(source);
  const lineStarts = buildLineStarts(source);
  const positions: CSharpPosition[] = [];

  for (const type of findSourceTopLevelTypes(masked)) {
    const fullName = type.namespace ? `${type.namespace}.${type.name}` : type.name;
    if (type.bodyStart === undefined || type.bodyEnd === undefined || !matchesCSharpTypeName(fullName, targetTypeName)) {
      continue;
    }

    for (const member of findSourceMethodMembers(masked, type.bodyStart, type.bodyEnd)) {
      if (member.name === methodName) {
        positions.push(positionAt(lineStarts, member.nameStart));
      }
    }
  }

  return positions;
}

/** Refines server type ranges to exact source name ranges when source text is available. */
async function refineTypeRangesFromSource(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  types: readonly CSharpTypeSymbolSnapshot[]
): Promise<CSharpTypeSymbolSnapshot[]> {
  const sourceTypes = await tryFindSourceTypes(runtimeVscode, uri);
  if (!sourceTypes?.length) {
    return [...types];
  }

  return types.map(type => {
    const sourceType = sourceTypes.find(candidate =>
      matchesCSharpTypeName(candidate.fullName, type.fullName) ||
      matchesCSharpTypeName(candidate.name, type.name)
    );
    return sourceType ? {
      ...type,
      name: sourceType.name,
      fullName: sourceType.fullName,
      range: sourceType.range
    } : type;
  });
}

/** Refines server method ranges to exact source name ranges when source text is available. */
async function refineMethodRangesFromSource(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  methods: readonly CSharpMethodSymbolSnapshot[]
): Promise<CSharpMethodSymbolSnapshot[]> {
  const sourceMethods = await tryFindSourceMethods(runtimeVscode, uri);
  if (!sourceMethods?.length) {
    return [...methods];
  }

  return methods.map(method => {
    const sourceMethod = sourceMethods.find(candidate =>
      candidate.name === method.name &&
      (!method.typeName || !candidate.typeName || matchesCSharpTypeName(candidate.typeName, method.typeName))
    );
    return sourceMethod ? { ...method, range: sourceMethod.range } : method;
  });
}

/** Refines server field ranges to exact source name ranges when source text is available. */
async function refineFieldRangesFromSource(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  fields: readonly CSharpFieldSymbolSnapshot[]
): Promise<CSharpFieldSymbolSnapshot[]> {
  const sourceFields = await tryFindSourceUnityEventFields(runtimeVscode, uri);
  if (!sourceFields?.length) {
    return [...fields];
  }

  return fields.map(field => {
    const sourceField = sourceFields.find(candidate =>
      candidate.name === field.name &&
      (!field.typeName || !candidate.typeName || matchesCSharpTypeName(candidate.typeName, field.typeName))
    );
    return sourceField ? { ...field, range: sourceField.range } : field;
  });
}

/** Reads source types when available without turning unavailable source into a failure. */
async function tryFindSourceTypes(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTypeSymbolSnapshot[] | undefined> {
  try {
    return await findSourceTypesOrThrow(runtimeVscode, uri);
  } catch {
    return undefined;
  }
}

/** Reads source methods when available without turning unavailable source into a failure. */
async function tryFindSourceMethods(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpMethodSymbolSnapshot[] | undefined> {
  try {
    return await findSourceMethodsOrThrow(runtimeVscode, uri);
  } catch {
    return undefined;
  }
}

/** Reads source UnityEvent fields when available without turning unavailable source into a failure. */
async function tryFindSourceUnityEventFields(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpFieldSymbolSnapshot[] | undefined> {
  try {
    return await findSourceUnityEventFieldsOrThrow(runtimeVscode, uri);
  } catch {
    return undefined;
  }
}

/** Reads source target positions when available without turning unavailable source into a failure. */
async function tryFindSourceTargetMethodPositions(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  targetTypeName: string,
  methodName: string
): Promise<CSharpPosition[] | undefined> {
  try {
    return await findSourceTargetMethodPositionsOrThrow(runtimeVscode, uri, targetTypeName, methodName);
  } catch {
    return undefined;
  }
}

/** Reads source text or throws so callers can distinguish unavailable symbols from a real empty result. */
async function readSourceTextOrThrow(runtimeVscode: typeof vscode, uri: vscode.Uri): Promise<string> {
  try {
    return (await runtimeVscode.workspace.openTextDocument(uri)).getText();
  } catch (error) {
    throw new Error(`C# symbols and source text are unavailable for ${uri.fsPath}: ${String(error)}`);
  }
}

interface SourceMemberCandidate {
  name: string;
  nameStart: number;
  nameEnd: number;
}

/** Finds method declarations at direct type-member depth in masked C# source. */
function findSourceMethodMembers(masked: string, bodyStart: number, bodyEnd: number): SourceMemberCandidate[] {
  const body = masked.slice(bodyStart, bodyEnd);
  const methodPattern = /\b(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial)\s+)*(?:[A-Za-z_][A-Za-z0-9_.<>,?\[\]]*\s+)+(@?[A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const members: SourceMemberCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = methodPattern.exec(body))) {
    const absoluteIndex = bodyStart + match.index;
    if (getBraceDepthAt(masked, absoluteIndex) !== getBraceDepthAt(masked, bodyStart)) {
      continue;
    }

    const name = normalizeSourceIdentifier(match[1]);
    const nameStart = bodyStart + match.index + match[0].lastIndexOf(match[1]);
    members.push({ name, nameStart, nameEnd: nameStart + match[1].length });
  }

  return members;
}

/** Finds UnityEvent field declarations at direct type-member depth in masked C# source. */
function findSourceUnityEventFieldMembers(masked: string, bodyStart: number, bodyEnd: number): SourceMemberCandidate[] {
  const body = masked.slice(bodyStart, bodyEnd);
  const fieldPattern = /\b(?:(?:public|private|protected|internal|static|readonly|new|sealed|volatile)\s+)*((?:UnityEngine\.Events\.)?UnityEvent(?:\s*<[^;\n]+>)?)\s+(@?[A-Za-z_][A-Za-z0-9_]*)\b/g;
  const members: SourceMemberCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(body))) {
    const absoluteIndex = bodyStart + match.index;
    if (getBraceDepthAt(masked, absoluteIndex) !== getBraceDepthAt(masked, bodyStart)) {
      continue;
    }

    const name = normalizeSourceIdentifier(match[2]);
    const nameStart = bodyStart + match.index + match[0].lastIndexOf(match[2]);
    members.push({ name, nameStart, nameEnd: nameStart + match[2].length });
  }

  return members;
}

/** Creates a neutral C# range from source offsets. */
function sourceRangeAt(lineStarts: readonly number[], start: number, end: number): CSharpRange {
  return {
    start: positionAt(lineStarts, start),
    end: positionAt(lineStarts, end)
  };
}

/** Normalizes escaped C# identifiers to their symbol names. */
function normalizeSourceIdentifier(identifier: string): string {
  return identifier.startsWith('@') ? identifier.slice(1) : identifier;
}

async function getPrimaryTopLevelTypeFromSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTopLevelTypeSnapshot | 'fallback' | undefined> {
  const symbols = await getDocumentSymbols(runtimeVscode, uri);

  if (!symbols?.length) {
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
      nameEnd,
      ...findSourceTypeBody(masked, nameEnd)
    });
  }

  return candidates;
}

/** Locates the body span for block-bodied type declarations. */
function findSourceTypeBody(masked: string, searchStart: number): Pick<SourceTypeCandidate, 'bodyStart' | 'bodyEnd'> {
  const openBraceIndex = masked.indexOf('{', searchStart);
  const semicolonIndex = masked.indexOf(';', searchStart);

  if (openBraceIndex === -1 || (semicolonIndex !== -1 && semicolonIndex < openBraceIndex)) {
    return {};
  }

  const closeBraceIndex = findMatchingBrace(masked, openBraceIndex);
  if (closeBraceIndex === undefined) {
    return {};
  }

  return {
    bodyStart: openBraceIndex + 1,
    bodyEnd: closeBraceIndex
  };
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
