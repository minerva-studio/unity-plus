import { createRequire } from 'node:module';
import { extname } from 'node:path';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndex } from '../../unity/metadataIndex';

export type UnitySerializedAssetKind = 'prefab' | 'scene';

export interface UnityEventReference {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  line: number;
  character: number;
  eventFieldName: string;
  eventScriptPath?: string;
  gameObjectName?: string;
  targetTypeName: string;
  methodName: string;
  scriptPath: string;
}

export interface UnitySerializedAssetReferenceIndex {
  getReferences(scriptPath: string, methodName: string): readonly UnityEventReference[];
  getReferenceCount(scriptPath: string, methodName: string): number;
  getFieldReferences(scriptPath: string, fieldName: string): readonly UnityEventReference[];
  getFieldReferenceCount(scriptPath: string, fieldName: string): number;
  getAllReferences(): readonly UnityEventReference[];
  getDiagnostics(): UnityEventReferenceDiagnostics;
}

export interface UnityEventReferenceDiagnostics {
  discoveredAssetCount: number;
  prefabCount: number;
  sceneCount: number;
  skippedAssetCount: number;
  canceledAssetCount: number;
  persistentCallCount: number;
  resolvedReferenceCount: number;
  resolvedByTargetTypeNameCount: number;
  skippedDisabledCallCount: number;
  skippedMissingTargetTypeNameCount: number;
  skippedUnresolvedTargetTypeNameCount: number;
  skippedMissingMethodNameCount: number;
  elapsedMilliseconds: number;
}

export interface EventReferenceFeatureOptions {
  metadataIndex?: LazyUnityMetadataIndex;
  runtimeVscode?: typeof vscode;
  isEnabled?: () => boolean;
  findAssetFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  findCSharpFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile?: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion?: () => number;
  resolveCSharpType?: CSharpTypeResolver;
  buildCSharpTypeIndex?: CSharpTypeIndexBuilder;
}

interface EventReferenceRuntime {
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  metadataIndex: LazyUnityMetadataIndex;
  findAssetFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  findCSharpFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion: () => number;
  resolveCSharpType?: CSharpTypeResolver;
  buildCSharpTypeIndex?: CSharpTypeIndexBuilder;
}

export type CSharpTypeResolver = (
  fullTypeName: string,
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'metadataIndex' | 'findCSharpFiles' | 'readTextFile'>,
  context?: UnityEventReferenceBuildContext
) => Promise<string | undefined>;

export interface CSharpTypeIndex {
  resolve(fullTypeName: string): string | undefined;
}

export type CSharpTypeIndexBuilder = (
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'metadataIndex' | 'findCSharpFiles' | 'readTextFile'>,
  context?: UnityEventReferenceBuildContext
) => Promise<CSharpTypeIndex>;

interface SerializedDocument {
  classId: number;
  fileId: string;
  body: string;
  startLine: number;
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
  line: number;
  character: number;
  methodLine?: number;
  methodCharacter?: number;
  targetFileId?: string;
  targetTypeName: string;
  methodName: string;
  callState: number;
}

interface CSharpMethodSnapshot {
  name: string;
  range: vscode.Range;
}

interface CSharpFieldSnapshot {
  name: string;
  range: vscode.Range;
}

interface EventReferenceLocationTarget {
  kind: 'method' | 'field';
  scriptPath: string;
  symbolName: string;
  position: vscode.Position;
}

type UnityEventReferenceIndexStatus = 'idle' | 'building' | 'ready' | 'failed';

interface UnityEventReferenceIndexController {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  getStatus(): UnityEventReferenceIndexStatus;
  getReadyIndex(): UnitySerializedAssetReferenceIndex | undefined;
  scheduleBuild(): void;
  forceBuild(context?: UnityEventReferenceBuildContext): Promise<UnitySerializedAssetReferenceIndex | undefined>;
}

export type UnityEventReferenceBuildMode = 'background' | 'interactive';

export interface UnityEventReferenceBuildContext {
  mode: UnityEventReferenceBuildMode;
  cancellationToken?: vscode.CancellationToken;
  progress?: vscode.Progress<{ message?: string; increment?: number }>;
}

interface RunWithConcurrencyOptions {
  cancellationToken?: vscode.CancellationToken;
  yieldEvery?: number;
  onProgress?: (completedCount: number, totalCount: number) => void;
}

