/**
 * Parse Unity YAML files into internal AST.
 *
 * Unity YAML quirks handled:
 * - %YAML 1.1 / %TAG directives
 * - Multiple documents in one file (--- separators)
 * - Custom tags like !u!114 &1234567
 * - Stripped objects
 * - Flow mappings {fileID: 123, guid: abc, type: 3}
 * - Both old-style (Prefab/m_PrefabInternal) and new-style (PrefabInstance/m_CorrespondingSourceObject) formats
 */

import {
  UnityDocument,
  UnityFile,
  GameObjectNode,
  ComponentInfo,
  TransformInfo,
  PrefabInstanceInfo,
  PropertyModification,
  FileReference,
  UnityYamlParseOptions,
  UnityYamlParseProfile,
  UnitySourceLocation,
  UnityYamlSourceNode,
  UNITY_TYPE_MAP,
} from './types';

/** Parse a Unity YAML string into a UnityFile */
export function parseUnityYaml(content: string, options: UnityYamlParseOptions = {}): UnityFile {
  const context = createParserContext(content, options);
  const parsed = parseDocuments(context);

  const prefabInstances = extractPrefabInstances(parsed);
  const fileType = detectFileType(parsed, prefabInstances);

  let hierarchy: GameObjectNode | undefined;
  let variantSource: FileReference | undefined;

  if (context.profile === 'full' && fileType === 'variant') {
    const mainInstance = prefabInstances.find(pi =>
      String(pi.transformParent.fileID) === '0'
    );
    if (mainInstance) {
      variantSource = mainInstance.sourcePrefab;
    }
    // Check for added non-stripped, non-PI documents to build variant hierarchy.
    const hasAddedObjects = parsed.some(d => !d.stripped && d.typeId !== 1001);
    if (hasAddedObjects) {
      hierarchy = buildHierarchy(parsed, { findStrippedRoots: true });
    }
  } else if (context.profile === 'full') {
    // Regular prefab or scene: build hierarchy only for the full profile.
    hierarchy = buildHierarchy(parsed);
  }

  return {
    type: fileType,
    documents: parsed,
    hierarchy,
    prefabInstances,
    variantSource,
  };
}

/** Numeric metadata for one source line */
interface LineInfo {
  start: number;
  end: number;
  contentEnd: number;
  indent: number;
}

/** Runtime parser context scoped to one parse call */
interface ParserContext {
  content: string;
  lines: LineInfo[];
  profile: UnityYamlParseProfile;
  sourcePaths: readonly (readonly (string | number)[])[];
}

/** Span for a parsed key/value pair on one line */
interface KeyValueSpan {
  keyStart: number;
  keyEnd: number;
  colonOffset: number;
  valueStart: number;
  valueEnd: number;
}

/** Span for a scalar or flow value that may continue across lines */
interface ValueSpan {
  start: number;
  end: number;
  nextLine: number;
  multiLine: boolean;
}

/** Parsed inline value plus optional source children */
interface ParsedValue {
  value: any;
  children?: Record<string, UnityYamlSourceNode>;
}

/** Parsed Unity YAML document bounds */
interface DocumentSpan {
  headerLine: number;
  endLine: number;
  bodyStartLine: number;
  bodyStartOffset: number;
}

/** Creates the numeric line index used by the parser. */
function createParserContext(content: string, options: UnityYamlParseOptions): ParserContext {
  return {
    content,
    lines: createLineIndex(content),
    profile: options.profile ?? 'full',
    sourcePaths: options.sourcePaths ?? [],
  };
}

/** Builds a line table without splitting the file into line strings. */
function createLineIndex(content: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;

  while (start <= content.length) {
    let end = content.indexOf('\n', start);
    if (end === -1) {
      end = content.length;
    }

    const contentEnd = end > start && content.charCodeAt(end - 1) === 13 ? end - 1 : end;
    lines.push({
      start,
      end,
      contentEnd,
      indent: countIndent(content, start, contentEnd),
    });

    if (end === content.length) {
      break;
    }

    start = end + 1;
  }

  return lines;
}

/** Parses all document spans from the line table. */
function parseDocuments(context: ParserContext): UnityDocument[] {
  const documents: UnityDocument[] = [];
  let headerLine: number | undefined;

  for (let line = 0; line < context.lines.length; line++) {
    if (!lineStartsWith(context, line, '--- ')) {
      continue;
    }

    if (headerLine !== undefined) {
      documents.push(parseDocument(context, {
        headerLine,
        endLine: line,
        bodyStartLine: headerLine + 1,
        bodyStartOffset: context.lines[headerLine + 1]?.start ?? context.lines[headerLine].end,
      }));
    }

    headerLine = line;
  }

  if (headerLine !== undefined) {
    documents.push(parseDocument(context, {
      headerLine,
      endLine: context.lines.length,
      bodyStartLine: headerLine + 1,
      bodyStartOffset: context.lines[headerLine + 1]?.start ?? context.lines[headerLine].end,
    }));
  }

  return documents;
}

/** Parses a single document span into a UnityDocument. */
function parseDocument(context: ParserContext, document: DocumentSpan): UnityDocument {
  const { typeId, fileId, stripped } = parseHeader(context, document.headerLine);
  const { properties, bodyTypeName, typeLocation, source } = parseYamlBody(context, document);
  const typeName = bodyTypeName || UNITY_TYPE_MAP[typeId] || `Unknown_${typeId}`;

  return {
    typeId,
    typeName,
    fileId,
    stripped,
    properties,
    source: {
      header: createLocation(context, context.lines[document.headerLine].start),
      type: typeLocation,
      bodyStartLine: document.bodyStartLine,
      bodyStartOffset: document.bodyStartOffset,
      properties: source,
    },
  };
}

