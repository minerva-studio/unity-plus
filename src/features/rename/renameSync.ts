import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createVscodeCSharpLanguageService, CSharpTopLevelTypeSnapshot, CSharpLanguageService, CSharpPosition } from '../../unity/csharpLanguageService';
import { UnityPlusLogger } from '../../unity/logger';

export type RenameFileSyncMode = 'on' | 'off';
export type RenamePreviewMode = 'silent' | 'ask' | 'ask+warn';
type LegacyRenameFileSyncMode = RenameFileSyncMode | 'unity-object' | 'any';

export interface RenameFeatureOptions {
  runtimeVscode?: typeof vscode;
  getMode?: () => RenameFileSyncMode;
  getPreviewMode?: () => RenamePreviewMode;
  getMoveMetaWithAsset?: () => boolean;
  isUnityWorkspace?: boolean;
}

export interface ScriptFilenameSyncPlan {
  oldTypeName: string;
  newTypeName: string;
  oldFilePath: string;
  newFilePath: string;
  oldMetaPath: string;
  newMetaPath: string;
  isUndo: boolean;
}

export interface ScriptFilenameSyncOperations {
  fileExists(path: string): Promise<boolean>;
  applyRenameOperations(operations: readonly ScriptFileRenameOperation[]): Promise<boolean>;
  logger: UnityPlusLogger;
}

export interface ScriptFileRenameOperation {
  oldPath: string;
  newPath: string;
}

export type RenamePreviewDecision =
  | { kind: 'confirmed'; operations: readonly ScriptFileRenameOperation[] }
  | { kind: 'cancelled' };

type RenameOperationKind = 'script' | 'meta';

export interface RenameInputRequest {
  oldTypeName: string;
  filePath: string;
  previewMode: RenamePreviewMode;
  hasMetaFile: boolean;
}

export interface RenameInputDecision {
  newTypeName: string;
  operationKinds?: readonly RenameOperationKind[];
}

type RenameOperationQuickPickItem = vscode.QuickPickItem & {
  operation: ScriptFileRenameOperation;
  operationKind: RenameOperationKind;
};

type RenameInputQuickPickItem = vscode.QuickPickItem & {
  operationKind: RenameOperationKind;
};

export interface ScriptFileMove {
  oldPath: string;
  newPath: string;
}

export type AssetMetaRenameRisk =
  | { kind: 'missing-source-meta'; assetPath: string; metaPath: string }
  | { kind: 'destination-meta-exists'; assetPath: string; metaPath: string };

export interface AssetMetaRenamePreflightResult {
  operations: readonly ScriptFileRenameOperation[];
  risks: readonly AssetMetaRenameRisk[];
}

export interface RecentScriptFilenameSync {
  plan: ScriptFilenameSyncPlan;
}

export interface ScriptRenameSyncRuntime {
  uri: vscode.Uri;
  filePath: string;
  mode: RenameFileSyncMode;
  oldType: CSharpTopLevelTypeSnapshot | undefined;
  recentSync?: RecentScriptFilenameSync;
  languageService: CSharpLanguageService;
  operations: ScriptFilenameSyncOperations;
  showProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  wait(ms: number): Promise<void>;
  debounceMs: number;
  retryIntervalMs: number;
  settleTimeoutMs: number;
  logger: UnityPlusLogger;
}

export interface AtomicScriptRenameRuntime {
  uri: vscode.Uri;
  filePath: string;
  mode: RenameFileSyncMode;
  previewMode?: RenamePreviewMode;
  operationKinds?: readonly RenameOperationKind[];
  currentType: CSharpTopLevelTypeSnapshot | undefined;
  cursor: CSharpPosition;
  newTypeName: string;
  languageService: CSharpLanguageService;
  fileExists(path: string): Promise<boolean>;
  createFileUri(path: string): vscode.Uri;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  confirmRenamePreview(
    previewMode: RenamePreviewMode,
    plan: ScriptFilenameSyncPlan,
    operations: readonly ScriptFileRenameOperation[],
    edit: vscode.WorkspaceEdit
  ): Promise<RenamePreviewDecision | boolean>;
  confirmRenameWarning?(plan: ScriptFilenameSyncPlan, operations: readonly ScriptFileRenameOperation[], edit: vscode.WorkspaceEdit): Promise<boolean>;
  logger: UnityPlusLogger;
}

export interface RenameCommandEditor {
  languageId: string;
  uri: vscode.Uri;
  filePath: string;
  cursor: CSharpPosition;
}

export interface RenameTypeCommandRuntime {
  editor?: RenameCommandEditor;
  mode: RenameFileSyncMode;
  previewMode: RenamePreviewMode;
  languageService: CSharpLanguageService;
  showInputBox(options: { value: string; prompt: string; validateInput(value: string): string | undefined }): Promise<string | undefined>;
  showRenameInput(request: RenameInputRequest): Promise<RenameInputDecision | undefined>;
  showProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  executeNativeRename(): Promise<void>;
  executeAtomicRename(request: AtomicScriptRenameRuntime): Promise<AtomicScriptRenameResult>;
  fileExists(path: string): Promise<boolean>;
  createFileUri(path: string): vscode.Uri;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  confirmRenamePreview(
    previewMode: RenamePreviewMode,
    plan: ScriptFilenameSyncPlan,
    operations: readonly ScriptFileRenameOperation[],
    edit: vscode.WorkspaceEdit
  ): Promise<RenamePreviewDecision | boolean>;
  confirmRenameWarning(plan: ScriptFilenameSyncPlan, operations: readonly ScriptFileRenameOperation[], edit: vscode.WorkspaceEdit): Promise<boolean>;
  wait(ms: number): Promise<void>;
  retryIntervalMs: number;
  settleTimeoutMs: number;
  markSyncing(filePath: string): void;
  unmarkSyncing(filePath: string): void;
  logger: UnityPlusLogger;
}

