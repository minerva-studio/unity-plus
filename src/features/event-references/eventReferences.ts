import { createRequire } from 'node:module';
import { extname } from 'node:path';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndex } from '../../unity/metadataIndex';

export type UnitySerializedAssetKind = 'prefab' | 'scene' | 'asset';

export interface UnityEventReference {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  line: number;
  character: number;
  eventFieldName: string;
  eventScriptPath?: string;
  eventOwnerTypeName?: string;
  gameObjectName?: string;
  targetFileId?: string;
  targetTypeName: string;
  methodName: string;
  scriptPath?: string;
  scriptTypeName?: string;
}

export interface UnitySerializedInstanceLocation {
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
  line: number;
  character: number;
  fileId: string;
  scriptPath?: string;
  scriptTypeName?: string;
  name?: string;
  gameObjectName?: string;
}

export interface UnitySerializedAssetReferenceIndex {
  getReferences(scriptPath: string, methodName: string, typeName?: string): readonly UnityEventReference[];
  getReferenceCount(scriptPath: string, methodName: string, typeName?: string): number;
  getFieldReferences(scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[];
  getFieldReferenceCount(scriptPath: string, fieldName: string, typeName?: string): number;
  getFieldTargets(scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[];
  getFieldTargetCount(scriptPath: string, fieldName: string, typeName?: string): number;
  getSerializedInstances(scriptPath: string, typeName?: string): readonly UnitySerializedInstanceLocation[];
  getSerializedInstanceCount(scriptPath: string, typeName?: string): number;
  getAllReferences(): readonly UnityEventReference[];
  getDiagnostics(): UnityEventReferenceDiagnostics;
}

export interface UnityEventReferenceDiagnostics {
  discoveredAssetCount: number;
  prefabCount: number;
  sceneCount: number;
  assetCount: number;
  skippedAssetCount: number;
  canceledAssetCount: number;
  lightweightSerializedScanAssetCount: number;
  heavyParsedAssetCount: number;
  skippedHeavyParserAssetCount: number;
  persistentCallCount: number;
  serializedInstanceCount: number;
  resolvedReferenceCount: number;
  resolvedByTargetTypeNameCount: number;
  resolvedOwnerScriptGuidCount: number;
  resolvedOwnerEditorClassIdentifierCount: number;
  unresolvedOwnerScriptCount: number;
  resolvedSerializedInstanceScriptGuidCount: number;
  resolvedSerializedInstanceEditorClassIdentifierCount: number;
  unresolvedSerializedInstanceScriptCount: number;
  serializedInstanceScriptTextHitCount: number;
  serializedInstanceScriptResolvedTextHitCount: number;
  serializedInstanceScriptUnresolvedTextHitCount: number;
  serializedInstanceScriptDedupedTextHitCount: number;
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
  bodyStartOffset: number;
  bodyEndOffset: number;
  assetPath: string;
  assetKind: UnitySerializedAssetKind;
}

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

interface PersistentCallSnapshot {
  eventFieldName: string;
  ownerFileId?: string;
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
  typeName?: string;
  range: vscode.Range;
}

interface CSharpFieldSnapshot {
  name: string;
  typeName?: string;
  range: vscode.Range;
}

interface CSharpTypeSnapshot {
  name: string;
  fullName: string;
  range: vscode.Range;
  offset: number;
}

interface EventReferenceLocationTarget {
  kind: 'method' | 'field' | 'fieldTarget' | 'serializedInstance';
  scriptPath: string;
  symbolName?: string;
  typeName?: string;
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
const prefabInstanceClassId = 1001;
const assetGlobs = ['Assets/**/*', 'Packages/**/*'];
const csharpGlobs = ['Assets/**/*.cs', 'Packages/**/*.cs'];
const defaultAssetScanConcurrency = 4;
const backgroundAssetScanConcurrency = 1;
const scanYieldEvery = 4;
const backgroundScanYieldEvery = 1;
const backgroundBuildDebounceMilliseconds = 150;
const serializedLineScanYieldEvery = 2000;
const progressReportInterval = 10;
const editorBuildSettingsPath = 'ProjectSettings/EditorBuildSettings.asset';
const supportedAssetExtensions = new Set(['.prefab', '.unity', '.asset']);
const documentHeaderPattern = /^--- !u!(\d+) &(-?\d+)/gm;
const buildSettingsScenePathPattern = /^\s*path:\s*(Assets\/.*\.unity)\s*$/gm;
const fileIdPattern = /fileID:\s*(-?\d+)/;
const guidPattern = /guid:\s*([a-fA-F0-9]{32})/;
const methodPattern = /\b(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial|\s)+[\w<>,[\].?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const unityEventTokenPattern = /(?:UnityEngine\.Events\.)?UnityEvent\b/g;
const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*/y;
const persistentCallPropertyPathPattern = /^(.+)\.m_PersistentCalls\.m_Calls\.Array\.data\[(\d+)\]\.(m_[A-Za-z0-9_]+)$/;

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
      runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent references are disabled.'));
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
      title: runtimeVscode.l10n.t('Unity Plus: scanning UnityEvent references'),
      cancellable: true
    }, async (progress, cancellationToken) => {
      progress.report({ message: runtimeVscode.l10n.t('Preparing Unity metadata') });
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
        runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent reference scan canceled.'));
        return;
      }

      runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: UnityEvent reference index could not be built.'));
      return;
    }

    const diagnostics = index.getDiagnostics();
    const summary = formatDiagnostics(runtimeVscode, diagnostics);
    logger.info(`UnityEvent reference lookup ${summary}.`);
    runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: {summary}.', { summary }));
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
  const serializedInstances: UnitySerializedInstanceLocation[] = [];
  const diagnostics = createEmptyDiagnostics();

  throwIfCancellationRequested(context.cancellationToken);
  context.progress?.report({ message: runtime.runtimeVscode.l10n.t('Finding Unity serialized assets') });

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
      serializedInstances.push(...parsed.serializedInstances);
    } catch (error) {
      if (isCancellationError(error)) {
        throw error;
      }

      runtime.logger.warn(`Could not scan UnityEvent references in ${assetUri.fsPath}: ${errorMessage(error)}`);
    }
  }, context.mode === 'background' ? backgroundAssetScanConcurrency : defaultAssetScanConcurrency, {
    cancellationToken: context.cancellationToken,
    yieldEvery: context.mode === 'background' ? backgroundScanYieldEvery : scanYieldEvery,
    onProgress: (completedCount, totalCount) => {
      if (context.mode !== 'interactive') {
        return;
      }

      if (completedCount - lastReportedCount >= progressReportInterval || completedCount === totalCount) {
        lastReportedCount = completedCount;
        context.progress?.report({
          message: runtime.runtimeVscode.l10n.t('Scanning Unity serialized assets {completedCount}/{totalCount}', {
            completedCount,
            totalCount
          })
        });
      }
    }
  });

  if (isCancellationRequested(context.cancellationToken)) {
    diagnostics.canceledAssetCount = countUnfinishedAssets(assetFiles.length, diagnostics);
    diagnostics.elapsedMilliseconds = Date.now() - startedAt;
    throw new UnityEventReferenceScanCanceledError();
  }

  diagnostics.resolvedReferenceCount = references.length;
  diagnostics.serializedInstanceCount = serializedInstances.length;
  diagnostics.elapsedMilliseconds = Date.now() - startedAt;
  return createReferenceIndex(references, serializedInstances, diagnostics);
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
      context.progress?.report({ message: runtime.runtimeVscode.l10n.t('Indexing C# type declarations') });
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
): Promise<{
  references: UnityEventReference[];
  serializedInstances: UnitySerializedInstanceLocation[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  return await parseUnityEventReferencesCore(content, assetPath, assetKind, metadataIndex, resolveCSharpType);
}

async function parseUnityEventReferencesCore(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<{
  references: UnityEventReference[];
  serializedInstances: UnitySerializedInstanceLocation[];
  diagnostics: UnityEventReferenceDiagnostics;
}> {
  const diagnostics = createEmptyDiagnostics();
  diagnostics.lightweightSerializedScanAssetCount += 1;

  const serializedInstances = await collectSerializedInstancesFromLineScan(
    content,
    assetPath,
    assetKind,
    metadataIndex,
    resolveCSharpType,
    diagnostics
  );

  if (!needsHeavyUnityEventParsing(content)) {
    diagnostics.skippedHeavyParserAssetCount += 1;
    diagnostics.serializedInstanceCount = serializedInstances.length;
    return { references: [], serializedInstances, diagnostics };
  }

  diagnostics.heavyParsedAssetCount += 1;

  const documents = parseSerializedDocuments(content, assetPath, assetKind);
  const objects = new Map<string, SerializedObjectRecord>();
  const callsByDocument = new Map<string, PersistentCallSnapshot[]>();

  for (const document of documents) {
    const object = parseSerializedObject(document);
    objects.set(document.fileId, object);

    const calls = parsePersistentCalls(document.body, document.startLine);
    if (calls.length > 0) {
      callsByDocument.set(document.fileId, calls);
      diagnostics.persistentCallCount += calls.length;
    }

    const overrideCalls = parsePrefabOverridePersistentCalls(document);
    for (const call of overrideCalls) {
      const calls = callsByDocument.get(call.ownerFileId ?? document.fileId) ?? [];
      calls.push(call);
      callsByDocument.set(call.ownerFileId ?? document.fileId, calls);
      diagnostics.persistentCallCount += 1;
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
      const target = call.targetFileId ? objects.get(call.targetFileId) : undefined;
      const owner = call.ownerFileId ? objects.get(call.ownerFileId) : objects.get(ownerFileId);
      const ownerIdentity = await resolveSerializedObjectScriptIdentity(owner, metadataIndex, resolveCSharpType);
      const targetIdentity = await resolveSerializedObjectScriptIdentity(target, metadataIndex, resolveCSharpType);
      trackOwnerScriptIdentity(diagnostics, owner, ownerIdentity);

      const eventScriptPath = ownerIdentity.scriptPath;
      const eventOwnerTypeName = ownerIdentity.typeName;
      const resolvedTargetTypeName = targetTypeName || targetIdentity.typeName || '';
      let scriptPath = targetIdentity.scriptPath;
      let scriptTypeName = targetIdentity.typeName;

      if (!resolvedTargetTypeName) {
        diagnostics.skippedMissingTargetTypeNameCount += 1;
      } else if (!scriptPath) {
        scriptPath = await resolveCSharpType(resolvedTargetTypeName);
        scriptTypeName = scriptTypeName ?? resolvedTargetTypeName;
      }

      if (scriptPath) {
        diagnostics.resolvedByTargetTypeNameCount += 1;
      } else if (resolvedTargetTypeName) {
        diagnostics.skippedUnresolvedTargetTypeNameCount += 1;
      }

      if (!eventScriptPath && !eventOwnerTypeName && !scriptPath && !scriptTypeName) {
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
  diagnostics.serializedInstanceCount = serializedInstances.length;
  return { references, serializedInstances, diagnostics };
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
    }, backgroundBuildDebounceMilliseconds);
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
      const types = findCSharpTypes(runtime.runtimeVscode, document);
      const codeLenses: vscode.CodeLens[] = [];
      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      let serializedInstanceLensCount = 0;
      let methodLensCount = 0;
      let fieldReferenceLensCount = 0;
      let fieldTargetLensCount = 0;

      for (const type of types) {
        const serializedInstanceCount = index.getSerializedInstanceCount(scriptPath, type.fullName);
        if (serializedInstanceCount > 0) {
          serializedInstanceLensCount += 1;
          codeLenses.push(new runtime.runtimeVscode.CodeLens(type.range, {
            title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
              count: serializedInstanceCount
            }),
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'serializedInstance',
              scriptPath,
              typeName: type.fullName,
              position: type.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }
      }

      for (const method of methods) {
        const count = index.getReferenceCount(scriptPath, method.name, method.typeName);
        if (count > 0) {
          methodLensCount += 1;
          codeLenses.push(new runtime.runtimeVscode.CodeLens(method.range, {
            title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count }),
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'method',
              scriptPath,
              symbolName: method.name,
              typeName: method.typeName,
              position: method.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }
      }

      for (const field of fields) {
        const count = index.getFieldReferenceCount(scriptPath, field.name, field.typeName);
        if (count > 0) {
          fieldReferenceLensCount += 1;
          codeLenses.push(new runtime.runtimeVscode.CodeLens(field.range, {
            title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count }),
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'field',
              scriptPath,
              symbolName: field.name,
              typeName: field.typeName,
              position: field.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }

        const targetCount = index.getFieldTargetCount(scriptPath, field.name, field.typeName);
        if (targetCount > 0) {
          fieldTargetLensCount += 1;
          codeLenses.push(new runtime.runtimeVscode.CodeLens(field.range, {
            title: runtime.runtimeVscode.l10n.t('{count} UnityEvent targets', { count: targetCount }),
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'fieldTarget',
              scriptPath,
              symbolName: field.name,
              typeName: field.typeName,
              position: field.range.start
            } satisfies EventReferenceLocationTarget]
          }));
        }
      }

      runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${types.length} type(s), ${fields.length} UnityEvent field(s), ${methodLensCount} method lens(es), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es), ${serializedInstanceLensCount} serialized instance lens(es).`);

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
        const references = index.getReferences(scriptPath, method.name, method.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), method.range);
        }
      }

      const field = findUnityEventFieldAtPosition(runtime.runtimeVscode, document, position);
      if (field) {
        const references = index.getFieldReferences(scriptPath, field.name, field.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), field.range);
        }
      }

      return undefined;
    },
    async showReferenceLocations(target) {
      if (!isEnabled()) {
        runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: UnityEvent references are disabled.'));
        return;
      }

      const index = controller.getReadyIndex();
      if (!index) {
        controller.scheduleBuild();
        runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: UnityEvent reference index is still building.'));
        return;
      }

      const references = getReferencesForLocationTarget(index, target);

      if (references.length === 0) {
        if (target.kind === 'serializedInstance') {
          runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no Unity serialized instances found for this script.'));
          return;
        }

        runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no UnityEvent references found for this symbol.'));
        return;
      }

      if (target.kind === 'serializedInstance') {
        const serializedReferences = references as readonly UnitySerializedInstanceLocation[];
        await runtime.runtimeVscode.commands.executeCommand(
          'editor.action.showReferences',
          toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
          target.position,
          serializedReferences.map(reference => toSerializedInstanceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
        );
        return;
      }

      const eventReferences = references as readonly UnityEventReference[];

      if (target.kind === 'fieldTarget') {
        const locations = await createTargetMethodLocations(runtime, eventReferences);
        if (locations.length === 0) {
          runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no UnityEvent references found for this symbol.'));
          return;
        }

        await runtime.runtimeVscode.commands.executeCommand(
          'editor.action.showReferences',
          toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
          target.position,
          locations
        );
        return;
      }

      await runtime.runtimeVscode.commands.executeCommand(
        'editor.action.showReferences',
        toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
        target.position,
        eventReferences.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
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
      bodyStartOffset: bodyStart,
      bodyEndOffset: bodyEnd,
      assetPath,
      assetKind
    });
  }

  return documents;
}

function parseSerializedObject(document: SerializedDocument): SerializedObjectRecord {
  const scriptReference = document.classId === monoBehaviourClassId
    ? findGuidValueWithPosition(document.body, 'm_Script', document.startLine)
    : undefined;
  const editorClassIdentifier = findScalarValue(document.body, 'm_EditorClassIdentifier');

  return {
    classId: document.classId,
    fileId: document.fileId,
    name: findScalarValue(document.body, 'm_Name'),
    gameObjectFileId: findFileIdValue(document.body, 'm_GameObject'),
    scriptGuid: scriptReference?.guid,
    editorClassIdentifier,
    editorTypeName: parseEditorClassIdentifier(editorClassIdentifier),
    scriptLine: scriptReference?.line,
    scriptCharacter: scriptReference?.character
  };
}

async function collectSerializedInstancesFromLineScan(
  content: string,
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>,
  diagnostics: UnityEventReferenceDiagnostics
): Promise<UnitySerializedInstanceLocation[]> {
  const locations: UnitySerializedInstanceLocation[] = [];
  const gameObjectNamesByFileId = new Map<string, string>();
  const seen = new Set<string>();
  let currentClassId: number | undefined;
  let currentFileId: string | undefined;
  let currentDocumentStartOffset = 0;
  let currentName: string | undefined;
  let currentGameObjectFileId: string | undefined;
  let currentEditorTypeName: string | undefined;
  let pendingScript: { guid: string; line: number; character: number; lineStart: number } | undefined;
  let lineStart = 0;
  let lineNumber = 0;

  async function flushPendingScript(): Promise<void> {
    if (!pendingScript) {
      return;
    }

    const hit = pendingScript;
    pendingScript = undefined;
    diagnostics.serializedInstanceScriptTextHitCount += 1;

    const textScriptPath = metadataIndex.getAssetPath(hit.guid);
    const identity: SerializedObjectScriptIdentity = textScriptPath
      ? {
        scriptPath: textScriptPath,
        typeName: currentEditorTypeName,
        source: 'guid'
      }
      : await resolveSerializedLineScriptIdentity(currentEditorTypeName, resolveCSharpType);

    if (textScriptPath) {
      diagnostics.serializedInstanceScriptResolvedTextHitCount += 1;
    } else {
      diagnostics.serializedInstanceScriptUnresolvedTextHitCount += 1;
    }

    trackSerializedLineScriptIdentity(diagnostics, hit.guid, currentEditorTypeName, identity);

    if (!identity.scriptPath && !identity.typeName) {
      return;
    }

    const dedupeKey = serializedScriptLineHitKey(assetPath, currentFileId, currentDocumentStartOffset, hit.guid, hit.lineStart);
    if (seen.has(dedupeKey)) {
      diagnostics.serializedInstanceScriptDedupedTextHitCount += 1;
      return;
    }

    seen.add(dedupeKey);
    locations.push({
      assetPath,
      assetKind,
      line: hit.line,
      character: hit.character,
      fileId: currentFileId ?? `offset:${hit.lineStart}`,
      scriptPath: identity.scriptPath,
      scriptTypeName: identity.typeName,
      name: currentName,
      gameObjectName: currentGameObjectFileId ? gameObjectNamesByFileId.get(currentGameObjectFileId) : undefined
    });
  }

  // This scanner intentionally tracks only cheap per-document state; UnityEvent calls use the heavy parser later.
  while (lineStart <= content.length) {
    const nextLineBreak = content.indexOf('\n', lineStart);
    const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
    const rawLine = content.slice(lineStart, lineEnd);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    const header = /^--- !u!(\d+) &(-?\d+)/.exec(line);

    if (header) {
      await flushPendingScript();
      currentClassId = Number(header[1]);
      currentFileId = header[2];
      currentDocumentStartOffset = lineStart;
      currentName = undefined;
      currentGameObjectFileId = undefined;
      currentEditorTypeName = undefined;
    } else if (trimmed.startsWith('m_Name:')) {
      currentName = valueAfterColon(trimmed);
      if (currentClassId === gameObjectClassId && currentFileId && currentName) {
        gameObjectNamesByFileId.set(currentFileId, currentName);
      }
    } else if (trimmed.startsWith('m_GameObject:')) {
      currentGameObjectFileId = extractFileId(trimmed);
    } else if (trimmed.startsWith('m_EditorClassIdentifier:')) {
      currentEditorTypeName = parseEditorClassIdentifier(valueAfterColon(trimmed));
    } else if (trimmed.startsWith('m_Script:')) {
      const mapping = line.slice(line.indexOf('m_Script:') + 'm_Script:'.length);
      const guid = guidPattern.exec(mapping)?.[1];

      if (guid) {
        await flushPendingScript();
        pendingScript = {
          guid,
          line: lineNumber,
          character: Math.max(0, line.indexOf(guid)),
          lineStart
        };
      }
    }

    if (lineNumber > 0 && lineNumber % serializedLineScanYieldEvery === 0) {
      await yieldToEventLoop();
    }

    if (nextLineBreak === -1) {
      break;
    }

    lineStart = nextLineBreak + 1;
    lineNumber += 1;
  }

  await flushPendingScript();

  return locations;
}

async function resolveSerializedLineScriptIdentity(
  editorTypeName: string | undefined,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<SerializedObjectScriptIdentity> {
  if (!editorTypeName) {
    return {};
  }

  // m_EditorClassIdentifier is only a fallback for instances whose MonoScript GUID is not indexed.
  return {
    scriptPath: await resolveCSharpType(editorTypeName),
    typeName: editorTypeName,
    source: 'editorClassIdentifier'
  };
}

function trackSerializedLineScriptIdentity(
  diagnostics: UnityEventReferenceDiagnostics,
  guid: string | undefined,
  editorTypeName: string | undefined,
  identity: SerializedObjectScriptIdentity
): void {
  if (identity.source === 'guid') {
    diagnostics.resolvedSerializedInstanceScriptGuidCount += 1;
  } else if (identity.source === 'editorClassIdentifier') {
    diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount += 1;
  } else if (guid || editorTypeName) {
    diagnostics.unresolvedSerializedInstanceScriptCount += 1;
  }
}

function serializedScriptLineHitKey(
  assetPath: string,
  fileId: string | undefined,
  documentStartOffset: number,
  guid: string,
  lineStart: number
): string {
  const documentKey = fileId ? `${fileId}:${documentStartOffset}` : `offset:${lineStart}`;
  return `${assetPath}#${documentKey}#${guid.toLowerCase()}`;
}

function needsHeavyUnityEventParsing(content: string): boolean {
  return content.includes('m_PersistentCalls') ||
    (content.includes('propertyPath:') && content.includes('.m_PersistentCalls.'));
}

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

function trackSerializedInstanceScriptIdentity(
  diagnostics: UnityEventReferenceDiagnostics,
  object: SerializedObjectRecord | undefined,
  identity: SerializedObjectScriptIdentity
): void {
  if (identity.source === 'guid') {
    diagnostics.resolvedSerializedInstanceScriptGuidCount += 1;
  } else if (identity.source === 'editorClassIdentifier') {
    diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount += 1;
  } else if (object && (object.scriptGuid || object.editorTypeName)) {
    diagnostics.unresolvedSerializedInstanceScriptCount += 1;
  }
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

function parsePrefabOverridePersistentCalls(document: SerializedDocument): PersistentCallSnapshot[] {
  if (document.classId !== prefabInstanceClassId) {
    return [];
  }

  const callsByKey = new Map<string, Partial<PersistentCallSnapshot> & { fallbackLine?: number; fallbackCharacter?: number }>();
  const lines = document.body.split(/\r?\n/);
  let currentTargetFileId: string | undefined;
  let currentPropertyPath: string | undefined;
  let currentLine = document.startLine;
  let currentCharacter = 0;

  function flushModification(): void {
    if (!currentPropertyPath) {
      return;
    }

    // Unity stores prefab overrides as independent property changes, so group them by owner field and call index.
    const parsedPath = persistentCallPropertyPathPattern.exec(currentPropertyPath);
    if (!parsedPath) {
      return;
    }

    const key = `${currentTargetFileId ?? ''}#${parsedPath[1]}#${parsedPath[2]}`;
    const call = callsByKey.get(key) ?? {
      ownerFileId: currentTargetFileId,
      eventFieldName: parsedPath[1],
      fallbackLine: currentLine,
      fallbackCharacter: currentCharacter
    };
    call.ownerFileId = currentTargetFileId;
    call.eventFieldName = parsedPath[1];
    call.line = call.line ?? currentLine;
    call.character = call.character ?? currentCharacter;
    call.fallbackLine = Math.min(call.fallbackLine ?? currentLine, currentLine);
    call.fallbackCharacter = call.fallbackLine === currentLine ? currentCharacter : call.fallbackCharacter;

    if (parsedPath[3] === 'm_MethodName') {
      call.methodName = '';
      call.methodLine = currentLine;
      call.methodCharacter = currentCharacter;
      call.line = currentLine;
      call.character = currentCharacter;
    } else if (parsedPath[3] === 'm_TargetAssemblyTypeName') {
      call.targetTypeName = '';
    } else if (parsedPath[3] === 'm_Target') {
      call.targetFileId = undefined;
    } else if (parsedPath[3] === 'm_CallState') {
      call.callState = 1;
    }

    callsByKey.set(key, call);
  }

  function applyValue(key: string | undefined, trimmed: string, line: number, valueCharacter: number): void {
    if (!currentPropertyPath) {
      return;
    }

    const parsedPath = persistentCallPropertyPathPattern.exec(currentPropertyPath);
    if (!parsedPath) {
      return;
    }

    const call = callsByKey.get(`${currentTargetFileId ?? ''}#${parsedPath[1]}#${parsedPath[2]}`);
    if (!call) {
      return;
    }

    if (key === 'value' && parsedPath[3] === 'm_MethodName') {
      call.methodName = valueAfterColon(trimmed);
      call.methodLine = line;
      call.methodCharacter = valueCharacter;
      call.line = line;
      call.character = valueCharacter;
    } else if (key === 'value' && parsedPath[3] === 'm_TargetAssemblyTypeName') {
      call.targetTypeName = valueAfterColon(trimmed);
    } else if (key === 'value' && parsedPath[3] === 'm_CallState') {
      call.callState = Number(valueAfterColon(trimmed));
    } else if (key === 'objectReference' && parsedPath[3] === 'm_Target') {
      call.targetFileId = extractFileId(trimmed);
    }
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const absoluteLine = document.startLine + lineIndex;
    const trimmed = line.trim();
    const key = parseYamlKey(trimmed);

    if (trimmed.startsWith('- target:')) {
      currentTargetFileId = extractFileId(trimmed);
      currentPropertyPath = undefined;
      currentLine = absoluteLine;
      currentCharacter = getValueCharacter(line);
      continue;
    }

    if (key === 'propertyPath') {
      currentPropertyPath = valueAfterColon(trimmed);
      currentLine = absoluteLine;
      currentCharacter = getValueCharacter(line);
      flushModification();
      continue;
    }

    applyValue(key, trimmed, absoluteLine, getValueCharacter(line));
  }

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
  serializedInstances: readonly UnitySerializedInstanceLocation[] = [],
  diagnostics: UnityEventReferenceDiagnostics = createEmptyDiagnostics()
): UnitySerializedAssetReferenceIndex {
  const referencesByKey = new Map<string, UnityEventReference[]>();
  const referencesByTypeKey = new Map<string, UnityEventReference[]>();
  const referencesByFieldKey = new Map<string, UnityEventReference[]>();
  const referencesByFieldTypeKey = new Map<string, UnityEventReference[]>();
  const targetReferencesByFieldKey = new Map<string, UnityEventReference[]>();
  const targetReferencesByFieldTypeKey = new Map<string, UnityEventReference[]>();
  const targetReferenceKeysByFieldKey = new Map<string, Set<string>>();
  const targetReferenceKeysByFieldTypeKey = new Map<string, Set<string>>();
  const serializedInstancesByScriptPath = new Map<string, UnitySerializedInstanceLocation[]>();
  const serializedInstancesByScriptTypeName = new Map<string, UnitySerializedInstanceLocation[]>();

  for (const reference of references) {
    if (reference.scriptPath) {
      const key = referenceKey(reference.scriptPath, reference.methodName);
      appendMapValue(referencesByKey, key, reference);
    }

    if (reference.scriptTypeName && !reference.scriptPath) {
      appendMapValue(referencesByTypeKey, typeReferenceKey(reference.scriptTypeName, reference.methodName), reference);
    }

    if (reference.eventScriptPath) {
      const fieldKey = referenceKey(reference.eventScriptPath, reference.eventFieldName);
      appendMapValue(referencesByFieldKey, fieldKey, reference);

      if (reference.scriptPath) {
        addTargetFieldReference(targetReferencesByFieldKey, targetReferenceKeysByFieldKey, fieldKey, reference);
      }
    }

    if (reference.eventOwnerTypeName) {
      const fieldTypeKey = fieldTypeReferenceKey(reference.eventOwnerTypeName, reference.eventFieldName);
      appendMapValue(referencesByFieldTypeKey, fieldTypeKey, reference);

      if (reference.scriptPath) {
        addTargetFieldReference(targetReferencesByFieldTypeKey, targetReferenceKeysByFieldTypeKey, fieldTypeKey, reference);
      }
    }
  }

  for (const location of serializedInstances) {
    if (location.scriptPath) {
      appendMapValue(serializedInstancesByScriptPath, pathReferenceKey(location.scriptPath), location);
    }

    if (location.scriptTypeName) {
      appendMapValue(serializedInstancesByScriptTypeName, typeKey(location.scriptTypeName), location);
    }
  }

  const getReferences = (scriptPath: string, methodName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      referencesByKey.get(referenceKey(scriptPath, methodName)),
      typeName ? referencesByTypeKey.get(typeReferenceKey(typeName, methodName)) : undefined
    );
  const getFieldReferences = (scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      filterByType(referencesByFieldKey.get(referenceKey(scriptPath, fieldName)), typeName, reference => reference.eventOwnerTypeName),
      typeName ? referencesByFieldTypeKey.get(fieldTypeReferenceKey(typeName, fieldName)) : undefined
    );
  const getFieldTargets = (scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      filterByType(targetReferencesByFieldKey.get(referenceKey(scriptPath, fieldName)), typeName, reference => reference.eventOwnerTypeName),
      typeName ? targetReferencesByFieldTypeKey.get(fieldTypeReferenceKey(typeName, fieldName)) : undefined
    );
  const getSerializedInstances = (scriptPath: string, typeName?: string): readonly UnitySerializedInstanceLocation[] =>
    mergeUniqueReferences(
      filterByType(serializedInstancesByScriptPath.get(pathReferenceKey(scriptPath)), typeName, location => location.scriptTypeName),
      typeName ? serializedInstancesByScriptTypeName.get(typeKey(typeName)) : undefined
    );

  return {
    getReferences(scriptPath, methodName, typeName) {
      return getReferences(scriptPath, methodName, typeName);
    },
    getReferenceCount(scriptPath, methodName, typeName) {
      return getReferences(scriptPath, methodName, typeName).length;
    },
    getFieldReferences(scriptPath, fieldName, typeName) {
      return getFieldReferences(scriptPath, fieldName, typeName);
    },
    getFieldReferenceCount(scriptPath, fieldName, typeName) {
      return getFieldReferences(scriptPath, fieldName, typeName).length;
    },
    getFieldTargets(scriptPath, fieldName, typeName) {
      return getFieldTargets(scriptPath, fieldName, typeName);
    },
    getFieldTargetCount(scriptPath, fieldName, typeName) {
      return getFieldTargets(scriptPath, fieldName, typeName).length;
    },
    getSerializedInstances(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName);
    },
    getSerializedInstanceCount(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName).length;
    },
    getAllReferences() {
      return references;
    },
    getDiagnostics() {
      return diagnostics;
    }
  };
}

function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

function addTargetFieldReference(
  referencesByFieldKey: Map<string, UnityEventReference[]>,
  seenReferencesByFieldKey: Map<string, Set<string>>,
  fieldKey: string,
  reference: UnityEventReference
): void {
  if (!reference.scriptPath) {
    return;
  }

  const targetKey = `${referenceKey(reference.scriptPath, reference.methodName)}#${reference.targetFileId ?? ''}`;
  const seenTargets = seenReferencesByFieldKey.get(fieldKey) ?? new Set<string>();
  if (seenTargets.has(targetKey)) {
    return;
  }

  appendMapValue(referencesByFieldKey, fieldKey, reference);
  seenTargets.add(targetKey);
  seenReferencesByFieldKey.set(fieldKey, seenTargets);
}

function mergeUniqueReferences<T>(first: readonly T[] | undefined, second: readonly T[] | undefined): readonly T[] {
  if (!first?.length) {
    return second ?? [];
  }

  if (!second?.length) {
    return first;
  }

  const merged: T[] = [];
  const seen = new Set<T>();

  for (const value of [...first, ...second]) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    merged.push(value);
  }

  return merged;
}

function filterByType<T>(
  references: readonly T[] | undefined,
  typeName: string | undefined,
  getTypeName: (reference: T) => string | undefined
): readonly T[] | undefined {
  if (!references || !typeName) {
    return references;
  }

  const requestedTypeKey = typeKey(typeName);
  return references.filter(reference => {
    const referenceTypeName = getTypeName(reference);
    return !referenceTypeName || typeKey(referenceTypeName) === requestedTypeKey;
  });
}

function createEmptyDiagnostics(): UnityEventReferenceDiagnostics {
  return {
    discoveredAssetCount: 0,
    prefabCount: 0,
    sceneCount: 0,
    assetCount: 0,
    skippedAssetCount: 0,
    canceledAssetCount: 0,
    lightweightSerializedScanAssetCount: 0,
    heavyParsedAssetCount: 0,
    skippedHeavyParserAssetCount: 0,
    persistentCallCount: 0,
    serializedInstanceCount: 0,
    resolvedReferenceCount: 0,
    resolvedByTargetTypeNameCount: 0,
    resolvedOwnerScriptGuidCount: 0,
    resolvedOwnerEditorClassIdentifierCount: 0,
    unresolvedOwnerScriptCount: 0,
    resolvedSerializedInstanceScriptGuidCount: 0,
    resolvedSerializedInstanceEditorClassIdentifierCount: 0,
    unresolvedSerializedInstanceScriptCount: 0,
    serializedInstanceScriptTextHitCount: 0,
    serializedInstanceScriptResolvedTextHitCount: 0,
    serializedInstanceScriptUnresolvedTextHitCount: 0,
    serializedInstanceScriptDedupedTextHitCount: 0,
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
  } else if (assetKind === 'scene') {
    diagnostics.sceneCount += 1;
  } else {
    diagnostics.assetCount += 1;
  }
}

function mergeDiagnostics(target: UnityEventReferenceDiagnostics, source: UnityEventReferenceDiagnostics): void {
  target.discoveredAssetCount += source.discoveredAssetCount;
  target.prefabCount += source.prefabCount;
  target.sceneCount += source.sceneCount;
  target.assetCount += source.assetCount;
  target.skippedAssetCount += source.skippedAssetCount;
  target.canceledAssetCount += source.canceledAssetCount;
  target.lightweightSerializedScanAssetCount += source.lightweightSerializedScanAssetCount;
  target.heavyParsedAssetCount += source.heavyParsedAssetCount;
  target.skippedHeavyParserAssetCount += source.skippedHeavyParserAssetCount;
  target.persistentCallCount += source.persistentCallCount;
  target.serializedInstanceCount += source.serializedInstanceCount;
  target.resolvedReferenceCount += source.resolvedReferenceCount;
  target.resolvedByTargetTypeNameCount += source.resolvedByTargetTypeNameCount;
  target.resolvedOwnerScriptGuidCount += source.resolvedOwnerScriptGuidCount;
  target.resolvedOwnerEditorClassIdentifierCount += source.resolvedOwnerEditorClassIdentifierCount;
  target.unresolvedOwnerScriptCount += source.unresolvedOwnerScriptCount;
  target.resolvedSerializedInstanceScriptGuidCount += source.resolvedSerializedInstanceScriptGuidCount;
  target.resolvedSerializedInstanceEditorClassIdentifierCount += source.resolvedSerializedInstanceEditorClassIdentifierCount;
  target.unresolvedSerializedInstanceScriptCount += source.unresolvedSerializedInstanceScriptCount;
  target.serializedInstanceScriptTextHitCount += source.serializedInstanceScriptTextHitCount;
  target.serializedInstanceScriptResolvedTextHitCount += source.serializedInstanceScriptResolvedTextHitCount;
  target.serializedInstanceScriptUnresolvedTextHitCount += source.serializedInstanceScriptUnresolvedTextHitCount;
  target.serializedInstanceScriptDedupedTextHitCount += source.serializedInstanceScriptDedupedTextHitCount;
  target.skippedDisabledCallCount += source.skippedDisabledCallCount;
  target.skippedMissingTargetTypeNameCount += source.skippedMissingTargetTypeNameCount;
  target.skippedUnresolvedTargetTypeNameCount += source.skippedUnresolvedTargetTypeNameCount;
  target.skippedMissingMethodNameCount += source.skippedMissingMethodNameCount;
}

function formatDiagnostics(runtimeVscode: typeof vscode, diagnostics: UnityEventReferenceDiagnostics): string {
  const skipped = diagnostics.skippedDisabledCallCount +
    diagnostics.skippedMissingTargetTypeNameCount +
    diagnostics.skippedUnresolvedTargetTypeNameCount +
    diagnostics.skippedMissingMethodNameCount;
  const skippedAssets = diagnostics.skippedAssetCount + diagnostics.canceledAssetCount;
  return [
    runtimeVscode.l10n.t('discovered {count} serialized asset(s)', { count: diagnostics.discoveredAssetCount }),
    runtimeVscode.l10n.t('scanned {prefabCount} prefab(s), {sceneCount} scene(s), and {assetCount} asset file(s)', {
      prefabCount: diagnostics.prefabCount,
      sceneCount: diagnostics.sceneCount,
      assetCount: diagnostics.assetCount
    }),
    runtimeVscode.l10n.t('found {count} persistent call(s)', { count: diagnostics.persistentCallCount }),
    runtimeVscode.l10n.t('found {count} serialized instance(s)', {
      count: diagnostics.serializedInstanceCount
    }),
    runtimeVscode.l10n.t('serialized parser paths: {lightCount} light scan(s), {heavyCount} heavy parse(s), {skippedHeavyCount} heavy parse(s) skipped', {
      lightCount: diagnostics.lightweightSerializedScanAssetCount,
      heavyCount: diagnostics.heavyParsedAssetCount,
      skippedHeavyCount: diagnostics.skippedHeavyParserAssetCount
    }),
    runtimeVscode.l10n.t('found {count} UnityEvent reference(s)', {
      count: diagnostics.resolvedReferenceCount
    }),
    runtimeVscode.l10n.t('resolved {count} UnityEvent target method(s)', {
      count: diagnostics.resolvedByTargetTypeNameCount
    }),
    runtimeVscode.l10n.t('owner scripts: {guidCount} GUID, {editorCount} editor class, {unresolvedCount} unresolved', {
      guidCount: diagnostics.resolvedOwnerScriptGuidCount,
      editorCount: diagnostics.resolvedOwnerEditorClassIdentifierCount,
      unresolvedCount: diagnostics.unresolvedOwnerScriptCount
    }),
    runtimeVscode.l10n.t('serialized instance scripts: {guidCount} GUID, {editorCount} editor class, {unresolvedCount} unresolved', {
      guidCount: diagnostics.resolvedSerializedInstanceScriptGuidCount,
      editorCount: diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount,
      unresolvedCount: diagnostics.unresolvedSerializedInstanceScriptCount
    }),
    runtimeVscode.l10n.t('serialized instance text hits: {hitCount} found, {resolvedCount} metadata-resolved, {unresolvedCount} unresolved, {dedupedCount} deduped', {
      hitCount: diagnostics.serializedInstanceScriptTextHitCount,
      resolvedCount: diagnostics.serializedInstanceScriptResolvedTextHitCount,
      unresolvedCount: diagnostics.serializedInstanceScriptUnresolvedTextHitCount,
      dedupedCount: diagnostics.serializedInstanceScriptDedupedTextHitCount
    }),
    runtimeVscode.l10n.t('skipped {callCount} call(s) and {assetCount} asset(s)', {
      callCount: skipped,
      assetCount: skippedAssets
    }),
    runtimeVscode.l10n.t('finished in {elapsedMilliseconds}ms', {
      elapsedMilliseconds: diagnostics.elapsedMilliseconds
    })
  ].join(', ');
}

function createMissingWorkspaceMessage(runtimeVscode: typeof vscode): string {
  const roots = runtimeVscode.workspace.workspaceFolders
    ?.map(folder => folder.uri.fsPath)
    .join(', ') ?? '<none>';
  return runtimeVscode.l10n.t('Unity Plus: open a Unity project to scan UnityEvent references. Workspace roots: {roots}. Required markers: Assets, ProjectSettings, Packages/manifest.json.', {
    roots
  });
}

function findCSharpMethods(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpMethodSnapshot[] {
  const text = document.getText();
  const types = findCSharpTypes(runtimeVscode, document);
  const methods: CSharpMethodSnapshot[] = [];
  let match: RegExpExecArray | null;

  methodPattern.lastIndex = 0;
  while ((match = methodPattern.exec(text))) {
    const name = match[1];
    const nameStart = match.index + match[0].lastIndexOf(name);
    const start = document.positionAt(nameStart);
    const end = document.positionAt(nameStart + name.length);
    methods.push({
      name,
      typeName: findNearestCSharpType(types, nameStart)?.fullName,
      range: new runtimeVscode.Range(start, end)
    });
  }

  return methods;
}

function findCSharpTypes(runtimeVscode: typeof vscode, document: vscode.TextDocument): CSharpTypeSnapshot[] {
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
  const types = findCSharpTypes(runtimeVscode, document);
  const fields: CSharpFieldSnapshot[] = [];
  let match: RegExpExecArray | null;

  unityEventTokenPattern.lastIndex = 0;
  while ((match = unityEventTokenPattern.exec(text))) {
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

function skipWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function readIdentifierAt(text: string, offset: number): string | undefined {
  identifierPattern.lastIndex = offset;
  return identifierPattern.exec(text)?.[0];
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
  markdown.appendMarkdown(`**${runtimeVscode.l10n.t('{count} UnityEvent references', { count: references.length })}**\n\n`);

  for (const reference of references.slice(0, 12)) {
    const location = reference.gameObjectName
      ? `${reference.assetPath} (${reference.gameObjectName})`
      : reference.assetPath;
    markdown.appendMarkdown(`- ${escapeMarkdown(location)}: ${escapeMarkdown(reference.eventFieldName)} -> ${escapeMarkdown(reference.targetTypeName)}.${escapeMarkdown(reference.methodName)}\n`);
  }

  if (references.length > 12) {
    markdown.appendMarkdown(`- ${runtimeVscode.l10n.t('... {count} more', { count: references.length - 12 })}\n`);
  }

  return markdown;
}

function getReferencesForLocationTarget(
  index: UnitySerializedAssetReferenceIndex,
  target: EventReferenceLocationTarget
): readonly (UnityEventReference | UnitySerializedInstanceLocation)[] {
  if (target.kind === 'serializedInstance') {
    return index.getSerializedInstances(target.scriptPath, target.typeName);
  }

  if (!target.symbolName) {
    return [];
  }

  if (target.kind === 'method') {
    return index.getReferences(target.scriptPath, target.symbolName, target.typeName);
  }

  if (target.kind === 'fieldTarget') {
    return index.getFieldTargets(target.scriptPath, target.symbolName, target.typeName);
  }

  return index.getFieldReferences(target.scriptPath, target.symbolName, target.typeName);
}

async function createTargetMethodLocations(
  runtime: EventReferenceRuntime,
  references: readonly UnityEventReference[]
): Promise<vscode.Location[]> {
  const locations: vscode.Location[] = [];

  for (const reference of references) {
    if (!reference.scriptPath) {
      continue;
    }

    const uri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, reference.scriptPath);
    try {
      const content = await runtime.readTextFile(uri, runtime.runtimeVscode);
      const position = findCSharpMethodPosition(runtime.runtimeVscode, content, reference.methodName);
      if (position) {
        locations.push(new runtime.runtimeVscode.Location(uri, position));
      }
    } catch {
      // Missing or unreadable scripts cannot provide target locations, but other targets may still resolve.
    }
  }

  return locations;
}

function findCSharpMethodPosition(
  runtimeVscode: typeof vscode,
  content: string,
  methodName: string
): vscode.Position | undefined {
  methodPattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = methodPattern.exec(content))) {
    if (match[1] !== methodName) {
      continue;
    }

    const nameStart = match.index + match[0].lastIndexOf(methodName);
    const line = countLineBreaks(content, 0, nameStart);
    const previousLineBreak = content.lastIndexOf('\n', nameStart - 1);
    const character = nameStart - previousLineBreak - 1;
    return new runtimeVscode.Position(line, character);
  }

  return undefined;
}

function toReferenceLocation(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  reference: UnityEventReference
): vscode.Location {
  const position = new runtimeVscode.Position(reference.line, reference.character);
  return new runtimeVscode.Location(toWorkspaceUri(runtimeVscode, root, reference.assetPath), position);
}

function toSerializedInstanceLocation(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  reference: UnitySerializedInstanceLocation
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
  const fileGroups = await Promise.all(assetGlobs.map(async glob =>
    await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, glob))
  ));
  const files = fileGroups.flat();
  return files.filter(uri => supportedAssetExtensions.has(extname(uri.fsPath).toLowerCase()));
}

