import type * as vscode from 'vscode';

export interface CSharpMethodSnapshot {
  name: string;
  typeName?: string;
  range: vscode.Range;
}

export interface CSharpFieldSnapshot {
  name: string;
  typeName?: string;
  range: vscode.Range;
}

export interface CSharpTypeSnapshot {
  name: string;
  fullName: string;
  range: vscode.Range;
  offset: number;
}

interface CSharpMethodDeclaration {
  name: string;
  nameStart: number;
  nameEnd: number;
}

interface CSharpTypeBodyDeclaration {
  shortName: string;
  fullName: string;
  bodyStart: number;
  bodyEnd: number;
}

const csharpMethodNameCandidatePattern = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^;{}()[\]\n]*>)?\s*\(/g;
const unityEventTokenPattern = /(?:UnityEngine\.Events\.)?UnityEvent\b/g;
const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*/y;
const csharpMethodNameKeywordPattern = /^(?:if|for|foreach|while|switch|catch|using|lock|return|throw|yield|await|new|nameof|typeof|sizeof|default|checked|unchecked|fixed|base|this)$/;
const csharpNonDeclarationPrefixKeywordPattern = /\b(?:if|for|foreach|while|switch|catch|using|lock|return|throw|yield|await|new)\b/;

/** Finds C# method declarations that can receive UnityEvent reference CodeLens entries. */
export function findCSharpMethods(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpMethodSnapshot[] {
  const text = document.getText();
  const types = findCSharpTypes(runtimeVscode, document);
  return findCSharpMethodDeclarations(text).map(declaration => {
    const nameStart = declaration.nameStart;
    const start = document.positionAt(nameStart);
    const end = document.positionAt(declaration.nameEnd);
    return {
      name: declaration.name,
      typeName: findNearestCSharpType(types, nameStart)?.fullName,
      range: new runtimeVscode.Range(start, end)
    };
  });
}

/** Finds C# type declarations that can anchor serialized instance CodeLens entries. */
export function findCSharpTypes(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpTypeSnapshot[] {
  const text = document.getText();
  const namespaceMatches = [...text.matchAll(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[;{])/g)];
  const fileScopedNamespace = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(text)?.[1];
  const typePattern = /\b(?:public|private|protected|internal|abstract|sealed|static|partial|new|\s)*(?:class|struct|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const types: CSharpTypeSnapshot[] = [];
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(text))) {
    const name = match[1];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const start = document.positionAt(nameStart);
    const end = document.positionAt(nameStart + name.length);
    const namespaceName = fileScopedNamespace ?? findNearestNamespace(namespaceMatches, match.index);
    types.push({
      name,
      fullName: namespaceName ? `${namespaceName}.${name}` : name,
      offset: nameStart,
      range: new runtimeVscode.Range(start, end)
    });
  }

  return types;
}

/** Finds UnityEvent field declarations that can receive field reference CodeLens entries. */
export function findUnityEventFields(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpFieldSnapshot[] {
  const text = document.getText();
  const types = findCSharpTypes(runtimeVscode, document);
  const fields: CSharpFieldSnapshot[] = [];

  unityEventTokenPattern.lastIndex = 0;
  while (unityEventTokenPattern.exec(text)) {
    const nameStart = findUnityEventFieldNameStart(text, unityEventTokenPattern.lastIndex);
    if (nameStart === undefined) {
      continue;
    }

    const name = readIdentifierAt(text, nameStart);
    if (!name) {
      continue;
    }

    const start = document.positionAt(nameStart);
    const end = document.positionAt(nameStart + name.length);
    fields.push({
      name,
      typeName: findNearestCSharpType(types, nameStart)?.fullName,
      range: new runtimeVscode.Range(start, end)
    });
  }

  return fields;
}

/** Finds the method declaration under a hover or CodeLens position. */
export function findMethodAtPosition(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  position: vscode.Position
): CSharpMethodSnapshot | undefined {
  return findCSharpMethods(runtimeVscode, document).find(method =>
    method.range.start.line === position.line &&
    method.range.start.character <= position.character &&
    position.character <= method.range.end.character
  );
}

/** Finds the UnityEvent field declaration under a hover or CodeLens position. */
export function findUnityEventFieldAtPosition(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  position: vscode.Position
): CSharpFieldSnapshot | undefined {
  return findUnityEventFields(runtimeVscode, document).find(field =>
    field.range.start.line === position.line &&
    field.range.start.character <= position.character &&
    position.character <= field.range.end.character
  );
}

/** Finds a YAML target method declaration inside the C# type named by m_TargetAssemblyTypeName. */
export function findCSharpTargetMethodPosition(
  runtimeVscode: typeof vscode,
  content: string,
  targetTypeName: string,
  methodName: string
): vscode.Position | undefined {
  const targetType = findCSharpTargetTypeBody(content, targetTypeName);
  if (!targetType) {
    return undefined;
  }

  const declaration = findCSharpMethodDeclarations(content, methodName).find(candidate =>
    candidate.nameStart > targetType.bodyStart && candidate.nameStart < targetType.bodyEnd
  );
  if (!declaration) {
    return undefined;
  }

  return positionAtOffset(runtimeVscode, content, declaration.nameStart);
}

/** Finds a method declaration anywhere in a C# source string. */
export function findCSharpMethodPosition(
  runtimeVscode: typeof vscode,
  content: string,
  methodName: string
): vscode.Position | undefined {
  const declaration = findCSharpMethodDeclarations(content, methodName)[0];
  return declaration ? positionAtOffset(runtimeVscode, content, declaration.nameStart) : undefined;
}

/** Converts a source offset into a VS Code position without opening a document. */
function positionAtOffset(runtimeVscode: typeof vscode, content: string, offset: number): vscode.Position {
  const line = countLineBreaks(content, 0, offset);
  const previousLineBreak = content.lastIndexOf('\n', offset - 1);
  const character = offset - previousLineBreak - 1;
  return new runtimeVscode.Position(line, character);
}

/** Finds C# method declarations without treating ordinary calls as Unity target methods. */
function findCSharpMethodDeclarations(text: string, methodName?: string): CSharpMethodDeclaration[] {
  const declarations: CSharpMethodDeclaration[] = [];
  let match: RegExpExecArray | null;

  csharpMethodNameCandidatePattern.lastIndex = 0;
  while ((match = csharpMethodNameCandidatePattern.exec(text))) {
    const name = match[1];
    if (methodName && name !== methodName) {
      continue;
    }

    const nameStart = match.index;
    const openParen = match.index + match[0].lastIndexOf('(');
    if (!isCSharpMethodDeclarationCandidate(text, name, nameStart, openParen)) {
      continue;
    }

    declarations.push({
      name,
      nameStart,
      nameEnd: nameStart + name.length
    });
  }

  return declarations;
}

/** Validates a method-name candidate against declaration-only C# syntax markers. */
function isCSharpMethodDeclarationCandidate(
  text: string,
  name: string,
  nameStart: number,
  openParen: number
): boolean {
  if (csharpMethodNameKeywordPattern.test(name) || !hasCSharpMethodDeclarationPrefix(text, nameStart)) {
    return false;
  }

  const closeParen = findMatchingParenthesis(text, openParen);
  if (closeParen === -1) {
    return false;
  }

  const terminator = skipCSharpMethodConstraints(text, skipWhitespace(text, closeParen + 1));
  return text[terminator] === '{' ||
    text[terminator] === ';' ||
    (text[terminator] === '=' && text[terminator + 1] === '>');
}

/** Checks the text before a candidate method name for declaration shape instead of call shape. */
function hasCSharpMethodDeclarationPrefix(text: string, nameStart: number): boolean {
  const previousTokenOffset = findPreviousNonWhitespaceOffset(text, nameStart - 1);
  if (previousTokenOffset === undefined) {
    return false;
  }

  const previousChar = text[previousTokenOffset];
  if (!/[A-Za-z0-9_\]>]/.test(previousChar)) {
    return false;
  }

  const lineStart = text.lastIndexOf('\n', nameStart - 1) + 1;
  const prefix = text.slice(lineStart, nameStart).trim();
  if (!prefix || prefix.includes('=') || csharpNonDeclarationPrefixKeywordPattern.test(prefix)) {
    return false;
  }

  return true;
}

/** Finds the previous non-whitespace character offset before a parser cursor. */
function findPreviousNonWhitespaceOffset(text: string, offset: number): number | undefined {
  for (let index = offset; index >= 0; index -= 1) {
    if (!/\s/.test(text[index])) {
      return index;
    }
  }

  return undefined;
}

/** Finds a balanced closing parenthesis for a C# parameter list candidate. */
function findMatchingParenthesis(text: string, openParen: number): number {
  let depth = 0;

  for (let index = openParen; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = skipQuotedCSharpLiteral(text, index);
      continue;
    }

    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

/** Skips over a quoted C# literal while scanning a candidate method signature. */
function skipQuotedCSharpLiteral(text: string, quoteOffset: number): number {
  const quote = text[quoteOffset];

  for (let index = quoteOffset + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }

    if (text[index] === quote) {
      return index;
    }
  }

  return text.length - 1;
}

/** Skips simple C# generic constraints between a parameter list and declaration body. */
function skipCSharpMethodConstraints(text: string, offset: number): number {
  let cursor = offset;
  if (!text.startsWith('where ', cursor)) {
    return cursor;
  }

  while (cursor < text.length) {
    if (text[cursor] === '{' || text[cursor] === ';' || (text[cursor] === '=' && text[cursor + 1] === '>')) {
      return cursor;
    }

    cursor += 1;
  }

  return cursor;
}

/** Finds the nearest type declaration before a source offset. */
function findNearestCSharpType(types: readonly CSharpTypeSnapshot[], offset: number): CSharpTypeSnapshot | undefined {
  let nearest: CSharpTypeSnapshot | undefined;

  for (const type of types) {
    if (type.offset > offset) {
      break;
    }

    nearest = type;
  }

  return nearest;
}

/** Finds the source offset where a UnityEvent field name starts. */
function findUnityEventFieldNameStart(text: string, offset: number): number | undefined {
  let cursor = skipWhitespace(text, offset);

  if (text[cursor] === '<') {
    cursor = skipGenericArguments(text, cursor);
    if (cursor === -1) {
      return undefined;
    }
  }

  cursor = skipWhitespace(text, cursor);
  return readIdentifierAt(text, cursor) ? cursor : undefined;
}

/** Skips nested generic argument lists after UnityEvent tokens. */
function skipGenericArguments(text: string, offset: number): number {
  let depth = 0;

  // Generic UnityEvent arguments can be nested, so keep a tiny balanced scanner instead of a single regex.
  for (let index = offset; index < text.length; index += 1) {
    if (text[index] === '<') {
      depth += 1;
    } else if (text[index] === '>') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    } else if ((text[index] === ';' || text[index] === '\n') && depth > 0) {
      return -1;
    }
  }

  return -1;
}

/** Skips whitespace from a parser cursor. */
function skipWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  return cursor;
}

