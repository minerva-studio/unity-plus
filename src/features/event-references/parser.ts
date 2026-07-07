import type { UnityMetadataIndex } from '../../unity/metadataIndex';
import {
  getUnityYamlDocumentFileId,
  getUnityYamlDocumentScalar,
  getUnityYamlDocumentScriptReference,
  getUnityYamlPersistentCalls,
  getUnityYamlPrefabOverridePersistentCalls,
  parseUnityYamlAsset
} from '../../unity/unityYaml';
import type { UnityYamlDocument, UnityYamlPersistentCall } from '../../unity/unityYaml';
import { createEmptyDiagnostics } from './diagnostics';
import type { UnityEventReference, UnityEventReferenceDiagnostics, UnitySerializedAssetKind } from './model';
import { gameObjectClassId, monoBehaviourClassId } from './runtime';
import { isUnityBuiltInTargetTypeName, simplifyAssemblyTypeName } from './targetTypes';

interface SerializedObjectRecord {
  classId: number;
  fileId: string;
  name?: string;
  gameObjectFileId?: string;
  scriptGuid?: string;
  editorClassIdentifier?: string;
  editorTypeName?: string;
  scriptLine?: number;
  scriptCharacter?: number;
}

interface SerializedObjectScriptIdentity {
  scriptPath?: string;
  typeName?: string;
  source?: 'guid' | 'editorClassIdentifier';
}

type PersistentCallSnapshot = UnityYamlPersistentCall;

/** Parses UnityEvent persistent-call references from one serialized Unity asset. */
export async function parseUnityEventReferences(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => string | undefined | Promise<string | undefined> = () => undefined
): Promise<UnityEventReference[]> {
  return (await parseUnityEventReferencesCore(content, assetPath, assetKind, metadataIndex, async fullTypeName =>
    await resolveCSharpType(fullTypeName)
  )).references;
}

