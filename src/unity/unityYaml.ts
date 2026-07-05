import {
  parseUnityYaml as parseVendoredUnityYaml
} from '../vendor/unity-yaml-bridge/unity-yaml-parser';
import {
  writeUnityYaml
} from '../vendor/unity-yaml-bridge/unity-yaml-writer';
import type {
  UnityDocument as VendoredUnityDocument,
  UnityFile as VendoredUnityFile
} from '../vendor/unity-yaml-bridge/types';

export { writeUnityYaml };
export type { VendoredUnityDocument, VendoredUnityFile };

export interface UnityYamlSourceLocation {
  line: number;
  character: number;
}

export interface UnityYamlDocument {
  classId: number;
  typeName: string;
  fileId: string;
  stripped: boolean;
  properties: Record<string, unknown>;
  body: string;
  startLine: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
}

export interface UnityYamlParsedAsset {
  file: VendoredUnityFile;
  documents: UnityYamlDocument[];
  documentsByFileId: Map<string, UnityYamlDocument>;
}

export interface UnityYamlScriptReference extends UnityYamlSourceLocation {
  guid: string;
}

export interface UnityYamlPersistentCall {
  ownerFileId?: string;
  eventFieldName: string;
  line: number;
  character: number;
  methodLine?: number;
  methodCharacter?: number;
  targetFileId?: string;
  targetTypeName: string;
  methodName: string;
  callState: number;
}

interface RawUnityYamlDocument {
  classId: number;
  fileId: string;
  stripped: boolean;
  body: string;
  startLine: number;
  bodyStartOffset: number;
  bodyEndOffset: number;
}

interface PrefabModificationSource {
  targetFileId?: string;
  propertyPath?: string;
  fallbackLocation?: UnityYamlSourceLocation;
  propertyPathLocation?: UnityYamlSourceLocation;
  valueLocation?: UnityYamlSourceLocation;
  objectReferenceLocation?: UnityYamlSourceLocation;
}

interface PersistentCallSourceLocation extends UnityYamlSourceLocation {
  value?: string;
  targetFileId?: string;
}

const documentHeaderPattern = /^--- !u!(\d+) &(-?\d+)(?:\s+(stripped))?/gm;
const persistentCallPropertyPathPattern = /^(.+)\.m_PersistentCalls\.m_Calls\.Array\.data\[(\d+)\]\.(m_Target|m_TargetAssemblyTypeName|m_MethodName|m_CallState)$/;

/** Parses Unity YAML into the vendored AST plus source-backed document records. */
export function parseUnityYamlAsset(content: string): UnityYamlParsedAsset {
  const file = parseVendoredUnityYaml(content);
  const rawDocuments = parseRawUnityYamlDocuments(content);
  const documents = file.documents.map((document, index) => toUnityYamlDocument(document, rawDocuments[index]));
  const documentsByFileId = new Map<string, UnityYamlDocument>();

  for (const document of documents) {
    documentsByFileId.set(document.fileId, document);
  }

  return {
    file,
    documents,
    documentsByFileId
  };
}

/** Reads a direct scalar property from a Unity YAML document. */
export function getUnityYamlDocumentScalar(document: UnityYamlDocument, fieldName: string): string | undefined {
  return normalizeScalar(document.properties[fieldName]);
}

/** Reads a direct object reference fileID from a Unity YAML document. */
export function getUnityYamlDocumentFileId(document: UnityYamlDocument, fieldName: string): string | undefined {
  return getUnityYamlObjectReferenceFileId(document.properties[fieldName]);
}

/** Reads the MonoBehaviour m_Script GUID and source location from a document. */
export function getUnityYamlDocumentScriptReference(document: UnityYamlDocument): UnityYamlScriptReference | undefined {
  const guid = getUnityYamlObjectReferenceGuid(document.properties.m_Script);

  if (!guid) {
    return undefined;
  }

  const location = findGuidLocationInDocument(document, 'm_Script', guid);

  return {
    guid,
    line: location?.line ?? document.startLine,
    character: location?.character ?? 0
  };
}

/** Reads a Unity object reference fileID from an arbitrary parsed value. */
export function getUnityYamlObjectReferenceFileId(value: unknown): string | undefined {
  if (!isRecord(value) || value.fileID === undefined || value.fileID === null) {
    return undefined;
  }

  return String(value.fileID);
}

/** Reads a Unity object reference GUID from an arbitrary parsed value. */
export function getUnityYamlObjectReferenceGuid(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.guid !== 'string') {
    return undefined;
  }

  return value.guid;
}

