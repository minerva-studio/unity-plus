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
  uriPath?: string;
  range: CSharpRange;
}

export interface CSharpDocumentMemberSnapshot {
  methods: readonly CSharpMethodSymbolSnapshot[];
  fields: readonly CSharpFieldSymbolSnapshot[];
  methodsAvailable: boolean;
  fieldsAvailable: boolean;
}

export type CSharpSymbolKind = 'type' | 'method' | 'field';

export interface CSharpSymbolLocation {
  uriPath: string;
  name: string;
  containerName?: string;
  range: CSharpRange;
  source: 'documentSymbols' | 'workspaceSymbols';
  diagnostics: readonly string[];
}

export interface CSharpLanguageService {
  getPrimaryTopLevelType(uri: vscode.Uri): Promise<CSharpTopLevelTypeSnapshot | undefined>;
  findReferences(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpReferenceLocation[]>;
  buildRenameEdit(uri: vscode.Uri, position: CSharpPosition, newName: string): Promise<vscode.WorkspaceEdit | undefined>;
}

export interface CSharpSymbolLanguageService extends CSharpLanguageService {
  findDocumentMembers(
    uri: vscode.Uri,
    expectedMethodNames?: readonly string[],
    expectedFieldNames?: readonly string[]
  ): Promise<CSharpDocumentMemberSnapshot>;
  findMethods(uri: vscode.Uri, expectedNames?: readonly string[]): Promise<CSharpMethodSymbolSnapshot[]>;
  findTypes(uri: vscode.Uri): Promise<CSharpTypeSymbolSnapshot[]>;
  findUnityEventFields(uri: vscode.Uri, expectedNames?: readonly string[]): Promise<CSharpFieldSymbolSnapshot[]>;
  findMethodAtPosition(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpMethodSymbolSnapshot | undefined>;
  findUnityEventFieldAtPosition(uri: vscode.Uri, position: CSharpPosition): Promise<CSharpFieldSymbolSnapshot | undefined>;
  resolveType(typeName: string): Promise<CSharpSymbolLocation[]>;
  resolveMember(typeName: string, memberName: string, kind: 'method' | 'field'): Promise<CSharpSymbolLocation[]>;
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
    async findDocumentMembers(uri, expectedMethodNames = [], expectedFieldNames = []) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      const methods: CSharpMethodSymbolSnapshot[] = [];
      const fields: CSharpFieldSymbolSnapshot[] = [];
      collectCSharpMethodSymbols(runtimeVscode, symbols, [], methods);
      collectUnityEventFieldSymbols(runtimeVscode, symbols, [], fields);
      if (!containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
        return { methods, fields, methodsAvailable: true, fieldsAvailable: true };
      }

      const workspaceSymbols = await getWorkspaceSymbolsForExactUri(
        runtimeVscode,
        uri,
        [...expectedMethodNames, ...expectedFieldNames]
      );
      const workspaceMethods = createMethodSnapshotsFromWorkspaceSymbols(runtimeVscode, workspaceSymbols, expectedMethodNames);
      const workspaceFields = await createFieldSnapshotsFromWorkspaceSymbols(runtimeVscode, workspaceSymbols, expectedFieldNames);
      return {
        methods: workspaceMethods,
        fields: workspaceFields,
        methodsAvailable: expectedMethodNames.length === 0 || workspaceMethods.length > 0,
        fieldsAvailable: expectedFieldNames.length === 0 || workspaceFields.length > 0
      };
    },
    async findMethods(uri, expectedNames = []) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const methods: CSharpMethodSymbolSnapshot[] = [];
      collectCSharpMethodSymbols(runtimeVscode, symbols, [], methods);
      if (methods.length === 0 && containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
        const workspaceMethods = await findMethodsFromWorkspaceSymbols(runtimeVscode, uri, expectedNames);
        if (workspaceMethods.length > 0) {
          return workspaceMethods;
        }
      }
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, methods.length, 'methods');
      return methods;
    },
    async findTypes(uri) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const types: CSharpTypeSymbolSnapshot[] = [];
      collectCSharpTypeSymbols(runtimeVscode, uri, symbols, [], types);
      if (types.length === 0 && containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
        const workspaceTypes = await findTypesFromWorkspaceSymbols(runtimeVscode, uri);
        if (workspaceTypes.length > 0) {
          return workspaceTypes;
        }
      }
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, types.length, 'types');
      return types;
    },
    async findUnityEventFields(uri, expectedNames = []) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);

      const fields: CSharpFieldSymbolSnapshot[] = [];
      collectUnityEventFieldSymbols(runtimeVscode, symbols, [], fields);
      if (fields.length === 0 && containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
        const workspaceFields = await findUnityEventFieldsFromWorkspaceSymbols(runtimeVscode, uri, expectedNames);
        if (workspaceFields.length > 0) {
          return workspaceFields;
        }
      }
      throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, fields.length, 'UnityEvent fields');
      return fields;
    },
    async findMethodAtPosition(uri, position) {
      return (await this.findMethods(uri)).find(method => containsCSharpPosition(method.range, position));
    },
    async findUnityEventFieldAtPosition(uri, position) {
      return (await this.findUnityEventFields(uri)).find(field => containsCSharpPosition(field.range, position));
    },
    async resolveType(typeName) {
      return await resolveTypeSymbol(runtimeVscode, typeName);
    },
    async resolveMember(typeName, memberName, kind) {
      return await resolveMemberSymbol(runtimeVscode, typeName, memberName, kind);
    },
    async findTargetMethodPosition(uri, targetTypeName, methodName) {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      if (symbols.length === 0) {
        throw new Error(`C# document symbol provider returned empty symbols for target method ${targetTypeName}.${methodName} in ${uri.fsPath}.`);
      }

      const positions: CSharpPosition[] = [];
      collectTargetMethodSymbolPositions(runtimeVscode, symbols, [], targetTypeName, methodName, positions);
      if (positions.length === 0 && containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
        const workspaceMethods = await findMethodsFromWorkspaceSymbols(runtimeVscode, uri, [methodName]);
        positions.push(...workspaceMethods
          .filter(method =>
            normalizeCSharpSymbolName(method.name) === methodName &&
            method.typeName &&
            matchesCSharpTypeName(method.typeName, targetTypeName)
          )
          .map(method => method.range.start));
      }
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

/** Restores type positions from provider-backed workspace symbols when document symbols are namespace-only. */
async function findTypesFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri
): Promise<CSharpTypeSymbolSnapshot[]> {
  const symbols = await getWorkspaceSymbolsForExactUri(runtimeVscode, uri, [scriptFileStem(uri)]);
  const types = symbols
    .filter(symbol => getTopLevelTypeKind(runtimeVscode, symbol.kind))
    .map(symbol => {
      const name = normalizeCSharpSymbolName(symbol.name);
      return {
        name,
        fullName: toWorkspaceTypeFullName(symbol),
        uriPath: symbol.location.uri.fsPath,
        range: toCSharpRange(symbol.location.range)
      };
    });

  return dedupeTypeSnapshots(types);
}

