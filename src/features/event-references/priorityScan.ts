import type * as vscode from 'vscode';
import { parseUnityMetaGuid, type UnityMetadataIndex } from '../../unity/metadataIndex';
import { getAssetKind } from './assetDiscovery';
import { findCSharpTypes } from './csharpSource';
import { createEmptyDiagnostics, mergeDiagnostics } from './diagnostics';
import type { UnityEventReference, UnitySerializedInstanceLocation } from './model';
import { parseUnityEventReferencesWithDiagnostics } from './parser';
import { createReferenceIndex, pathReferenceKey, typeKey } from './referenceIndex';
import type { EventReferenceRuntime, PriorityScanResult } from './runtime';
import { findCurrentScriptCandidateAssetFiles } from './scanner';
import { errorMessage, findNearestNamespace, isCancellationRequested, shortTypeName, throwIfCancellationRequested, toProjectPath, toWorkspaceUri, yieldToEventLoop, UnityEventReferenceScanCanceledError } from './utils';

export async function buildPriorityReferenceIndex(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<PriorityScanResult> {
  const startedAt = Date.now();
  const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
  runtime.scanStatus?.start('Reading current script metadata', 'Unity refs: current');
  runtime.scanStatus?.update({ label: 'Unity refs: current', phase: 'Reading current script metadata', scriptPath });
  const currentScriptMetadata = await resolveCurrentScriptMetadata(runtime, scriptPath);
  const metadataGuidCount = currentScriptMetadata.metadataGuidCount;
  runtime.scanStatus?.update({
    label: 'Unity refs: current',
    phase: currentScriptMetadata.scriptGuid ? 'Current script metadata ready' : 'Current script GUID missing',
    scriptPath,
    metadataGuidCount
  });
  const scriptGuid = currentScriptMetadata.scriptGuid;
  const diagnostics = createEmptyDiagnostics();

  if (!scriptGuid || isCancellationRequested(token)) {
    const reason = scriptGuid ? 'scan canceled' : 'script GUID not found in metadata index';
    diagnostics.elapsedMilliseconds = Date.now() - startedAt;
    runtime.logger.warn(`UnityEvent priority scan for ${scriptPath}: ${reason}.`);
    runtime.scanStatus?.finish('completed', diagnostics, {
      label: 'Unity refs: current',
      phase: reason,
      scriptPath,
      metadataGuidCount,
      referenceCount: 0,
      instanceCount: 0,
      elapsedMilliseconds: diagnostics.elapsedMilliseconds
    });
    return {
      index: createReferenceIndex([], [], diagnostics),
      diagnostics,
      reason
    };
  }

  runtime.scanStatus?.start('Searching current script references', 'Unity refs: current');
  runtime.scanStatus?.update({
    label: 'Unity refs: current',
    phase: 'Searching current script candidates',
    scriptPath,
    scriptGuid,
    metadataGuidCount
  });
  const discovery = await findCurrentScriptCandidateAssetFiles(runtime, scriptGuid, token);
  const candidateUris = discovery.files;
  const references: UnityEventReference[] = [];
  const serializedInstances: UnitySerializedInstanceLocation[] = [];
  const resolveCSharpType = createCurrentDocumentTypeResolver(runtime, document, scriptPath, token);
  const metadata = createPriorityMetadataIndex(scriptPath, scriptGuid, currentScriptMetadata.metadata);

  diagnostics.discoveredAssetCount = candidateUris.length;
  diagnostics.candidateAssetCount = candidateUris.length;
  diagnostics.candidateSearchBackend = discovery.backend;
  diagnostics.textCandidateSearchCount = discovery.textSearchCount;
  runtime.scanStatus?.update({
    label: 'Unity refs: current',
    phase: 'Parsing current script candidates',
    scriptPath,
    scriptGuid,
    metadataGuidCount,
    candidateCount: candidateUris.length,
    scannedCount: 0,
    totalCount: candidateUris.length,
    referenceCount: 0,
    instanceCount: 0,
    elapsedMilliseconds: Date.now() - startedAt
  });

  for (const [index, uri] of candidateUris.entries()) {
    if (isCancellationRequested(token)) {
      diagnostics.elapsedMilliseconds = Date.now() - startedAt;
      runtime.scanStatus?.finish('canceled', diagnostics, {
        label: 'Unity refs: current',
        phase: 'Canceled',
        scriptPath,
        scriptGuid,
        candidateCount: candidateUris.length,
        scannedCount: index,
        totalCount: candidateUris.length,
        referenceCount: references.length,
        instanceCount: serializedInstances.length,
        elapsedMilliseconds: diagnostics.elapsedMilliseconds
      });
      throw new UnityEventReferenceScanCanceledError();
    }

    const assetKind = getAssetKind(uri);
    if (!assetKind) {
      continue;
    }

    const content = await runtime.readTextFile(uri, runtime.runtimeVscode);
    diagnostics.assetReadCount += 1;
    if (discovery.backend === 'findFilesFallback' && !content.includes(scriptGuid)) {
      runtime.scanStatus?.update({
        label: 'Unity refs: current',
        phase: 'Filtering current script candidates',
        scriptPath,
        scriptGuid,
        metadataGuidCount,
        candidateCount: candidateUris.length,
        scannedCount: index + 1,
        totalCount: candidateUris.length,
        referenceCount: references.length,
        instanceCount: serializedInstances.length,
        elapsedMilliseconds: Date.now() - startedAt
      });
      await yieldToEventLoop();
      continue;
    }

    const assetPath = toProjectPath(runtime.metadataIndex.root, uri);
    const parsed = await parseUnityEventReferencesWithDiagnostics(content, assetPath, assetKind, metadata, resolveCSharpType);
    const locations = parsed.serializedInstances.filter(location =>
      location.scriptPath
        ? pathReferenceKey(location.scriptPath) === pathReferenceKey(scriptPath)
        : location.scriptTypeName !== undefined && isCurrentDocumentType(document, location.scriptTypeName)
    );
    const currentReferences = parsed.references.filter(reference =>
      isCurrentScriptReference(scriptPath, document, reference)
    );

    mergeDiagnostics(diagnostics, parsed.diagnostics);
    references.push(...currentReferences);
    serializedInstances.push(...locations);
    runtime.scanStatus?.update({
      label: 'Unity refs: current',
      phase: 'Parsing current script candidates',
      scriptPath,
      scriptGuid,
      metadataGuidCount,
      candidateCount: candidateUris.length,
      scannedCount: index + 1,
      totalCount: candidateUris.length,
      referenceCount: references.length,
      instanceCount: serializedInstances.length,
      elapsedMilliseconds: Date.now() - startedAt
    });
    await yieldToEventLoop();
  }

  diagnostics.resolvedReferenceCount = references.length;
  diagnostics.serializedInstanceCount = serializedInstances.length;
  diagnostics.elapsedMilliseconds = Date.now() - startedAt;
  const index = createReferenceIndex(references, serializedInstances, diagnostics);
  runtime.scanStatus?.finish('completed', diagnostics, {
    label: 'Unity refs: current',
    phase: 'Current script scan complete',
    scriptPath,
    scriptGuid,
    metadataGuidCount,
    candidateCount: candidateUris.length,
    scannedCount: candidateUris.length,
    totalCount: candidateUris.length,
    referenceCount: references.length,
    instanceCount: serializedInstances.length,
    elapsedMilliseconds: diagnostics.elapsedMilliseconds
  });
  runtime.logger.debug(`UnityEvent priority scan for ${scriptPath}: ${candidateUris.length} candidate asset(s), ${references.length} reference(s), ${serializedInstances.length} instance(s).`);
  return { index, diagnostics, scriptGuid };
}

/** Resolves the current script GUID without forcing a full Unity metadata rebuild. */
async function resolveCurrentScriptMetadata(
  runtime: EventReferenceRuntime,
  scriptPath: string
): Promise<{ scriptGuid?: string; metadata?: UnityMetadataIndex; metadataGuidCount?: number }> {
  const sidecarGuid = await readCurrentScriptSidecarGuid(runtime, scriptPath);
  const metadata = runtime.metadataIndex.isBuilt()
    ? await runtime.metadataIndex.getOrBuild()
    : undefined;

  if (sidecarGuid) {
    return {
      scriptGuid: sidecarGuid,
      metadata,
      metadataGuidCount: metadata?.getStatistics?.().parsedGuidCount
    };
  }

  if (!metadata) {
    return {};
  }

  return {
    scriptGuid: metadata.getGuid(scriptPath),
    metadata,
    metadataGuidCount: metadata.getStatistics?.().parsedGuidCount
  };
}

/** Reads Assets/Foo.cs.meta directly so priority scans avoid full metadata indexing. */
async function readCurrentScriptSidecarGuid(
  runtime: EventReferenceRuntime,
  scriptPath: string
): Promise<string | undefined> {
  try {
    const metaUri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, `${scriptPath}.meta`);
    const content = await runtime.readTextFile(metaUri, runtime.runtimeVscode);
    return parseUnityMetaGuid(content);
  } catch {
    return undefined;
  }
}

