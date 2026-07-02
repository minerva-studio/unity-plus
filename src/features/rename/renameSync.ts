import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { createVscodeCSharpLanguageService, CSharpClassSnapshot, CSharpLanguageService } from '../../unity/csharpLanguageService';
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

export function registerRenameFeature(logger: UnityPlusLogger): vscode.Disposable {
  const runtimeVscode = loadVscode();
  const languageService = createVscodeCSharpLanguageService(runtimeVscode);
  const disposables: vscode.Disposable[] = [];
  const previousCsharpClasses = new Map<string, CSharpClassSnapshot>();
  let recentSync: RecentScriptFilenameSync | undefined;

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncScriptFilename', async () => {
    logger.info('Script filename sync is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage('Unity Plus: script filename sync is planned for v0.2.');
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.syncClassName', async () => {
    logger.info('Class name sync is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage('Unity Plus: class name sync is planned for v0.2.');
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
    if (!event.document.uri.fsPath.endsWith('.cs')) {
      return;
    }

    const mode = getRenameClassFileSyncMode(runtimeVscode);
    if (mode === 'off') {
      return;
    }

    const oldClass = previousCsharpClasses.get(event.document.uri.fsPath);
    const newClass = await getPrimaryClass(languageService, event.document.uri, mode, logger);
    if (newClass) {
      previousCsharpClasses.set(event.document.uri.fsPath, newClass);
    } else {
      previousCsharpClasses.delete(event.document.uri.fsPath);
    }

    const plan = planScriptFilenameSync(
      event.document.uri.fsPath,
      oldClass,
      newClass,
      mode,
      recentSync
    );

    if (!plan) {
      return;
    }

    try {
      const applied = await applyScriptFilenameSyncPlan(plan, {
        fileExists: async path => await fileExists(runtimeVscode, path),
        applyRenameOperations: async operations => await applyRenameOperations(runtimeVscode, operations),
        logger
      });
      if (applied) {
        recentSync = { plan };
        logger.info(`Renamed Unity script file from ${basename(event.document.uri.fsPath)} to ${basename(plan.newFilePath)}.`);
      }
    } catch (error) {
      logger.warn(`Could not rename Unity script file: ${errorMessage(error)}`);
    }
  }));

  return runtimeVscode.Disposable.from(...disposables);
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