/** Restores method positions from exact provider symbols for names already discovered from Unity YAML. */
async function findMethodsFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  expectedNames: readonly string[]
): Promise<CSharpMethodSymbolSnapshot[]> {
  const symbols = await getWorkspaceSymbolsForExactUri(runtimeVscode, uri, expectedNames);
  return createMethodSnapshotsFromWorkspaceSymbols(runtimeVscode, symbols, expectedNames);
}

/** Converts provider workspace symbols into method snapshots without issuing another provider query. */
function createMethodSnapshotsFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly vscode.SymbolInformation[],
  expectedNames: readonly string[]
): CSharpMethodSymbolSnapshot[] {
  const methods = symbols
    .filter(symbol => symbol.kind === runtimeVscode.SymbolKind.Method)
    .filter(symbol => expectedNames.length === 0 || expectedNames.some(name => normalizeCSharpSymbolName(symbol.name) === name))
    .map(symbol => ({
      name: normalizeCSharpSymbolName(symbol.name),
      typeName: normalizeCSharpQualifiedName(symbol.containerName),
      range: toCSharpRange(symbol.location.range)
    }));

  return dedupeMethodSnapshots(methods);
}

/** Resolves a type declaration by asking the C# provider for workspace symbols. */
async function resolveTypeSymbol(
  runtimeVscode: typeof vscode,
  typeName: string
): Promise<CSharpSymbolLocation[]> {
  const diagnostics: string[] = [];
  const queries = createTypeSymbolQueries(typeName);
  const symbols = await getWorkspaceSymbolsForExactNames(runtimeVscode, queries);
  diagnostics.push(`type=${typeName}; queries=${queries.join(', ')}; raw=${symbols.length}`);

  const typeSymbols = symbols
    .filter(symbol => getTopLevelTypeKind(runtimeVscode, symbol.kind))
    .map(symbol => ({
      symbol,
      name: normalizeCSharpSymbolName(symbol.name),
      fullName: toWorkspaceTypeFullName(symbol)
    }));
  const exactMatches = typeSymbols.filter(candidate => matchesCSharpTypeName(candidate.fullName, typeName));
  const shortMatches = typeSymbols.filter(candidate =>
    csharpSymbolKey(candidate.name) === csharpSymbolKey(shortCSharpTypeName(typeName))
  );
  const accepted = exactMatches.length > 0
    ? exactMatches
    : uniqueWorkspaceSymbolUris(shortMatches).length === 1
      ? shortMatches
      : [];

  if (accepted.length === 0) {
    diagnostics.push(`accepted=0; typeCandidates=${describeWorkspaceSymbolSample(typeSymbols.map(candidate => candidate.symbol))}`);
  } else {
    diagnostics.push(`accepted=${accepted.length}`);
  }

  return dedupeSymbolLocations(accepted.map(candidate => ({
    uriPath: candidate.symbol.location.uri.fsPath,
    name: candidate.name,
    containerName: normalizeCSharpQualifiedName(candidate.symbol.containerName),
    range: toCSharpRange(candidate.symbol.location.range),
    source: 'workspaceSymbols',
    diagnostics
  })));
}

