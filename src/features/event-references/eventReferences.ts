import { createRequire } from 'node:module';
import { extname } from 'node:path';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndex } from '../../unity/metadataIndex';

export type UnitySerializedAssetKind = 'prefab' | 'scene';

export interface UnityEventReference {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  eventFieldName: string;
  gameObjectName?: string;
  targetTypeName: string;
  methodName: string;
  scriptPath: string;
}

export interface UnitySerializedAssetReferenceIndex {
  getReferences(scriptPath: string, methodName: string): readonly UnityEventReference[];
  getReferenceCount(scriptPath: string, methodName: string): number;
  getAllReferences(): readonly UnityEventReference[];
  getDiagnostics(): UnityEventReferenceDiagnostics;
}

export interface UnityEventReferenceDiagnostics {
  prefabCount: number;
  sceneCount: number;
  persistentCallCount: number;
  resolvedReferenceCount: number;
  skippedDisabledCallCount: number;
  skippedMissingTargetCount: number;
  skippedMissingScriptGuidCount: number;
  skippedUnresolvedGuidCount: number;
}

export interface EventReferenceFeatureOptions {
  metadataIndex?: LazyUnityMetadataIndex;
  runtimeVscode?: typeof vscode;
  isEnabled?: () => boolean;
  findAssetFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile?: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion?: () => number;
}

interface EventReferenceRuntime {
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  metadataIndex: LazyUnityMetadataIndex;
  findAssetFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion: () => number;
}

interface SerializedDocument {
  classId: number;
  fileId: string;
  body: string;
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
}

interface SerializedObjectRecord {
  classId: number;
  fileId: string;
  name?: string;
  gameObjectFileId?: string;
  scriptGuid?: string;
}

interface PersistentCallSnapshot {
  eventFieldName: string;
  targetFileId: string;
  targetTypeName: string;
  methodName: string;
  callState: number;
}

interface CSharpMethodSnapshot {
  name: string;
  range: vscode.Range;
}

const gameObjectClassId = 1;
const monoBehaviourClassId = 114;
const assetGlob = 'Assets/**/*';
const supportedAssetExtensions = new Set(['.prefab', '.unity']);
const documentHeaderPattern = /^--- !u!(\d+) &(-?\d+)/gm;
const fileIdPattern = /fileID:\s*(-?\d+)/;
const guidPattern = /guid:\s*([a-fA-F0-9]{32})/;
const methodPattern = /\b(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial|\s)+[\w<>,\[\]\.?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

export function registerEventReferenceFeature(
  logger: UnityPlusLogger,
  options: EventReferenceFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isEnabled = options.isEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('eventReferences.enabled') === true
  );
  const disposables: vscode.Disposable[] = [];

  if (options.metadataIndex) {
    const featureRuntime: EventReferenceRuntime = {
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      getCacheVersion: options.getCacheVersion ?? (() => 0)
    };
    const provider = createEventReferenceProvider(featureRuntime, isEnabled);

    disposables.push(
      runtimeVscode.languages.registerCodeLensProvider({ language: 'csharp' }, provider),
      runtimeVscode.languages.registerHoverProvider({ language: 'csharp' }, provider)
    );
  }

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.showUnityEventReferences', async () => {
    if (!isEnabled()) {
      logger.info('UnityEvent reference lookup is disabled.');
      runtimeVscode.window.showInformationMessage('Unity Plus: UnityEvent references are disabled.');
      return;
    }

    if (!options.metadataIndex) {
      logger.warn('UnityEvent reference lookup requires a detected Unity workspace.');
      runtimeVscode.window.showWarningMessage(createMissingWorkspaceMessage(runtimeVscode));
      return;
    }

    const metadata = await options.metadataIndex.getOrBuild();
    const index = await buildUnityEventReferenceIndex({
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      getCacheVersion: options.getCacheVersion ?? (() => 0)
    }, metadata);
    const diagnostics = index.getDiagnostics();
    const summary = formatDiagnostics(diagnostics);
    logger.info(`UnityEvent reference lookup ${summary}.`);
    runtimeVscode.window.showInformationMessage(`Unity Plus: ${summary}.`);
  }));

  return runtimeVscode.Disposable.from(...disposables);
}

