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
  isUnityObjectType(uri: vscode.Uri, typeName: string): Promise<boolean>;
}

interface TopLevelTypeSymbolCandidate {
  name: string;
  kind: CSharpTopLevelTypeKind;
  namespace?: string;
  position: vscode.Position;
  range: vscode.Range;
}

interface TypeHierarchyLookupCandidate {
  name: string;
  fullName: string;
  position: vscode.Position;
}

export function createVscodeCSharpLanguageService(runtimeVscode: typeof vscode): CSharpSymbolLanguageService {
  return {
    async getPrimaryTopLevelType(uri) {
      return await getPrimaryTopLevelTypeFromSymbols(runtimeVscode, uri);
    },
    async findMethods(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const methods: CSharpMethodSymbolSnapshot[] = [];
      collectCSharpMethodSymbols(runtimeVscode, symbols, [], methods);
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, methods.length, 'methods');
      return methods;
    },
    async findTypes(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const types: CSharpTypeSymbolSnapshot[] = [];
      collectCSharpTypeSymbols(runtimeVscode, symbols, [], types);
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, types.length, 'types');
      return types;
    },
    async findUnityEventFields(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const fields: CSharpFieldSymbolSnapshot[] = [];
      collectUnityEventFieldSymbols(runtimeVscode, symbols, [], fields);
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, fields.length, 'UnityEvent fields');
      return fields;
    },
    async findMethodAtPosition(uri, position) {
      return (await this.findMethods(uri)).find(method => containsCSharpPosition(method.range, position));
    },
    async findUnityEventFieldAtPosition(uri, position) {
      return (await this.findUnityEventFields(uri)).find(field => containsCSharpPosition(field.range, position));
    },
    async findTargetMethodPosition(uri, targetTypeName, methodName) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const positions: CSharpPosition[] = [];
      collectTargetMethodSymbolPositions(runtimeVscode, symbols, [], targetTypeName, methodName, positions);
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, positions.length, `target method ${targetTypeName}.${methodName}`);
      return positions;
    },
    async isUnityObjectType(uri, typeName) {
      return await isUnityObjectTypeFromHierarchy(runtimeVscode, uri, typeName);
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

/** Uses VS Code type hierarchy to prove whether a C# type inherits UnityEngine.Object. */
async function isUnityObjectTypeFromHierarchy(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  typeName: string
): Promise<boolean> {
  try {
    const symbols = await getDocumentSymbols(runtimeVscode, uri);
    const candidates = await collectTypeHierarchyLookupCandidates(runtimeVscode, uri, symbols);
    const type = candidates.find(candidate =>
      matchesCSharpTypeName(candidate.fullName, typeName) ||
      matchesCSharpTypeName(candidate.name, typeName)
    );
    if (!type) {
      return false;
    }

    const position = type.position;
    const hierarchyItems = await runtimeVscode.commands.executeCommand<vscode.TypeHierarchyItem[] | undefined>(
      'vscode.prepareTypeHierarchy',
      uri,
      position
    );
    const rootItems = (hierarchyItems ?? []).filter(item => matchesTypeHierarchyItemName(item, typeName));
    if (await hasUnityObjectSupertype(runtimeVscode, rootItems.length > 0 ? rootItems : hierarchyItems ?? [])) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Collects provider-backed type positions that can seed VS Code TypeHierarchy. */
async function collectTypeHierarchyLookupCandidates(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]
): Promise<TypeHierarchyLookupCandidate[]> {
  const candidates: TopLevelTypeSymbolCandidate[] = [];
  for (const symbol of symbols) {
    collectTopLevelTypeSymbols(runtimeVscode, symbol, [], candidates);
  }
  return candidates.map(candidate => ({
    name: normalizeCSharpSymbolName(candidate.name),
    fullName: toTopLevelTypeFullName(candidate),
    position: candidate.position
  }));
}

/** Walks type hierarchy parents while avoiding cycles from buggy language servers. */
async function hasUnityObjectSupertype(
  runtimeVscode: typeof vscode,
  rootItems: readonly vscode.TypeHierarchyItem[]
): Promise<boolean> {
  const pending = [...rootItems];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) {
      continue;
    }

    const key = `${item.uri.fsPath}:${item.name}:${item.detail ?? ''}:${item.range.start.line}:${item.range.start.character}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    if (isUnityObjectHierarchyItem(item)) {
      return true;
    }

    const supertypes = await runtimeVscode.commands.executeCommand<vscode.TypeHierarchyItem[] | undefined>(
      'vscode.provideSupertypes',
      item
    );
    pending.push(...supertypes ?? []);
  }

  return false;
}

/** Checks the item name and detail because C# servers differ in hierarchy labels. */
function isUnityObjectHierarchyItem(item: vscode.TypeHierarchyItem): boolean {
  const detail = item.detail ?? '';
  return item.name === 'Object' && /\bUnityEngine\b/.test(detail) ||
    item.name === 'UnityEngine.Object' ||
    `${detail}.${item.name}` === 'UnityEngine.Object';
}

/** Matches the requested C# type against the hierarchy item label. */
function matchesTypeHierarchyItemName(item: vscode.TypeHierarchyItem, typeName: string): boolean {
  const detail = item.detail ?? '';
  return matchesCSharpTypeName(item.name, typeName) ||
    (detail ? matchesCSharpTypeName(`${detail}.${item.name}`, typeName) : false);
}

/** Creates the full C# type name from provider symbol namespace metadata. */
function toTopLevelTypeFullName(type: TopLevelTypeSymbolCandidate): string {
  return joinCSharpName(type.namespace, type.name);
}

/** Reads C# symbols from the active language server after loading the document in VS Code. */
async function getDocumentSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<Array<vscode.DocumentSymbol | vscode.SymbolInformation>> {
  const document = await runtimeVscode.workspace.openTextDocument(uri);
  const symbols = await runtimeVscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
    'vscode.executeDocumentSymbolProvider',
    document.uri
  );
  if (!symbols) {
    throw new Error(`C# document symbol provider returned no result for ${uri.fsPath}.`);
  }

  return symbols;
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
          typeName: normalizeCSharpQualifiedName(symbol.containerName),
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
        const name = normalizeCSharpSymbolName(symbol.name);
        types.push({
          name,
          fullName: joinCSharpName(normalizeCSharpNamespaceName(symbol.containerName), name),
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
        fullName: joinCSharpName(namespaceName, name),
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
  ancestors: readonly vscode.DocumentSymbol[],
  targetTypeName: string,
  methodName: string,
  positions: CSharpPosition[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      if (symbol.kind === runtimeVscode.SymbolKind.Method &&
        normalizeCSharpSymbolName(symbol.name) === methodName &&
        symbol.containerName &&
        matchesCSharpTypeName(normalizeCSharpQualifiedName(symbol.containerName) ?? symbol.containerName, targetTypeName)) {
        positions.push(toCSharpPosition(symbol.location.range.start));
      }
      continue;
    }

    const symbolTypeName = getTopLevelTypeKind(runtimeVscode, symbol.kind)
      ? joinCSharpName(findNearestNamespace(runtimeVscode, ancestors), normalizeCSharpSymbolName(symbol.name))
      : undefined;
    if (symbolTypeName && matchesCSharpTypeName(symbolTypeName, targetTypeName)) {
      collectMethodSymbolsInType(runtimeVscode, symbol, methodName, positions);
      continue; // Found the target type, so skip recursion into other types.
    }

    collectTargetMethodSymbolPositions(runtimeVscode, symbol.children, [...ancestors, symbol], targetTypeName, methodName, positions);
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

/** Fails when the C# provider reports namespaces but omits semantic children. */
function throwIfNamespaceOnlyDocumentSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  resultCount: number,
  semanticName: string,
  providerCovered = false
): void {
  if (resultCount > 0 || providerCovered || symbols.length === 0 || !containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
    return;
  }

  const providerNames = flattenProviderSymbolNames(symbols).join(', ') || '<none>';
  throw new Error(
    `C# document symbol provider returned namespace-only symbols for ${semanticName} in ${uri.fsPath}. ` +
    `Provider symbols: ${providerNames}.`
  );
}

/** Checks whether every provider symbol is a namespace container. */
function containsOnlyNamespaceSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]
): boolean {
  let sawSymbol = false;

  for (const symbol of symbols) {
    sawSymbol = true;
    if (symbol.kind !== runtimeVscode.SymbolKind.Namespace) {
      return false;
    }

    if (!isSymbolInformation(symbol) &&
      symbol.children.length > 0 &&
      !containsOnlyNamespaceSymbols(runtimeVscode, symbol.children)) {
      return false;
    }
  }

  return sawSymbol;
}

