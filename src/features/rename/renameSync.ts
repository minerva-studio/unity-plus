import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createVscodeCSharpLanguageService, CSharpClassSnapshot, CSharpLanguageService, CSharpPosition } from '../../unity/csharpLanguageService';
import { UnityPlusLogger } from '../../unity/logger';

export type RenameClassFileSyncMode = 'unity-object' | 'any' | 'off';

export interface ScriptFilenameSyncPlan {
  oldClassName: string;
  newClassName: string;
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
  mode: RenameClassFileSyncMode;
  oldClass: CSharpClassSnapshot | undefined;
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
  mode: RenameClassFileSyncMode;
  currentClass: CSharpClassSnapshot | undefined;
  cursor: CSharpPosition;
  newClassName: string;
  languageService: CSharpLanguageService;
  fileExists(path: string): Promise<boolean>;
  createFileUri(path: string): vscode.Uri;
  applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean>;
  logger: UnityPlusLogger;
}

export type AtomicScriptRenameResult =
  | { kind: 'applied'; oldClassName: string; newClassName: string }
  | { kind: 'fallback' }
  | { kind: 'failed'; message: string };

export function registerRenameFeature(logger: UnityPlusLogger): vscode.Disposable {
  const runtimeVscode = loadVscode();
  const languageService = createVscodeCSharpLanguageService(runtimeVscode);
  const disposables: vscode.Disposable[] = [];
  const previousCsharpClasses = new Map<string, CSharpClassSnapshot>();
  const syncingScriptRenameFiles = new Set<string>();
  let recentSync: RecentScriptFilenameSync | undefined;

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncScriptFilename', async () => {
    logger.info('Script filename sync is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage('Unity Plus: script filename sync is planned for v0.2.');
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncClassName', async () => {
    const editor = runtimeVscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'csharp') {
      await executeNativeRename(runtimeVscode);
      return;
    }

    const mode = getRenameClassFileSyncMode(runtimeVscode);
    if (mode === 'off') {
      await executeNativeRename(runtimeVscode);
      return;
    }

    const currentClass = await getPrimaryClass(languageService, editor.document.uri, mode, logger);
    if (!canAttemptAtomicScriptRename(editor.document.uri.fsPath, currentClass, editor.selection.active, mode)) {
      await executeNativeRename(runtimeVscode);
      return;
    }

    const newClassName = await runtimeVscode.window.showInputBox({
      value: currentClass.name,
      prompt: 'Rename C# class, script file, and Unity meta file',
      validateInput: value => isValidCSharpIdentifier(value) ? undefined : 'Enter a valid C# class name.'
    });

    if (!newClassName || newClassName === currentClass.name) {
      return;
    }

    syncingScriptRenameFiles.add(editor.document.uri.fsPath);
    try {
      const result = await runtimeVscode.window.withProgress({
        location: runtimeVscode.ProgressLocation.Notification,
        title: 'Unity Plus: Renaming class and script file...'
      }, async () => await executeAtomicScriptRename({
        uri: editor.document.uri,
        filePath: editor.document.uri.fsPath,
        mode,
        currentClass,
        cursor: {
          line: editor.selection.active.line,
          character: editor.selection.active.character
        },
        newClassName,
        languageService,
        fileExists: async path => await fileExists(runtimeVscode, path),
        createFileUri: path => runtimeVscode.Uri.file(path),
        applyWorkspaceEdit: async edit => await runtimeVscode.workspace.applyEdit(edit, { isRefactoring: true }),
        logger
      }));

      if (result.kind === 'fallback') {
        await executeNativeRename(runtimeVscode);
      } else if (result.kind === 'failed') {
        logger.warn(result.message);
        void runtimeVscode.window.showWarningMessage(`Unity Plus: ${result.message}`);
      } else {
        const message = `Unity Plus: Renamed ${result.oldClassName} -> ${result.newClassName}`;
        logger.info(message);
        void runtimeVscode.window.showInformationMessage(message);
      }
    } catch (error) {
      const message = `Could not rename Unity script class: ${errorMessage(error)}`;
      logger.warn(message);
      void runtimeVscode.window.showWarningMessage(`Unity Plus: ${message}`);
    } finally {
      syncingScriptRenameFiles.delete(editor.document.uri.fsPath);
    }
  }));

  disposables.push(runtimeVscode.workspace.onDidRenameFiles(event => {
    const csharpMoves = event.files.filter(file => file.oldUri.path.endsWith('.cs') || file.newUri.path.endsWith('.cs'));
    if (csharpMoves.length > 0 && getRenameClassFileSyncMode(runtimeVscode) !== 'off') {
      logger.debug(`Observed ${csharpMoves.length} C# rename operation(s).`);
    }

    for (const file of csharpMoves) {
      const previousClass = previousCsharpClasses.get(file.oldUri.fsPath);
      if (previousClass) {
        previousCsharpClasses.set(file.newUri.fsPath, previousClass);
        previousCsharpClasses.delete(file.oldUri.fsPath);
      }
    }

    void moveScriptMetaFilesForDirectRename(runtimeVscode, event.files.map(file => ({
      oldPath: file.oldUri.fsPath,
      newPath: file.newUri.fsPath
    })), logger);
  }));

  runtimeVscode.workspace.textDocuments
    .filter(document => document.uri.fsPath.endsWith('.cs'))
    .forEach(document => {
      void refreshPrimaryClass(languageService, document.uri, getRenameClassFileSyncMode(runtimeVscode), previousCsharpClasses, logger);
    });

  disposables.push(runtimeVscode.workspace.onDidOpenTextDocument(document => {
    if (document.uri.fsPath.endsWith('.cs')) {
      void refreshPrimaryClass(languageService, document.uri, getRenameClassFileSyncMode(runtimeVscode), previousCsharpClasses, logger);
    }
  }));

  disposables.push(runtimeVscode.workspace.onDidCloseTextDocument(document => {
    previousCsharpClasses.delete(document.uri.fsPath);
  }));

  disposables.push(runtimeVscode.workspace.onDidChangeTextDocument(async event => {
    const filePath = event.document.uri.fsPath;
    if (!filePath.endsWith('.cs')) {
      return;
    }

    const mode = getRenameClassFileSyncMode(runtimeVscode);
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
        oldClass: previousCsharpClasses.get(filePath),
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

      if (result.newClass) {
        previousCsharpClasses.set(filePath, result.newClass);
      } else {
        previousCsharpClasses.delete(filePath);
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

  return runtimeVscode.Disposable.from(...disposables);
}

export async function executeAtomicScriptRename(runtime: AtomicScriptRenameRuntime): Promise<AtomicScriptRenameResult> {
  if (!canAttemptAtomicScriptRename(runtime.filePath, runtime.currentClass, runtime.cursor, runtime.mode)) {
    return { kind: 'fallback' };
  }

  const currentClass = runtime.currentClass;
  if (!currentClass.position) {
    return { kind: 'fallback' };
  }

  const renameEdit = await runtime.languageService.buildRenameEdit(
    runtime.uri,
    currentClass.position,
    runtime.newClassName
  );

  if (!renameEdit) {
    return { kind: 'failed', message: 'C# rename provider did not return a rename edit.' };
  }

  const plan = createScriptFilenameSyncPlan(runtime.filePath, currentClass.name, runtime.newClassName);
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
    oldClassName: currentClass.name,
    newClassName: runtime.newClassName
  };
}

export async function syncScriptRenameAfterClassChange(runtime: ScriptRenameSyncRuntime): Promise<{
  newClass?: CSharpClassSnapshot;
  appliedPlan?: ScriptFilenameSyncPlan;
}> {
  // Let the C# provider settle after a Rename Symbol edit before reading document symbols.
  await runtime.wait(runtime.debounceMs);

  const { newClass, plan } = await waitForScriptRenamePlan(runtime);

  if (!plan) {
    return { newClass };
  }

  const applied = await runtime.showProgress('Unity Plus: Syncing script rename...', async () =>
    await applyScriptFilenameSyncPlan(plan, runtime.operations)
  );

  if (!applied) {
    const message = `Unity script rename sync did not apply for ${basename(runtime.filePath)}. See Unity Plus output for details.`;
    runtime.logger.warn(message);
    runtime.showWarningMessage(`Unity Plus: ${message}`);
    return { newClass };
  }

  const message = `Unity Plus: Renamed ${basename(plan.oldFilePath)} -> ${basename(plan.newFilePath)}`;
  runtime.logger.info(message);
  runtime.showInformationMessage(message);
  return { newClass, appliedPlan: plan };
}

function createScriptFilenameSyncPlan(
  filePath: string,
  oldClassName: string,
  newClassName: string
): ScriptFilenameSyncPlan {
  return {
    oldClassName,
    newClassName,
    oldFilePath: filePath,
    newFilePath: join(dirname(filePath), `${newClassName}.cs`),
    oldMetaPath: `${filePath}.meta`,
    newMetaPath: `${join(dirname(filePath), `${newClassName}.cs`)}.meta`,
    isUndo: false
  };
}

async function waitForScriptRenamePlan(runtime: ScriptRenameSyncRuntime): Promise<{
  newClass?: CSharpClassSnapshot;
  plan?: ScriptFilenameSyncPlan;
}> {
  let elapsedMs = 0;
  let latestClass: CSharpClassSnapshot | undefined;

  while (elapsedMs <= runtime.settleTimeoutMs) {
    latestClass = await getPrimaryClass(runtime.languageService, runtime.uri, runtime.mode, runtime.logger);
    const plan = planScriptFilenameSync(
      runtime.filePath,
      runtime.oldClass,
      latestClass,
      runtime.mode,
      runtime.recentSync
    );

    if (plan) {
      return { newClass: latestClass, plan };
    }

    if (!shouldRetryClassRenameSnapshot(runtime.oldClass, latestClass)) {
      return { newClass: latestClass };
    }

    await runtime.wait(runtime.retryIntervalMs);
    elapsedMs += runtime.retryIntervalMs;
  }

  runtime.logger.debug(`C# language service did not settle a script rename plan for ${basename(runtime.filePath)}.`);
  return { newClass: latestClass };
}

function shouldRetryClassRenameSnapshot(
  oldClass: CSharpClassSnapshot | undefined,
  newClass: CSharpClassSnapshot | undefined
): boolean {
  if (!oldClass) {
    return false;
  }

  return !newClass || oldClass.name === newClass.name;
}

export function planScriptFilenameSync(
  filePath: string,
  oldClass: CSharpClassSnapshot | undefined,
  newClass: CSharpClassSnapshot | undefined,
  mode: RenameClassFileSyncMode = 'unity-object',
  recentSync?: RecentScriptFilenameSync
): ScriptFilenameSyncPlan | undefined {
  if (mode === 'off') {
    return undefined;
  }

  if (!oldClass || !newClass || oldClass.name === newClass.name) {
    return undefined;
  }

  const undoPlan = planUndoScriptFilenameSync(filePath, oldClass.name, newClass.name, recentSync);
  if (undoPlan) {
    return undoPlan;
  }

  if (!hasCompatibleRenameTypes(oldClass, newClass, mode)) {
    return undefined;
  }

  if (basename(filePath) !== `${oldClass.name}.cs`) {
    return undefined;
  }

  return {
    oldClassName: oldClass.name,
    newClassName: newClass.name,
    oldFilePath: filePath,
    newFilePath: join(dirname(filePath), `${newClass.name}.cs`),
    oldMetaPath: `${filePath}.meta`,
    newMetaPath: `${join(dirname(filePath), `${newClass.name}.cs`)}.meta`,
    isUndo: false
  };
}

export function invertScriptFilenameSyncPlan(plan: ScriptFilenameSyncPlan): ScriptFilenameSyncPlan {
  return {
    oldClassName: plan.newClassName,
    newClassName: plan.oldClassName,
    oldFilePath: plan.newFilePath,
    newFilePath: plan.oldFilePath,
    oldMetaPath: plan.newMetaPath,
    newMetaPath: plan.oldMetaPath,
    isUndo: !plan.isUndo
  };
}

function planUndoScriptFilenameSync(
  filePath: string,
  oldClassName: string,
  newClassName: string,
  recentSync?: RecentScriptFilenameSync
): ScriptFilenameSyncPlan | undefined {
  if (!recentSync) {
    return undefined;
  }

  const undoPlan = invertScriptFilenameSyncPlan(recentSync.plan);

  if (
    filePath === undoPlan.oldFilePath &&
    oldClassName === undoPlan.oldClassName &&
    newClassName === undoPlan.newClassName
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

function canAttemptAtomicScriptRename(
  filePath: string,
  currentClass: CSharpClassSnapshot | undefined,
  cursor: CSharpPosition,
  mode: RenameClassFileSyncMode
): currentClass is CSharpClassSnapshot & { position: CSharpPosition } {
  if (mode === 'off' || !currentClass?.position || !currentClass.nameRange) {
    return false;
  }

  if (mode === 'unity-object' && currentClass.isUnityObject !== true) {
    return false;
  }

  if (basename(filePath) !== `${currentClass.name}.cs`) {
    return false;
  }

  return isPositionInRange(cursor, currentClass.nameRange);
}

function isPositionInRange(position: CSharpPosition, range: NonNullable<CSharpClassSnapshot['nameRange']>): boolean {
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

function scriptMoveKey(oldPath: string, newPath: string): string {
  return `${oldPath}\n${newPath}`;
}

function hasCompatibleRenameTypes(
  oldType: CSharpClassSnapshot,
  newType: CSharpClassSnapshot,
  mode: RenameClassFileSyncMode
): boolean {
  if (oldType.namespace !== newType.namespace) {
    return false;
  }

  if (mode === 'unity-object') {
    return newType.isUnityObject === true;
  }

  return true;
}

async function refreshPrimaryClass(
  languageService: CSharpLanguageService,
  uri: vscode.Uri,
  mode: RenameClassFileSyncMode,
  previousCsharpClasses: Map<string, CSharpClassSnapshot>,
  logger: UnityPlusLogger
): Promise<void> {
  const primaryClass = await getPrimaryClass(languageService, uri, mode, logger);
  if (primaryClass) {
    previousCsharpClasses.set(uri.fsPath, primaryClass);
  }
}

async function getPrimaryClass(
  languageService: CSharpLanguageService,
  uri: vscode.Uri,
  mode: RenameClassFileSyncMode,
  logger: UnityPlusLogger
): Promise<CSharpClassSnapshot | undefined> {
  try {
    return await languageService.getPrimaryClass(uri, {
      includeUnityObject: mode === 'unity-object'
    });
  } catch (error) {
    logger.debug(`C# language service did not return a primary class for ${basename(uri.fsPath)}: ${errorMessage(error)}`);
    return undefined;
  }
}

function getRenameClassFileSyncMode(runtimeVscode: typeof vscode): RenameClassFileSyncMode {
  const mode = runtimeVscode.workspace.getConfiguration('unityPlus').get<string>('rename.classFileSyncMode', 'any');

  return isRenameClassFileSyncMode(mode) ? mode : 'any';
}

function isRenameClassFileSyncMode(mode: string | undefined): mode is RenameClassFileSyncMode {
  return mode === 'unity-object' || mode === 'any' || mode === 'off';
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