/** Parses a document header line. */
function parseHeader(context: ParserContext, line: number): { typeId: number; fileId: string; stripped: boolean } {
  const info = context.lines[line];
  let offset = info.start + '--- !u!'.length;
  const typeStart = offset;

  while (offset < info.contentEnd && isDigit(context.content.charCodeAt(offset))) {
    offset++;
  }

  if (offset === typeStart || context.content.charCodeAt(offset) !== 32 || context.content.charCodeAt(offset + 1) !== 38) {
    throw new Error(`Invalid document header: ${context.content.slice(info.start, info.contentEnd)}`);
  }

  const typeId = Number(context.content.slice(typeStart, offset));
  offset += 2;
  const fileIdStart = offset;
  if (context.content.charCodeAt(offset) === 45) {
    offset++;
  }
  while (offset < info.contentEnd && isDigit(context.content.charCodeAt(offset))) {
    offset++;
  }

  if (offset === fileIdStart) {
    throw new Error(`Invalid document header: ${context.content.slice(info.start, info.contentEnd)}`);
  }

  return {
    typeId,
    fileId: context.content.slice(fileIdStart, offset),
    stripped: lineContains(context, line, 'stripped', offset),
  };
}

/** Parses a document body into properties and source nodes in one pass. */
function parseYamlBody(context: ParserContext, document: DocumentSpan): {
  properties: Record<string, any>;
  bodyTypeName: string;
  typeLocation?: UnitySourceLocation;
  source: Record<string, UnityYamlSourceNode>;
} {
  const properties: Record<string, any> = {};
  const source: Record<string, UnityYamlSourceNode> = {};
  let bodyTypeName = '';
  let typeLocation: UnitySourceLocation | undefined;
  let startLine = document.bodyStartLine;

  for (let line = document.bodyStartLine; line < document.endLine; line++) {
    if (isBlankOrDirective(context, line)) {
      continue;
    }

    const span = readKeyValueSpan(context, line, context.lines[line].indent);
    if (span) {
      bodyTypeName = context.content.slice(span.keyStart, span.keyEnd);
      typeLocation = createLocation(context, span.keyStart);
    }
    startLine = line + 1;
    break;
  }

  parseIndentedBlock(context, startLine, document.endLine, 2, properties, source, true);
  return { properties, bodyTypeName, typeLocation, source };
}

/** Parses an indented mapping block. */
function parseIndentedBlock(
  context: ParserContext,
  startLine: number,
  endLine: number,
  expectedIndent: number,
  target: Record<string, any>,
  source: Record<string, UnityYamlSourceNode>,
  topLevel: boolean
): number {
  let line = startLine;

  while (line < endLine) {
    if (isBlank(context, line)) {
      line++;
      continue;
    }

    const info = context.lines[line];
    if (info.indent < expectedIndent) {
      break;
    }
    if (info.indent > expectedIndent || lineStartsWithAtContent(context, line, '- ')) {
      line++;
      continue;
    }

    const span = readKeyValueSpan(context, line, info.indent);
    if (!span) {
      line++;
      continue;
    }

    const key = context.content.slice(span.keyStart, span.keyEnd);
    if (!shouldMaterializeTopLevelKey(context, key, line, endLine, expectedIndent, topLevel)) {
      line = skipValueBlock(context, line, endLine, expectedIndent);
      continue;
    }

    const node = createSourceNode(context, span.keyStart, span.valueStart, span.valueEnd);
    source[key] = node;
    line = parsePropertyValue(context, line, endLine, expectedIndent, span, target, key, node);
  }

  return line;
}

/** Parses the value of one mapping property and writes it into the target object. */
function parsePropertyValue(
  context: ParserContext,
  line: number,
  endLine: number,
  expectedIndent: number,
  span: KeyValueSpan,
  target: Record<string, any>,
  key: string,
  node: UnityYamlSourceNode
): number {
  if (span.valueStart >= span.valueEnd) {
    const nextLine = findNextMeaningfulLine(context, line + 1, endLine);
    if (nextLine === -1 || (context.lines[nextLine].indent <= expectedIndent && !lineStartsWithAtContent(context, nextLine, '- '))) {
      target[key] = '';
      return line + 1;
    }

    if (lineStartsWithAtContent(context, nextLine, '- ')) {
      const arr: any[] = [];
      node.items = [];
      const parsedLine = parseArray(context, nextLine, endLine, context.lines[nextLine].indent, arr, node);
      target[key] = arr;
      return parsedLine;
    }

    const nested: Record<string, any> = {};
    node.children = {};
    const parsedLine = parseIndentedBlock(context, nextLine, endLine, context.lines[nextLine].indent, nested, node.children, false);
    target[key] = nested;
    return parsedLine;
  }

  const valueSpan = collectValueSpan(context, line, endLine, span.valueStart, span.valueEnd, expectedIndent);
  const parsed = parseInlineValue(context, valueSpan.start, valueSpan.end, valueSpan.multiLine);
  target[key] = parsed.value;
  if (parsed.children) {
    node.children = parsed.children;
  }
  node.rawValue = sliceTrimmed(context, valueSpan.start, valueSpan.end);
  return valueSpan.nextLine;
}