const gameObjectClassId = 1;
const monoBehaviourClassId = 114;
const assetGlob = 'Assets/**/*';
const csharpGlob = 'Assets/**/*.cs';
const defaultAssetScanConcurrency = 4;
const scanYieldEvery = 4;
const progressReportInterval = 10;
const editorBuildSettingsPath = 'ProjectSettings/EditorBuildSettings.asset';
const supportedAssetExtensions = new Set(['.prefab', '.unity']);
const documentHeaderPattern = /^--- !u!(\d+) &(-?\d+)/gm;
const buildSettingsScenePathPattern = /^\s*path:\s*(Assets\/.*\.unity)\s*$/gm;
const fileIdPattern = /fileID:\s*(-?\d+)/;
const guidPattern = /guid:\s*([a-fA-F0-9]{32})/;
const methodPattern = /\b(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial|\s)+[\w<>,\[\]\.?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const unityEventFieldPattern = /\b(?:public|private|protected|internal|static|readonly|new|serializedfield|SerializeField|\s|\[[^\]]+\])*(?:UnityEngine\.Events\.)?UnityEvent(?:\s*<[^;>{}]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[=;])/g;

export function registerEventReferenceFeature(
  logger: UnityPlusLogger,
  options: EventReferenceFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isEnabled = options.isEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('eventReferences.enabled') === true
  );
  const disposables: vscode.Disposable[] = [];
  let indexController: UnityEventReferenceIndexController | undefined;

  if (options.metadataIndex) {
    const featureRuntime: EventReferenceRuntime = {
      runtimeVscode,
      logger,
      metadataIndex: options.metadataIndex,
      findAssetFiles: options.findAssetFiles ?? findDefaultAssetFiles,
      findCSharpFiles: options.findCSharpFiles ?? findDefaultCSharpFiles,
      readTextFile: options.readTextFile ?? readDefaultTextFile,
      getCacheVersion: options.getCacheVersion ?? (() => 0),
      resolveCSharpType: options.resolveCSharpType,
      buildCSharpTypeIndex: options.buildCSharpTypeIndex ?? buildDefaultCSharpTypeIndex
    };
    indexController = createEventReferenceIndexController(featureRuntime);
    const provider = createEventReferenceProvider(featureRuntime, indexController, isEnabled);

    disposables.push(
      runtimeVscode.languages.registerCodeLensProvider({ language: 'csharp' }, provider),
      runtimeVscode.languages.registerHoverProvider({ language: 'csharp' }, provider),
      runtimeVscode.commands.registerCommand('unityPlus.showUnityEventReferenceLocations', async (target: EventReferenceLocationTarget) => {
        await provider.showReferenceLocations(target);
      })
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

    const metadataIndex = options.metadataIndex;
    let canceled = false;
    const index = await runtimeVscode.window.withProgress({
      location: runtimeVscode.ProgressLocation.Notification,
      title: 'Unity Plus: scanning UnityEvent references',
      cancellable: true
    }, async (progress, cancellationToken) => {
      progress.report({ message: 'Preparing Unity metadata' });
      await metadataIndex.getOrBuild();

      if (isCancellationRequested(cancellationToken)) {
        canceled = true;
        return undefined;
      }

      const builtIndex = await indexController?.forceBuild({
        mode: 'interactive',
        cancellationToken,
        progress
      });
      canceled = isCancellationRequested(cancellationToken);
      return builtIndex;
    });

    if (!index) {
      if (canceled) {
        runtimeVscode.window.showInformationMessage('Unity Plus: UnityEvent reference scan canceled.');
        return;
      }

      runtimeVscode.window.showWarningMessage('Unity Plus: UnityEvent reference index could not be built.');
      return;
    }

    const diagnostics = index.getDiagnostics();
    const summary = formatDiagnostics(diagnostics);
    logger.info(`UnityEvent reference lookup ${summary}.`);
    runtimeVscode.window.showInformationMessage(`Unity Plus: ${summary}.`);
  }));

  return runtimeVscode.Disposable.from(...disposables);
}