export async function buildUnityEventReferenceIndex(
  runtime: EventReferenceRuntime,
  metadata?: UnityMetadataIndex
): Promise<UnitySerializedAssetReferenceIndex> {
  const metadataIndex = metadata ?? await runtime.metadataIndex.getOrBuild();
  const assetFiles = await runtime.findAssetFiles(runtime.metadataIndex.root, runtime.runtimeVscode);
  const references: UnityEventReference[] = [];
  const diagnostics = createEmptyDiagnostics();

  for (const assetUri of assetFiles) {
    try {
      const assetPath = toProjectPath(runtime.metadataIndex.root, assetUri);
      const assetKind = getAssetKind(assetUri);

      if (!assetKind) {
        continue;
      }

      const content = await runtime.readTextFile(assetUri, runtime.runtimeVscode);
      incrementAssetCount(diagnostics, assetKind);
      const parsed = parseUnityEventReferencesWithDiagnostics(content, assetPath, assetKind, metadataIndex);
      mergeDiagnostics(diagnostics, parsed.diagnostics);
      references.push(...parsed.references);
    } catch (error) {
      runtime.logger.warn(`Could not scan UnityEvent references in ${assetUri.fsPath}: ${errorMessage(error)}`);
    }
  }

  diagnostics.resolvedReferenceCount = references.length;
  return createReferenceIndex(references, diagnostics);
}

export function parseUnityEventReferences(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>
): UnityEventReference[] {
  return parseUnityEventReferencesWithDiagnostics(content, assetPath, assetKind, metadataIndex).references;
}

function parseUnityEventReferencesWithDiagnostics(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>
): { references: UnityEventReference[]; diagnostics: UnityEventReferenceDiagnostics } {
  const documents = parseSerializedDocuments(content, assetPath, assetKind);
  const objects = new Map<string, SerializedObjectRecord>();
  const callsByDocument = new Map<string, PersistentCallSnapshot[]>();
  const diagnostics = createEmptyDiagnostics();

  for (const document of documents) {
    objects.set(document.fileId, parseSerializedObject(document));
    const calls = parsePersistentCalls(document.body);
    if (calls.length > 0) {
      callsByDocument.set(document.fileId, calls);
      diagnostics.persistentCallCount += calls.length;
    }
  }

  const references: UnityEventReference[] = [];
  for (const [ownerFileId, calls] of callsByDocument) {
    const owner = objects.get(ownerFileId);

    for (const call of calls) {
      if (call.callState === 0) {
        diagnostics.skippedDisabledCallCount += 1;
        continue;
      }

      if (!call.methodName || !call.targetFileId) {
        diagnostics.skippedMissingTargetCount += 1;
        continue;
      }

      const target = objects.get(call.targetFileId);
      if (!target?.scriptGuid) {
        diagnostics.skippedMissingScriptGuidCount += 1;
        continue;
      }

      const scriptPath = metadataIndex.getAssetPath(target.scriptGuid);
      if (!scriptPath) {
        diagnostics.skippedUnresolvedGuidCount += 1;
        continue;
      }

      references.push({
        assetPath,
        assetKind,
        eventFieldName: call.eventFieldName,
        gameObjectName: getGameObjectName(objects, target.gameObjectFileId ?? owner?.gameObjectFileId),
        targetTypeName: simplifyAssemblyTypeName(call.targetTypeName),
        methodName: call.methodName,
        scriptPath
      });
    }
  }

  diagnostics.resolvedReferenceCount = references.length;
  return { references, diagnostics };
}