/** Parses an array block. */
function parseArray(
  context: ParserContext,
  startLine: number,
  endLine: number,
  expectedIndent: number,
  target: any[],
  sourceNode: UnityYamlSourceNode
): number {
  let line = startLine;

  while (line < endLine) {
    if (isBlank(context, line)) {
      line++;
      continue;
    }

    const info = context.lines[line];
    if (info.indent < expectedIndent) {
      break;
    }
    if (!lineStartsWithAtContent(context, line, '- ')) {
      if (info.indent === expectedIndent) {
        break;
      }
      line++;
      continue;
    }

    const itemStart = firstContentOffset(context, line);
    const valueStart = skipSpaces(context, itemStart + 2, info.contentEnd);
    const itemNode: UnityYamlSourceNode = {
      item: createLocation(context, itemStart),
    };
    sourceNode.items ??= [];
    sourceNode.items.push(itemNode);

    if (context.content.charCodeAt(valueStart) === 123) {
      const valueSpan = collectValueSpan(context, line, endLine, valueStart, info.contentEnd, expectedIndent);
      const parsed = parseInlineValue(context, valueSpan.start, valueSpan.end, valueSpan.multiLine);
      target.push(parsed.value);
      if (parsed.children) {
        itemNode.children = parsed.children;
      }
      line = valueSpan.nextLine;
      continue;
    }

    const span = readKeyValueSpan(context, line, valueStart);
    if (!span) {
      const valueSpan = collectValueSpan(context, line, endLine, valueStart, info.contentEnd, expectedIndent);
      target.push(parseInlineValue(context, valueSpan.start, valueSpan.end, valueSpan.multiLine).value);
      line = valueSpan.nextLine;
      continue;
    }

    const obj: Record<string, any> = {};
    itemNode.children = {};
    const key = context.content.slice(span.keyStart, span.keyEnd);
    const childNode = createSourceNode(context, span.keyStart, span.valueStart, span.valueEnd);
    itemNode.children[key] = childNode;
    line = parseArrayItemFirstValue(context, line, endLine, expectedIndent, span, obj, key, childNode);
    line = parseArrayItemContinuations(context, line, endLine, expectedIndent + 2, obj, itemNode);
    target.push(obj);
  }

  return line;
}

/** Parses the first key/value pair on an array item line. */
function parseArrayItemFirstValue(
  context: ParserContext,
  line: number,
  endLine: number,
  expectedIndent: number,
  span: KeyValueSpan,
  target: Record<string, any>,
  key: string,
  node: UnityYamlSourceNode
): number {
  if (span.valueStart >= span.valueEnd) {
    const nextLine = findNextMeaningfulLine(context, line + 1, endLine);
    const continuationIndent = expectedIndent + 2;

    if (isUnityReferenceKey(key) && nextLine !== -1 && isUnityReferenceEntry(context, nextLine)) {
      const nested: Record<string, any> = {};
      node.children = {};
      const parsedLine = parseUnityReferenceBlock(context, nextLine, endLine, nested, node);
      target[key] = markFlow(nested);
      return parsedLine;
    }

    if (nextLine !== -1 && context.lines[nextLine].indent > continuationIndent && !lineStartsWithAtContent(context, nextLine, '- ')) {
      const nested: Record<string, any> = {};
      node.children = {};
      const parsedLine = parseIndentedBlock(context, nextLine, endLine, context.lines[nextLine].indent, nested, node.children, false);
      target[key] = nested;
      return parsedLine;
    }

    if (nextLine !== -1 && context.lines[nextLine].indent >= expectedIndent && lineStartsWithAtContent(context, nextLine, '- ')) {
      const arr: any[] = [];
      node.items = [];
      const parsedLine = parseArray(context, nextLine, endLine, context.lines[nextLine].indent, arr, node);
      target[key] = arr;
      return parsedLine;
    }

    target[key] = '';
    return line + 1;
  }

  const valueSpan = collectValueSpan(context, line, endLine, span.valueStart, span.valueEnd, expectedIndent);
  const parsed = parseInlineValue(context, valueSpan.start, valueSpan.end, valueSpan.multiLine);
  target[key] = parsed.value;
  if (parsed.children) {
    node.children = parsed.children;
  }
  node.rawValue = sliceTrimmed(context, valueSpan.start, valueSpan.end);
  return valueSpan.nextLine;
}

/** Parses continuation key/value lines for one object array item. */
function parseArrayItemContinuations(
  context: ParserContext,
  startLine: number,
  endLine: number,
  continuationIndent: number,
  target: Record<string, any>,
  itemNode: UnityYamlSourceNode
): number {
  let line = startLine;

  while (line < endLine) {
    if (isBlank(context, line)) {
      line++;
      continue;
    }

    const info = context.lines[line];
    if (info.indent < continuationIndent || lineStartsWithAtContent(context, line, '- ')) {
      break;
    }
    if (info.indent !== continuationIndent) {
      line++;
      continue;
    }

    const span = readKeyValueSpan(context, line, info.indent);
    if (!span) {
      line++;
      continue;
    }

    const key = context.content.slice(span.keyStart, span.keyEnd);
    const node = createSourceNode(context, span.keyStart, span.valueStart, span.valueEnd);
    itemNode.children ??= {};
    itemNode.children[key] = node;
    line = parsePropertyValue(context, line, endLine, continuationIndent, span, target, key, node);
  }

  return line;
}

/** Parses a loose Unity object reference block after an array item key. */
function parseUnityReferenceBlock(
  context: ParserContext,
  startLine: number,
  endLine: number,
  target: Record<string, any>,
  sourceNode: UnityYamlSourceNode
): number {
  let line = startLine;

  while (line < endLine && isUnityReferenceEntry(context, line)) {
    const span = readKeyValueSpan(context, line, context.lines[line].indent);
    if (!span) {
      break;
    }

    const key = context.content.slice(span.keyStart, span.keyEnd);
    const node = createSourceNode(context, span.keyStart, span.valueStart, span.valueEnd);
    const parsed = parseInlineValue(context, span.valueStart, span.valueEnd, false);
    sourceNode.children ??= {};
    sourceNode.children[key] = node;
    target[key] = parsed.value;
    line++;
  }

  return line;
}

/** Checks if a top-level key should be materialized for the selected profile. */
function shouldMaterializeTopLevelKey(
  context: ParserContext,
  key: string,
  line: number,
  endLine: number,
  expectedIndent: number,
  topLevel: boolean
): boolean {
  if (context.profile === 'full' || !topLevel) {
    return true;
  }

  if (key === 'm_Name' ||
      key === 'm_GameObject' ||
      key === 'm_Script' ||
      key === 'm_EditorClassIdentifier' ||
      key === 'm_Modification') {
    return true;
  }

  return isTopLevelSourcePathRequested(context, key) ||
    keyContainsNestedNeedle(context, line, endLine, expectedIndent, 'm_PersistentCalls');
}