export async function buildUnityEventReferenceIndex(
  runtime: EventReferenceRuntime,
  metadata?: UnityMetadataIndex,
  context: UnityEventReferenceBuildContext = { mode: 'background' }
): Promise<UnitySerializedAssetReferenceIndex> {
  const startedAt = Date.now();
  const references: UnityEventReference[] = [];
  const diagnostics = createEmptyDiagnostics();

  throwIfCancellationRequested(context.cancellationToken);
  context.progress?.report({ message: 'Finding Unity serialized assets' });

  const metadataIndex = metadata ?? await runtime.metadataIndex.getOrBuild();
  const discoveredAssetFiles = await runtime.findAssetFiles(runtime.metadataIndex.root, runtime.runtimeVscode);
  const assetFiles = await filterAssetFilesForConfiguredSceneScope(runtime, discoveredAssetFiles);
  const resolveCSharpType = await createBuildScopedTypeResolver(runtime, context);
  let lastReportedCount = 0;

  diagnostics.discoveredAssetCount = discoveredAssetFiles.length;
  diagnostics.skippedAssetCount += discoveredAssetFiles.length - assetFiles.length;

  await runWithConcurrency(assetFiles, async assetUri => {
    throwIfCancellationRequested(context.cancellationToken);

    try {
      const assetPath = toProjectPath(runtime.metadataIndex.root, assetUri);
      const assetKind = getAssetKind(assetUri);

      if (!assetKind) {
        diagnostics.skippedAssetCount += 1;
        return;
      }

      const content = await runtime.readTextFile(assetUri, runtime.runtimeVscode);
      throwIfCancellationRequested(context.cancellationToken);

      incrementAssetCount(diagnostics, assetKind);
      const parsed = await parseUnityEventReferencesWithDiagnostics(content, assetPath, assetKind, metadataIndex, resolveCSharpType);
      throwIfCancellationRequested(context.cancellationToken);

      mergeDiagnostics(diagnostics, parsed.diagnostics);
      references.push(...parsed.references);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }

      runtime.logger.warn(`Could not scan UnityEvent references in ${assetUri.fsPath}: ${errorMessage(error)}`);
    }
  }, defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({ message: `Scanning Unity serialized assets ${completedCount}/${totalCount}` });
      }
    }
  });

  if (isCancellationRequested(context.cancellationToken)) {
    diagnostics.canceledAssetCount = countUnfinishedAssets(assetFiles.length, diagnostics);
    diagnostics.elapsedMilliseconds = Date.now() - startedAt;
    throw new UnityEventReferenceScanCanceledError();
  }

  diagnostics.resolvedReferenceCount = references.length;
  diagnostics.elapsedMilliseconds = Date.now() - startedAt;
  return createReferenceIndex(references, diagnostics);
}

async function createBuildScopedTypeResolver(
  runtime: EventReferenceRuntime,
  context: UnityEventReferenceBuildContext
): Promise<(fullTypeName: string) => Promise<string | undefined>> {
  if (runtime.resolveCSharpType) {
    return async fullTypeName => {
      throwIfCancellationRequested(context.cancellationToken);
      return await runtime.resolveCSharpType?.(fullTypeName, runtime, context);
    };
  }

  let typeIndexPromise: Promise<CSharpTypeIndex> | undefined;
  return async fullTypeName => {
    throwIfCancellationRequested(context.cancellationToken);

    if (!typeIndexPromise) {
      context.progress?.report({ message: 'Indexing C# type declarations' });
      typeIndexPromise = (runtime.buildCSharpTypeIndex ?? buildDefaultCSharpTypeIndex)(runtime, context);
    }

    const typeIndex = await typeIndexPromise;
    throwIfCancellationRequested(context.cancellationToken);
    return typeIndex.resolve(fullTypeName);
  };
}

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

