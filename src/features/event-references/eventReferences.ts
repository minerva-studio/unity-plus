import { createRequire } from 'node:module';
import { extname } from 'node:path';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex, UnityMetadataIndex } from '../../unity/metadataIndex';
import {
  getUnityYamlDocumentFileId,
  getUnityYamlDocumentScalar,
  getUnityYamlDocumentScriptReference,
  getUnityYamlPersistentCalls,
  getUnityYamlPrefabOverridePersistentCalls,
  getUnityYamlSerializedScriptDocuments,
  parseUnityYamlAsset
} from '../../unity/unityYaml';
import type { UnityYamlDocument, UnityYamlPersistentCall, UnityYamlSerializedScriptDocument } from '../../unity/unityYaml';

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
  parsedYamlAssetCount: number;
  parsedUnityEventAssetCount: number;
  skippedUnityEventAssetCount: number;
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
  findAssetFilesContainingText?: (root: vscode.Uri, runtimeVscode: typeof vscode, text: string) => Promise<readonly vscode.Uri[]>;
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
  findAssetFilesContainingText?: (root: vscode.Uri, runtimeVscode: typeof vscode, text: string) => Promise<readonly vscode.Uri[]>;
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
  serializedInstances?: readonly UnitySerializedInstanceLocation[];
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
const assetGlobs = ['Assets/**/*', 'Packages/**/*'];
const csharpGlobs = ['Assets/**/*.cs', 'Packages/**/*.cs'];
const defaultAssetScanConcurrency = 4;
const backgroundAssetScanConcurrency = 1;
const scanYieldEvery = 4;
const backgroundScanYieldEvery = 1;
const backgroundBuildDebounceMilliseconds = 150;
const progressReportInterval = 10;
const editorBuildSettingsPath = 'ProjectSettings/EditorBuildSettings.asset';
const supportedAssetExtensions = new Set(['.prefab', '.unity', '.asset']);
const buildSettingsScenePathPattern = /^\s*path:\s*(Assets\/.*\.unity)\s*$/gm;
const methodPattern = /\b(?:public|private|protected|internal|static|virtual|override|sealed|async|extern|new|unsafe|partial|\s)+[\w<>,[\].?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const unityEventTokenPattern = /(?:UnityEngine\.Events\.)?UnityEvent\b/g;
const identifierPattern = /[A-Za-z_][A-Za-z0-9_]*/y;

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
      findAssetFilesContainingText: options.findAssetFilesContainingText ?? findDefaultAssetFilesContainingText,
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
  const documents = parseUnityYamlAsset(content, { profile: 'eventReferences' }).documents;
  const objects = new Map<string, SerializedObjectRecord>();
  const callsByDocument = new Map<string, PersistentCallSnapshot[]>();
  const serializedInstances = await collectSerializedInstancesFromDocuments(
    documents,
    assetPath,
    assetKind,
    metadataIndex,
    resolveCSharpType,
    diagnostics
  );
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
        if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
          controller.scheduleBuild();
          return [];
        }

        return await createFastSerializedInstanceCodeLenses(runtime, document, token);
      }

      const methods = findCSharpMethods(runtime.runtimeVscode, document);
      const fields = findUnityEventFields(runtime.runtimeVscode, document);
      const types = findCSharpTypes(runtime.runtimeVscode, document);
      const codeLenses: vscode.CodeLens[] = [];
      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      const serializedInstanceAnchor = findSerializedInstanceAnchorType(types, scriptPath);
      let serializedInstanceLensCount = 0;
      let methodLensCount = 0;
      let fieldReferenceLensCount = 0;
      let fieldTargetLensCount = 0;

      for (const type of types) {
        const serializedInstances = filterSerializedInstancesForTypeLens(
          index.getSerializedInstances(scriptPath, type.fullName),
          type.fullName,
          type === serializedInstanceAnchor
        );

        if (serializedInstances.length > 0) {
          serializedInstanceLensCount += 1;
          codeLenses.push(new runtime.runtimeVscode.CodeLens(type.range, {
            title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
              count: serializedInstances.length
            }),
            command: 'unityPlus.showUnityEventReferenceLocations',
            arguments: [{
              kind: 'serializedInstance',
              scriptPath,
              typeName: type.fullName,
              ...(type === serializedInstanceAnchor ? {} : { serializedInstances }),
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
        if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
          controller.scheduleBuild();
        }
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
      if (!index && target.kind === 'serializedInstance' && target.serializedInstances) {
        const serializedReferences = target.serializedInstances;
        await runtime.runtimeVscode.commands.executeCommand(
          'editor.action.showReferences',
          toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
          target.position,
          serializedReferences.map(reference => toSerializedInstanceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
        );
        return;
      }

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

/** Creates serialized-instance CodeLens entries by parsing only GUID text-search candidates. */
async function createFastSerializedInstanceCodeLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  token: vscode.CancellationToken
): Promise<vscode.CodeLens[]> {
  const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
  const types = findCSharpTypes(runtime.runtimeVscode, document);
  const anchor = findSerializedInstanceAnchorType(types, scriptPath);
  const metadata = await runtime.metadataIndex.getOrBuild();
  const scriptGuid = metadata.getGuid(scriptPath);

  if (!scriptGuid || isCancellationRequested(token)) {
    return [];
  }

  const findCandidates = runtime.findAssetFilesContainingText ?? findDefaultAssetFilesContainingText;
  const candidateUris = await findCandidates(runtime.metadataIndex.root, runtime.runtimeVscode, scriptGuid);
  const diagnostics = createEmptyDiagnostics();
  const serializedInstances: UnitySerializedInstanceLocation[] = [];

  for (const uri of candidateUris) {
    if (isCancellationRequested(token)) {
      return [];
    }

    const assetKind = getAssetKind(uri);
    if (!assetKind) {
      continue;
    }

    const content = await runtime.readTextFile(uri, runtime.runtimeVscode);
    const assetPath = toProjectPath(runtime.metadataIndex.root, uri);
    const parsed = parseUnityYamlAsset(content, { profile: 'eventReferences' });
    const locations = await collectSerializedInstancesFromDocuments(
      parsed.documents,
      assetPath,
      assetKind,
      metadata,
      async () => undefined,
      diagnostics,
      scriptGuid
    );

    serializedInstances.push(...locations);
    await yieldToEventLoop();
  }

  const codeLenses: vscode.CodeLens[] = [];
  for (const type of types) {
    const locations = filterSerializedInstancesForTypeLens(
      mergeUniqueReferences(
        serializedInstances.filter(location => pathReferenceKey(location.scriptPath ?? '') === pathReferenceKey(scriptPath)),
        serializedInstances.filter(location => !location.scriptPath && location.scriptTypeName !== undefined && typeKey(location.scriptTypeName) === typeKey(type.fullName))
      ),
      type.fullName,
      type === anchor
    );

    if (locations.length === 0) {
      continue;
    }

    codeLenses.push(new runtime.runtimeVscode.CodeLens(type.range, {
      title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
        count: locations.length
      }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'serializedInstance',
        scriptPath,
        typeName: type.fullName,
        serializedInstances: locations,
        position: type.range.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  runtime.logger.debug(`Unity serialized instance fast scan for ${scriptPath}: ${candidateUris.length} candidate asset(s), ${serializedInstances.length} instance(s).`);
  return codeLenses;
}

/** Chooses the single C# type that should receive path-based serialized instance counts. */
function findSerializedInstanceAnchorType(
  types: readonly CSharpTypeSnapshot[],
  scriptPath: string
): CSharpTypeSnapshot | undefined {
  if (types.length <= 1) {
    return types[0];
  }

  const fileName = scriptPath.split(/[\\/]/).pop() ?? '';
  const typeNameFromFile = fileName.replace(/\.cs$/i, '').toLowerCase();
  return types.find(type => type.name.toLowerCase() === typeNameFromFile) ?? types[0];
}

/** Filters type-only fallback instances while keeping path hits on the selected anchor type. */
function filterSerializedInstancesForTypeLens(
  locations: readonly UnitySerializedInstanceLocation[],
  typeName: string,
  includePathInstances: boolean
): readonly UnitySerializedInstanceLocation[] {
  if (includePathInstances) {
    return locations;
  }

  return locations.filter(location =>
    !location.scriptPath &&
    location.scriptTypeName !== undefined &&
    typeKey(location.scriptTypeName) === typeKey(typeName)
  );
}

/** Converts a parsed Unity YAML document into the local object lookup shape. */
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

/** Collects serialized script instances from vendored parser AST documents. */
async function collectSerializedInstancesFromDocuments(
  documents: readonly UnityYamlDocument[],
  assetPath: string,
  assetKind: UnitySerializedAssetKind,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>,
  diagnostics: UnityEventReferenceDiagnostics,
  targetGuid?: string
): Promise<UnitySerializedInstanceLocation[]> {
  const locations: UnitySerializedInstanceLocation[] = [];
  const seen = new Set<string>();
  const objects = new Map<string, SerializedObjectRecord>();

  for (const document of documents) {
    const object = parseSerializedObject(document);
    objects.set(document.fileId, object);
    if (object.classId === gameObjectClassId && object.name) {
      objects.set(document.fileId, object);
    }
  }

  for (const candidate of getUnityYamlSerializedScriptDocuments(documents)) {
    const guid = candidate.scriptReference?.guid;
    if (targetGuid && guid?.toLowerCase() !== targetGuid.toLowerCase()) {
      continue;
    }

    if (guid) {
      diagnostics.serializedInstanceScriptTextHitCount += 1;
    }

    const identity = await resolveSerializedDocumentScriptIdentity(candidate, metadataIndex, resolveCSharpType);

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

/** Checks whether an asset may contain UnityEvent call data before extracting call helpers. */
function needsHeavyUnityEventParsing(content: string): boolean {
  return content.includes('m_PersistentCalls') ||
    (content.includes('propertyPath:') && content.includes('.m_PersistentCalls.'));
}

/** Resolves a serialized document to a script path first, then an editor-class type fallback. */
async function resolveSerializedDocumentScriptIdentity(
  candidate: UnityYamlSerializedScriptDocument,
  metadataIndex: Pick<UnityMetadataIndex, 'getAssetPath'>,
  resolveCSharpType: (fullTypeName: string) => Promise<string | undefined>
): Promise<SerializedObjectScriptIdentity> {
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

  // m_EditorClassIdentifier remains a fallback when the MonoScript GUID is not indexed.
  return {
    scriptPath: await resolveCSharpType(candidate.editorTypeName),
    typeName: candidate.editorTypeName,
    source: 'editorClassIdentifier'
  };
}

/** Records how a serialized script document identity was resolved for diagnostics. */
function trackSerializedDocumentScriptIdentity(
  diagnostics: UnityEventReferenceDiagnostics,
  candidate: UnityYamlSerializedScriptDocument,
  identity: SerializedObjectScriptIdentity
): void {
  if (identity.source === 'guid') {
    diagnostics.resolvedSerializedInstanceScriptGuidCount += 1;
  } else if (identity.source === 'editorClassIdentifier') {
    diagnostics.resolvedSerializedInstanceEditorClassIdentifierCount += 1;
  } else if (candidate.scriptReference || candidate.editorTypeName) {
    diagnostics.unresolvedSerializedInstanceScriptCount += 1;
  }
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
      scriptPath ? serializedInstancesByScriptPath.get(pathReferenceKey(scriptPath)) : undefined,
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
    parsedYamlAssetCount: 0,
    parsedUnityEventAssetCount: 0,
    skippedUnityEventAssetCount: 0,
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
  target.parsedYamlAssetCount += source.parsedYamlAssetCount;
  target.parsedUnityEventAssetCount += source.parsedUnityEventAssetCount;
  target.skippedUnityEventAssetCount += source.skippedUnityEventAssetCount;
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
    runtimeVscode.l10n.t('YAML parser paths: {assetCount} asset parse(s), {unityEventCount} UnityEvent parse(s), {skippedUnityEventCount} UnityEvent parse(s) skipped', {
      assetCount: diagnostics.parsedYamlAssetCount,
      unityEventCount: diagnostics.parsedUnityEventAssetCount,
      skippedUnityEventCount: diagnostics.skippedUnityEventAssetCount
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
    if (target.serializedInstances) {
      return target.serializedInstances;
    }

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

/** Reads the opt-in flag that permits CodeLens to start a full asset scan. */
function isEventReferenceAutoScanEnabled(runtimeVscode: typeof vscode): boolean {
  return runtimeVscode.workspace
    .getConfiguration('unityPlus')
    .get<boolean>('eventReferences.autoScan', false) === true;
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

/** Finds candidate serialized assets with VS Code text search before AST validation. */
async function findDefaultAssetFilesContainingText(
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  text: string
): Promise<readonly vscode.Uri[]> {
  const workspace = runtimeVscode.workspace as typeof runtimeVscode.workspace & {
    findTextInFiles?: (
      query: { pattern: string },
      callback: (result: { uri: vscode.Uri }) => void,
      options?: { include?: vscode.GlobPattern }
    ) => Thenable<void>;
  };

  if (typeof workspace.findTextInFiles !== 'function') {
    return [];
  }

  const matches = new Map<string, vscode.Uri>();
  await workspace.findTextInFiles(
    { pattern: text },
    result => {
      if (!supportedAssetExtensions.has(extname(result.uri.fsPath).toLowerCase())) {
        return;
      }

      matches.set(result.uri.fsPath.replace(/\\/g, '/'), result.uri);
    },
    {
      include: new runtimeVscode.RelativePattern(root, '{Assets,Packages}/**/*.{prefab,unity,asset}')
    }
  );

  return [...matches.values()];
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

function countLineBreaks(text: string, startOffset: number, endOffset: number): number {
  let line = 0;
  for (let index = startOffset; index < endOffset; index += 1) {
    if (text[index] === '\n') {
      line += 1;
    }
  }

  return line;
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