/** Checks whether options requested source for a top-level key. */
function isTopLevelSourcePathRequested(context: ParserContext, key: string): boolean {
  return context.sourcePaths.some(path => path[0] === key);
}

/** Skips a non-materialized property value block. */
function skipValueBlock(context: ParserContext, line: number, endLine: number, expectedIndent: number): number {
  let nextLine = line + 1;

  while (nextLine < endLine) {
    if (isBlank(context, nextLine)) {
      nextLine++;
      continue;
    }

    const info = context.lines[nextLine];
    if (info.indent < expectedIndent || (info.indent === expectedIndent && !lineStartsWithAtContent(context, nextLine, '- '))) {
      break;
    }

    nextLine++;
  }

  return nextLine;
}

/** Checks if a property block contains a nested needle. */
function keyContainsNestedNeedle(
  context: ParserContext,
  line: number,
  endLine: number,
  expectedIndent: number,
  needle: string
): boolean {
  for (let current = line + 1; current < endLine; current++) {
    if (isBlank(context, current)) {
      continue;
    }

    const info = context.lines[current];
    if (info.indent < expectedIndent || (info.indent === expectedIndent && !lineStartsWithAtContent(context, current, '- '))) {
      return false;
    }

    if (lineContains(context, current, needle)) {
      return true;
    }
  }

  return false;
}

/** Collects the complete span for a value that may continue across lines. */
function collectValueSpan(
  context: ParserContext,
  line: number,
  endLine: number,
  valueStart: number,
  valueEnd: number,
  expectedIndent: number
): ValueSpan {
  const firstChar = context.content.charCodeAt(valueStart);

  if (firstChar === 123) {
    return collectBalancedSpan(context, line, endLine, valueStart, valueEnd, 123, 125);
  }

  if (firstChar === 91) {
    return collectBalancedSpan(context, line, endLine, valueStart, valueEnd, 91, 93);
  }

  if (firstChar === 39 || firstChar === 34) {
    return collectQuotedSpan(context, line, endLine, valueStart, valueEnd, firstChar);
  }

  let lastLine = line;
  let lastEnd = valueEnd;
  let nextLine = line + 1;

  while (nextLine < endLine) {
    if (isBlank(context, nextLine)) {
      break;
    }

    const info = context.lines[nextLine];
    if (info.indent <= expectedIndent || lineStartsWithAtContent(context, nextLine, '- ')) {
      break;
    }

    lastLine = nextLine;
    lastEnd = info.contentEnd;
    nextLine++;
  }

  return {
    start: valueStart,
    end: lastEnd,
    nextLine: lastLine + 1,
    multiLine: lastLine !== line,
  };
}

/** Collects a balanced flow mapping or sequence span. */
function collectBalancedSpan(
  context: ParserContext,
  line: number,
  endLine: number,
  valueStart: number,
  valueEnd: number,
  openChar: number,
  closeChar: number
): ValueSpan {
  let depth = 0;
  let inQuote = 0;

  for (let currentLine = line; currentLine < endLine; currentLine++) {
    const info = context.lines[currentLine];
    const start = currentLine === line ? valueStart : info.start;

    for (let offset = start; offset < info.contentEnd; offset++) {
      const code = context.content.charCodeAt(offset);
      if (inQuote !== 0) {
        if (code === inQuote) {
          inQuote = 0;
        }
        continue;
      }

      if (code === 39 || code === 34) {
        inQuote = code;
      } else if (code === openChar) {
        depth++;
      } else if (code === closeChar) {
        depth--;
        if (depth === 0) {
          return {
            start: valueStart,
            end: offset + 1,
            nextLine: currentLine + 1,
            multiLine: currentLine !== line,
          };
        }
      }
    }
  }

  return { start: valueStart, end: valueEnd, nextLine: line + 1, multiLine: false };
}

/** Collects a quoted scalar span across lines. */
function collectQuotedSpan(
  context: ParserContext,
  line: number,
  endLine: number,
  valueStart: number,
  valueEnd: number,
  quote: number
): ValueSpan {
  for (let currentLine = line; currentLine < endLine; currentLine++) {
    const info = context.lines[currentLine];
    const start = currentLine === line ? valueStart + 1 : info.start;

    for (let offset = start; offset < info.contentEnd; offset++) {
      if (context.content.charCodeAt(offset) === quote && context.content.charCodeAt(offset - 1) !== 92) {
        return {
          start: valueStart,
          end: offset + 1,
          nextLine: currentLine + 1,
          multiLine: currentLine !== line,
        };
      }
    }
  }

  return { start: valueStart, end: valueEnd, nextLine: line + 1, multiLine: false };
}

/** Parses an inline scalar, flow mapping, or flow sequence from a source span. */
function parseInlineValue(context: ParserContext, start: number, end: number, multiLine: boolean): ParsedValue {
  const trimmed = trimSpan(context, start, end);
  if (trimmed.start >= trimmed.end) {
    return { value: '' };
  }

  const firstChar = context.content.charCodeAt(trimmed.start);
  const lastChar = context.content.charCodeAt(trimmed.end - 1);

  if (firstChar === 123) {
    const parsed = parseFlowMapping(context, trimmed.start, trimmed.end);
    if (multiLine) {
      markMultiLine(parsed.value);
    }
    return parsed;
  }

  if (firstChar === 91 && lastChar === 93) {
    return { value: parseFlowSequence(context, trimmed.start, trimmed.end) };
  }

  const raw = context.content.slice(trimmed.start, trimmed.end);
  if ((firstChar === 39 && lastChar === 39) || (firstChar === 34 && lastChar === 34)) {
    return { value: raw };
  }

  return { value: parseScalar(raw) };
}