async function parseUnityEventReferencesWithDiagnostics(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{ references: UnityEventReference[]; diagnostics: UnityEventReferenceDiagnostics }> {
  return await parseUnityEventReferencesCore(content, assetPath, assetKind, metadataIndex, resolveCSharpType);
}

async function parseUnityEventReferencesCore(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{ references: UnityEventReference[]; diagnostics: UnityEventReferenceDiagnostics }> {
  const documents = parseSerializedDocuments(content, assetPath, assetKind);
  const objects = new Map<string, SerializedObjectRecord>();
  const callsByDocument = new Map<string, PersistentCallSnapshot[]>();
  const diagnostics = createEmptyDiagnostics();

  for (const document of documents) {
    objects.set(document.fileId, parseSerializedObject(document));
    const calls = parsePersistentCalls(document.body, document.startLine);
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

      if (!call.methodName) {
        diagnostics.skippedMissingMethodNameCount += 1;
        continue;
      }

      const targetTypeName = simplifyAssemblyTypeName(call.targetTypeName);
      if (!targetTypeName) {
        diagnostics.skippedMissingTargetTypeNameCount += 1;
        continue;
      }

      const scriptPath = await resolveCSharpType(targetTypeName);
      if (!scriptPath) {
        diagnostics.skippedUnresolvedTargetTypeNameCount += 1;
        continue;
      }

      const target = call.targetFileId ? objects.get(call.targetFileId) : undefined;
      const eventScriptPath = owner?.scriptGuid ? metadataIndex.getAssetPath(owner.scriptGuid) : undefined;
      references.push({
        assetPath,
        assetKind,
        line: call.line,
        character: call.character,
        eventFieldName: call.eventFieldName,
        eventScriptPath,
        gameObjectName: getGameObjectName(objects, target?.gameObjectFileId ?? owner?.gameObjectFileId),
        targetTypeName,
        methodName: call.methodName,
        scriptPath
      });
      diagnostics.resolvedByTargetTypeNameCount += 1;
    }
  }

  diagnostics.resolvedReferenceCount = references.length;
  return { references, diagnostics };
}

function createEventReferenceIndexController(runtime: EventReferenceRuntime): UnityEventReferenceIndexController {
  const codeLensEvents = new runtime.runtimeVscode.EventEmitter<void>();
  let status: UnityEventReferenceIndexStatus = 'idle';
  let cachedVersion: number | undefined;
  let index: UnitySerializedAssetReferenceIndex | undefined;
  let buildPromise: Promise<UnitySerializedAssetReferenceIndex | undefined> | undefined;
  let scheduledBuild = false;

  function refreshVersion(): void {
    const version = runtime.getCacheVersion();
    if (cachedVersion === version) {
      return;
    }

    cachedVersion = version;
    status = 'idle';
    index = undefined;
    buildPromise = undefined;
    scheduledBuild = false;
  }

  async function forceBuild(context: UnityEventReferenceBuildContext = { mode: 'background' }): Promise<UnitySerializedAssetReferenceIndex | undefined> {
    refreshVersion();

    if (status === 'building' && buildPromise) {
      return await buildPromise;
    }

    const buildVersion = cachedVersion;
    const previousIndex = index;
    status = 'building';
    buildPromise = buildUnityEventReferenceIndex(runtime, undefined, context)
      .then(builtIndex => {
        if (buildVersion !== runtime.getCacheVersion()) {
          status = 'idle';
          return undefined;
        }

        index = builtIndex;
        status = 'ready';
        codeLensEvents.fire();
        return builtIndex;
      })
      .catch(error => {
        if (isCancellationError(error)) {
          status = previousIndex ? 'ready' : 'idle';
          runtime.logger.info('UnityEvent reference index build canceled.');
          codeLensEvents.fire();
          return undefined;
        }

        status = 'failed';
        runtime.logger.warn(`Could not build UnityEvent reference index: ${errorMessage(error)}`);
        codeLensEvents.fire();
        return undefined;
      })
      .finally(() => {
        buildPromise = undefined;
      });

    return await buildPromise;
  }

  function scheduleBuild(): void {
    refreshVersion();
    if (scheduledBuild || status === 'building' || status === 'ready') {
      return;
    }

    scheduledBuild = true;
    setTimeout(() => {
      scheduledBuild = false;
      refreshVersion();

      if (status === 'idle' || status === 'failed') {
        void forceBuild({ mode: 'background' });
      }
    }, 0);
  }

  return {
    onDidChangeCodeLenses: codeLensEvents.event,
    getStatus: () => {
      refreshVersion();
      return status;
    },
    getReadyIndex: () => {
      refreshVersion();
      return status === 'ready' ? index : undefined;
    },
    scheduleBuild,
    forceBuild
  };
}

function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  return {
    onDidChangeCodeLenses: controller.onDidChangeCodeLenses,
    async provideCodeLenses(document, token) {
      if (!isEnabled() || !isCSharpFile(document.uri) || isCancellationRequested(token)) {
        return [];
      }

      const index = controller.getReadyIndex();
      if (!index) {
        controller.scheduleBuild();
        return [];
      }

      const methods = findCSharpMethods(runtime.runtimeVscode, document);
      const fields = findUnityEventFields(runtime.runtimeVscode, document);
      const codeLenses: vscode.CodeLens[] = [];
      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);

      for (const method of methods) {
        const count = index.getReferenceCount(scriptPath, method.name);
        if (count > 0) {
          codeLenses.push(new runtime.runtimeVscode.CodeLens(method.range, {
            title: `UnityEvent references: ${count}`,
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'method',
              scriptPath,
              symbolName: method.name,
              position: method.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }
      }

      for (const field of fields) {
        const count = index.getFieldReferenceCount(scriptPath, field.name);
        if (count > 0) {
          codeLenses.push(new runtime.runtimeVscode.CodeLens(field.range, {
            title: `UnityEvent references: ${count}`,
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'field',
              scriptPath,
              symbolName: field.name,
              position: field.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }
      }

      return codeLenses;
    },
    async provideHover(document, position, token) {
      if (!isEnabled() || !isCSharpFile(document.uri) || isCancellationRequested(token)) {
        return undefined;
      }

      const index = controller.getReadyIndex();
      if (!index) {
        controller.scheduleBuild();
        return undefined;
      }

      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      const method = findMethodAtPosition(runtime.runtimeVscode, document, position);

      if (method) {
        const references = index.getReferences(scriptPath, method.name);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), method.range);
        }
      }

      const field = findUnityEventFieldAtPosition(runtime.runtimeVscode, document, position);
      if (field) {
        const references = index.getFieldReferences(scriptPath, field.name);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), field.range);
        }
      }

      return undefined;
    },
    async showReferenceLocations(target) {
      if (!isEnabled()) {
        runtime.runtimeVscode.window.showInformationMessage('Unity Plus: UnityEvent references are disabled.');
        return;
      }

      const index = controller.getReadyIndex();
      if (!index) {
        controller.scheduleBuild();
        runtime.runtimeVscode.window.showInformationMessage('Unity Plus: UnityEvent reference index is still building.');
        return;
      }

      const references = target.kind === 'method'
        ? index.getReferences(target.scriptPath, target.symbolName)
        : index.getFieldReferences(target.scriptPath, target.symbolName);

      if (references.length === 0) {
        runtime.runtimeVscode.window.showInformationMessage('Unity Plus: no UnityEvent references found for this symbol.');
        return;
      }

      await runtime.runtimeVscode.commands.executeCommand(
        'editor.action.showReferences',
        toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
        target.position,
        references.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
      );
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
  let lineCursor = 0;
  let offsetCursor = 0;

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const next = headers[index + 1];
    const bodyStart = header.index + header[0].length;
    const bodyEnd = next?.index ?? content.length;

    // Advance from the previous body start so line tracking stays linear for large Unity YAML files.
    const startLine = lineCursor + countLineBreaks(content, offsetCursor, bodyStart);

    lineCursor = startLine;
    offsetCursor = bodyStart;

    documents.push({
      classId: Number(header[1]),
      fileId: header[2],
      body: content.slice(bodyStart, bodyEnd),
      startLine,
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

function parsePersistentCalls(body: string, startLine: number): PersistentCallSnapshot[] {
  const lines = body.split(/\r?\n/);
  const calls: PersistentCallSnapshot[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let activeEventFieldName: string | undefined;
  let currentCall: Partial<PersistentCallSnapshot> | undefined;

  function flushCall(): void {
    if (currentCall?.eventFieldName) {
      calls.push({
        eventFieldName: currentCall.eventFieldName,
        line: currentCall.methodLine ?? currentCall.line ?? startLine,
        character: currentCall.methodCharacter ?? currentCall.character ?? 0,
        methodLine: currentCall.methodLine,
        methodCharacter: currentCall.methodCharacter,
        targetFileId: currentCall.targetFileId,
        targetTypeName: currentCall.targetTypeName ?? '',
        methodName: currentCall.methodName ?? '',
        callState: currentCall.callState ?? 1
      });
    }
    currentCall = undefined;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const absoluteLine = startLine + lineIndex;
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
          line: absoluteLine,
          character: getIndent(line),
          targetFileId: extractFileId(trimmed)
        };
      } else if (currentCall) {
        updatePersistentCall(currentCall, key, trimmed, absoluteLine, getValueCharacter(line));
      }

      // The stack is intentionally small and indentation-based because Unity YAML uses stable field nesting.
      if (!trimmed.startsWith('- ')) {
        stack.push({ indent, key });
      }
    } else if (currentCall) {
      updatePersistentCall(currentCall, undefined, trimmed, absoluteLine, getValueCharacter(line));
    }
  }

  flushCall();
  return calls;
}

function updatePersistentCall(
  currentCall: Partial<PersistentCallSnapshot>,
  key: string | undefined,
  trimmed: string,
  line: number,
  valueCharacter: number
): void {
  if (key === 'm_Target' && !currentCall.targetFileId) {
    currentCall.targetFileId = extractFileId(trimmed);
  } else if (key === 'fileID' && !currentCall.targetFileId) {
    currentCall.targetFileId = valueAfterColon(trimmed);
  } else if (key === 'm_TargetAssemblyTypeName') {
    currentCall.targetTypeName = valueAfterColon(trimmed);
  } else if (key === 'm_MethodName') {
    currentCall.methodName = valueAfterColon(trimmed);
    currentCall.methodLine = line;
    currentCall.methodCharacter = valueCharacter;
  } else if (key === 'm_CallState') {
    currentCall.callState = Number(valueAfterColon(trimmed));
  }
}

function createReferenceIndex(
  references: readonly UnityEventReference[],
  diagnostics: UnityEventReferenceDiagnostics = createEmptyDiagnostics()
): UnitySerializedAssetReferenceIndex {
  const referencesByKey = new Map<string, UnityEventReference[]>();
  const referencesByFieldKey = new Map<string, UnityEventReference[]>();

  for (const reference of references) {
    const key = referenceKey(reference.scriptPath, reference.methodName);
    const bucket = referencesByKey.get(key) ?? [];
    bucket.push(reference);
    referencesByKey.set(key, bucket);

    if (reference.eventScriptPath) {
      const fieldKey = referenceKey(reference.eventScriptPath, reference.eventFieldName);
      const fieldBucket = referencesByFieldKey.get(fieldKey) ?? [];
      fieldBucket.push(reference);
      referencesByFieldKey.set(fieldKey, fieldBucket);
    }
  }

  return {
    getReferences(scriptPath, methodName) {
      return referencesByKey.get(referenceKey(scriptPath, methodName)) ?? [];
    },
    getReferenceCount(scriptPath, methodName) {
      return referencesByKey.get(referenceKey(scriptPath, methodName))?.length ?? 0;
    },
    getFieldReferences(scriptPath, fieldName) {
      return referencesByFieldKey.get(referenceKey(scriptPath, fieldName)) ?? [];
    },
    getFieldReferenceCount(scriptPath, fieldName) {
      return referencesByFieldKey.get(referenceKey(scriptPath, fieldName))?.length ?? 0;
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
    discoveredAssetCount: 0,
    prefabCount: 0,
    sceneCount: 0,
    skippedAssetCount: 0,
    canceledAssetCount: 0,
    persistentCallCount: 0,
    resolvedReferenceCount: 0,
    resolvedByTargetTypeNameCount: 0,
    skippedDisabledCallCount: 0,
    skippedMissingTargetTypeNameCount: 0,
    skippedUnresolvedTargetTypeNameCount: 0,
    skippedMissingMethodNameCount: 0,
    elapsedMilliseconds: 0
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
  target.discoveredAssetCount += source.discoveredAssetCount;
  target.prefabCount += source.prefabCount;
  target.sceneCount += source.sceneCount;
  target.skippedAssetCount += source.skippedAssetCount;
  target.canceledAssetCount += source.canceledAssetCount;
  target.persistentCallCount += source.persistentCallCount;
  target.resolvedReferenceCount += source.resolvedReferenceCount;
  target.resolvedByTargetTypeNameCount += source.resolvedByTargetTypeNameCount;
  target.skippedDisabledCallCount += source.skippedDisabledCallCount;
  target.skippedMissingTargetTypeNameCount += source.skippedMissingTargetTypeNameCount;
  target.skippedUnresolvedTargetTypeNameCount += source.skippedUnresolvedTargetTypeNameCount;
  target.skippedMissingMethodNameCount += source.skippedMissingMethodNameCount;
}

function formatDiagnostics(diagnostics: UnityEventReferenceDiagnostics): string {
  const skipped = diagnostics.skippedDisabledCallCount +
    diagnostics.skippedMissingTargetTypeNameCount +
    diagnostics.skippedUnresolvedTargetTypeNameCount +
    diagnostics.skippedMissingMethodNameCount;
  const skippedAssets = diagnostics.skippedAssetCount + diagnostics.canceledAssetCount;
  return [
    `discovered ${diagnostics.discoveredAssetCount} serialized asset(s)`,
    `scanned ${diagnostics.prefabCount} prefab(s) and ${diagnostics.sceneCount} scene(s)`,
    `found ${diagnostics.persistentCallCount} persistent call(s)`,
    `resolved ${diagnostics.resolvedReferenceCount} UnityEvent reference(s) by target type name`,
    `skipped ${skipped} call(s) and ${skippedAssets} asset(s)`,
    `finished in ${diagnostics.elapsedMilliseconds}ms`
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

function findUnityEventFields(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpFieldSnapshot[] {
  const text = document.getText();
  const fields: CSharpFieldSnapshot[] = [];
  let match: RegExpExecArray | null;

  unityEventFieldPattern.lastIndex = 0;
  while ((match = unityEventFieldPattern.exec(text))) {
    const name = match[1];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const start = document.positionAt(nameStart);
    const end = document.positionAt(nameStart + name.length);
    fields.push({ name, range: new runtimeVscode.Range(start, end) });
  }

  return fields;
}

function findUnityEventFieldAtPosition(
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

function toReferenceLocation(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  reference: UnityEventReference
): vscode.Location {
  const position = new runtimeVscode.Position(reference.line, reference.character);
  return new runtimeVscode.Location(toWorkspaceUri(runtimeVscode, root, reference.assetPath), position);
}

function toWorkspaceUri(runtimeVscode: typeof vscode, root: vscode.Uri, projectPath: string): vscode.Uri {
  return runtimeVscode.Uri.file(`${root.fsPath.replace(/[\\/]+$/, '')}/${projectPath.replace(/\\/g, '/')}`);
}

async function runWithConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
  options: RunWithConcurrencyOptions = {}
): Promise<void> {
  let nextIndex = 0;
  let completedCount = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    // Keep project-wide IO bounded so background indexing does not starve the extension host.
    while (nextIndex < items.length) {
      if (isCancellationRequested(options.cancellationToken)) {
        break;
      }

      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);

      completedCount += 1;
      options.onProgress?.(completedCount, items.length);

      if (options.yieldEvery && completedCount % options.yieldEvery === 0) {
        await yieldToEventLoop();
      }
    }
  });

  await Promise.all(workers);
}

async function filterAssetFilesForConfiguredSceneScope(
  runtime: EventReferenceRuntime,
  files: readonly vscode.Uri[]
): Promise<readonly vscode.Uri[]> {
  if (shouldIncludeScenesOutsideBuildSettings(runtime.runtimeVscode)) {
    return files;
  }

  const buildSettingsScenePaths = await findBuildSettingsSceneFiles(runtime);
  const filtered = files.filter(uri => {
    const assetKind = getAssetKind(uri);
    if (assetKind !== 'scene') {
      return true;
    }

    return buildSettingsScenePaths.has(toNormalizedPath(toProjectPath(runtime.metadataIndex.root, uri)));
  });

  const skippedCount = files.length - filtered.length;
  if (skippedCount > 0) {
    runtime.logger.info(`Skipped ${skippedCount} Unity scene file(s) outside Build Settings.`);
  }

  return filtered;
}

async function findBuildSettingsSceneFiles(runtime: EventReferenceRuntime): Promise<ReadonlySet<string>> {
  const buildSettingsUri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, editorBuildSettingsPath);

  try {
    const content = await runtime.readTextFile(buildSettingsUri, runtime.runtimeVscode);
    const scenePaths = parseBuildSettingsScenePaths(content);

    if (scenePaths.size === 0) {
      runtime.logger.warn('Unity Build Settings did not list any scene paths; UnityEvent scene scanning will include prefabs only.');
    }

    return scenePaths;
  } catch (error) {
    runtime.logger.warn(`Could not read Unity Build Settings for UnityEvent scene filtering: ${errorMessage(error)}`);
    return new Set<string>();
  }
}

function parseBuildSettingsScenePaths(content: string): ReadonlySet<string> {
  const scenePaths = new Set<string>();
  let match: RegExpExecArray | null;

  buildSettingsScenePathPattern.lastIndex = 0;
  while ((match = buildSettingsScenePathPattern.exec(content))) {
    scenePaths.add(toNormalizedPath(match[1].trim()));
  }

  return scenePaths;
}

function shouldIncludeScenesOutsideBuildSettings(runtimeVscode: typeof vscode): boolean {
  return runtimeVscode.workspace
    .getConfiguration('unityPlus')
    .get<boolean>('scan.includeScenesOutsideBuildSettings', true) !== false;
}

async function findDefaultAssetFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const files = await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, assetGlob));
  return files.filter(uri => supportedAssetExtensions.has(extname(uri.fsPath).toLowerCase()));
}