function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider {
  let indexPromise: Promise<UnitySerializedAssetReferenceIndex> | undefined;
  let cachedVersion: number | undefined;

  async function getIndex(): Promise<UnitySerializedAssetReferenceIndex> {
    const version = runtime.getCacheVersion();
    if (!indexPromise || cachedVersion !== version) {
      cachedVersion = version;
      indexPromise = buildUnityEventReferenceIndex(runtime);
    }

    return await indexPromise;
  }

  return {
    async provideCodeLenses(document) {
      if (!isEnabled() || !isCSharpFile(document.uri)) {
        return [];
      }

      const index = await getIndex();
      const methods = findCSharpMethods(runtime.runtimeVscode, document);
      const codeLenses: vscode.CodeLens[] = [];

      for (const method of methods) {
        const count = index.getReferenceCount(toProjectPath(runtime.metadataIndex.root, document.uri), method.name);
        if (count > 0) {
          codeLenses.push(new runtime.runtimeVscode.CodeLens(method.range, {
            title: `UnityEvent references: ${count}`,
            command: 'unityPlus.showUnityEventReferences'
          }));
        }
      }

      return codeLenses;
    },
    async provideHover(document, position) {
      if (!isEnabled() || !isCSharpFile(document.uri)) {
        return undefined;
      }

      const method = findMethodAtPosition(runtime.runtimeVscode, document, position);
      if (!method) {
        return undefined;
      }

      const index = await getIndex();
      const references = index.getReferences(toProjectPath(runtime.metadataIndex.root, document.uri), method.name);
      if (references.length === 0) {
        return undefined;
      }

      return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), method.range);
    }
  };
}

function parseSerializedDocuments(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind
): SerializedDocument[] {
  const headers = [...content.matchAll(documentHeaderPattern)];
  const documents: SerializedDocument[] = [];

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const next = headers[index + 1];
    const bodyStart = header.index + header[0].length;
    const bodyEnd = next?.index ?? content.length;

    documents.push({
      classId: Number(header[1]),
      fileId: header[2],
      body: content.slice(bodyStart, bodyEnd),
      assetPath,
      assetKind
    });
  }

  return documents;
}

function parseSerializedObject(document: SerializedDocument): SerializedObjectRecord {
  return {
    classId: document.classId,
    fileId: document.fileId,
    name: findScalarValue(document.body, 'm_Name'),
    gameObjectFileId: findFileIdValue(document.body, 'm_GameObject'),
    scriptGuid: document.classId === monoBehaviourClassId ? findGuidValue(document.body, 'm_Script') : undefined
  };
}