/** Parses a YAML flow mapping directly from a source span. */
function parseFlowMapping(context: ParserContext, start: number, end: number): ParsedValue {
  const result: Record<string, any> = {};
  const children: Record<string, UnityYamlSourceNode> = {};
  const innerStart = skipSpaces(context, start + 1, end);
  const innerEnd = trimEnd(context, innerStart, end - 1);

  forEachFlowPart(context, innerStart, innerEnd, 44, part => {
    const colon = findTopLevelColon(context, part.start, part.end);
    if (colon === -1) {
      return;
    }

    const keySpan = trimSpan(context, part.start, colon);
    const valueSpan = trimSpan(context, colon + 1, part.end);
    if (keySpan.start >= keySpan.end) {
      return;
    }

    const key = context.content.slice(keySpan.start, keySpan.end);
    const parsed = parseInlineValue(context, valueSpan.start, valueSpan.end, part.multiLine);
    const node = createSourceNode(context, keySpan.start, valueSpan.start, valueSpan.end);
    if (parsed.children) {
      node.children = parsed.children;
    }
    node.rawValue = sliceTrimmed(context, valueSpan.start, valueSpan.end);
    children[key] = node;
    result[key] = parsed.value;
  });

  markFlow(result);
  return { value: result, children };
}

/** Parses a YAML flow sequence directly from a source span. */
function parseFlowSequence(context: ParserContext, start: number, end: number): any[] {
  const values: any[] = [];
  const innerStart = skipSpaces(context, start + 1, end);
  const innerEnd = trimEnd(context, innerStart, end - 1);

  forEachFlowPart(context, innerStart, innerEnd, 44, part => {
    values.push(parseInlineValue(context, part.start, part.end, part.multiLine).value);
  });

  return values;
}

/** Iterates comma-delimited flow parts without materializing an intermediate array. */
function forEachFlowPart(
  context: ParserContext,
  start: number,
  end: number,
  delimiter: number,
  callback: (part: { start: number; end: number; multiLine: boolean }) => void
): void {
  let partStart = start;
  let depth = 0;
  let inQuote = 0;
  let partHasNewline = false;

  for (let offset = start; offset < end; offset++) {
    const code = context.content.charCodeAt(offset);
    if (code === 10) {
      partHasNewline = true;
    }

    if (inQuote !== 0) {
      if (code === inQuote) {
        inQuote = 0;
      }
      continue;
    }

    if (code === 39 || code === 34) {
      inQuote = code;
    } else if (code === 123 || code === 91) {
      depth++;
    } else if (code === 125 || code === 93) {
      depth--;
    } else if (code === delimiter && depth === 0) {
      const part = trimSpan(context, partStart, offset);
      if (part.start < part.end) {
        callback({ ...part, multiLine: partHasNewline });
      }
      partStart = offset + 1;
      partHasNewline = false;
    }
  }

  const part = trimSpan(context, partStart, end);
  if (part.start < part.end) {
    callback({ ...part, multiLine: partHasNewline });
  }
}

/** Finds a top-level colon in a flow mapping part. */
function findTopLevelColon(context: ParserContext, start: number, end: number): number {
  let depth = 0;
  let inQuote = 0;

  for (let offset = start; offset < end; offset++) {
    const code = context.content.charCodeAt(offset);
    if (inQuote !== 0) {
      if (code === inQuote) {
        inQuote = 0;
      }
      continue;
    }

    if (code === 39 || code === 34) {
      inQuote = code;
    } else if (code === 123 || code === 91) {
      depth++;
    } else if (code === 125 || code === 93) {
      depth--;
    } else if (code === 58 && depth === 0) {
      return offset;
    }
  }

  return -1;
}