/** Resolves a member by first locating its containing type, then reading provider document symbols. */
async function resolveMemberSymbol(
  runtimeVscode: typeof vscode,
  typeName: string,
  memberName: string,
  kind: 'method' | 'field'
): Promise<CSharpSymbolLocation[]> {
  const diagnostics: string[] = [`member=${typeName}.${memberName}; kind=${kind}`];
  const typeLocations = await resolveTypeSymbol(runtimeVscode, typeName);
  diagnostics.push(...typeLocations.flatMap(location => location.diagnostics));

  const locations: CSharpSymbolLocation[] = [];
  for (const typeLocation of typeLocations) {
    const uri = runtimeVscode.Uri.file(typeLocation.uriPath);
    try {
      const symbols = await getDocumentSymbols(runtimeVscode, uri);
      const documentMatches: CSharpSymbolLocation[] = [];
      collectMemberSymbolLocationsInDocument(runtimeVscode, uri, symbols, [], typeName, memberName, kind, documentMatches, diagnostics);
      if (documentMatches.length > 0) {
        locations.push(...documentMatches);
        continue;
      }

      diagnostics.push(`documentSymbols no ${kind} match in ${uri.fsPath}; shape=${describeProviderSymbolShape(symbols)}`);
    } catch (error) {
      diagnostics.push(`documentSymbols failed in ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (locations.length > 0) {
    return dedupeSymbolLocations(locations);
  }

  const workspaceFallback = await resolveMemberSymbolFromWorkspaceSymbols(runtimeVscode, typeLocations, typeName, memberName, kind, diagnostics);
  const resolvedFallback = dedupeSymbolLocations(workspaceFallback);
  if (resolvedFallback.length > 0) {
    return resolvedFallback;
  }

  throw new Error(`C# provider could not resolve ${kind} ${typeName}.${memberName}. Diagnostics: ${diagnostics.join(' | ')}`);
}

/** Resolves a member from workspace symbols only when declaring type evidence is present. */
async function resolveMemberSymbolFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  typeLocations: readonly CSharpSymbolLocation[],
  typeName: string,
  memberName: string,
  kind: 'method' | 'field',
  diagnostics: string[]
): Promise<CSharpSymbolLocation[]> {
  const symbols = await getWorkspaceSymbolsForExactNames(runtimeVscode, [memberName]);
  const expectedKind = kind === 'method'
    ? runtimeVscode.SymbolKind.Method
    : runtimeVscode.SymbolKind.Field;
  diagnostics.push(`workspace ${kind} query=${memberName}; raw=${symbols.length}`);

  const accepted: CSharpSymbolLocation[] = [];
  const rejected: Array<{ symbol: vscode.SymbolInformation; reason: string }> = [];
  const typeUriKeys = new Set(typeLocations.map(location => csharpPathKey(location.uriPath)));
  const targetShortTypeName = shortCSharpTypeName(typeName);

  for (const symbol of symbols) {
    if (symbol.kind !== expectedKind || normalizeCSharpSymbolName(symbol.name) !== memberName) {
      rejected.push({ symbol, reason: 'kind-or-name-mismatch' });
      continue;
    }

    const containerName = normalizeCSharpQualifiedName(symbol.containerName);
    const containerShortName = normalizeWorkspaceSymbolContainerShortName(symbol.containerName);
    const fullTypeMatch = containerName && matchesFullCSharpDeclaringTypeName(containerName, typeName);
    const sameUriTypeMatch = typeUriKeys.has(csharpUriKey(symbol.location.uri)) &&
      containerShortName &&
      csharpSymbolKey(containerShortName) === csharpSymbolKey(targetShortTypeName);
    if (!fullTypeMatch && !sameUriTypeMatch) {
      rejected.push({
        symbol,
        reason: `declaring-type-mismatch; rawContainer=${symbol.containerName ?? '<none>'}; ` +
          `normalizedContainer=${containerName ?? '<none>'}; shortContainer=${containerShortName ?? '<none>'}; ` +
          `sameTypeUri=${typeUriKeys.has(csharpUriKey(symbol.location.uri))}`
      });
      continue;
    }

    accepted.push({
      uriPath: symbol.location.uri.fsPath,
      name: normalizeCSharpSymbolName(symbol.name),
      containerName: containerName ?? containerShortName,
      range: toCSharpRange(symbol.location.range),
      source: 'workspaceSymbols',
      diagnostics
    });
  }

  if (accepted.length === 0) {
    diagnostics.push(`workspace ${kind} accepted=0; rejected=${describeRejectedWorkspaceSymbolSample(rejected)}`);
  } else {
    diagnostics.push(`workspace ${kind} accepted=${accepted.length}`);
  }

  return accepted;
}

/** Restores UnityEvent field positions from exact provider symbols and hover-backed type evidence. */
async function findUnityEventFieldsFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  expectedNames: readonly string[]
): Promise<CSharpFieldSymbolSnapshot[]> {
  const symbols = await getWorkspaceSymbolsForExactUri(runtimeVscode, uri, expectedNames);
  return await createFieldSnapshotsFromWorkspaceSymbols(runtimeVscode, symbols, expectedNames);
}

/** Converts provider workspace symbols into UnityEvent field snapshots without issuing another symbol query. */
async function createFieldSnapshotsFromWorkspaceSymbols(
  runtimeVscode: typeof vscode,
  symbols: readonly vscode.SymbolInformation[],
  expectedNames: readonly string[]
): Promise<CSharpFieldSymbolSnapshot[]> {
  const fields: CSharpFieldSymbolSnapshot[] = [];

  for (const symbol of symbols) {
    if (symbol.kind !== runtimeVscode.SymbolKind.Field) {
      continue;
    }

    if (expectedNames.length > 0 && !expectedNames.some(name => normalizeCSharpSymbolName(symbol.name) === name)) {
      continue;
    }

    if (!await isWorkspaceSymbolUnityEventField(runtimeVscode, symbol)) {
      continue;
    }

    fields.push({
      name: normalizeCSharpSymbolName(symbol.name),
      typeName: normalizeCSharpQualifiedName(symbol.containerName),
      range: toCSharpRange(symbol.location.range)
    });
  }

  return dedupeFieldSnapshots(fields);
}

/** Queries VS Code workspace symbols with exact names and keeps only symbols from the requested file. */
async function getWorkspaceSymbolsForExactUri(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  exactNames: readonly string[]
): Promise<vscode.SymbolInformation[]> {
  const symbols = await getWorkspaceSymbolsForExactNames(runtimeVscode, exactNames);
  const results: vscode.SymbolInformation[] = [];
  const uriKey = csharpUriKey(uri);

  for (const symbol of symbols) {
    if (csharpUriKey(symbol.location.uri) !== uriKey) {
      continue;
    }

    results.push(symbol);
  }

  return results;
}

/** Queries VS Code workspace symbols by exact names and keeps provider SymbolInformation results. */
async function getWorkspaceSymbolsForExactNames(
  runtimeVscode: typeof vscode,
  exactNames: readonly string[]
): Promise<vscode.SymbolInformation[]> {
  const queries = createMemberQueries(exactNames);
  const results: vscode.SymbolInformation[] = [];

  for (const query of queries) {
    const symbols = await runtimeVscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
      'vscode.executeWorkspaceSymbolProvider',
      query
    );

    for (const symbol of symbols ?? []) {
      if (!isSymbolInformation(symbol)) {
        continue;
      }

      results.push(symbol);
    }
  }

  return results;
}