async function findDefaultCSharpFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  return await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, csharpGlob));
}

async function readDefaultTextFile(uri: vscode.Uri, runtimeVscode: typeof vscode): Promise<string> {
  const bytes = await runtimeVscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

async function buildDefaultCSharpTypeIndex(
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'metadataIndex' | 'findCSharpFiles' | 'readTextFile'>,
  context: UnityEventReferenceBuildContext = { mode: 'background' }
): Promise<CSharpTypeIndex> {
  throwIfCancellationRequested(context.cancellationToken);

  const files = await runtime.findCSharpFiles(runtime.metadataIndex.root, runtime.runtimeVscode);
  const matches: Array<{ fullName: string; shortName: string; path: string }> = [];
  let lastReportedCount = 0;

  await runWithConcurrency(files, async file => {
    throwIfCancellationRequested(context.cancellationToken);

    try {
      const content = await runtime.readTextFile(file, runtime.runtimeVscode);
      throwIfCancellationRequested(context.cancellationToken);

      const path = toProjectPath(runtime.metadataIndex.root, file);
      matches.push(...findCSharpTypeDeclarations(content).map(type => ({ ...type, path })));
    } catch {
      if (isCancellationRequested(context.cancellationToken)) {
        throw new UnityEventReferenceScanCanceledError();
      }

      // Source scan is a fallback resolver; unreadable files simply cannot contribute candidates.
    }
  }, defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({ message: `Indexing C# type declarations ${completedCount}/${totalCount}` });
      }
    }
  });

  return createCSharpTypeIndex(matches);
}

