import {
  parseUnityYaml as parseVendoredUnityYaml
} from '../vendor/unity-yaml-bridge/unity-yaml-parser';
import {
  writeUnityYaml
} from '../vendor/unity-yaml-bridge/unity-yaml-writer';
import type {
  UnityDocument as VendoredUnityDocument,
  UnityFile as VendoredUnityFile,
  UnitySourceLocation,
  UnityYamlSourceNode
} from '../vendor/unity-yaml-bridge/types';

export { writeUnityYaml };
export type { VendoredUnityDocument, VendoredUnityFile };

export interface UnityYamlSourceLocation {
  line: number;
  character: number;
  offset: number;
}

export interface UnityYamlDocument {
  classId: number;
  typeName: string;
  fileId: string;
  stripped: boolean;
  properties: Record<string, unknown>;
  source?: VendoredUnityDocument['source'];
}

export interface UnityYamlParsedAsset {
  file: VendoredUnityFile;
  documents: UnityYamlDocument[];
  documentsByFileId: Map<string, UnityYamlDocument>;
}

export interface UnityYamlScriptReference extends UnityYamlSourceLocation {
  guid: string;
}

export interface UnityYamlSerializedScriptDocument {
  document: UnityYamlDocument;
  scriptReference?: UnityYamlScriptReference;
  editorClassIdentifier?: string;
  editorTypeName?: string;
  name?: string;
  gameObjectFileId?: string;
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

const persistentCallPropertyPathPattern = /^(.+)\.m_PersistentCalls\.m_Calls\.Array\.data\[(\d+)\]\.(m_Target|m_TargetAssemblyTypeName|m_MethodName|m_CallState)$/;

/** Parses Unity YAML into the vendored AST plus local document records. */
export function parseUnityYamlAsset(content: string): UnityYamlParsedAsset {
  const file = parseVendoredUnityYaml(content);
  const documents = file.documents.map(toUnityYamlDocument);
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

  const location = sourceLocationForPath(document, ['m_Script', 'guid']) ??
    sourceLocationForPath(document, ['m_Script']) ??
    documentHeaderLocation(document);

  return {
    guid,
    line: location.line,
    character: location.character,
    offset: location.offset
  };
}

/** Reads all documents that carry a serialized MonoScript reference or editor class fallback. */
export function getUnityYamlSerializedScriptDocuments(documents: readonly UnityYamlDocument[]): UnityYamlSerializedScriptDocument[] {
  const candidates: UnityYamlSerializedScriptDocument[] = [];

  for (const document of documents) {
    const editorClassIdentifier = getUnityYamlDocumentScalar(document, 'm_EditorClassIdentifier');
    const scriptReference = getUnityYamlDocumentScriptReference(document);
    const editorTypeName = parseEditorClassIdentifier(editorClassIdentifier);

    if (!scriptReference && !editorTypeName) {
      continue;
    }

    candidates.push({
      document,
      scriptReference,
      editorClassIdentifier,
      editorTypeName,
      name: getUnityYamlDocumentScalar(document, 'm_Name'),
      gameObjectFileId: getUnityYamlDocumentFileId(document, 'm_GameObject')
    });
  }

  return candidates;
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

/** Extracts normal UnityEvent persistent calls from parsed AST fields. */
export function getUnityYamlPersistentCalls(document: UnityYamlDocument): UnityYamlPersistentCall[] {
  const calls: UnityYamlPersistentCall[] = [];

  for (const [eventFieldName, eventValue] of Object.entries(document.properties)) {
    const eventObject = asRecord(eventValue);
    const persistentCalls = asRecord(eventObject?.m_PersistentCalls);
    const persistentCallList = persistentCalls?.m_Calls;

    if (!Array.isArray(persistentCallList)) {
      continue;
    }

    persistentCallList.forEach((callValue, index) => {
      const call = asRecord(callValue);
      const methodLocation = sourceLocationForPath(document, [eventFieldName, 'm_PersistentCalls', 'm_Calls', index, 'm_MethodName']);
      const targetLocation = sourceLocationForPath(document, [eventFieldName, 'm_PersistentCalls', 'm_Calls', index, 'm_Target']);
      const fallbackLocation = methodLocation ?? targetLocation ?? documentHeaderLocation(document);

      calls.push({
        eventFieldName,
        line: fallbackLocation.line,
        character: fallbackLocation.character,
        methodLine: methodLocation?.line,
        methodCharacter: methodLocation?.character,
        targetFileId: getUnityYamlObjectReferenceFileId(call?.m_Target),
        targetTypeName: normalizeScalar(call?.m_TargetAssemblyTypeName) ?? '',
        methodName: normalizeScalar(call?.m_MethodName) ?? '',
        callState: normalizeNumber(call?.m_CallState, 1)
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

    const ownerFileId = getUnityYamlObjectReferenceFileId(modification?.target);
    const eventFieldName = parsedPath[1];
    const callIndex = parsedPath[2];
    const propertyName = parsedPath[3];
    const callKey = `${ownerFileId ?? ''}#${eventFieldName}#${callIndex}`;
    const propertyPathLocation = sourceLocationForPath(document, ['m_Modification', 'm_Modifications', index, 'propertyPath']);
    const fallback = propertyPathLocation ?? documentHeaderLocation(document);
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
      const location = sourceLocationForPath(document, ['m_Modification', 'm_Modifications', index, 'value']) ?? fallback;
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
    line: call.methodLine ?? call.line ?? call.fallbackLine ?? documentHeaderLocation(document).line,
    character: call.methodCharacter ?? call.character ?? call.fallbackCharacter ?? documentHeaderLocation(document).character,
    methodLine: call.methodLine,
    methodCharacter: call.methodCharacter,
    targetFileId: call.targetFileId,
    targetTypeName: call.targetTypeName ?? '',
    methodName: call.methodName ?? '',
    callState: call.callState ?? 1
  }));
}

/** Converts a vendored document into the local adapter shape. */
function toUnityYamlDocument(document: VendoredUnityDocument): UnityYamlDocument {
  return {
    classId: document.typeId,
    typeName: document.typeName,
    fileId: document.fileId,
    stripped: document.stripped,
    properties: document.properties,
    source: document.source
  };
}

/** Finds the source location for a document property path. */
function sourceLocationForPath(
  document: UnityYamlDocument,
  path: readonly (string | number)[]
): UnityYamlSourceLocation | undefined {
  const node = sourceNodeForPath(document, path);
  const location = node?.value ?? node?.item ?? node?.key;
  return location ? toLocalLocation(location) : undefined;
}

/** Finds the source node for a document property path. */
function sourceNodeForPath(
  document: UnityYamlDocument,
  path: readonly (string | number)[]
): UnityYamlSourceNode | undefined {
  let node: UnityYamlSourceNode | undefined;
  let children = document.source?.properties;

  for (const segment of path) {
    if (typeof segment === 'number') {
      node = node?.items?.[segment];
      children = node?.children;
      continue;
    }

    node = children?.[segment];
    children = node?.children;
  }

  return node;
}

/** Returns the document header location as the last source fallback. */
function documentHeaderLocation(document: UnityYamlDocument): UnityYamlSourceLocation {
  return toLocalLocation(document.source?.header ?? { line: 0, character: 0, offset: 0 });
}

/** Converts vendored source locations to adapter source locations. */
function toLocalLocation(location: UnitySourceLocation): UnityYamlSourceLocation {
  return {
    line: location.line,
    character: location.character,
    offset: location.offset
  };
}

/** Parses Unity's editor class identifier into a C# full type name. */
function parseEditorClassIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const separatorIndex = value.indexOf('::');
  const typeName = separatorIndex === -1 ? value : value.slice(separatorIndex + 2);
  return typeName.trim() || undefined;
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