type RenameFallbackVisibility = 'silent' | 'informational';

export type RenameTypeCommandResult =
  | { kind: 'applied'; oldTypeName: string; newTypeName: string }
  | { kind: 'fallback'; reason: string; visibility: RenameFallbackVisibility }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export type AtomicScriptRenameResult =
  | { kind: 'applied'; oldTypeName: string; newTypeName: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export function registerRenameFeature(
  logger: UnityPlusLogger,
  options: RenameFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const getMode = options.getMode ?? (() => getRenameFileSyncMode(runtimeVscode));
  const getPreviewMode = options.getPreviewMode ?? (() => getRenamePreviewMode(runtimeVscode));
  const getMoveMetaWithAsset = options.getMoveMetaWithAsset ?? (() => getMetaFilesMoveWithAsset(runtimeVscode));
  const isUnityWorkspace = options.isUnityWorkspace ?? true;
  const languageService = createVscodeCSharpLanguageService(runtimeVscode);
  const disposables: vscode.Disposable[] = [];
  const previousCsharpTypes = new Map<string, CSharpTopLevelTypeSnapshot>();
  const syncingScriptRenameFiles = new Set<string>();
  let recentSync: RecentScriptFilenameSync | undefined;

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncScriptFilename', async () => {
    logger.info('Script filename sync is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('Unity Plus: script filename sync is planned for v0.2.'));
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncClassName', async () => {
    try {
      const result = await runRenameTypeCommand({
        editor: createRenameCommandEditor(runtimeVscode.window.activeTextEditor),
        mode: getMode(),
        previewMode: getPreviewMode(),
        languageService,
        showInputBox: async options => await runtimeVscode.window.showInputBox(options),
        showRenameInput: async request => await showRenameInput(runtimeVscode, request),
        showProgress: async (title, task) => await runtimeVscode.window.withProgress({
          location: runtimeVscode.ProgressLocation.Notification,
          title
        }, task),
        showInformationMessage: message => {
          void runtimeVscode.window.showInformationMessage(message);
        },
        showWarningMessage: message => {
          void runtimeVscode.window.showWarningMessage(message);
        },
        executeNativeRename: async () => await executeNativeRename(runtimeVscode),
        executeAtomicRename: async request => await executeAtomicScriptRename(request),
        fileExists: async path => await fileExists(runtimeVscode, path),
        createFileUri: path => runtimeVscode.Uri.file(path),
        applyWorkspaceEdit: async edit => await runtimeVscode.workspace.applyEdit(edit, { isRefactoring: true }),
        confirmRenamePreview: async (previewMode, plan, operations, edit) => await confirmRenamePreview(runtimeVscode, previewMode, plan, operations, edit),
        confirmRenameWarning: async (plan, operations, edit) => await confirmDetailedRenameWarning(runtimeVscode, plan, operations, edit),
        wait,
        retryIntervalMs: 200,
        settleTimeoutMs: 2000,
        markSyncing: filePath => syncingScriptRenameFiles.add(filePath),
        unmarkSyncing: filePath => syncingScriptRenameFiles.delete(filePath),
        logger
      });

      if (result.kind === 'fallback') {
        if (result.visibility === 'silent') {
          logger.debug(`Unity Plus rename command fell back silently: ${result.reason}`);
        } else {
          logger.info(`Unity Plus: ${result.reason}`);
        }
      } else if (result.kind === 'failed') {
        logger.warn(result.message);
        void runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: {message}', {
          message: runtimeVscode.l10n.t(result.message)
        }));
      } else if (result.kind === 'applied') {
        const message = runtimeVscode.l10n.t('Unity Plus: Renamed {oldName} -> {newName}', {
          oldName: result.oldTypeName,
          newName: result.newTypeName
        });
        logger.info(message);
        void runtimeVscode.window.showInformationMessage(message);
      }
    } catch (error) {
      const message = `Could not rename C# type and script file: ${errorMessage(error)}`;
      logger.warn(message);
      void runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: {message}', { message }));
    }
  }));

  if (isUnityWorkspace && (getMode() !== 'off' || getMoveMetaWithAsset())) {
    disposables.push(runtimeVscode.workspace.onWillRenameFiles(event => {
      if (!getMoveMetaWithAsset()) {
        return;
      }

      const moves = event.files.map(file => ({
        oldPath: file.oldUri.fsPath,
        newPath: file.newUri.fsPath
      }));

      // waitUntil must be called during event dispatch. The promise performs
      // the asynchronous preflight before VS Code applies the original rename.
      event.waitUntil(buildAssetMetaRenameOperations(moves, {
        fileExists: async path => await fileExists(runtimeVscode, path)
      }).then(result => {
        const edit = new runtimeVscode.WorkspaceEdit();
        if (result.risks.length > 0) {
          showAssetMetaRenameWarning(runtimeVscode, result.risks, logger);
          return edit;
        }

        for (const operation of result.operations) {
          edit.renameFile(
            runtimeVscode.Uri.file(operation.oldPath),
            runtimeVscode.Uri.file(operation.newPath),
            { overwrite: false }
          );
        }
        return edit;
      }));
    }));

    disposables.push(runtimeVscode.workspace.onDidRenameFiles(event => {
      const mode = getMode();

      const csharpMoves = event.files.filter(file => file.oldUri.path.endsWith('.cs') || file.newUri.path.endsWith('.cs'));
      if (mode !== 'off' && csharpMoves.length > 0) {
        logger.debug(`Observed ${csharpMoves.length} C# rename operation(s).`);
      }

      if (mode !== 'off') {
        for (const file of csharpMoves) {
          const previousType = previousCsharpTypes.get(file.oldUri.fsPath);
          if (previousType) {
            previousCsharpTypes.set(file.newUri.fsPath, previousType);
            previousCsharpTypes.delete(file.oldUri.fsPath);
          }
        }
      }

    }));
  }

  if (isUnityWorkspace && getMode() !== 'off') {
    disposables.push(runtimeVscode.workspace.onDidOpenTextDocument(document => {
      const mode = getMode();
      if (mode !== 'off' && document.uri.fsPath.endsWith('.cs')) {
        void refreshPrimaryTopLevelType(languageService, document.uri, mode, previousCsharpTypes, logger);
      }
    }));

    disposables.push(runtimeVscode.workspace.onDidCloseTextDocument(document => {
      previousCsharpTypes.delete(document.uri.fsPath);
    }));

    disposables.push(runtimeVscode.workspace.onDidChangeTextDocument(async event => {
      const filePath = event.document.uri.fsPath;
      if (!filePath.endsWith('.cs')) {
        return;
      }

      const mode = getMode();
      if (mode === 'off') {
        return;
      }

      if (syncingScriptRenameFiles.has(filePath)) {
        logger.debug(`Script rename sync is already running for ${basename(filePath)}.`);
        return;
      }

      syncingScriptRenameFiles.add(filePath);

      try {
        const result = await syncScriptRenameAfterClassChange({
          uri: event.document.uri,
          filePath,
          mode,
          oldType: previousCsharpTypes.get(filePath),
          recentSync,
          languageService,
          operations: {
            fileExists: async path => await fileExists(runtimeVscode, path),
            applyRenameOperations: async operations => await applyRenameOperations(runtimeVscode, operations),
            logger
          },
          showProgress: async (title, task) => await runtimeVscode.window.withProgress({
            location: runtimeVscode.ProgressLocation.Notification,
            title
          }, task),
          showInformationMessage: message => {
            void runtimeVscode.window.showInformationMessage(message);
          },
          showWarningMessage: message => {
            void runtimeVscode.window.showWarningMessage(message);
          },
          wait,
          debounceMs: 400,
          retryIntervalMs: 200,
          settleTimeoutMs: 2000,
          logger
        });

        if (result.newType) {
          previousCsharpTypes.set(filePath, result.newType);
        } else {
          previousCsharpTypes.delete(filePath);
        }

        if (result.appliedPlan) {
          recentSync = { plan: result.appliedPlan };
        }
      } catch (error) {
        const message = `Could not rename Unity script file: ${errorMessage(error)}`;
        logger.warn(message);
        void runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: {message}', { message }));
      } finally {
        syncingScriptRenameFiles.delete(filePath);
      }
    }));
  }

  return runtimeVscode.Disposable.from(...disposables);
}

