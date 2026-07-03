import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createVscodeCSharpLanguageService, CSharpTopLevelTypeSnapshot, CSharpLanguageService, CSharpPosition } from '../../unity/csharpLanguageService';
import { UnityPlusLogger } from '../../unity/logger';

export type RenameFileSyncMode = 'on' | 'off';
type LegacyRenameFileSyncMode = RenameFileSyncMode | 'unity-object' | 'any';

export interface RenameFeatureOptions {
  runtimeVscode?: typeof vscode;
  getMode?: () => RenameFileSyncMode;
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

export interface ScriptFileMove {
  oldPath: string;
  newPath: string;
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
  currentType: CSharpTopLevelTypeSnapshot | undefined;
  cursor: CSharpPosition;
  newTypeName: string;
  languageService: CSharpLanguageService;
  fileExists(path: string): Promise<boolean>;
  createFileUri(path: string): vscode.Uri;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
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
  languageService: CSharpLanguageService;
  showInputBox(options: { value: string; prompt: string; validateInput(value: string): string | undefined }): Promise<string | undefined>;
  showProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  showInformationMessage(message: string): void;
  showWarningMessage(message: string): void;
  executeNativeRename(): Promise<void>;
  executeAtomicRename(request: AtomicScriptRenameRuntime): Promise<AtomicScriptRenameResult>;
  fileExists(path: string): Promise<boolean>;
  createFileUri(path: string): vscode.Uri;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  wait(ms: number): Promise<void>;
  retryIntervalMs: number;
  settleTimeoutMs: number;
  markSyncing(filePath: string): void;
  unmarkSyncing(filePath: string): void;
  logger: UnityPlusLogger;
}

export type RenameTypeCommandResult =
  | { kind: 'applied'; oldTypeName: string; newTypeName: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

export type AtomicScriptRenameResult =
  | { kind: 'applied'; oldTypeName: string; newTypeName: string }
  | { kind: 'fallback'; reason: string }
  | { kind: 'failed'; message: string };

export function registerRenameFeature(
  logger: UnityPlusLogger,
  options: RenameFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const getMode = options.getMode ?? (() => getRenameFileSyncMode(runtimeVscode));
  const isUnityWorkspace = options.isUnityWorkspace ?? true;
  const languageService = createVscodeCSharpLanguageService(runtimeVscode);
  const disposables: vscode.Disposable[] = [];
  const previousCsharpTypes = new Map<string, CSharpTopLevelTypeSnapshot>();
  const syncingScriptRenameFiles = new Set<string>();
  let recentSync: RecentScriptFilenameSync | undefined;

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncScriptFilename', async () => {
    logger.info('Script filename sync is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage('Unity Plus: script filename sync is planned for v0.2.');
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncClassName', async () => {
    try {
      const result = await runRenameTypeCommand({
        editor: createRenameCommandEditor(runtimeVscode.window.activeTextEditor),
        mode: getMode(),
        languageService,
        showInputBox: async options => await runtimeVscode.window.showInputBox(options),
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
        wait,
        retryIntervalMs: 200,
        settleTimeoutMs: 2000,
        markSyncing: filePath => syncingScriptRenameFiles.add(filePath),
        unmarkSyncing: filePath => syncingScriptRenameFiles.delete(filePath),
        logger
      });

      if (result.kind === 'fallback') {
        logger.info(`Unity Plus: ${result.reason}`);
      } else if (result.kind === 'failed') {
        logger.warn(result.message);
        void runtimeVscode.window.showWarningMessage(`Unity Plus: ${result.message}`);
      } else if (result.kind === 'applied') {
        const message = `Unity Plus: Renamed ${result.oldTypeName} -> ${result.newTypeName}`;
        logger.info(message);
        void runtimeVscode.window.showInformationMessage(message);
      }
    } catch (error) {
      const message = `Could not rename C# type and script file: ${errorMessage(error)}`;
      logger.warn(message);
      void runtimeVscode.window.showWarningMessage(`Unity Plus: ${message}`);
    }
  }));