/** Creates a tiny metadata overlay that knows the current script GUID plus any ready full index. */
function createPriorityMetadataIndex(
  scriptPath: string,
  scriptGuid: string,
  metadata: UnityMetadataIndex | undefined
): Pick<UnityMetadataIndex, 'getAssetPath'> {
  return {
    getAssetPath: guid => guid.toLowerCase() === scriptGuid.toLowerCase()
      ? scriptPath
      : metadata?.getAssetPath(guid)
  };
}

/** Creates an empty priority result so failed or GUID-less scans still render zero-count feedback. */
export function createEmptyPriorityScanResult(
  runtime: EventReferenceRuntime,
  scriptPath: string,
  reason: string
): PriorityScanResult {
  const diagnostics = createEmptyDiagnostics();
  runtime.logger.debug(`UnityEvent priority scan for ${scriptPath} produced no index: ${reason}.`);
  return {
    index: createReferenceIndex([], [], diagnostics),
    diagnostics,
    reason
  };
}

/** Resolves editor-class identifiers only against the current C# file for fast priority scans. */
function createCurrentDocumentTypeResolver(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  scriptPath: string,
  token: vscode.CancellationToken
): (fullTypeName: string) => Promise<string | undefined> {
  const currentTypes = findCSharpTypes(runtime.runtimeVscode, document);

  return async fullTypeName => {
    throwIfCancellationRequested(token);

    if (currentTypes.some(type =>
      typeKey(type.fullName) === typeKey(fullTypeName) ||
      typeKey(type.name) === typeKey(shortTypeName(fullTypeName))
    )) {
      return scriptPath;
    }

    return undefined;
  };
}