export async function runRenameTypeCommand(runtime: RenameTypeCommandRuntime): Promise<RenameTypeCommandResult> {
  return await runPreparedRenameTypeCommand(runtime);
}

async function runPreparedRenameTypeCommand(runtime: RenameTypeCommandRuntime): Promise<RenameTypeCommandResult> {
  runtime.logger.debug('Unity Plus rename command started.');

  if (!runtime.editor) {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because no active editor is available.', 'silent');
  }

  if (runtime.editor.languageId !== 'csharp') {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because this is not a C# editor.', 'silent');
  }

  if (runtime.mode === 'off') {
    return await fallbackToNativeRename(runtime, 'Rename sync mode is off; using VS Code Rename Symbol.');
  }

  // The command entry must not wait for C# symbols when the cursor is on a
  // field or member. A single provider snapshot is enough to decide whether
  // Unity Plus owns this rename or should immediately fall back to native F2.
  const currentType = await getPrimaryTopLevelType(runtime.languageService, runtime.editor.uri, runtime.mode, runtime.logger);
  const fallbackReason = getAtomicRenameFallbackReason(
    runtime.editor.filePath,
    currentType,
    runtime.editor.cursor,
    runtime.mode
  );
  runtime.logger.debug(`Unity Plus rename command primary top-level type: ${currentType?.name ?? '<none>'}.`);

  if (fallbackReason) {
    return await fallbackToNativeRename(runtime, fallbackReason, getRenameFallbackVisibility(fallbackReason));
  }

  const renameType = currentType;
  if (!renameType) {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because no primary top-level C# type was found.');
  }

  const renameInput = await readRenameInput(runtime, renameType);
  if (!renameInput || renameInput.newTypeName === renameType.name) {
    runtime.logger.debug('Unity Plus rename command was cancelled or unchanged.');
    return { kind: 'cancelled' };
  }

  if (!isValidCSharpIdentifier(renameInput.newTypeName)) {
    return { kind: 'failed', message: 'Enter a valid C# type name.' };
  }

  runtime.markSyncing(runtime.editor.filePath);
  try {
    const result = await runtime.showProgress('Unity Plus: Renaming type and script file...', async () =>
      await runtime.executeAtomicRename({
        uri: runtime.editor!.uri,
        filePath: runtime.editor!.filePath,
        mode: runtime.mode,
        previewMode: runtime.previewMode,
        currentType: renameType,
        cursor: runtime.editor!.cursor,
        newTypeName: renameInput.newTypeName,
        operationKinds: renameInput.operationKinds,
        languageService: runtime.languageService,
        fileExists: runtime.fileExists,
        createFileUri: runtime.createFileUri,
        applyWorkspaceEdit: runtime.applyWorkspaceEdit,
        confirmRenamePreview: runtime.confirmRenamePreview,
        confirmRenameWarning: runtime.confirmRenameWarning,
        logger: runtime.logger
      })
    );

    if (result.kind === 'fallback') {
      return await fallbackToNativeRename(runtime, result.reason, getRenameFallbackVisibility(result.reason));
    }

    return result;
  } finally {
    runtime.unmarkSyncing(runtime.editor.filePath);
  }
}

