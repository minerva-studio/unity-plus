export type UnityScriptKind = 'MonoBehaviour' | 'ScriptableObject';

export interface UnityScriptType {
  name: string;
  namespace?: string;
  kind: UnityScriptKind;
  isPartial: boolean;
}

export interface UnityScriptDetection {
  types: UnityScriptType[];
  isSafeForAutomaticRename: boolean;
}

const classDeclarationPattern = /(?:^|[;{}\s])(?:(?:public|private|protected|internal|abstract|sealed|static|partial|new)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{}]+>)?\s*(?::\s*([^{]+))?\{/g;
const namespacePattern = /namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\{|;)/g;

export function detectUnityScriptTypes(source: string): UnityScriptDetection {
  const sanitizedSource = stripCommentsAndStrings(source);
  const types: UnityScriptType[] = [];
  let match: RegExpExecArray | null;

  while ((match = classDeclarationPattern.exec(sanitizedSource)) !== null) {
    const name = match[1];
    const baseTypes = parseBaseTypes(match[2] ?? '');
    const kind = detectUnityScriptKind(baseTypes);

    if (!kind) {
      continue;
    }

    types.push({
      name,
      namespace: findNamespaceAt(sanitizedSource, match.index),
      kind,
      isPartial: isPartialClassDeclaration(match[0])
    });
  }

  return {
    types,
    isSafeForAutomaticRename: types.length === 1 && !hasUnsafePartialOverlap(types)
  };
}

function detectUnityScriptKind(baseTypes: readonly string[]): UnityScriptKind | undefined {
  if (baseTypes.includes('MonoBehaviour')) {
    return 'MonoBehaviour';
  }

  if (baseTypes.includes('ScriptableObject')) {
    return 'ScriptableObject';
  }

  return undefined;
}

function parseBaseTypes(baseTypeList: string): string[] {
  return baseTypeList
    .split(',')
    .map(baseType => baseType.trim().split('.').pop() ?? '')
    .filter(baseType => baseType.length > 0);
}

function isPartialClassDeclaration(declaration: string): boolean {
  return /\bpartial\s+class\b/.test(declaration);
}

function hasUnsafePartialOverlap(types: readonly UnityScriptType[]): boolean {
  const partialTypeNames = new Set(types.filter(type => type.isPartial).map(type => `${type.namespace ?? ''}.${type.name}`));
  return partialTypeNames.size > 0 && types.length > 1;
}

function findNamespaceAt(source: string, offset: number): string | undefined {
  let namespaceMatch: RegExpExecArray | null;
  let currentNamespace: string | undefined;
  namespacePattern.lastIndex = 0;

  while ((namespaceMatch = namespacePattern.exec(source)) !== null && namespaceMatch.index < offset) {
    currentNamespace = namespaceMatch[1];
  }

  return currentNamespace;
}

function stripCommentsAndStrings(source: string): string {
  // Preserve whitespace shape so regex offsets still line up with nearby namespace declarations.
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|\/\*[\s\S]*?\*\//g, value => ' '.repeat(value.length));
}