  if (isUnityWorkspace && getMode() !== 'off') {
    disposables.push(runtimeVscode.workspace.onDidRenameFiles(event => {
      if (getMode() === 'off') {
        return;
      }

      const csharpMoves = event.files.filter(file => file.oldUri.path.endsWith('.cs') || file.newUri.path.endsWith('.cs'));
      if (csharpMoves.length > 0) {
        logger.debug(`Observed ${csharpMoves.length} C# rename operation(s).`);
      }

      for (const file of csharpMoves) {
        const previousType = previousCsharpTypes.get(file.oldUri.fsPath);
        if (previousType) {
          previousCsharpTypes.set(file.newUri.fsPath, previousType);
          previousCsharpTypes.delete(file.oldUri.fsPath);
        }
      }

      void moveScriptMetaFilesForDirectRename(runtimeVscode, event.files.map(file => ({
        oldPath: file.oldUri.fsPath,
        newPath: file.newUri.fsPath
      })), logger);
    }));

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
        void runtimeVscode.window.showWarningMessage(`Unity Plus: ${message}`);
      } finally {
        syncingScriptRenameFiles.delete(filePath);
      }
    }));
  }

  return runtimeVscode.Disposable.from(...disposables);
}

export async function runRenameTypeCommand(runtime: RenameTypeCommandRuntime): Promise<RenameTypeCommandResult> {
  return await runtime.showProgress('Unity Plus: Preparing rename...', async () =>
    await runPreparedRenameTypeCommand(runtime)
  );
}

async function runPreparedRenameTypeCommand(runtime: RenameTypeCommandRuntime): Promise<RenameTypeCommandResult> {
  runtime.logger.debug('Unity Plus rename command started.');

  if (!runtime.editor) {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because no active editor is available.');
  }

  if (runtime.editor.languageId !== 'csharp') {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because this is not a C# editor.');
  }

  if (runtime.mode === 'off') {
    return await fallbackToNativeRename(runtime, 'Rename sync mode is off; using VS Code Rename Symbol.');
  }

  const { currentType, fallbackReason } = await waitForRenameCommandPrimaryTopLevelType(runtime);
  runtime.logger.debug(`Unity Plus rename command primary top-level type: ${currentType?.name ?? '<none>'}.`);

  if (fallbackReason) {
    return await fallbackToNativeRename(runtime, fallbackReason);
  }

  const renameType = currentType;
  if (!renameType) {
    return await fallbackToNativeRename(runtime, 'Using VS Code Rename Symbol because no primary top-level C# type was found.');
  }

  const newTypeName = await runtime.showInputBox({
    value: renameType.name,
    prompt: 'Rename C# type, script file, and Unity meta file',
    validateInput: value => isValidCSharpIdentifier(value) ? undefined : 'Enter a valid C# type name.'
  });

  if (!newTypeName || newTypeName === renameType.name) {
    runtime.logger.debug('Unity Plus rename command was cancelled or unchanged.');
    return { kind: 'cancelled' };
  }

  runtime.markSyncing(runtime.editor.filePath);
  try {
    const result = await runtime.showProgress('Unity Plus: Renaming type and script file...', async () =>
      await runtime.executeAtomicRename({
        uri: runtime.editor!.uri,
        filePath: runtime.editor!.filePath,
        mode: runtime.mode,
        currentType: renameType,
        cursor: runtime.editor!.cursor,
        newTypeName,
        languageService: runtime.languageService,
        fileExists: runtime.fileExists,
        createFileUri: runtime.createFileUri,
        applyWorkspaceEdit: runtime.applyWorkspaceEdit,
        logger: runtime.logger
      })
    );

    if (result.kind === 'fallback') {
      return await fallbackToNativeRename(runtime, result.reason);
    }

    return result;
  } finally {
    runtime.unmarkSyncing(runtime.editor.filePath);
  }
}