async function readRenameInput(
  runtime: RenameTypeCommandRuntime,
  renameType: CSharpTopLevelTypeSnapshot
): Promise<RenameInputDecision | undefined> {
  if (!runtime.editor) {
    return undefined;
  }

  if (runtime.previewMode === 'silent') {
    const newTypeName = await runtime.showInputBox({
      value: renameType.name,
      prompt: 'Rename C# type, script file, and Unity meta file',
      validateInput: value => isValidCSharpIdentifier(value) ? undefined : 'Enter a valid C# type name.'
    });

    return newTypeName ? { newTypeName } : undefined;
  }

  return await runtime.showRenameInput({
    oldTypeName: renameType.name,
    filePath: runtime.editor.filePath,
    previewMode: runtime.previewMode,
    hasMetaFile: await runtime.fileExists(`${runtime.editor.filePath}.meta`)
  });
}

export function showRenameInput(
  runtimeVscode: typeof vscode,
  request: RenameInputRequest
): Promise<RenameInputDecision | undefined> {
  return new Promise(resolve => {
    const quickPick = runtimeVscode.window.createQuickPick<RenameInputQuickPickItem>();
    let accepted = false;

    const buildItems = (): RenameInputQuickPickItem[] => {
      const items: RenameInputQuickPickItem[] = [{
        label: runtimeVscode.l10n.t('Rename script file'),
        picked: true,
        alwaysShow: true,
        operationKind: 'script'
      }];

      if (request.hasMetaFile) {
        items.push({
          label: runtimeVscode.l10n.t('Rename Unity meta file'),
          picked: true,
          alwaysShow: true,
          operationKind: 'meta'
        });
      }

      return items;
    };

    quickPick.title = runtimeVscode.l10n.t('Rename C# Type and Script');
    quickPick.placeholder = runtimeVscode.l10n.t('New C# type name');
    quickPick.canSelectMany = true;
    quickPick.matchOnDescription = false;
    quickPick.matchOnDetail = false;
    quickPick.value = request.oldTypeName;
    quickPick.items = buildItems();
    quickPick.selectedItems = quickPick.items.filter(item => item.picked);

    quickPick.onDidChangeSelection(selectedItems => {
      const selectedKinds = new Set(selectedItems.map(item => item.operationKind));
      if (!selectedKinds.has('script')) {
        quickPick.selectedItems = selectedItems.filter(item => item.operationKind !== 'meta');
      }
    });
    quickPick.onDidAccept(() => {
      const newTypeName = quickPick.value.trim();
      const validationMessage = validateRenameInputValue(newTypeName);
      if (validationMessage) {
        void runtimeVscode.window.showWarningMessage(validationMessage);
        return;
      }

      accepted = true;
      const selectedKinds = new Set(quickPick.selectedItems.map(item => item.operationKind));
      const operationKinds = selectedKinds.has('script')
        ? quickPick.selectedItems.map(item => item.operationKind)
        : [];

      resolve({
        newTypeName,
        operationKinds
      });
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      if (!accepted) {
        resolve(undefined);
      }
      quickPick.dispose();
    });
    quickPick.show();
  });
}

function validateRenameInputValue(value: string): string | undefined {
  const trimmedValue = value.trim();
  return isValidCSharpIdentifier(trimmedValue) ? undefined : 'Enter a valid C# type name.';
}

export async function executeAtomicScriptRename(runtime: AtomicScriptRenameRuntime): Promise<AtomicScriptRenameResult> {
  const fallbackReason = getAtomicRenameFallbackReason(
    runtime.filePath,
    runtime.currentType,
    runtime.cursor,
    runtime.mode
  );
  if (fallbackReason) {
    return { kind: 'fallback', reason: fallbackReason };
  }

  const currentType = runtime.currentType;
  if (!currentType) {
    return { kind: 'fallback', reason: 'Using VS Code Rename Symbol because no primary top-level C# type was found.' };
  }

  if (!currentType.position) {
    return { kind: 'fallback', reason: 'Using VS Code Rename Symbol because the primary top-level type position is unavailable.' };
  }

  const renameEdit = await runtime.languageService.buildRenameEdit(
    runtime.uri,
    currentType.position,
    runtime.newTypeName
  );

  if (!renameEdit) {
    return { kind: 'failed', message: 'C# rename provider did not return a rename edit.' };
  }

  const plan = createScriptFilenameSyncPlan(runtime.filePath, currentType.name, runtime.newTypeName);
  const renameOperations = await buildScriptFilenameSyncOperations(plan, {
    fileExists: runtime.fileExists,
    logger: runtime.logger
  });

  if (renameOperations.length === 0) {
    return { kind: 'failed', message: `Script file rename preflight failed for ${basename(runtime.filePath)}.` };
  }

  const previewDecision = await decideRenamePreview(runtime, plan, filterRenameOperations(plan, renameOperations, runtime.operationKinds), renameEdit);
  if (previewDecision.kind === 'cancelled') {
    return { kind: 'cancelled' };
  }

  for (const operation of previewDecision.operations) {
    renameEdit.renameFile(
      runtime.createFileUri(operation.oldPath),
      runtime.createFileUri(operation.newPath),
      { overwrite: false }
    );
  }

  const applied = await runtime.applyWorkspaceEdit(renameEdit);
  if (!applied) {
    return { kind: 'failed', message: `Atomic rename did not apply for ${basename(runtime.filePath)}.` };
  }

  return {
    kind: 'applied',
    oldTypeName: currentType.name,
    newTypeName: runtime.newTypeName
  };
}

export async function confirmRenamePreview(
  runtimeVscode: typeof vscode,
  previewMode: RenamePreviewMode,
  plan: ScriptFilenameSyncPlan,
  operations: readonly ScriptFileRenameOperation[],
  edit: vscode.WorkspaceEdit
): Promise<RenamePreviewDecision> {
  const selectedOperations = await pickRenameOperations(runtimeVscode, plan, operations);
  if (!selectedOperations) {
    return { kind: 'cancelled' };
  }

  if (previewMode === 'ask+warn') {
    const confirmed = await confirmDetailedRenameWarning(runtimeVscode, plan, selectedOperations, edit);
    if (!confirmed) {
      return { kind: 'cancelled' };
    }
  }

  return { kind: 'confirmed', operations: selectedOperations };
}