/** Extracts normal UnityEvent persistent calls from a parsed document. */
export function getUnityYamlPersistentCalls(document: UnityYamlDocument): UnityYamlPersistentCall[] {
  const calls: UnityYamlPersistentCall[] = [];
  const sourceLocations = scanPersistentCallSourceLocations(document);

  for (const [eventFieldName, eventValue] of Object.entries(document.properties)) {
    const eventObject = asRecord(eventValue);
    const persistentCalls = asRecord(eventObject?.m_PersistentCalls);
    const persistentCallList = persistentCalls?.m_Calls;

    if (!Array.isArray(persistentCallList)) {
      continue;
    }

    persistentCallList.forEach((callValue, index) => {
      const call = asRecord(callValue);
      const methodLocation = sourceLocations.get(persistentCallLocationKey(eventFieldName, index, 'm_MethodName'));
      const targetLocation = sourceLocations.get(persistentCallLocationKey(eventFieldName, index, 'm_Target'));
      const targetTypeLocation = sourceLocations.get(persistentCallLocationKey(eventFieldName, index, 'm_TargetAssemblyTypeName'));
      const callStateLocation = sourceLocations.get(persistentCallLocationKey(eventFieldName, index, 'm_CallState'));
      const fallbackLocation = methodLocation ?? targetLocation ?? { line: document.startLine, character: 0 };

      calls.push({
        eventFieldName,
        line: fallbackLocation.line,
        character: fallbackLocation.character,
        methodLine: methodLocation?.line,
        methodCharacter: methodLocation?.character,
        targetFileId: getUnityYamlObjectReferenceFileId(call?.m_Target) ?? targetLocation?.targetFileId,
        targetTypeName: normalizeScalar(call?.m_TargetAssemblyTypeName) ?? targetTypeLocation?.value ?? '',
        methodName: normalizeScalar(call?.m_MethodName) ?? methodLocation?.value ?? '',
        callState: normalizeNumber(call?.m_CallState, normalizeNumber(callStateLocation?.value, 1))
      });
    });
  }

  return calls;
}

/** Extracts UnityEvent calls stored as PrefabInstance property modifications. */
export function getUnityYamlPrefabOverridePersistentCalls(document: UnityYamlDocument): UnityYamlPersistentCall[] {
  if (document.classId !== 1001) {
    return [];
  }

  const modificationList = asRecord(document.properties.m_Modification)?.m_Modifications;

  if (!Array.isArray(modificationList)) {
    return [];
  }

  const sources = scanPrefabModificationSourceLocations(document);
  const callsByKey = new Map<string, Partial<UnityYamlPersistentCall> & {
    fallbackLine?: number;
    fallbackCharacter?: number;
  }>();

  modificationList.forEach((modificationValue, index) => {
    const modification = asRecord(modificationValue);
    const propertyPath = normalizeScalar(modification?.propertyPath);
    const parsedPath = propertyPath ? persistentCallPropertyPathPattern.exec(propertyPath) : undefined;

    if (!parsedPath) {
      return;
    }

    const source = sources[index];
    const ownerFileId = getUnityYamlObjectReferenceFileId(modification?.target);
    const eventFieldName = parsedPath[1];
    const callIndex = parsedPath[2];
    const propertyName = parsedPath[3];
    const callKey = `${ownerFileId ?? ''}#${eventFieldName}#${callIndex}`;
    const fallback = source?.propertyPathLocation ?? source?.fallbackLocation ?? { line: document.startLine, character: 0 };
    const call = callsByKey.get(callKey) ?? {
      ownerFileId,
      eventFieldName,
      line: fallback.line,
      character: fallback.character,
      fallbackLine: fallback.line,
      fallbackCharacter: fallback.character
    };

    call.ownerFileId = ownerFileId;
    call.eventFieldName = eventFieldName;
    call.line = Math.min(call.line ?? fallback.line, fallback.line);
    call.character = call.line === fallback.line ? fallback.character : call.character;
    call.fallbackLine = Math.min(call.fallbackLine ?? fallback.line, fallback.line);
    call.fallbackCharacter = call.fallbackLine === fallback.line ? fallback.character : call.fallbackCharacter;

    if (propertyName === 'm_MethodName') {
      const location = source?.valueLocation ?? fallback;
      call.methodName = normalizeScalar(modification?.value) ?? '';
      call.methodLine = location.line;
      call.methodCharacter = location.character;
      call.line = location.line;
      call.character = location.character;
    } else if (propertyName === 'm_TargetAssemblyTypeName') {
      call.targetTypeName = normalizeScalar(modification?.value) ?? '';
    } else if (propertyName === 'm_Target') {
      call.targetFileId = getUnityYamlObjectReferenceFileId(modification?.objectReference);
    } else if (propertyName === 'm_CallState') {
      call.callState = normalizeNumber(modification?.value, 1);
    }

    callsByKey.set(callKey, call);
  });

  return [...callsByKey.values()].map(call => ({
    eventFieldName: call.eventFieldName ?? '<unknown>',
    ownerFileId: call.ownerFileId,
    line: call.methodLine ?? call.line ?? call.fallbackLine ?? document.startLine,
    character: call.methodCharacter ?? call.character ?? call.fallbackCharacter ?? 0,
    methodLine: call.methodLine,
    methodCharacter: call.methodCharacter,
    targetFileId: call.targetFileId,
    targetTypeName: call.targetTypeName ?? '',
    methodName: call.methodName ?? '',
    callState: call.callState ?? 1
  }));
}