/** Creates deterministic provider queries while avoiding broad alphabet or type-name scans. */
function createMemberQueries(exactNames: readonly string[]): string[] {
  const queries = exactNames
    .map(name => normalizeCSharpSymbolName(name))
    .filter(name => name.length > 0);
  return [...new Set(queries)];
}

/** Creates type lookup queries that match Roslyn NavigateTo's name-based behavior. */
function createTypeSymbolQueries(typeName: string): string[] {
  const normalizedFullName = normalizeCSharpQualifiedName(typeName) ?? typeName;
  return [...new Set([
    normalizedFullName,
    shortCSharpTypeName(normalizedFullName)
  ].filter(name => name.length > 0))];
}

/** Uses the current script file name as the only type fallback query. */
function scriptFileStem(uri: vscode.Uri): string {
  const fileName = uri.fsPath.split(/[\\/]/).pop() ?? '';
  return fileName.replace(/\.cs$/i, '');
}

/** Builds a type full name from provider workspace symbols without double-prefixing qualified names. */
function toWorkspaceTypeFullName(symbol: vscode.SymbolInformation): string {
  const name = normalizeCSharpSymbolName(symbol.name);
  return name.includes('.')
    ? normalizeCSharpQualifiedName(name) ?? name
    : joinCSharpName(normalizeCSharpNamespaceName(symbol.containerName), name);
}