function createCSharpTypeIndex(matches: readonly { fullName: string; shortName: string; path: string }[]): CSharpTypeIndex {
  const fullNameToPath = new Map<string, string | undefined>();
  const shortNameToPath = new Map<string, string | undefined>();

  for (const match of matches) {
    setUniquePath(fullNameToPath, match.fullName, match.path);
    setUniquePath(shortNameToPath, match.shortName, match.path);
  }

  return {
    resolve(fullTypeName) {
      return fullNameToPath.get(fullTypeName) ?? shortNameToPath.get(shortTypeName(fullTypeName));
    }
  };
}

function setUniquePath(map: Map<string, string | undefined>, key: string, path: string): void {
  if (!map.has(key)) {
    map.set(key, path);
    return;
  }

  if (map.get(key) !== path) {
    map.set(key, undefined);
  }
}

function findCSharpTypeDeclarations(content: string): Array<{ fullName: string; shortName: string }> {
  const declarations: Array<{ fullName: string; shortName: string }> = [];
  const namespaceMatches = [...content.matchAll(/\bnamespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*(?:[;{])/g)];
  const fileScopedNamespace = /^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m.exec(content)?.[1];
  const typePattern = /\b(?:public|private|protected|internal|abstract|sealed|static|partial|new|\s)*(?:class|struct|interface|record)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match: RegExpExecArray | null;

  while ((match = typePattern.exec(content))) {
    const shortName = match[1];
    const namespaceName = fileScopedNamespace ?? findNearestNamespace(namespaceMatches, match.index);
    declarations.push({
      shortName,
      fullName: namespaceName ? `${namespaceName}.${shortName}` : shortName
    });
  }

  return declarations;
}

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

function countLineBreaks(text: string, startOffset: number, endOffset: number): number {
  let line = 0;
  for (let index = startOffset; index < endOffset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }

  return line;
}

function getValueCharacter(line: string): number {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) {
    return getIndent(line);
  }

  let valueIndex = colonIndex + 1;
  while (valueIndex < line.length && line[valueIndex] === ' ') {
    valueIndex += 1;
  }

  return valueIndex;
}

function valueAfterColon(trimmed: string): string {
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? '' : trimmed.slice(colonIndex + 1).trim();
}

function simplifyAssemblyTypeName(typeName: string): string {
  return typeName.split(',')[0]?.trim() ?? typeName;
}

function shortTypeName(fullTypeName: string): string {
  return fullTypeName.split('.').at(-1) ?? fullTypeName;
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

function countUnfinishedAssets(totalCount: number, diagnostics: UnityEventReferenceDiagnostics): number {
  const finishedCount = diagnostics.prefabCount + diagnostics.sceneCount + diagnostics.skippedAssetCount;
  return Math.max(0, totalCount - finishedCount);
}

function isCancellationRequested(token: vscode.CancellationToken | undefined): boolean {
  return token?.isCancellationRequested === true;
}

function throwIfCancellationRequested(token: vscode.CancellationToken | undefined): void {
  if (isCancellationRequested(token)) {
    throw new UnityEventReferenceScanCanceledError();
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof UnityEventReferenceScanCanceledError;
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class UnityEventReferenceScanCanceledError extends Error {
  constructor() {
    super('UnityEvent reference scan canceled.');
  }
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