async function decideRenamePreview(
  runtime: AtomicScriptRenameRuntime,
  plan: ScriptFilenameSyncPlan,
  operations: readonly ScriptFileRenameOperation[],
  edit: vscode.WorkspaceEdit
): Promise<RenamePreviewDecision> {
  if ((runtime.previewMode ?? 'ask') === 'silent' || runtime.operationKinds) {
    if ((runtime.previewMode ?? 'ask') === 'ask+warn') {
      const confirmed = await runtime.confirmRenameWarning?.(plan, operations, edit);
      return confirmed ? { kind: 'confirmed', operations } : { kind: 'cancelled' };
    }

    return { kind: 'confirmed', operations };
  }

  // Preview happens after preflight and before the workspace edit is applied, so it shows the exact safe operations.
  const decision = await runtime.confirmRenamePreview(runtime.previewMode ?? 'ask', plan, operations, edit);
  if (typeof decision === 'boolean') {
    return decision
      ? { kind: 'confirmed', operations }
      : { kind: 'cancelled' };
  }

  return decision;
}

function filterRenameOperations(
  plan: ScriptFilenameSyncPlan,
  operations: readonly ScriptFileRenameOperation[],
  operationKinds: readonly RenameOperationKind[] | undefined
): readonly ScriptFileRenameOperation[] {
  if (!operationKinds) {
    return operations;
  }

  const selectedKinds = new Set(operationKinds);
  if (!selectedKinds.has('script')) {
    return [];
  }

  return operations.filter(operation =>
    operation.oldPath === plan.oldFilePath ||
    (operation.oldPath === plan.oldMetaPath && selectedKinds.has('meta'))
  );
}

async function pickRenameOperations(
  runtimeVscode: typeof vscode,
  plan: ScriptFilenameSyncPlan,
  operations: readonly ScriptFileRenameOperation[]
): Promise<ScriptFileRenameOperation[] | undefined> {
  const scriptOperation = operations.find(operation => operation.oldPath === plan.oldFilePath);
  const metaOperation = operations.find(operation => operation.oldPath === plan.oldMetaPath);
  const scriptLabel = runtimeVscode.l10n.t('Rename script file');
  const metaLabel = runtimeVscode.l10n.t('Rename Unity meta file');
  const items: RenameOperationQuickPickItem[] = [];

  if (scriptOperation) {
    items.push({
      label: scriptLabel,
      description: `${basename(scriptOperation.oldPath)} -> ${basename(scriptOperation.newPath)}`,
      picked: true,
      operation: scriptOperation,
      operationKind: 'script'
    });
  }

  if (metaOperation) {
    items.push({
      label: metaLabel,
      description: `${basename(metaOperation.oldPath)} -> ${basename(metaOperation.newPath)}`,
      picked: scriptOperation !== undefined,
      operation: metaOperation,
      operationKind: 'meta'
    });
  }

  const selectedItems = await runtimeVscode.window.showQuickPick<RenameOperationQuickPickItem>(items, {
    canPickMany: true,
    title: runtimeVscode.l10n.t('Unity Plus Rename Options'),
    placeHolder: runtimeVscode.l10n.t('Choose file changes to apply with the C# type rename')
  });

  if (!selectedItems) {
    return undefined;
  }

  const selectedKinds = new Set(selectedItems.map(item => item.operationKind));
  if (!selectedKinds.has('script')) {
    return [];
  }

  return selectedItems
    .filter(item => item.operation && (item.operationKind === 'script' || selectedKinds.has('script')))
    .map(item => item.operation!);
}

async function confirmDetailedRenameWarning(
  runtimeVscode: typeof vscode,
  plan: ScriptFilenameSyncPlan,
  operations: readonly ScriptFileRenameOperation[],
  edit: vscode.WorkspaceEdit
): Promise<boolean> {
  const codeFiles = getWorkspaceEditAffectedFiles(edit);
  const lines = [
    runtimeVscode.l10n.t('Unity Plus will rename:'),
    runtimeVscode.l10n.t('Class: {oldName} -> {newName}', {
      oldName: plan.oldTypeName,
      newName: plan.newTypeName
    })
  ];

  if (codeFiles.length > 0) {
    lines.push(runtimeVscode.l10n.t('C# references in: {files}', {
      files: formatAffectedFiles(runtimeVscode, codeFiles, 5)
    }));
  }

  const scriptOperation = operations.find(operation => operation.oldPath === plan.oldFilePath);
  const metaOperation = operations.find(operation => operation.oldPath === plan.oldMetaPath);
  if (scriptOperation) {
    lines.push(runtimeVscode.l10n.t('Script file: {oldName} -> {newName}', {
      oldName: basename(scriptOperation.oldPath),
      newName: basename(scriptOperation.newPath)
    }));
  }

  if (metaOperation) {
    lines.push(runtimeVscode.l10n.t('Unity meta file: {oldName} -> {newName}', {
      oldName: basename(metaOperation.oldPath),
      newName: basename(metaOperation.newPath)
    }));
  }

  const confirmLabel = runtimeVscode.l10n.t('Rename');
  const selected = await runtimeVscode.window.showWarningMessage(
    lines.join('\n'),
    { modal: true },
    confirmLabel
  );
  return selected === confirmLabel;
}

function getWorkspaceEditAffectedFiles(edit: vscode.WorkspaceEdit): string[] {
  if (typeof edit.entries !== 'function') {
    return [];
  }

  return edit.entries()
    .filter(([, edits]) => edits.length > 0)
    .map(([uri]) => uri.fsPath);
}

function formatAffectedFiles(runtimeVscode: typeof vscode, files: readonly string[], limit: number): string {
  const visibleFiles = files.slice(0, limit).map(file => basename(file));
  const hiddenCount = files.length - visibleFiles.length;

  if (hiddenCount === 0) {
    return visibleFiles.join(', ');
  }

  return `${visibleFiles.join(', ')}, ${runtimeVscode.l10n.t('and {count} other files', { count: hiddenCount })}`;
}

