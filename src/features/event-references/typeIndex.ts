import type { UnityEventReferenceBuildContext } from './model';
import type { CSharpTypeIndex, EventReferenceRuntime } from './runtime';
import { backgroundScanYieldEvery, defaultAssetScanConcurrency, progressReportInterval, scanYieldEvery } from './runtime';
import { getBackgroundScanConcurrency } from './settings';
import { isCancellationRequested, runWithConcurrency, shortTypeName, throwIfCancellationRequested, toProjectPath, UnityEventReferenceScanCanceledError } from './utils';

interface SourceTypeCandidate {
  name: string;
  fullName: string;
}

interface NamespaceRange {
  name: string;
  start: number;
  end: number;
  depth: number;
}

/** Builds a fallback C# type-name index from source text first, then C# language-server symbols. */
export async function buildDefaultCSharpTypeIndex(
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'metadataIndex' | 'findCSharpFiles' | 'readTextFile' | 'csharpLanguageService'>,
  context: UnityEventReferenceBuildContext = { mode: 'background' }
): Promise<CSharpTypeIndex> {
  throwIfCancellationRequested(context.cancellationToken);

  const files = await runtime.findCSharpFiles(runtime.metadataIndex.root, runtime.runtimeVscode);
  const matches: Array<{ fullName: string; shortName: string; path: string }> = [];
  let lastReportedCount = 0;

  await runWithConcurrency(files, async file => {
    throwIfCancellationRequested(context.cancellationToken);

    try {
      const path = toProjectPath(runtime.metadataIndex.root, file);
      const sourceTypes = await findSourceTypesForIndex(runtime, file);
      throwIfCancellationRequested(context.cancellationToken);

      if (sourceTypes.length > 0) {
        matches.push(...sourceTypes.map(type => ({ fullName: type.fullName, shortName: type.name, path })));
        return;
      }

      const types = await runtime.csharpLanguageService?.findTypes(file) ?? [];
      throwIfCancellationRequested(context.cancellationToken);
      matches.push(...types.map(type => ({ fullName: type.fullName, shortName: type.name, path })));
    } catch {
      if (isCancellationRequested(context.cancellationToken)) {
        throw new UnityEventReferenceScanCanceledError();
      }

      // Language-server symbol failures simply cannot contribute fallback type candidates.
    }
  }, context.mode === 'background' ? getBackgroundScanConcurrency(runtime.runtimeVscode) : defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: context.mode === 'background' ? backgroundScanYieldEvery : scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({
          message: runtime.runtimeVscode.l10n.t('Indexing C# type declarations {completedCount}/{totalCount}', {
            completedCount,
            totalCount
          })
        });
      }
    }
  });

  return createCSharpTypeIndex(matches);
}

/** Extracts top-level C# types from source text so project scans do not depend on editor symbols. */
async function findSourceTypesForIndex(
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'readTextFile'>,
  file: Parameters<EventReferenceRuntime['readTextFile']>[0]
): Promise<SourceTypeCandidate[]> {
  let source: string;

  try {
    source = await runtime.readTextFile(file, runtime.runtimeVscode);
  } catch {
    return [];
  }

  return findSourceTypes(source);
}

/** Parses namespace-qualified top-level type names from one C# source file. */
export function findSourceTypes(source: string): SourceTypeCandidate[] {
  const masked = maskCommentsAndStrings(source);
  const namespaceRanges = findNamespaceRanges(masked);
  const typePattern = /\b(?:class|struct|enum|interface|record(?:\s+(?:class|struct))?)\s+(@?[A-Za-z_][A-Za-z0-9_]*)/g;
  const candidates: SourceTypeCandidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(masked))) {
    const name = normalizeSourceIdentifier(match[1]);
    const activeNamespace = findActiveNamespace(namespaceRanges, match.index);
    const depth = getBraceDepthAt(masked, match.index);

    // Only file-level or namespace-level declarations describe Unity script types.
    if (activeNamespace) {
      if (depth !== activeNamespace.depth) {
        continue;
      }
    } else if (depth !== 0) {
      continue;
    }

    candidates.push({
      name,
      fullName: activeNamespace ? `${activeNamespace.name}.${name}` : name
    });
  }

  return candidates;
}

/** Creates lookup maps that only resolve unique full or short type names. */
function createCSharpTypeIndex(matches: readonly { fullName: string; shortName: string; path: string }[]): CSharpTypeIndex {
  const fullNameToPath = new Map<string, string | undefined>();
  const shortNameToPath = new Map<string, string | undefined>();

  for (const match of matches) {
    setUniquePath(fullNameToPath, match.fullName, match.path);
    setUniquePath(shortNameToPath, match.shortName, match.path);
  }

  return {
    resolve(fullTypeName) {
      return fullNameToPath.get(typeLookupKey(fullTypeName)) ?? shortNameToPath.get(typeLookupKey(shortTypeName(fullTypeName)));
    }
  };
}

/** Stores a path only while a type-name key remains unambiguous. */
function setUniquePath(map: Map<string, string | undefined>, key: string, path: string): void {
  const normalizedKey = typeLookupKey(key);

  if (!map.has(normalizedKey)) {
    map.set(normalizedKey, path);
    return;
  }

  if (map.get(normalizedKey) !== path) {
    map.set(normalizedKey, undefined);
  }
}

/** Normalizes serialized and source type names for resilient lookups. */
function typeLookupKey(typeName: string): string {
  return typeName.split(',')[0]?.trim().toLowerCase() ?? typeName.toLowerCase();
}

/** Finds namespace spans for both block-scoped and file-scoped C# namespace declarations. */
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

/** Returns the innermost namespace containing a source offset. */
function findActiveNamespace(ranges: readonly NamespaceRange[], index: number): NamespaceRange | undefined {
  return ranges
    .filter(range => range.start <= index && index < range.end)
    .sort((left, right) => right.start - left.start)[0];
}

/** Finds the matching close brace for a block namespace. */
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

/** Counts open braces before an offset in comment/string-masked source text. */
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

/** Removes C# comments and string contents while preserving offsets and line breaks. */
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

/** Masks a line comment without removing its trailing newline. */
function maskUntilLineEnd(characters: string[], start: number): number {
  let index = start;
  while (index < characters.length && characters[index] !== '\n') {
    characters[index] = ' ';
    index += 1;
  }

  return index;
}

/** Masks a block comment while preserving line breaks. */
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

/** Masks a normal string literal while preserving line breaks. */
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

/** Masks a verbatim string literal while preserving doubled quote escapes. */
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

/** Masks a char literal while preserving line breaks. */
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

/** Removes verbatim identifier markers from C# type names. */
function normalizeSourceIdentifier(identifier: string): string {
  return identifier.startsWith('@') ? identifier.slice(1) : identifier;
}