/** Converts vendored and raw document records into the local adapter shape. */
function toUnityYamlDocument(document: VendoredUnityDocument, raw: RawUnityYamlDocument | undefined): UnityYamlDocument {
  return {
    classId: document.typeId,
    typeName: document.typeName,
    fileId: document.fileId,
    stripped: document.stripped,
    properties: document.properties,
    body: raw?.body ?? '',
    startLine: raw?.startLine ?? 0,
    bodyStartOffset: raw?.bodyStartOffset ?? 0,
    bodyEndOffset: raw?.bodyEndOffset ?? 0
  };
}

/** Parses Unity YAML document headers and raw bodies for source location lookup. */
function parseRawUnityYamlDocuments(content: string): RawUnityYamlDocument[] {
  const headers = [...content.matchAll(documentHeaderPattern)];
  const documents: RawUnityYamlDocument[] = [];
  let lineCursor = 0;
  let offsetCursor = 0;

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const next = headers[index + 1];
    const bodyStart = (header.index ?? 0) + header[0].length;
    const bodyEnd = next?.index ?? content.length;
    const startLine = lineCursor + countLineBreaks(content, offsetCursor, bodyStart);

    lineCursor = startLine;
    offsetCursor = bodyStart;

    documents.push({
      classId: Number(header[1]),
      fileId: header[2],
      stripped: header[3] === 'stripped',
      body: content.slice(bodyStart, bodyEnd),
      startLine,
      bodyStartOffset: bodyStart,
      bodyEndOffset: bodyEnd
    });
  }

  return documents;
}

/** Scans a document body for source locations of normal UnityEvent call fields. */
function scanPersistentCallSourceLocations(document: UnityYamlDocument): Map<string, PersistentCallSourceLocation> {
  const locations = new Map<string, PersistentCallSourceLocation>();
  const lines = document.body.split(/\r?\n/);
  const stack: Array<{ indent: number; key: string }> = [];
  const callIndexByField = new Map<string, number>();
  let activeEventFieldName: string | undefined;
  let currentEventFieldName: string | undefined;
  let currentCallIndex = -1;
  let pendingTarget: { eventFieldName: string; callIndex: number; indent: number; lineIndex: number } | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const absoluteLine = document.startLine + lineIndex;
    const indent = getIndent(line);
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = parseYamlKey(trimmed);

    if (!key) {
      continue;
    }

    if (pendingTarget && key === 'fileID' && lineIndex <= pendingTarget.lineIndex + 3) {
      const targetLocation = locations.get(persistentCallLocationKey(
        pendingTarget.eventFieldName,
        pendingTarget.callIndex,
        'm_Target'
      ));

      if (targetLocation) {
        targetLocation.targetFileId = valueAfterColon(trimmed);
      }
    } else if (pendingTarget && indent <= pendingTarget.indent) {
      pendingTarget = undefined;
    }

    if (key === 'm_PersistentCalls') {
      activeEventFieldName = stack[stack.length - 1]?.key;
    } else if (trimmed.startsWith('- m_Target:') && activeEventFieldName) {
      currentEventFieldName = activeEventFieldName;
      currentCallIndex = (callIndexByField.get(activeEventFieldName) ?? -1) + 1;
      callIndexByField.set(activeEventFieldName, currentCallIndex);
      locations.set(persistentCallLocationKey(activeEventFieldName, currentCallIndex, 'm_Target'), {
        line: absoluteLine,
        character: getValueCharacter(line),
        value: valueAfterColon(trimmed),
        targetFileId: extractFileIdFromLine(trimmed)
      });
      pendingTarget = {
        eventFieldName: activeEventFieldName,
        callIndex: currentCallIndex,
        indent,
        lineIndex
      };
    } else if (currentEventFieldName && currentCallIndex >= 0) {
      locations.set(persistentCallLocationKey(currentEventFieldName, currentCallIndex, key), {
        line: absoluteLine,
        character: getValueCharacter(line),
        value: valueAfterColon(trimmed)
      });
    }

    if (!trimmed.startsWith('- ')) {
      stack.push({ indent, key });
    }
  }

  return locations;
}