export async function syncScriptRenameAfterClassChange(runtime: ScriptRenameSyncRuntime): Promise<{
  newType?: CSharpTopLevelTypeSnapshot;
  appliedPlan?: ScriptFilenameSyncPlan;
}> {
  // Let the C# provider settle after a Rename Symbol edit before reading document symbols.
  await runtime.wait(runtime.debounceMs);

  const { newType, plan } = await waitForScriptRenamePlan(runtime);

  if (!plan) {
    return { newType };
  }

  const applied = await runtime.showProgress('Unity Plus: Syncing script rename...', async () =>
    await applyScriptFilenameSyncPlan(plan, runtime.operations)
  );

  if (!applied) {
    const message = `Unity script rename sync did not apply for ${basename(runtime.filePath)}. See Unity Plus output for details.`;
    runtime.logger.warn(message);
    runtime.showWarningMessage(`Unity Plus: ${message}`);
    return { newType };
  }

  const message = `Unity Plus: Renamed ${basename(plan.oldFilePath)} -> ${basename(plan.newFilePath)}`;
  runtime.logger.info(message);
  runtime.showInformationMessage(message);
  return { newType, appliedPlan: plan };
}

function createScriptFilenameSyncPlan(
  filePath: string,
  oldTypeName: string,
  newTypeName: string
): ScriptFilenameSyncPlan {
  return {
    oldTypeName,
    newTypeName,
    oldFilePath: filePath,
    newFilePath: join(dirname(filePath), `${newTypeName}.cs`),
    oldMetaPath: `${filePath}.meta`,
    newMetaPath: `${join(dirname(filePath), `${newTypeName}.cs`)}.meta`,
    isUndo: false
  };
}

async function waitForScriptRenamePlan(runtime: ScriptRenameSyncRuntime): Promise<{
  newType?: CSharpTopLevelTypeSnapshot;
  plan?: ScriptFilenameSyncPlan;
}> {
  let elapsedMs = 0;
  let latestType: CSharpTopLevelTypeSnapshot | undefined;

  while (elapsedMs <= runtime.settleTimeoutMs) {
    latestType = await getPrimaryTopLevelType(runtime.languageService, runtime.uri, runtime.mode, runtime.logger);
    const plan = planScriptFilenameSync(
      runtime.filePath,
      runtime.oldType,
      latestType,
      runtime.mode,
      runtime.recentSync
    );

    if (plan) {
      return { newType: latestType, plan };
    }

    if (!shouldRetryClassRenameSnapshot(runtime.oldType, latestType)) {
      return { newType: latestType };
    }

    await runtime.wait(runtime.retryIntervalMs);
    elapsedMs += runtime.retryIntervalMs;
  }

  runtime.logger.debug(`C# language service did not settle a script rename plan for ${basename(runtime.filePath)}.`);
  return { newType: latestType };
}

function shouldRetryClassRenameSnapshot(
  oldType: CSharpTopLevelTypeSnapshot | undefined,
  newType: CSharpTopLevelTypeSnapshot | undefined
): boolean {
  if (!oldType) {
    return false;
  }

  return !newType || oldType.name === newType.name;
}

export function planScriptFilenameSync(
  filePath: string,
  oldType: CSharpTopLevelTypeSnapshot | undefined,
  newType: CSharpTopLevelTypeSnapshot | undefined,
  mode: RenameFileSyncMode = 'on',
  recentSync?: RecentScriptFilenameSync
): ScriptFilenameSyncPlan | undefined {
  if (mode === 'off') {
    return undefined;
  }

  if (!oldType || !newType || oldType.name === newType.name) {
    return undefined;
  }

  const undoPlan = planUndoScriptFilenameSync(filePath, oldType.name, newType.name, recentSync);
  if (undoPlan) {
    return undoPlan;
  }

  if (!hasCompatibleRenameTypes(oldType, newType)) {
    return undefined;
  }

  if (basename(filePath) !== `${oldType.name}.cs`) {
    return undefined;
  }

  return {
    oldTypeName: oldType.name,
    newTypeName: newType.name,
    oldFilePath: filePath,
    newFilePath: join(dirname(filePath), `${newType.name}.cs`),
    oldMetaPath: `${filePath}.meta`,
    newMetaPath: `${join(dirname(filePath), `${newType.name}.cs`)}.meta`,
    isUndo: false
  };
}

export function invertScriptFilenameSyncPlan(plan: ScriptFilenameSyncPlan): ScriptFilenameSyncPlan {
  return {
    oldTypeName: plan.newTypeName,
    newTypeName: plan.oldTypeName,
    oldFilePath: plan.newFilePath,
    newFilePath: plan.oldFilePath,
    oldMetaPath: plan.newMetaPath,
    newMetaPath: plan.oldMetaPath,
    isUndo: !plan.isUndo
  };
}

function planUndoScriptFilenameSync(
  filePath: string,
  oldTypeName: string,
  newTypeName: string,
  recentSync?: RecentScriptFilenameSync
): ScriptFilenameSyncPlan | undefined {
  if (!recentSync) {
    return undefined;
  }

  const undoPlan = invertScriptFilenameSyncPlan(recentSync.plan);

  if (
    filePath === undoPlan.oldFilePath &&
    oldTypeName === undoPlan.oldTypeName &&
    newTypeName === undoPlan.newTypeName
  ) {
    return undoPlan;
  }

  return undefined;
}

export async function applyScriptFilenameSyncPlan(
  plan: ScriptFilenameSyncPlan,
  operations: ScriptFilenameSyncOperations
): Promise<boolean> {
  const renameOperations = await buildScriptFilenameSyncOperations(plan, operations);

  if (renameOperations.length === 0) {
    return false;
  }

  return await operations.applyRenameOperations(renameOperations);
}