/** Keeps URI uniqueness separate from type-name proof for diagnostic-friendly resolver decisions. */
function uniqueWorkspaceSymbolUris(symbols: readonly { symbol: vscode.SymbolInformation }[]): string[] {
  return [...new Set(symbols.map(candidate => csharpUriKey(candidate.symbol.location.uri)))];
}

/** Formats a bounded workspace-symbol sample without dumping source text. */
function describeWorkspaceSymbolSample(symbols: readonly vscode.SymbolInformation[], limit = 8): string {
  return JSON.stringify(symbols.slice(0, limit).map(symbol => ({
    name: symbol.name,
    kind: symbol.kind,
    containerName: symbol.containerName,
    uri: symbol.location.uri.fsPath,
    range: toPlainRange(symbol.location.range)
  })));
}

/** Formats rejected workspace-symbol candidates with the resolver decision reason. */
function describeRejectedWorkspaceSymbolSample(
  rejected: readonly { symbol: vscode.SymbolInformation; reason: string }[],
  limit = 8
): string {
  return JSON.stringify(rejected.slice(0, limit).map(({ symbol, reason }) => ({
    name: symbol.name,
    kind: symbol.kind,
    containerName: symbol.containerName,
    normalizedContainer: normalizeCSharpQualifiedName(symbol.containerName),
    shortContainer: normalizeWorkspaceSymbolContainerShortName(symbol.containerName),
    uri: symbol.location.uri.fsPath,
    range: toPlainRange(symbol.location.range),
    reason
  })));
}