function parsePersistentCalls(body: string): PersistentCallSnapshot[] {
  const lines = body.split(/\r?\n/);
  const calls: PersistentCallSnapshot[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let activeEventFieldName: string | undefined;
  let currentCall: Partial<PersistentCallSnapshot> | undefined;

  function flushCall(): void {
    if (currentCall?.eventFieldName && currentCall.targetFileId && currentCall.methodName) {
      calls.push({
        eventFieldName: currentCall.eventFieldName,
        targetFileId: currentCall.targetFileId,
        targetTypeName: currentCall.targetTypeName ?? '',
        methodName: currentCall.methodName,
        callState: currentCall.callState ?? 1
      });
    }
    currentCall = undefined;
  }

  for (const line of lines) {
    const indent = getIndent(line);
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      continue;
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const key = parseYamlKey(trimmed);
    if (key) {
      if (key === 'm_PersistentCalls') {
        activeEventFieldName = stack[stack.length - 1]?.key;
      } else if (trimmed.startsWith('- m_Target:')) {
        flushCall();
        currentCall = {
          eventFieldName: activeEventFieldName ?? '<unknown>',
          targetFileId: extractFileId(trimmed)
        };
      } else if (currentCall) {
        updatePersistentCall(currentCall, key, trimmed);
      }

      // The stack is intentionally small and indentation-based because Unity YAML uses stable field nesting.
      if (!trimmed.startsWith('- ')) {
        stack.push({ indent, key });
      }
    } else if (currentCall) {
      updatePersistentCall(currentCall, undefined, trimmed);
    }
  }

  flushCall();
  return calls;
}

function updatePersistentCall(
  currentCall: Partial<PersistentCallSnapshot>,
  key: string | undefined,
  trimmed: string
): void {
  if (key === 'm_Target' && !currentCall.targetFileId) {
    currentCall.targetFileId = extractFileId(trimmed);
  } else if (key === 'fileID' && !currentCall.targetFileId) {
    currentCall.targetFileId = valueAfterColon(trimmed);
  } else if (key === 'm_TargetAssemblyTypeName') {
    currentCall.targetTypeName = valueAfterColon(trimmed);
  } else if (key === 'm_MethodName') {
    currentCall.methodName = valueAfterColon(trimmed);
  } else if (key === 'm_CallState') {
    currentCall.callState = Number(valueAfterColon(trimmed));
  }
}

function createReferenceIndex(
  references: readonly UnityEventReference[],
  diagnostics: UnityEventReferenceDiagnostics = createEmptyDiagnostics()
): UnitySerializedAssetReferenceIndex {
  const referencesByKey = new Map<string, UnityEventReference[]>();

  for (const reference of references) {
    const key = referenceKey(reference.scriptPath, reference.methodName);
    const bucket = referencesByKey.get(key) ?? [];
    bucket.push(reference);
    referencesByKey.set(key, bucket);
  }

  return {
    getReferences(scriptPath, methodName) {
      return referencesByKey.get(referenceKey(scriptPath, methodName)) ?? [];
    },
    getReferenceCount(scriptPath, methodName) {
      return referencesByKey.get(referenceKey(scriptPath, methodName))?.length ?? 0;
    },
    getAllReferences() {
      return references;
    },
    getDiagnostics() {
      return diagnostics;
    }
  };
}

function createEmptyDiagnostics(): UnityEventReferenceDiagnostics {
  return {
    prefabCount: 0,
    sceneCount: 0,
    persistentCallCount: 0,
    resolvedReferenceCount: 0,
    skippedDisabledCallCount: 0,
    skippedMissingTargetCount: 0,
    skippedMissingScriptGuidCount: 0,
    skippedUnresolvedGuidCount: 0
  };
}

function incrementAssetCount(diagnostics: UnityEventReferenceDiagnostics, assetKind: UnitySerializedAssetKind): void {
  if (assetKind === 'prefab') {
    diagnostics.prefabCount += 1;
  } else {
    diagnostics.sceneCount += 1;
  }
}

function mergeDiagnostics(target: UnityEventReferenceDiagnostics, source: UnityEventReferenceDiagnostics): void {
  target.persistentCallCount += source.persistentCallCount;
  target.resolvedReferenceCount += source.resolvedReferenceCount;
  target.skippedDisabledCallCount += source.skippedDisabledCallCount;
  target.skippedMissingTargetCount += source.skippedMissingTargetCount;
  target.skippedMissingScriptGuidCount += source.skippedMissingScriptGuidCount;
  target.skippedUnresolvedGuidCount += source.skippedUnresolvedGuidCount;
}

function formatDiagnostics(diagnostics: UnityEventReferenceDiagnostics): string {
  const skipped = diagnostics.skippedDisabledCallCount +
    diagnostics.skippedMissingTargetCount +
    diagnostics.skippedMissingScriptGuidCount +
    diagnostics.skippedUnresolvedGuidCount;
  return [
    `scanned ${diagnostics.prefabCount} prefab(s) and ${diagnostics.sceneCount} scene(s)`,
    `found ${diagnostics.persistentCallCount} persistent call(s)`,
    `resolved ${diagnostics.resolvedReferenceCount} UnityEvent reference(s)`,
    `skipped ${skipped} call(s)`
  ].join(', ');
}

function createMissingWorkspaceMessage(runtimeVscode: typeof vscode): string {
  const roots = runtimeVscode.workspace.workspaceFolders
    ?.map(folder => folder.uri.fsPath)
    .join(', ') ?? '<none>';
  return `Unity Plus: open a Unity project to scan UnityEvent references. Workspace roots: ${roots}. Required markers: Assets, ProjectSettings, Packages/manifest.json.`;
}

function findCSharpMethods(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpMethodSnapshot[] {
  const text = document.getText();
  const methods: CSharpMethodSnapshot[] = [];
  let match: RegExpExecArray | null;

  methodPattern.lastIndex = 0;
  while ((match = methodPattern.exec(text))) {
    const name = match[1];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const start = document.positionAt(nameStart);
    const end = document.positionAt(nameStart + name.length);
    methods.push({ name, range: new runtimeVscode.Range(start, end) });
  }

  return methods;
}

function findMethodAtPosition(
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

function createHoverMarkdown(
  runtimeVscode: typeof vscode,
  references: readonly UnityEventReference[]
): vscode.MarkdownString {
  const markdown = new runtimeVscode.MarkdownString();
  markdown.appendMarkdown(`**UnityEvent references: ${references.length}**\n\n`);

  for (const reference of references.slice(0, 12)) {
    const location = reference.gameObjectName
      ? `${reference.assetPath} (${reference.gameObjectName})`
      : reference.assetPath;
    markdown.appendMarkdown(`- ${escapeMarkdown(location)}: ${escapeMarkdown(reference.eventFieldName)} -> ${escapeMarkdown(reference.targetTypeName)}.${escapeMarkdown(reference.methodName)}\n`);
  }

  if (references.length > 12) {
    markdown.appendMarkdown(`- ... ${references.length - 12} more\n`);
  }

  return markdown;
}

async function findDefaultAssetFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const files = await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, assetGlob));
  return files.filter(uri => supportedAssetExtensions.has(extname(uri.fsPath).toLowerCase()));
}

