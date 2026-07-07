import type { UnityMetadataIndex } from '../../unity/metadataIndex';
import {
  getUnityYamlSerializedScriptDocuments,
  parseUnityYamlAsset
} from '../../unity/unityYaml';
import type { UnityYamlDocument, UnityYamlSerializedScriptDocument } from '../../unity/unityYaml';
import type { UnitySerializedAssetKind } from '../serialized-assets/model';
import { gameObjectClassId } from '../event-references/runtime';
import {
  getUnityYamlDocumentScalar
} from '../../unity/unityYaml';
import { createEmptySerializedInstanceDiagnostics } from './diagnostics';
import type { UnitySerializedInstanceDiagnostics, UnitySerializedInstanceLocation } from './model';

interface SerializedObjectRecord {
  classId: number;
  fileId: string;
  name?: string;
}

interface SerializedScriptIdentity {
  scriptPath?: string;
  typeName?: string;
  source?: 'guid' | 'editorClassIdentifier';
}

/** Parses serialized MonoBehaviour instance locations from one Unity YAML asset. */
export async function parseSerializedInstancesWithDiagnostics(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>
): Promise<{
  serializedInstances: UnitySerializedInstanceLocation[];
  diagnostics: UnitySerializedInstanceDiagnostics;
}> {
  const diagnostics = createEmptySerializedInstanceDiagnostics();
  const documents = parseUnityYamlAsset(content, { profile: 'eventReferences' }).documents;
  const serializedInstances = collectSerializedInstancesFromDocuments(
    documents,
    assetPath,
    assetKind,
    metadataIndex,
    diagnostics
  );

  diagnostics.parsedYamlAssetCount += 1;
  diagnostics.serializedInstanceCount = serializedInstances.length;
  return { serializedInstances, diagnostics };
}

/** Collects serialized script instances from vendored parser AST documents. */
function collectSerializedInstancesFromDocuments(
  documents: readonly UnityYamlDocument[],
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  diagnostics: UnitySerializedInstanceDiagnostics
): UnitySerializedInstanceLocation[] {
  const locations: UnitySerializedInstanceLocation[] = [];
  const seen = new Set<string>();
  const objects = collectSerializedObjects(documents);

  for (const candidate of getUnityYamlSerializedScriptDocuments(documents)) {
    const guid = candidate.scriptReference?.guid;
    if (guid) {
      diagnostics.serializedInstanceScriptTextHitCount += 1;
    }

    const identity = resolveSerializedDocumentScriptIdentity(candidate, metadataIndex);
    if (guid && identity.scriptPath) {
      diagnostics.serializedInstanceScriptResolvedTextHitCount += 1;
    } else if (guid) {
      diagnostics.serializedInstanceScriptUnresolvedTextHitCount += 1;
    }

    trackSerializedDocumentScriptIdentity(diagnostics, candidate, identity);
    if (!identity.scriptPath && !identity.typeName) {
      continue;
    }

    const dedupeKey = `${assetPath}#${candidate.document.fileId}#${identity.scriptPath ?? identity.typeName ?? ''}`;
    if (seen.has(dedupeKey)) {
      diagnostics.serializedInstanceScriptDedupedTextHitCount += 1;
      continue;
    }

    seen.add(dedupeKey);
    locations.push({
      assetPath,
      assetKind,
      line: candidate.scriptReference?.line ?? 0,
      character: candidate.scriptReference?.character ?? 0,
      fileId: candidate.document.fileId,
      scriptPath: identity.scriptPath,
      scriptTypeName: identity.typeName,
      name: candidate.name,
      gameObjectName: getGameObjectName(objects, candidate.gameObjectFileId)
    });
  }

  return locations;
}

/** Builds a minimal object lookup for component-to-GameObject display names. */
function collectSerializedObjects(documents: readonly UnityYamlDocument[]): ReadonlyMap<string, SerializedObjectRecord> {
  const objects = new Map<string, SerializedObjectRecord>();
  for (const document of documents) {
    objects.set(document.fileId, {
      classId: document.classId,
      fileId: document.fileId,
      name: getUnityYamlDocumentScalar(document, 'm_Name')
    });
  }

  return objects;
}

/** Resolves a serialized document to a script path first, then an editor-class type fallback. */
function resolveSerializedDocumentScriptIdentity(
  candidate: UnityYamlSerializedScriptDocument,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>
): SerializedScriptIdentity {
  if (candidate.scriptReference) {
    const scriptPath = metadataIndex.getAssetPath(candidate.scriptReference.guid);
    if (scriptPath) {
      return {
        scriptPath,
        typeName: candidate.editorTypeName,
        source: 'guid'
      };
    }
  }

  if (!candidate.editorTypeName) {
    return {};
  }

  // Keep editor class identifiers as type-only evidence without waking C# providers.
  return {
    typeName: candidate.editorTypeName,
    source: 'editorClassIdentifier'
  };
}

/** Records how a serialized script document identity was resolved for diagnostics. */
function trackSerializedDocumentScriptIdentity(
  diagnostics: UnitySerializedInstanceDiagnostics,
  candidate: UnityYamlSerializedScriptDocument,
  identity: SerializedScriptIdentity
): void {
  if (identity.source === 'guid') {
    diagnostics.resolvedSerializedInstanceScriptGuidCount += 1;
  } else if (identity.source === 'editorClassIdentifier') {
    diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount += 1;
  } else if (candidate.scriptReference || candidate.editorTypeName) {
    diagnostics.unresolvedSerializedInstanceScriptCount += 1;
  }
}

/** Looks up the GameObject name for a component file ID. */
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