/** Proves a workspace field symbol is a UnityEvent by asking the provider for hover text at the symbol range. */
async function isWorkspaceSymbolUnityEventField(
  runtimeVscode: typeof vscode,
  symbol: vscode.SymbolInformation
): Promise<boolean> {
  const hoverText = await readProviderHoverText(runtimeVscode, symbol.location.uri, symbol.location.range.start);
  return isUnityEventTypeText(hoverText);
}

/** Reads hover text from the C# provider without using source text as semantic fallback. */
async function readProviderHoverText(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  position: vscode.Position
): Promise<string> {
  const hovers = await runtimeVscode.commands.executeCommand<vscode.Hover[] | undefined>(
    'vscode.executeHoverProvider',
    uri,
    new runtimeVscode.Position(position.line, position.character)
  );

  return (hovers ?? [])
    .flatMap(hover => hover.contents)
    .map(markdownContentToString)
    .join('\n');
}

/** Normalizes VS Code hover content into searchable provider text. */
function markdownContentToString(content: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof content === 'string') {
    return content;
  }

  return content.value;
}

/** Removes duplicate method snapshots returned by overlapping exact provider queries. */
function dedupeMethodSnapshots(methods: readonly CSharpMethodSymbolSnapshot[]): CSharpMethodSymbolSnapshot[] {
  const seen = new Set<string>();
  return methods.filter(method => {
    const key = `${method.typeName ?? ''}#${method.name}#${method.range.start.line}:${method.range.start.character}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Removes duplicate field snapshots returned by overlapping exact provider queries. */
function dedupeFieldSnapshots(fields: readonly CSharpFieldSymbolSnapshot[]): CSharpFieldSymbolSnapshot[] {
  const seen = new Set<string>();
  return fields.filter(field => {
    const key = `${field.typeName ?? ''}#${field.name}#${field.range.start.line}:${field.range.start.character}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Removes duplicate symbol locations returned by overlapping provider paths. */
function dedupeSymbolLocations(methods: readonly CSharpSymbolLocation[]): CSharpSymbolLocation[] {
  const seen = new Set<string>();
  return methods.filter(method => {
    const key = `${method.uriPath}#${method.range.start.line}:${method.range.start.character}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Removes duplicate type snapshots returned by provider symbol search. */
function dedupeTypeSnapshots(types: readonly CSharpTypeSymbolSnapshot[]): CSharpTypeSymbolSnapshot[] {
  const seen = new Set<string>();
  return types.filter(type => {
    const key = `${type.fullName}#${type.range.start.line}:${type.range.start.character}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Normalizes provider URIs for exact same-file filtering. */
function csharpUriKey(uri: vscode.Uri): string {
  return csharpPathKey(uri.fsPath);
}

/** Normalizes provider file paths for exact same-file filtering. */
function csharpPathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
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
  uri: vscode.Uri,
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
          uriPath: symbol.location.uri.fsPath,
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
        uriPath: uri.fsPath,
        range: toCSharpRange(symbol.selectionRange)
      });
    }

    collectCSharpTypeSymbols(runtimeVscode, uri, symbol.children, [...ancestors, symbol], types);
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

/** Collects provider-backed member locations inside the requested type's document symbol subtree. */
function collectMemberSymbolLocationsInDocument(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  ancestors: readonly vscode.DocumentSymbol[],
  typeName: string,
  memberName: string,
  kind: 'method' | 'field',
  locations: CSharpSymbolLocation[],
  diagnostics: readonly string[]
): void {
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      const expectedKind = kind === 'method'
        ? runtimeVscode.SymbolKind.Method
        : runtimeVscode.SymbolKind.Field;
      const containerName = normalizeCSharpQualifiedName(symbol.containerName);
      if (symbol.kind === expectedKind &&
        normalizeCSharpSymbolName(symbol.name) === memberName &&
        containerName &&
        matchesCSharpTypeName(containerName, typeName)) {
        locations.push({
          uriPath: symbol.location.uri.fsPath,
          name: normalizeCSharpSymbolName(symbol.name),
          containerName,
          range: toCSharpRange(symbol.location.range),
          source: 'documentSymbols',
          diagnostics
        });
      }
      continue;
    }

    const symbolTypeName = getTopLevelTypeKind(runtimeVscode, symbol.kind)
      ? joinCSharpName(findNearestNamespace(runtimeVscode, ancestors), normalizeCSharpSymbolName(symbol.name))
      : undefined;
    if (symbolTypeName && matchesCSharpTypeName(symbolTypeName, typeName)) {
      collectMemberSymbolsInType(runtimeVscode, uri, symbol, symbolTypeName, memberName, kind, locations, diagnostics);
      continue;
    }

    collectMemberSymbolLocationsInDocument(runtimeVscode, uri, symbol.children, [...ancestors, symbol], typeName, memberName, kind, locations, diagnostics);
  }
}

/** Collects matching methods or fields once the containing type symbol has been proven. */
function collectMemberSymbolsInType(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  typeSymbol: vscode.DocumentSymbol,
  typeName: string,
  memberName: string,
  kind: 'method' | 'field',
  locations: CSharpSymbolLocation[],
  diagnostics: readonly string[]
): void {
  const expectedKind = kind === 'method'
    ? runtimeVscode.SymbolKind.Method
    : runtimeVscode.SymbolKind.Field;

  for (const child of typeSymbol.children) {
    if (child.kind === expectedKind && normalizeCSharpSymbolName(child.name) === memberName) {
      locations.push({
        uriPath: uri.fsPath,
        name: normalizeCSharpSymbolName(child.name),
        containerName: typeName,
        range: toCSharpRange(child.selectionRange),
        source: 'documentSymbols',
        diagnostics
      });
    }

    collectMemberSymbolsInType(runtimeVscode, uri, child, typeName, memberName, kind, locations, diagnostics);
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
  return isUnityEventTypeText(symbol.detail);
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
  const providerShape = describeProviderSymbolShape(symbols);
  throw new Error(
    `C# document symbol provider returned namespace-only symbols for ${semanticName} in ${uri.fsPath}. ` +
    `Provider symbols: ${providerNames}. Raw shape: ${providerShape}.`
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

/** Formats provider symbol shape for logs without dumping source code. */
function describeProviderSymbolShape(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): string {
  return JSON.stringify(symbols.map(symbol => ({
    shape: isSymbolInformation(symbol) ? 'SymbolInformation' : 'DocumentSymbol',
    name: symbol.name,
    kind: symbol.kind,
    range: isSymbolInformation(symbol)
      ? toPlainRange(symbol.location.range)
      : toPlainRange(symbol.selectionRange),
    children: isSymbolInformation(symbol)
      ? undefined
      : symbol.children.length
  })));
}

/** Converts a VS Code range into a stable JSON-ready diagnostic object. */
function toPlainRange(range: vscode.Range): { start: CSharpPosition; end: CSharpPosition } {
  return {
    start: toCSharpPosition(range.start),
    end: toCSharpPosition(range.end)
  };
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
  const providerContainer = stripCSharpAssemblyName(normalizeWorkspaceSymbolContainerName(name));
  const normalized = providerContainer
    ?.split('.')
    .map(part => normalizeCSharpSymbolName(part))
    .filter(Boolean)
    .join('.');
  return normalizeCSharpNamespaceName(normalized);
}

/** Normalizes Roslyn workspace-symbol containers such as "in TypeName (project X)". */
function normalizeWorkspaceSymbolContainerName(name: string | undefined): string | undefined {
  const container = name?.trim();
  if (!container) {
    return undefined;
  }

  const projectScopedMember = /^(?:in|在)\s*(.+?)\s*\((?:project|项目)\s+.+\)\s*(?:中)?$/i.exec(container);
  if (projectScopedMember?.[1]) {
    return projectScopedMember[1];
  }

  const projectScopedType = /^(?:project|项目)\s+.+$/i.test(container);
  return projectScopedType ? undefined : container;
}

/** Extracts only the declaring type label from localized workspace-symbol containers. */
function normalizeWorkspaceSymbolContainerShortName(name: string | undefined): string | undefined {
  const containerName = stripCSharpAssemblyName(normalizeWorkspaceSymbolContainerName(name));
  return containerName ? shortCSharpTypeName(containerName) : undefined;
}

/** Removes Unity/Roslyn assembly suffixes from type display strings. */
function stripCSharpAssemblyName(name: string | undefined): string | undefined {
  return name?.split(',')[0]?.trim();
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

/** Matches only when both provider and target carry namespace-qualified type names. */
function matchesFullCSharpDeclaringTypeName(symbolTypeName: string, targetTypeName: string): boolean {
  const symbolName = normalizeCSharpQualifiedName(symbolTypeName) ?? symbolTypeName;
  const targetName = normalizeCSharpQualifiedName(targetTypeName) ?? targetTypeName;
  if (!symbolName.includes('.') || !targetName.includes('.')) {
    return false;
  }

  return csharpSymbolKey(symbolName) === csharpSymbolKey(targetName);
}

/** Returns the final segment of a namespace-qualified C# type name. */
function shortCSharpTypeName(typeName: string): string {
  const normalizedTypeName = stripCSharpAssemblyName(typeName) ?? typeName;
  return normalizedTypeName.split('.').at(-1) ?? normalizedTypeName;
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
  if (candidates.length === 0 && containsOnlyNamespaceSymbols(runtimeVscode, symbols)) {
    const workspaceTypes = await findTypesFromWorkspaceSymbols(runtimeVscode, uri);
    if (workspaceTypes.length === 1) {
      return {
        name: workspaceTypes[0].name,
        kind: 'class',
        namespace: namespaceFromFullTypeName(workspaceTypes[0].fullName, workspaceTypes[0].name),
        position: workspaceTypes[0].range.start,
        nameRange: workspaceTypes[0].range
      };
    }
  }
  throwIfNamespaceOnlyDocumentSymbols(runtimeVscode, uri, symbols, candidates.length, 'primary top-level type');

  if (candidates.length !== 1) {
    return undefined;
  }

  return createTypeSnapshot(candidates[0]);
}

/** Extracts a namespace from a provider-backed full type name. */
function namespaceFromFullTypeName(fullName: string, name: string): string | undefined {
  const suffix = `.${name}`;
  return fullName.endsWith(suffix)
    ? normalizeCSharpNamespaceName(fullName.slice(0, -suffix.length))
    : undefined;
}

/** Checks provider hover/detail text for UnityEvent or UnityEvent<T> type evidence. */
function isUnityEventTypeText(value: string): boolean {
  return /(?:^|[^A-Za-z0-9_.])(?:UnityEngine\.Events\.)?UnityEvent(?:\s*<|\b)/.test(value);
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