export async function buildScriptFilenameSyncOperations(
  plan: ScriptFilenameSyncPlan,
  operations: Pick<ScriptFilenameSyncOperations, 'fileExists' | 'logger'>
): Promise<ScriptFileRenameOperation[]> {
  if (!await operations.fileExists(plan.oldFilePath)) {
    operations.logger.warn(`Unity script file was not found for ${basename(plan.oldFilePath)}.`);
    return [];
  }

  if (await operations.fileExists(plan.newFilePath)) {
    operations.logger.warn(`Unity script rename skipped because ${basename(plan.newFilePath)} already exists.`);
    return [];
  }

  const renameOperations: ScriptFileRenameOperation[] = [{
    oldPath: plan.oldFilePath,
    newPath: plan.newFilePath
  }];

  if (!await operations.fileExists(plan.oldMetaPath)) {
    operations.logger.debug(`Unity script meta file was not found for ${basename(plan.oldMetaPath)}.`);
    return renameOperations;
  }

  if (await operations.fileExists(plan.newMetaPath)) {
    operations.logger.warn(`Unity script rename skipped because ${basename(plan.newMetaPath)} already exists.`);
    return [];
  }

  renameOperations.push({
    oldPath: plan.oldMetaPath,
    newPath: plan.newMetaPath
  });

  return renameOperations;
}

export async function buildAssetMetaRenameOperations(
  moves: readonly ScriptFileMove[],
  operations: Pick<ScriptFilenameSyncOperations, 'fileExists'>
): Promise<AssetMetaRenamePreflightResult> {
  const eventMoveKeys = new Set(moves.map(move => scriptMoveKey(move.oldPath, move.newPath)));
  const candidateOperations: ScriptFileRenameOperation[] = [];
  const risks: AssetMetaRenameRisk[] = [];
  const explicitMetaSourcePaths = new Set(
    moves.filter(isMetaFileMove).map(move => pathComparisonKey(move.oldPath))
  );

  for (const move of moves) {
    if (isMetaFileMove(move)) {
      continue;
    }

    const oldMetaPath = `${move.oldPath}.meta`;
    const newMetaPath = `${move.newPath}.meta`;

    // VS Code may report a paired .meta rename in the same batch; do not duplicate it.
    if (eventMoveKeys.has(scriptMoveKey(oldMetaPath, newMetaPath))) {
      continue;
    }

    if (!await operations.fileExists(oldMetaPath)) {
      if (!isUnityAssetsPath(move.oldPath)) {
        continue;
      }

      risks.push({
        kind: 'missing-source-meta',
        assetPath: move.oldPath,
        metaPath: oldMetaPath
      });
      continue;
    }

    candidateOperations.push({
      oldPath: oldMetaPath,
      newPath: newMetaPath
    });
  }

  const vacatedMetaSourcePaths = new Set([
    ...explicitMetaSourcePaths,
    ...candidateOperations.map(operation => pathComparisonKey(operation.oldPath))
  ]);

  for (const operation of candidateOperations) {
    const destinationIsVacated = vacatedMetaSourcePaths.has(pathComparisonKey(operation.newPath));
    if (isCaseOnlyRename(operation) || destinationIsVacated) {
      continue;
    }

    if (await operations.fileExists(operation.newPath)) {
      risks.push({
        kind: 'destination-meta-exists',
        assetPath: operation.oldPath.slice(0, -'.meta'.length),
        metaPath: operation.newPath
      });
    }
  }

  return {
    operations: risks.length === 0 ? candidateOperations : [],
    risks
  };
}

async function fileExists(runtimeVscode: typeof vscode, path: string): Promise<boolean> {
  try {
    await runtimeVscode.workspace.fs.stat(runtimeVscode.Uri.file(path));
    return true;
  } catch {
    return false;
  }
}