/** Parses a scalar string using the previous numeric-preservation rules. */
function parseScalar(raw: string): any {
  if (/^-?\d+$/.test(raw)) {
    if (raw === '-0') return raw;
    if (raw.length > 1 && raw.startsWith('0')) return raw;
    const n = parseInt(raw, 10);
    return Math.abs(n) > Number.MAX_SAFE_INTEGER ? raw : n;
  }

  if (/^-?\d*\.\d+$/.test(raw)) {
    const f = parseFloat(raw);
    return String(f) !== raw ? raw : f;
  }
  if (/^-?\d+\.\d*e[+-]?\d+$/i.test(raw)) return parseFloat(raw);
  if (/^-?0$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

/** Mark a flow mapping object as originally multi-line */
function markMultiLine(obj: Record<string, any>): Record<string, any> {
  Object.defineProperty(obj, '__multiLine', { value: true, enumerable: false, writable: false });
  return obj;
}

/** Mark an object as originally parsed from a flow mapping (inline {}) */
function markFlow(obj: Record<string, any>): Record<string, any> {
  Object.defineProperty(obj, '__flow', { value: true, enumerable: false, writable: false });
  return obj;
}

/** Check if a key usually represents a Unity object reference */
function isUnityReferenceKey(key: string): boolean {
  return key === 'm_Target' ||
    key === 'target' ||
    key === 'objectReference' ||
    key.endsWith('Object') ||
    key.endsWith('Prefab') ||
    key.endsWith('Asset');
}

/** Check if a line is one field of a Unity object reference block */
function isUnityReferenceEntry(context: ParserContext, line: number): boolean {
  const span = readKeyValueSpan(context, line, context.lines[line].indent);
  if (!span) {
    return false;
  }

  const keyLength = span.keyEnd - span.keyStart;
  return (keyLength === 6 && context.content.startsWith('fileID', span.keyStart)) ||
    (keyLength === 4 && context.content.startsWith('guid', span.keyStart)) ||
    (keyLength === 4 && context.content.startsWith('type', span.keyStart));
}

/** Reads a key/value pair from a line starting at a known content offset. */
function readKeyValueSpan(context: ParserContext, line: number, contentStart: number): KeyValueSpan | undefined {
  const info = context.lines[line];
  const keyStart = skipSpaces(context, Math.max(info.start, contentStart), info.contentEnd);
  const colonOffset = context.content.indexOf(':', keyStart);

  if (colonOffset === -1 || colonOffset >= info.contentEnd) {
    return undefined;
  }

  const keyEnd = trimEnd(context, keyStart, colonOffset);
  return {
    keyStart,
    keyEnd,
    colonOffset,
    valueStart: skipSpaces(context, colonOffset + 1, info.contentEnd),
    valueEnd: info.contentEnd,
  };
}

/** Creates a source node for a parsed key/value span. */
function createSourceNode(context: ParserContext, keyStart: number, valueStart: number, valueEnd: number): UnityYamlSourceNode {
  return {
    key: createLocation(context, keyStart),
    value: createLocation(context, valueStart),
    rawValue: sliceTrimmed(context, valueStart, valueEnd),
  };
}

/** Creates a source location from an absolute offset. */
function createLocation(context: ParserContext, offset: number): UnitySourceLocation {
  const line = findLineForOffset(context, offset);
  return {
    line,
    character: offset - context.lines[line].start,
    offset,
  };
}

/** Finds the line index for an absolute offset. */
function findLineForOffset(context: ParserContext, offset: number): number {
  let low = 0;
  let high = context.lines.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const info = context.lines[mid];
    if (offset < info.start) {
      high = mid - 1;
    } else if (offset > info.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  return Math.max(0, Math.min(context.lines.length - 1, low));
}

/** Finds the next non-blank line within a range. */
function findNextMeaningfulLine(context: ParserContext, startLine: number, endLine: number): number {
  for (let line = startLine; line < endLine; line++) {
    if (!isBlank(context, line)) {
      return line;
    }
  }

  return -1;
}

/** Counts leading indentation without slicing. */
function countIndent(content: string, start: number, end: number): number {
  let offset = start;
  while (offset < end && (content.charCodeAt(offset) === 32 || content.charCodeAt(offset) === 9)) {
    offset++;
  }
  return offset - start;
}

/** Returns true when a character code is an ASCII digit. */
function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Returns the first non-space offset in a line. */
function firstContentOffset(context: ParserContext, line: number): number {
  const info = context.lines[line];
  return info.start + info.indent;
}

/** Checks whether a line starts with text at its first content offset. */
function lineStartsWithAtContent(context: ParserContext, line: number, text: string): boolean {
  return context.content.startsWith(text, firstContentOffset(context, line));
}

/** Checks whether a line starts with text at its raw start offset. */
function lineStartsWith(context: ParserContext, line: number, text: string): boolean {
  return context.content.startsWith(text, context.lines[line].start);
}

/** Checks whether a line contains text within its content range. */
function lineContains(context: ParserContext, line: number, text: string, fromOffset?: number): boolean {
  const info = context.lines[line];
  const start = Math.max(fromOffset ?? info.start, info.start);
  const lastStart = info.contentEnd - text.length;

  for (let offset = start; offset <= lastStart; offset++) {
    if (context.content.startsWith(text, offset)) {
      return true;
    }
  }

  return false;
}

/** Checks whether a line is blank. */
function isBlank(context: ParserContext, line: number): boolean {
  return firstContentOffset(context, line) >= context.lines[line].contentEnd;
}

/** Checks whether a line is blank or a YAML directive. */
function isBlankOrDirective(context: ParserContext, line: number): boolean {
  return isBlank(context, line) || context.content.charCodeAt(firstContentOffset(context, line)) === 37;
}

/** Skips spaces inside an offset range. */
function skipSpaces(context: ParserContext, start: number, end: number): number {
  let offset = start;
  while (offset < end && (context.content.charCodeAt(offset) === 32 || context.content.charCodeAt(offset) === 9)) {
    offset++;
  }
  return offset;
}

/** Trims trailing spaces inside an offset range. */
function trimEnd(context: ParserContext, start: number, end: number): number {
  let offset = end;
  while (offset > start && (context.content.charCodeAt(offset - 1) === 32 || context.content.charCodeAt(offset - 1) === 9)) {
    offset--;
  }
  return offset;
}

/** Returns a trimmed span for a range. */
function trimSpan(context: ParserContext, start: number, end: number): { start: number; end: number } {
  const trimmedStart = skipSpaces(context, start, end);
  return {
    start: trimmedStart,
    end: trimEnd(context, trimmedStart, end),
  };
}

/** Returns the trimmed text for a source range. */
function sliceTrimmed(context: ParserContext, start: number, end: number): string {
  const span = trimSpan(context, start, end);
  return context.content.slice(span.start, span.end);
}
/** Extract PrefabInstance info from parsed documents */
function extractPrefabInstances(docs: UnityDocument[]): PrefabInstanceInfo[] {
  return docs
    .filter(d => d.typeId === 1001 && (d.typeName === 'PrefabInstance' || d.typeName === 'Prefab'))
    .filter(d => {
      const props = d.properties;
      // Only PrefabInstance documents that have modifications (not old-style Prefab root)
      return props.m_Modification || props.m_SourcePrefab;
    })
    .map(d => {
      const props = d.properties;
      const mod = props.m_Modification || {};

      // Handle old format (m_ParentPrefab) vs new format (m_SourcePrefab)
      const sourcePrefab = props.m_SourcePrefab || props.m_ParentPrefab || { fileID: '0' };

      const modifications: PropertyModification[] = (mod.m_Modifications || []).map((m: any) => ({
        target: m.target || { fileID: '0' },
        propertyPath: m.propertyPath || '',
        value: String(m.value ?? ''),
        objectReference: m.objectReference || { fileID: '0' },
      }));

      return {
        fileId: d.fileId,
        sourcePrefab: sourcePrefab as FileReference,
        transformParent: (mod.m_TransformParent || { fileID: '0' }) as FileReference,
        modifications,
        removedComponents: (mod.m_RemovedComponents || []) as FileReference[],
      };
    });
}

/** Detect file type based on document structure */
function detectFileType(docs: UnityDocument[], prefabInstances: PrefabInstanceInfo[]): 'prefab' | 'variant' | 'scene' {
  // Scene has OcclusionCullingSettings, RenderSettings, etc.
  const hasSceneObjects = docs.some(d => [29, 104, 157, 196].includes(d.typeId));
  if (hasSceneObjects) return 'scene';

  // Variant: has a root PrefabInstance (transformParent == 0).
  // This includes both pure variants AND variants with added objects.
  const hasRootPI = prefabInstances.some(pi => String(pi.transformParent.fileID) === '0');
  if (hasRootPI) return 'variant';

  return 'prefab';
}

/** Options for buildHierarchy */
interface BuildHierarchyOptions {
  /** If true, roots are GOs whose transform m_Father points to a stripped transform (for variant added objects) */
  findStrippedRoots?: boolean;
}

/** Build the GameObject hierarchy from parsed documents */
function buildHierarchy(docs: UnityDocument[], options?: BuildHierarchyOptions): GameObjectNode | undefined {
  // Index documents by fileId
  const byId = new Map<string, UnityDocument>();
  for (const doc of docs) {
    byId.set(doc.fileId, doc);
  }

  // Find all GameObjects
  const gameObjects = docs.filter(d => d.typeId === 1 && !d.stripped);
  if (gameObjects.length === 0) return undefined;

  // Find all Transforms/RectTransforms, including stripped transforms needed for hierarchy.
  const transforms = docs.filter(d => (d.typeId === 4 || d.typeId === 224));

  // Build a map: GO fileId -> Transform doc
  const goToTransform = new Map<string, UnityDocument>();
  for (const t of transforms) {
    const goRef = t.properties.m_GameObject;
    if (goRef && goRef.fileID) {
      goToTransform.set(String(goRef.fileID), t);
    }
  }

  // Build a map: Transform fileId -> children transform fileIds
  const transformChildren = new Map<string, string[]>();
  const transformParent = new Map<string, string>();

  for (const t of transforms) {
    const children = t.properties.m_Children;
    if (Array.isArray(children)) {
      const childIds = children.map((c: any) => String(c.fileID)).filter((id: string) => id !== '0');
      transformChildren.set(t.fileId, childIds);
      for (const childId of childIds) {
        transformParent.set(childId, t.fileId);
      }
    }

    const father = t.properties.m_Father;
    if (father && String(father.fileID) !== '0') {
      transformParent.set(t.fileId, String(father.fileID));
    }
  }

  // Build component map: GO fileId -> Component docs.
  // The GameObject's m_Component list is the authoritative attachment list;
  // m_GameObject back-references can be missing or unusable in some files.
  const goToComponents = new Map<string, UnityDocument[]>();
  const goComponentIds = new Map<string, Set<string>>();

  function isAttachableComponent(doc: UnityDocument): boolean {
    return doc.typeId !== 1 &&
      doc.typeId !== 4 &&
      doc.typeId !== 224 &&
      doc.typeId !== 1001 &&
      !doc.stripped;
  }

  function referencedComponentId(entry: any): string | undefined {
    const ref = entry?.component || entry;
    if (!ref || ref.fileID === undefined || ref.fileID === null) return undefined;
    const id = String(ref.fileID);
    return id === '0' ? undefined : id;
  }

  function addComponentToGameObject(goId: string, componentDoc: UnityDocument): void {
    if (!goToComponents.has(goId)) goToComponents.set(goId, []);
    if (!goComponentIds.has(goId)) goComponentIds.set(goId, new Set());

    const seen = goComponentIds.get(goId)!;
    if (seen.has(componentDoc.fileId)) return;

    goToComponents.get(goId)!.push(componentDoc);
    seen.add(componentDoc.fileId);
  }

  for (const go of gameObjects) {
    const componentRefs = go.properties.m_Component;
    if (!Array.isArray(componentRefs)) continue;

    for (const componentRef of componentRefs) {
      const componentId = referencedComponentId(componentRef);
      if (!componentId) continue;

      const componentDoc = byId.get(componentId);
      if (!componentDoc || !isAttachableComponent(componentDoc)) continue;

      addComponentToGameObject(go.fileId, componentDoc);
    }
  }

  // Compatibility fallback for files where component docs exist but the owning
  // GameObject does not list them in m_Component.
  for (const doc of docs) {
    if (!isAttachableComponent(doc)) continue;

    const goRef = doc.properties.m_GameObject;
    if (goRef && goRef.fileID) {
      const goId = String(goRef.fileID);
      addComponentToGameObject(goId, doc);
    }
  }

  // Build nodes recursively
  function buildNode(goDoc: UnityDocument): GameObjectNode {
    const props = goDoc.properties;
    const transformDoc = goToTransform.get(goDoc.fileId);

    const components: ComponentInfo[] = [];
    const compDocs = goToComponents.get(goDoc.fileId) || [];

    for (const comp of compDocs) {
      let typeName = comp.typeName;
      let scriptGuid: string | undefined;

      if (comp.typeId === 114) {
        // MonoBehaviour components use script GUIDs for identification.
        const script = comp.properties.m_Script;
        if (script && script.guid) {
          scriptGuid = script.guid;
          typeName = script.guid; // Will be resolved later or kept as GUID
        }
      }

      // Filter out boilerplate fields
      const filteredProps: Record<string, any> = {};
      for (const [key, value] of Object.entries(comp.properties)) {
        if (!isOmittedField(key)) {
          filteredProps[key] = value;
        }
      }

      components.push({
        typeName,
        typeId: comp.typeId,
        fileId: comp.fileId,
        scriptGuid,
        properties: filteredProps,
        stripped: comp.stripped,
      });
    }

    // Build transform info
    const transformInfo: TransformInfo = {
      fileId: transformDoc?.fileId || '',
      isRect: transformDoc?.typeId === 224,
      properties: {},
    };

    if (transformDoc) {
      for (const [key, value] of Object.entries(transformDoc.properties)) {
        if (!isOmittedField(key)) {
          transformInfo.properties[key] = value;
        }
      }
    }

    // Build children
    const children: GameObjectNode[] = [];
    if (transformDoc) {
      const childTransformIds = transformChildren.get(transformDoc.fileId) || [];
      for (const childTId of childTransformIds) {
        const childTransform = byId.get(childTId);
        if (!childTransform) continue;

        if (!childTransform.stripped) {
          // Normal child
          const childGoRef = childTransform.properties.m_GameObject;
          if (childGoRef && childGoRef.fileID) {
            const childGo = byId.get(String(childGoRef.fileID));
            if (childGo && !childGo.stripped) {
              children.push(buildNode(childGo));
            }
          }
        } else {
          // Stripped children come from nested prefab instances.
          // Find the PrefabInstance that owns this stripped transform
          const prefabInstanceRef = childTransform.properties.m_PrefabInstance;
          if (prefabInstanceRef && prefabInstanceRef.fileID) {
            const prefabInstanceDoc = byId.get(String(prefabInstanceRef.fileID));
            if (prefabInstanceDoc) {
              // Get the source prefab name from modifications (m_Name property)
              const mods = prefabInstanceDoc.properties?.m_Modification?.m_Modifications || [];
              let goName = 'NestedPrefab';
              let sourceGuid = '';

              const sourcePrefab = prefabInstanceDoc.properties?.m_SourcePrefab;
              if (sourcePrefab?.guid) sourceGuid = sourcePrefab.guid;

              // Look for m_Name in modifications
              for (const mod of mods) {
                if (mod.propertyPath === 'm_Name' && mod.value) {
                  goName = String(mod.value);
                  break;
                }
              }

              // Also check for a stripped GameObject associated with this instance
              const strippedGOs = docs.filter(d =>
                d.typeId === 1 && d.stripped &&
                String(d.properties?.m_PrefabInstance?.fileID) === String(prefabInstanceRef.fileID)
              );
              if (strippedGOs.length > 0) {
                // Use the stripped GO's info
                const strippedGo = strippedGOs[0];
                children.push({
                  name: goName,
                  fileId: strippedGo.fileId,
                  components: [],
                  transform: { fileId: childTId, isRect: childTransform.typeId === 224, properties: {} },
                  children: [],
                  nestedPrefab: { instanceId: String(prefabInstanceRef.fileID), sourceGuid },
                  layer: 0,
                  isActive: true,
                });
              } else {
                children.push({
                  name: goName,
                  fileId: '0',
                  components: [],
                  transform: { fileId: childTId, isRect: childTransform.typeId === 224, properties: {} },
                  children: [],
                  nestedPrefab: { instanceId: String(prefabInstanceRef.fileID), sourceGuid },
                  layer: 0,
                  isActive: true,
                });
              }
            }
          }
        }
      }
    }

    return {
      name: props.m_Name || 'Unnamed',
      fileId: goDoc.fileId,
      components,
      transform: transformInfo,
      children,
      layer: props.m_Layer || 0,
      isActive: props.m_IsActive !== 0,
    };
  }

  // Check for old-format root (Prefab document with m_RootGameObject)
  const prefabDoc = docs.find(d => d.typeId === 1001 && d.properties.m_RootGameObject);
  let explicitRootId: string | undefined;
  if (prefabDoc?.properties.m_RootGameObject?.fileID) {
    explicitRootId = String(prefabDoc.properties.m_RootGameObject.fileID);
  }

  // Find root GameObjects
  const roots: GameObjectNode[] = [];
  if (options?.findStrippedRoots) {
    // Variant added objects: roots are GOs whose transform m_Father points to a
    // stripped transform, or root-level additions whose father is 0.
    const strippedTransformIds = new Set(
      docs.filter(d => d.stripped && (d.typeId === 4 || d.typeId === 224)).map(d => d.fileId)
    );
    for (const go of gameObjects) {
      const transformDoc = goToTransform.get(go.fileId);
      if (transformDoc) {
        const father = transformDoc.properties.m_Father;
        const fatherId = father ? String(father.fileID) : '0';
        if (fatherId === '0' || strippedTransformIds.has(fatherId)) {
          roots.push(buildNode(go));
        }
      }
    }
  } else if (explicitRootId) {
    // Old format: explicit root
    const rootGo = byId.get(explicitRootId);
    if (rootGo) {
      roots.push(buildNode(rootGo));
    }
  } else {
    // New format: root is the GO whose Transform has m_Father: {fileID: 0}
    for (const go of gameObjects) {
      const transformDoc = goToTransform.get(go.fileId);
      if (transformDoc) {
        const father = transformDoc.properties.m_Father;
        if (!father || String(father.fileID) === '0') {
          roots.push(buildNode(go));
        }
      }
    }
  }

  // For prefabs, there should be exactly one root
  if (roots.length === 1) return roots[0];

  // For scenes or multiple roots / multiple added roots, create a virtual root
  if (roots.length > 1) {
    return {
      name: '__added_root__',
      fileId: '0',
      components: [],
      transform: { fileId: '0', isRect: false, properties: {} },
      children: roots,
      layer: 0,
      isActive: true,
    };
  }

  return undefined;
}

function isOmittedField(key: string): boolean {
  const OMIT = new Set([
    'm_ObjectHideFlags',
    'm_CorrespondingSourceObject',
    'm_PrefabInstance',
    'm_PrefabAsset',
    'm_PrefabInternal',
    'm_PrefabParentObject',
    'serializedVersion',
    'm_EditorHideFlags',
    'm_EditorClassIdentifier',
    'm_Script',
    'm_Name',
    'm_GameObject',
    'm_Father',
    'm_Children',
    'm_RootOrder',
    'm_Component',
    'm_TagString',
    'm_Icon',
    'm_NavMeshLayer',
    'm_StaticEditorFlags',
    'm_LocalEulerAnglesHint',
  ]);
  return OMIT.has(key);
}