async function readDefaultTextFile(uri: vscode.Uri, runtimeVscode: typeof vscode): Promise<string> {
  const bytes = await runtimeVscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

function findScalarValue(body: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}:\\s*(.*)$`, 'm');
  const value = pattern.exec(body)?.[1]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function findFileIdValue(body: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}:\\s*\\{([^}]*)\\}`, 'm');
  const mapping = pattern.exec(body)?.[1];
  return mapping ? fileIdPattern.exec(mapping)?.[1] : undefined;
}

function findGuidValue(body: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}:\\s*\\{([^}]*)\\}`, 'm');
  const mapping = pattern.exec(body)?.[1];
  return mapping ? guidPattern.exec(mapping)?.[1] : undefined;
}

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

function parseYamlKey(trimmed: string): string | undefined {
  const normalized = trimmed.startsWith('- ') ? trimmed.slice(2) : trimmed;
  return /^([A-Za-z_][A-Za-z0-9_]*):/.exec(normalized)?.[1];
}

function extractFileId(text: string): string | undefined {
  return fileIdPattern.exec(text)?.[1];
}

function getIndent(line: string): number {
  return line.length - line.trimStart().length;
}

function valueAfterColon(trimmed: string): string {
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? '' : trimmed.slice(colonIndex + 1).trim();
}

function simplifyAssemblyTypeName(typeName: string): string {
  return typeName.split(',')[0]?.trim() ?? typeName;
}

function referenceKey(scriptPath: string, methodName: string): string {
  return `${toNormalizedPath(scriptPath).toLowerCase()}#${methodName}`;
}

function toProjectPath(root: vscode.Uri, uri: vscode.Uri): string {
  const rootPath = toNormalizedPath(root.fsPath);
  const path = toNormalizedPath(uri.fsPath);

  if (path.toLowerCase().startsWith(`${rootPath.toLowerCase()}/`)) {
    return path.slice(rootPath.length + 1);
  }

  return path;
}

function toNormalizedPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function getAssetKind(uri: vscode.Uri): UnitySerializedAssetKind | undefined {
  const extension = extname(uri.fsPath).toLowerCase();
  if (extension === '.prefab') {
    return 'prefab';
  }

  if (extension === '.unity') {
    return 'scene';
  }

  return undefined;
}

function isCSharpFile(uri: vscode.Uri): boolean {
  return extname(uri.fsPath).toLowerCase() === '.cs';
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