async function waitForRenameCommandPrimaryTopLevelType(runtime: RenameTypeCommandRuntime): Promise<{
  currentType?: CSharpTopLevelTypeSnapshot;
  fallbackReason?: string;
}> {
  if (!runtime.editor) {
    return { fallbackReason: 'Using VS Code Rename Symbol because no active editor is available.' };
  }

  let elapsedMs = 0;
  let attempts = 0;
  let latestType: CSharpTopLevelTypeSnapshot | undefined;
  let latestReason: string | undefined;

  while (elapsedMs <= runtime.settleTimeoutMs) {
    attempts += 1;
    latestType = await getPrimaryTopLevelType(runtime.languageService, runtime.editor.uri, runtime.mode, runtime.logger);
    latestReason = getAtomicRenameFallbackReason(
      runtime.editor.filePath,
      latestType,
      runtime.editor.cursor,
      runtime.mode
    );

    if (!latestReason || !isRetryableAtomicRenameFallbackReason(latestReason)) {
      runtime.logger.debug(`Unity Plus rename command primary top-level type settled after ${attempts} attempt(s).`);
      return {
        currentType: latestType,
        fallbackReason: latestReason
      };
    }

    await runtime.wait(runtime.retryIntervalMs);
    elapsedMs += runtime.retryIntervalMs;
  }

  runtime.logger.debug(`Unity Plus rename command primary top-level type did not settle after ${attempts} attempt(s).`);
  return {
    currentType: latestType,
    fallbackReason: latestReason ?? 'Using VS Code Rename Symbol because no primary top-level C# type was found.'
  };
}

function isRetryableAtomicRenameFallbackReason(reason: string): boolean {
  return reason.includes('no primary top-level C# type was found') ||
    reason.includes('primary top-level type location is unavailable');
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

  for (const operation of renameOperations) {
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

export async function buildScriptMetaRenameOperations(
  moves: readonly ScriptFileMove[],
  operations: Pick<ScriptFilenameSyncOperations, 'fileExists' | 'logger'>
): Promise<ScriptFileRenameOperation[]> {
  const eventMoveKeys = new Set(moves.map(move => scriptMoveKey(move.oldPath, move.newPath)));
  const renameOperations: ScriptFileRenameOperation[] = [];

  for (const move of moves) {
    if (!isCSharpScriptMove(move)) {
      continue;
    }

    const oldMetaPath = `${move.oldPath}.meta`;
    const newMetaPath = `${move.newPath}.meta`;

    // VS Code may report a paired .meta rename in the same batch; do not duplicate it.
    if (eventMoveKeys.has(scriptMoveKey(oldMetaPath, newMetaPath))) {
      continue;
    }

    if (!await operations.fileExists(oldMetaPath)) {
      operations.logger.debug(`Unity script meta file was not found for ${basename(oldMetaPath)}.`);
      continue;
    }

    if (await operations.fileExists(newMetaPath)) {
      operations.logger.warn(`Unity script meta rename skipped because ${basename(newMetaPath)} already exists.`);
      continue;
    }

    renameOperations.push({
      oldPath: oldMetaPath,
      newPath: newMetaPath
    });
  }

  return renameOperations;
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

async function moveScriptMetaFilesForDirectRename(
  runtimeVscode: typeof vscode,
  moves: readonly ScriptFileMove[],
  logger: UnityPlusLogger
): Promise<void> {
  const renameOperations = await buildScriptMetaRenameOperations(moves, {
    fileExists: async path => await fileExists(runtimeVscode, path),
    logger
  });

  if (renameOperations.length === 0) {
    return;
  }

  const applied = await applyRenameOperations(runtimeVscode, renameOperations);
  if (applied) {
    logger.info(`Moved ${renameOperations.length} Unity script meta file(s) after C# file rename.`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCSharpScriptMove(move: ScriptFileMove): boolean {
  return move.oldPath.endsWith('.cs') && move.newPath.endsWith('.cs');
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

  if (basename(filePath) !== `${currentType.name}.cs`) {
    return 'Using VS Code Rename Symbol because type/file names do not match.';
  }

  if (!isPositionInRange(cursor, currentType.nameRange)) {
    return 'Using VS Code Rename Symbol because the cursor is not on the primary top-level type name.';
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
  reason: string
): Promise<RenameTypeCommandResult> {
  await runtime.executeNativeRename();
  runtime.showInformationMessage(`Unity Plus: ${reason}`);
  return { kind: 'fallback', reason };
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

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