async function applyRenameOperations(
  runtimeVscode: typeof vscode,
  renameOperations: readonly ScriptFileRenameOperation[]
): Promise<boolean> {
  const edit = new runtimeVscode.WorkspaceEdit();

  renameOperations.forEach(operation => {
    edit.renameFile(
      runtimeVscode.Uri.file(operation.oldPath),
      runtimeVscode.Uri.file(operation.newPath),
      { overwrite: false }
    );
  });

  return await runtimeVscode.workspace.applyEdit(edit, { isRefactoring: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMetaFileMove(move: ScriptFileMove): boolean {
  return move.oldPath.endsWith('.meta') || move.newPath.endsWith('.meta');
}

/** Returns whether a path is managed as an authored Unity asset. */
function isUnityAssetsPath(path: string): boolean {
  return /(^|[\\/])Assets([\\/]|$)/i.test(path);
}

/** Returns a stable key for batch comparisons across case-insensitive file systems. */
function pathComparisonKey(path: string): string {
  return path.toLocaleLowerCase();
}

/** Returns whether the companion meta move changes only path casing. */
function isCaseOnlyRename(operation: ScriptFileRenameOperation): boolean {
  return operation.oldPath !== operation.newPath
    && pathComparisonKey(operation.oldPath) === pathComparisonKey(operation.newPath);
}

/** Shows one warning for an unsafe batch instead of one notification per asset. */
function showAssetMetaRenameWarning(
  runtimeVscode: typeof vscode,
  risks: readonly AssetMetaRenameRisk[],
  logger: UnityPlusLogger
): void {
  const visibleRisks = risks.slice(0, 3);
  const details = visibleRisks.map(risk => risk.kind === 'missing-source-meta'
    ? runtimeVscode.l10n.t('Missing source meta file: {path}', { path: risk.metaPath })
    : runtimeVscode.l10n.t('Destination meta file already exists: {path}', { path: risk.metaPath }));

  if (risks.length > visibleRisks.length) {
    details.push(runtimeVscode.l10n.t('... and {count} more meta file issue(s).', {
      count: risks.length - visibleRisks.length
    }));
  }

  const message = runtimeVscode.l10n.t(
    'Unity Plus: The asset rename will continue, but no Unity meta files were moved because this batch has conflicts:\n{details}',
    { details: details.join('\n') }
  );
  logger.warn(message);
  void runtimeVscode.window.showWarningMessage(message);
}

function getAtomicRenameFallbackReason(
  filePath: string,
  currentType: CSharpTopLevelTypeSnapshot | undefined,
  cursor: CSharpPosition,
  mode: RenameFileSyncMode
): string | undefined {
  if (mode === 'off') {
    return 'Rename sync mode is off; using VS Code Rename Symbol.';
  }

  if (!currentType) {
    return 'Using VS Code Rename Symbol because no primary top-level C# type was found.';
  }

  if (!currentType.position || !currentType.nameRange) {
    return 'Using VS Code Rename Symbol because the primary top-level type location is unavailable.';
  }

  if (!isPositionInRange(cursor, currentType.nameRange)) {
    // Field and member renames should pass through to the native C# rename provider immediately.
    return 'Using VS Code Rename Symbol because the cursor is not on the primary top-level type name.';
  }

  if (basename(filePath) !== `${currentType.name}.cs`) {
    return 'Using VS Code Rename Symbol because type/file names do not match.';
  }

  return undefined;
}

function isPositionInRange(position: CSharpPosition, range: NonNullable<CSharpTopLevelTypeSnapshot['nameRange']>): boolean {
  if (position.line < range.start.line || position.line > range.end.line) {
    return false;
  }

  if (position.line === range.start.line && position.character < range.start.character) {
    return false;
  }

  if (position.line === range.end.line && position.character > range.end.character) {
    return false;
  }

  return true;
}

function isValidCSharpIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

async function executeNativeRename(runtimeVscode: typeof vscode): Promise<void> {
  await runtimeVscode.commands.executeCommand('editor.action.rename');
}

async function fallbackToNativeRename(
  runtime: Pick<RenameTypeCommandRuntime, 'executeNativeRename' | 'showInformationMessage'>,
  reason: string,
  visibility: RenameFallbackVisibility = 'informational'
): Promise<RenameTypeCommandResult> {
  await runtime.executeNativeRename();
  if (visibility === 'informational') {
    runtime.showInformationMessage(`Unity Plus: ${reason}`);
  }
  return { kind: 'fallback', reason, visibility };
}

function getRenameFallbackVisibility(reason: string): RenameFallbackVisibility {
  if (reason.includes('cursor is not on the primary top-level type name')) {
    return 'silent';
  }

  return 'informational';
}

function createRenameCommandEditor(editor: vscode.TextEditor | undefined): RenameCommandEditor | undefined {
  if (!editor) {
    return undefined;
  }

  return {
    languageId: editor.document.languageId,
    uri: editor.document.uri,
    filePath: editor.document.uri.fsPath,
    cursor: {
      line: editor.selection.active.line,
      character: editor.selection.active.character
    }
  };
}

function scriptMoveKey(oldPath: string, newPath: string): string {
  return `${oldPath}\n${newPath}`;
}

function hasCompatibleRenameTypes(
  oldType: CSharpTopLevelTypeSnapshot,
  newType: CSharpTopLevelTypeSnapshot
): boolean {
  if (oldType.namespace !== newType.namespace) {
    return false;
  }

  return true;
}

async function refreshPrimaryTopLevelType(
  languageService: CSharpLanguageService,
  uri: vscode.Uri,
  mode: RenameFileSyncMode,
  previousCsharpTypes: Map<string, CSharpTopLevelTypeSnapshot>,
  logger: UnityPlusLogger
): Promise<void> {
  const primaryTopLevelType = await getPrimaryTopLevelType(languageService, uri, mode, logger);
  if (primaryTopLevelType) {
    previousCsharpTypes.set(uri.fsPath, primaryTopLevelType);
  }
}

async function getPrimaryTopLevelType(
  languageService: CSharpLanguageService,
  uri: vscode.Uri,
  _mode: RenameFileSyncMode,
  logger: UnityPlusLogger
): Promise<CSharpTopLevelTypeSnapshot | undefined> {
  try {
    return await languageService.getPrimaryTopLevelType(uri);
  } catch (error) {
    logger.debug(`C# language service did not return a primary top-level type for ${basename(uri.fsPath)}: ${errorMessage(error)}`);
    return undefined;
  }
}

function getRenameFileSyncMode(runtimeVscode: typeof vscode): RenameFileSyncMode {
  const mode = runtimeVscode.workspace.getConfiguration('unityPlus').get<string>('rename.classFileSyncMode', 'on');

  return normalizeRenameFileSyncMode(mode);
}

function getRenamePreviewMode(runtimeVscode: typeof vscode): RenamePreviewMode {
  const mode = runtimeVscode.workspace.getConfiguration('unityPlus').get<string>('rename.previewMode', 'ask');

  return normalizeRenamePreviewMode(mode);
}

function getMetaFilesMoveWithAsset(runtimeVscode: typeof vscode): boolean {
  return runtimeVscode.workspace.getConfiguration('unityPlus').get<boolean>('metaFiles.moveWithAsset', true) === true;
}

function normalizeRenameFileSyncMode(mode: string | undefined): RenameFileSyncMode {
  if (mode === 'off') {
    return 'off';
  }

  if (isLegacyEnabledRenameFileSyncMode(mode)) {
    return 'on';
  }

  return 'on';
}

function isLegacyEnabledRenameFileSyncMode(mode: string | undefined): mode is Exclude<LegacyRenameFileSyncMode, 'off'> {
  return mode === 'on' || mode === 'unity-object' || mode === 'any';
}

function normalizeRenamePreviewMode(mode: string | undefined): RenamePreviewMode {
  if (mode === 'silent' || mode === 'ask+warn') {
    return mode;
  }

  return 'ask';
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