/** Scans a PrefabInstance document for source locations of m_Modifications entries. */
function scanPrefabModificationSourceLocations(document: UnityYamlDocument): PrefabModificationSource[] {
  const sources: PrefabModificationSource[] = [];
  const lines = document.body.split(/\r?\n/);
  let currentSource: PrefabModificationSource | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const absoluteLine = document.startLine + lineIndex;
    const trimmed = line.trim();
    const location = { line: absoluteLine, character: getValueCharacter(line) };

    if (trimmed.startsWith('- target:')) {
      currentSource = {
        targetFileId: extractFileIdFromLine(trimmed),
        fallbackLocation: location
      };
      sources.push(currentSource);
      continue;
    }

    if (!currentSource) {
      continue;
    }

    const key = parseYamlKey(trimmed);
    if (key === 'propertyPath') {
      currentSource.propertyPath = valueAfterColon(trimmed);
      currentSource.propertyPathLocation = location;
    } else if (key === 'value') {
      currentSource.valueLocation = location;
    } else if (key === 'objectReference') {
      currentSource.objectReferenceLocation = location;
    }
  }

  return sources;
}

/** Creates a stable source-location map key for a UnityEvent call field. */
function persistentCallLocationKey(eventFieldName: string, callIndex: number, key: string): string {
  return `${eventFieldName}#${callIndex}#${key}`;
}

/** Finds the exact GUID character position for a direct document field. */
function findGuidLocationInDocument(
  document: UnityYamlDocument,
  fieldName: string,
  guid: string
): UnityYamlSourceLocation | undefined {
  const lines = document.body.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const trimmed = line.trim();

    if (!trimmed.startsWith(`${fieldName}:`)) {
      continue;
    }

    const guidIndex = line.indexOf(guid);
    if (guidIndex === -1) {
      continue;
    }

    return {
      line: document.startLine + lineIndex,
      character: guidIndex
    };
  }

  return undefined;
}

/** Counts line breaks in a content slice without allocating intermediate strings. */
function countLineBreaks(content: string, start: number, end: number): number {
  let count = 0;

  for (let index = start; index < end; index += 1) {
    if (content.charCodeAt(index) === 10) {
      count += 1;
    }
  }

  return count;
}

/** Reads a YAML key from a line, including array-item key syntax. */
function parseYamlKey(trimmed: string): string | undefined {
  const normalized = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed;
  const colonIndex = normalized.indexOf(':');

  if (colonIndex <= 0) {
    return undefined;
  }

  return normalized.slice(0, colonIndex).trim();
}

/** Returns the number of leading spaces in a YAML line. */
function getIndent(line: string): number {
  const match = /^ */.exec(line);
  return match?.[0].length ?? 0;
}

/** Returns the character offset where a YAML value begins. */
function getValueCharacter(line: string): number {
  const colonIndex = line.indexOf(':');
  return colonIndex === -1 ? getIndent(line) : colonIndex + 1 + countSpacesAfter(line, colonIndex + 1);
}

/** Counts spaces after a specific character offset. */
function countSpacesAfter(value: string, start: number): number {
  let count = 0;

  for (let index = start; index < value.length && value[index] === ' '; index += 1) {
    count += 1;
  }

  return count;
}

/** Reads the raw value after the first YAML colon in a line. */
function valueAfterColon(trimmed: string): string {
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? '' : trimmed.slice(colonIndex + 1).trim();
}

/** Extracts a fileID from a Unity YAML flow mapping line. */
function extractFileIdFromLine(trimmed: string): string | undefined {
  const match = /fileID:\s*(-?\d+)/.exec(trimmed);
  return match?.[1];
}

/** Converts scalar-like parsed values into strings. */
function normalizeScalar(value: unknown): string | undefined {
  if (value === undefined || value === null || isRecord(value) || Array.isArray(value)) {
    return undefined;
  }

  return String(value);
}

/** Converts scalar-like parsed values into numbers with a fallback. */
function normalizeNumber(value: unknown, fallback: number): number {
  const scalar = normalizeScalar(value);
  const parsed = scalar === undefined ? Number.NaN : Number(scalar);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Narrows an unknown value to a string-keyed object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns an object value or undefined when the value is not object-like. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