/** Parses references and serialized instances while returning scan diagnostics for index builds. */
export async function parseUnityEventReferencesWithDiagnostics(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{
  references: UnityEventReference[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  return await parseUnityEventReferencesCore(content, assetPath, assetKind, metadataIndex, resolveCSharpType);
}

/** Parses references from an already parsed Unity YAML document snapshot. */
export async function parseUnityEventReferencesFromParsedDocuments(
  content: string,
  documents: readonly UnityYamlDocument[],
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{
  references: UnityEventReference[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  return await collectUnityEventReferencesFromDocuments(
    content,
    documents,
    assetPath,
    assetKind,
    metadataIndex,
    resolveCSharpType
  );
}

/** Shares YAML parsing between the public parser and diagnostics-aware index path. */
async function parseUnityEventReferencesCore(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{
  references: UnityEventReference[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  const documents = parseUnityYamlAsset(content, { profile: 'eventReferences' }).documents;
  return await collectUnityEventReferencesFromDocuments(content, documents, assetPath, assetKind, metadataIndex, resolveCSharpType);
}

/** Collects UnityEvent references from parsed YAML documents without reparsing text. */
async function collectUnityEventReferencesFromDocuments(
  content: string,
  documents: readonly UnityYamlDocument[],
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{
  references: UnityEventReference[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  const diagnostics = createEmptyDiagnostics();
  const objects = new Map<string, SerializedObjectRecord>();
  const callsByDocument = new Map<string, PersistentCallSnapshot[]>();
  const shouldParseUnityEventCalls = needsHeavyUnityEventParsing(content);

  diagnostics.parsedYamlAssetCount += 1;

  if (!shouldParseUnityEventCalls) {
    diagnostics.skippedUnityEventAssetCount += 1;
  } else {
    diagnostics.parsedUnityEventAssetCount += 1;
  }

  for (const document of documents) {
    const object = parseSerializedObject(document);
    objects.set(document.fileId, object);

    if (!shouldParseUnityEventCalls) {
      continue;
    }

    const calls = getUnityYamlPersistentCalls(document);
    if (calls.length > 0) {
      callsByDocument.set(document.fileId, calls);
      diagnostics.persistentCallCount += calls.length;
    }

    const overrideCalls = getUnityYamlPrefabOverridePersistentCalls(document);
    for (const call of overrideCalls) {
      const calls = callsByDocument.get(call.ownerFileId ?? document.fileId) ?? [];
      calls.push(call);
      callsByDocument.set(call.ownerFileId ?? document.fileId, calls);
      diagnostics.persistentCallCount += 1;
    }
  }

  const references: UnityEventReference[] = [];
  for (const [ownerFileId, calls] of callsByDocument) {
    for (const call of calls) {
      if (call.callState === 0) {
        diagnostics.skippedDisabledCallCount += 1;
        continue;
      }

      if (!call.methodName) {
        diagnostics.skippedMissingMethodNameCount += 1;
        continue;
      }

      const targetTypeName = simplifyAssemblyTypeName(call.targetTypeName);
      const target = call.targetFileId ? objects.get(call.targetFileId) : undefined;
      const owner = call.ownerFileId ? objects.get(call.ownerFileId) : objects.get(ownerFileId);
      const ownerIdentity = await resolveSerializedObjectScriptIdentity(owner, metadataIndex, resolveCSharpType);
      trackOwnerScriptIdentity(diagnostics, owner, ownerIdentity);

      const eventScriptPath = ownerIdentity.scriptPath;
      const eventOwnerTypeName = ownerIdentity.typeName;
      const resolvedTargetTypeName = targetTypeName || '';
      let scriptPath: string | undefined;
      let resolvedByTargetTypeName = false;
      const scriptTypeName = resolvedTargetTypeName;

      if (!resolvedTargetTypeName) {
        diagnostics.skippedMissingTargetTypeNameCount += 1;
      } else if (!isUnityBuiltInTargetTypeName(resolvedTargetTypeName)) {
        if (target) {
          // Prefer the target component's MonoScript GUID because it is already
          // present in Unity YAML and avoids waking the C# server for every call.
          scriptPath = (await resolveSerializedObjectScriptIdentity(target, metadataIndex, resolveCSharpType)).scriptPath;
        }

        if (!scriptPath) {
          scriptPath = await resolveCSharpType(resolvedTargetTypeName);
          resolvedByTargetTypeName = scriptPath !== undefined;
        }
      }

      if (resolvedByTargetTypeName) {
        diagnostics.resolvedByTargetTypeNameCount += 1;
      } else if (resolvedTargetTypeName && !scriptPath) {
        diagnostics.skippedUnresolvedTargetTypeNameCount += 1;
      }

      if (!eventScriptPath && !eventOwnerTypeName && !resolvedTargetTypeName) {
        continue;
      }

      references.push({
        assetPath,
        assetKind,
        line: call.line,
        character: call.character,
        eventFieldName: call.eventFieldName,
        eventScriptPath,
        eventOwnerTypeName,
        gameObjectName: getGameObjectName(objects, target?.gameObjectFileId ?? owner?.gameObjectFileId),
        targetFileId: call.targetFileId,
        targetTypeName: resolvedTargetTypeName,
        methodName: call.methodName,
        scriptPath,
        scriptTypeName
      });
    }
  }

  diagnostics.resolvedReferenceCount = references.length;
  return { references, diagnostics };
}


function parseSerializedObject(document: UnityYamlDocument): SerializedObjectRecord {
  const scriptReference = document.classId === monoBehaviourClassId
    ? getUnityYamlDocumentScriptReference(document)
    : undefined;
  const editorClassIdentifier = getUnityYamlDocumentScalar(document, 'm_EditorClassIdentifier');

  return {
    classId: document.classId,
    fileId: document.fileId,
    name: getUnityYamlDocumentScalar(document, 'm_Name'),
    gameObjectFileId: getUnityYamlDocumentFileId(document, 'm_GameObject'),
    scriptGuid: scriptReference?.guid,
    editorClassIdentifier,
    editorTypeName: parseEditorClassIdentifier(editorClassIdentifier),
    scriptLine: scriptReference?.line,
    scriptCharacter: scriptReference?.character
  };
}

/** Checks whether an asset may contain UnityEvent call data before extracting call helpers. */
function needsHeavyUnityEventParsing(content: string): boolean {
  return content.includes('m_PersistentCalls') ||
    (content.includes('propertyPath:') && content.includes('.m_PersistentCalls.'));
}

/** Resolves a serialized owner object to a script path or editor-class type fallback. */
async function resolveSerializedObjectScriptIdentity(
  object: SerializedObjectRecord | undefined,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<SerializedObjectScriptIdentity> {
  if (!object || object.classId !== monoBehaviourClassId) {
    return {};
  }

  if (object.scriptGuid) {
    const scriptPath = metadataIndex.getAssetPath(object.scriptGuid);
    if (scriptPath) {
      return {
        scriptPath,
        typeName: object.editorTypeName,
        source: 'guid'
      };
    }
  }

  if (!object.editorTypeName) {
    return {};
  }

  // Unity sometimes preserves the type in m_EditorClassIdentifier even when the MonoScript GUID is not indexed.
  return {
    scriptPath: await resolveCSharpType(object.editorTypeName),
    typeName: object.editorTypeName,
    source: 'editorClassIdentifier'
  };
}

/** Records how a UnityEvent owner script identity was resolved. */
function trackOwnerScriptIdentity(
  diagnostics: UnityEventReferenceDiagnostics,
  object: SerializedObjectRecord | undefined,
  identity: SerializedObjectScriptIdentity
): void {
  if (!object || object.classId !== monoBehaviourClassId) {
    return;
  }

  if (identity.source === 'guid') {
    diagnostics.resolvedOwnerScriptGuidCount += 1;
  } else if (identity.source === 'editorClassIdentifier') {
    diagnostics.resolvedOwnerEditorClassIdentifierCount += 1;
  } else if (object.scriptGuid || object.editorTypeName) {
    diagnostics.unresolvedOwnerScriptCount += 1;
  }
}

/** Looks up the GameObject name for a component or target object file ID. */
function getGameObjectName(
  objects: ReadonlyMap<string, SerializedObjectRecord>,
  gameObjectFileId: string | undefined
): string | undefined {
  if (!gameObjectFileId) {
    return undefined;
  }

  const gameObject = objects.get(gameObjectFileId);
  return gameObject?.classId === gameObjectClassId ? gameObject.name : undefined;
}

/** Extracts the managed type name stored in Unity's editor class identifier field. */
function parseEditorClassIdentifier(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const separatorIndex = trimmed.lastIndexOf('::');
  return separatorIndex === -1
    ? trimmed
    : trimmed.slice(separatorIndex + 2).trim();
}