/** Flattens provider symbols for dependency diagnostics without reading source text. */
function flattenProviderSymbolNames(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string[] {
  const names: string[] = [];

  for (const symbol of symbols) {
    names.push(normalizeCSharpSymbolName(symbol.name));
    if (!isSymbolInformation(symbol)) {
      names.push(...flattenProviderSymbolNames(symbol.children));
    }
  }

  return names;
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
  return joinCSharpName(namespaceName, normalizeCSharpSymbolName(typeSymbol.name));
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
  return name.replace(/\s*\(.*$/, '').trim();
}

/** Normalizes namespace labels from C# providers before creating snapshots. */
function normalizeCSharpNamespaceName(name: string | undefined): string | undefined {
  const normalized = name
    ?.replace(/\s+/g, '')
    .replace(/\.+$/g, '');
  return normalized ? normalized : undefined;
}

/** Normalizes provider-qualified type names without inventing missing type data. */
function normalizeCSharpQualifiedName(name: string | undefined): string | undefined {
  const normalized = name
    ?.split('.')
    .map(part => normalizeCSharpSymbolName(part))
    .filter(Boolean)
    .join('.');
  return normalizeCSharpNamespaceName(normalized);
}

/** Joins namespace and symbol names without allowing empty or doubled separators. */
function joinCSharpName(namespaceName: string | undefined, name: string): string {
  const normalizedNamespace = normalizeCSharpNamespaceName(namespaceName);
  const normalizedName = normalizeCSharpSymbolName(name);
  return normalizedNamespace ? `${normalizedNamespace}.${normalizedName}` : normalizedName;
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
  return normalizeCSharpQualifiedName(value)?.toLowerCase() ?? '';
}

async function getPrimaryTopLevelTypeFromSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTopLevelTypeSnapshot | undefined> {
  const symbols = await getDocumentSymbols(runtimeVscode, uri);

  if (symbols.length === 0) {
    return undefined;
  }

  const candidates: TopLevelTypeSymbolCandidate[] = [];
  for (const symbol of symbols) {
    collectTopLevelTypeSymbols(runtimeVscode, symbol, [], candidates);
  }
  throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, candidates.length, 'primary top-level type');

  if (candidates.length !== 1) {
    return undefined;
  }

  return createTypeSnapshot(candidates[0]);
}

function createTypeSnapshot(candidate: TopLevelTypeSymbolCandidate): CSharpTopLevelTypeSnapshot {
  return {
    name: normalizeCSharpSymbolName(candidate.name),
    kind: candidate.kind,
    namespace: normalizeCSharpNamespaceName(candidate.namespace),
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
      const name = normalizeCSharpSymbolName(symbol.name);
      candidates.push({
        name,
        kind,
        namespace: normalizeCSharpNamespaceName(symbol.containerName),
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
      name: normalizeCSharpSymbolName(symbol.name),
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

function findNearestNamespace(runtimeVscode: typeof vscode, ancestors: readonly vscode.DocumentSymbol[]): string | undefined {
  let namespaceName: string | undefined;

  for (const ancestor of ancestors) {
    if (ancestor.kind !== runtimeVscode.SymbolKind.Namespace) {
      continue;
    }

    const nextName = normalizeCSharpNamespaceName(ancestor.name);
    if (!nextName) {
      continue;
    }

    // Some C# providers emit full namespace names at each namespace node;
    // others emit one segment per nested namespace node.
    namespaceName = !namespaceName || nextName.startsWith(`${namespaceName}.`)
      ? nextName
      : `${namespaceName}.${nextName}`;
  }

  return namespaceName;
}

function isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
  return 'location' in symbol;
}