/** Checks whether a Unity YAML reference belongs to the current script by path or current C# type name. */
function isCurrentScriptReference(
  scriptPath: string,
  document: vscode.TextDocument,
  reference: UnityEventReference
): boolean {
  return pathReferenceKey(reference.scriptPath ?? '') === pathReferenceKey(scriptPath) ||
    pathReferenceKey(reference.eventScriptPath ?? '') === pathReferenceKey(scriptPath) ||
    (!!reference.scriptTypeName && isCurrentDocumentType(document, reference.scriptTypeName)) ||
    (!!reference.eventOwnerTypeName && isCurrentDocumentType(document, reference.eventOwnerTypeName));
}

/** Checks whether a full type name resolves to any type declared in the current C# document. */
function isCurrentDocumentType(document: vscode.TextDocument, typeName: string): boolean {
  const text = document.getText();
  const namespaceMatches = [...text.matchAll(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[;{])/g)];
  const fileScopedNamespace = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(text)?.[1];
  const typePattern = /\b(?:public|private|protected|internal|abstract|sealed|static|partial|new|\s)*(?:class|struct|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(text))) {
    const namespaceName = fileScopedNamespace ?? findNearestNamespace(namespaceMatches, match.index);
    const fullName = namespaceName ? `${namespaceName}.${match[1]}` : match[1];
    if (typeKey(fullName) === typeKey(typeName)) {
      return true;
    }
  }

  return false;
}