async function findDefaultCSharpFiles(
  root: vscode.Uri,
  runtimeVscode: typeof vscode
): Promise<readonly vscode.Uri[]> {
  const fileGroups = await Promise.all(csharpGlobs.map(async glob =>
    await runtimeVscode.workspace.findFiles(new runtimeVscode.RelativePattern(root, glob))
  ));
  return fileGroups.flat();
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
  }, context.mode === 'background' ? backgroundAssetScanConcurrency : defaultAssetScanConcurrency, {
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

function findGuidValueWithPosition(
  body: string,
  fieldName: string,
  startLine: number
): { guid: string; line: number; character: number } | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(fieldName)}:\\s*\\{([^}]*)\\}`, 'mg');
  const match = pattern.exec(body);
  const mapping = match?.[1];
  const guid = mapping ? guidPattern.exec(mapping)?.[1] : undefined;

  if (!match || !guid) {
    return undefined;
  }

  // The CodeLens target should land on the script reference when possible, not just on the YAML header.
  const matchOffset = match.index;
  const guidOffset = body.indexOf(guid, matchOffset);
  const line = startLine + countLineBreaks(body, 0, matchOffset);
  const lineStart = body.lastIndexOf('\n', guidOffset - 1);
  return {
    guid,
    line,
    character: guidOffset - lineStart - 1
  };
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

function getCharacterAtOffset(text: string, offset: number): number {
  const lineStart = text.lastIndexOf('\n', offset - 1);
  return offset - lineStart - 1;
}

function valueAfterColon(trimmed: string): string {
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? '' : trimmed.slice(colonIndex + 1).trim();
}

function simplifyAssemblyTypeName(typeName: string): string {
  return typeName.split(',')[0]?.trim() ?? typeName;
}

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

function shortTypeName(fullTypeName: string): string {
  return fullTypeName.split('.').at(-1) ?? fullTypeName;
}

function referenceKey(scriptPath: string, methodName: string): string {
  return `${pathReferenceKey(scriptPath)}#${methodName}`;
}

function typeReferenceKey(typeName: string, methodName: string): string {
  return `${typeKey(typeName)}#${methodName}`;
}

function fieldTypeReferenceKey(typeName: string, fieldName: string): string {
  return `${typeKey(typeName)}#${fieldName}`;
}

function pathReferenceKey(scriptPath: string): string {
  return toNormalizedPath(scriptPath).toLowerCase();
}

function typeKey(typeName: string): string {
  return typeName.toLowerCase();
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

  if (extension === '.asset') {
    return 'asset';
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
  const finishedCount = diagnostics.prefabCount + diagnostics.sceneCount + diagnostics.assetCount + diagnostics.skippedAssetCount;
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