/** Reads one C# identifier from a source offset. */
function readIdentifierAt(text: string, offset: number): string | undefined {
  identifierPattern.lastIndex = offset;
  return identifierPattern.exec(text)?.[0];
}

/** Finds the C# type body that corresponds to a YAML target assembly type name. */
function findCSharpTargetTypeBody(content: string, targetTypeName: string): CSharpTypeBodyDeclaration | undefined {
  return findCSharpTypeBodyDeclarations(content).find(type =>
    typeKey(type.fullName) === typeKey(targetTypeName) ||
    typeKey(type.shortName) === typeKey(shortTypeName(targetTypeName))
  );
}

/** Parses C# type declarations with body spans for target-method declaration lookup. */
function findCSharpTypeBodyDeclarations(content: string): CSharpTypeBodyDeclaration[] {
  const declarations: CSharpTypeBodyDeclaration[] = [];
  const namespaceMatches = [...content.matchAll(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[;{])/g)];
  const fileScopedNamespace = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(content)?.[1];
  const typePattern = /\b(?:public|private|protected|internal|abstract|sealed|static|partial|new|\s)*(?:class|struct|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(content))) {
    const shortName = match[1];
    const bodyStart = content.indexOf('{', typePattern.lastIndex);
    if (bodyStart === -1) {
      continue;
    }

    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd === -1) {
      continue;
    }

    const namespaceName = fileScopedNamespace ?? findNearestNamespace(namespaceMatches, match.index);
    declarations.push({
      shortName,
      fullName: namespaceName ? `${namespaceName}.${shortName}` : shortName,
      bodyStart,
      bodyEnd
    });
  }

  return declarations;
}

/** Finds a balanced closing brace for a C# type body candidate. */
function findMatchingBrace(text: string, openBrace: number): number {
  let depth = 0;

  for (let index = openBrace; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' || char === "'") {
      index = skipQuotedCSharpLiteral(text, index);
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

/** Finds the namespace declaration nearest to a source offset. */
function findNearestNamespace(matches: RegExpMatchArray[], offset: number): string | undefined {
  let namespaceName: string | undefined;
  for (const match of matches) {
    if ((match.index ?? 0) > offset) {
      break;
    }

    namespaceName = match[1];
  }

  return namespaceName;
}

/** Counts line breaks in a source span. */
function countLineBreaks(text: string, startOffset: number, endOffset: number): number {
  let line = 0;
  for (let index = startOffset; index < endOffset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }

  return line;
}

/** Returns the short type name from a namespace-qualified type name. */
function shortTypeName(fullTypeName: string): string {
  return fullTypeName.split('.').at(-1) ?? fullTypeName;
}

/** Normalizes type names for case-insensitive Unity YAML lookups. */
function typeKey(typeName: string): string {
  return typeName.toLowerCase();
}
