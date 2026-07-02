import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { detectUnityScriptTypes } from '../../unity/csharpTypeDetector';
import { UnityPlusLogger } from '../../unity/logger';

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
  renameFile(oldPath: string, newPath: string): Promise<void>;
  logger: UnityPlusLogger;
}

export interface RecentScriptFilenameSync {
  plan: ScriptFilenameSyncPlan;
}

export function registerRenameFeature(logger: UnityPlusLogger): vscode.Disposable {
  const runtimeVscode = loadVscode();
  const disposables: vscode.Disposable[] = [];
  const previousCsharpText = new Map<string, string>();
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
    if (csharpMoves.length > 0 && runtimeVscode.workspace.getConfiguration('unityPlus').get('rename.syncClassAndFile') === true) {
      logger.debug(`Observed ${csharpMoves.length} C# rename operation(s).`);
    }
  }));

  runtimeVscode.workspace.textDocuments
    .filter(document => document.uri.fsPath.endsWith('.cs'))
    .forEach(document => previousCsharpText.set(document.uri.fsPath, document.getText()));

  disposables.push(runtimeVscode.workspace.onDidOpenTextDocument(document => {
    if (document.uri.fsPath.endsWith('.cs')) {
      previousCsharpText.set(document.uri.fsPath, document.getText());
    }
  }));

  disposables.push(runtimeVscode.workspace.onDidCloseTextDocument(document => {
    previousCsharpText.delete(document.uri.fsPath);
  }));

  disposables.push(runtimeVscode.workspace.onDidChangeTextDocument(async event => {
    if (!event.document.uri.fsPath.endsWith('.cs')) {
      return;
    }

    const newSource = event.document.getText();
    const oldSource = previousCsharpText.get(event.document.uri.fsPath);
    previousCsharpText.set(event.document.uri.fsPath, newSource);

    if (!oldSource) {
      return;
    }

    if (runtimeVscode.workspace.getConfiguration('unityPlus').get('rename.syncClassAndFile') !== true) {
      return;
    }

    const plan = planScriptFilenameSync(
      event.document.uri.fsPath,
      oldSource,
      newSource,
      recentSync
    );

    if (!plan) {
      return;
    }

    try {
      await applyScriptFilenameSyncPlan(plan, {
        fileExists: async path => await fileExists(runtimeVscode, path),
        renameFile: async (oldPath, newPath) => {
          await runtimeVscode.workspace.fs.rename(
            runtimeVscode.Uri.file(oldPath),
            runtimeVscode.Uri.file(newPath),
            { overwrite: false }
          );
        },
        logger
      });
      recentSync = { plan };
      logger.info(`Renamed Unity script file from ${basename(event.document.uri.fsPath)} to ${basename(plan.newFilePath)}.`);
    } catch (error) {
      logger.warn(`Could not rename Unity script file: ${errorMessage(error)}`);
    }
  }));

  return runtimeVscode.Disposable.from(...disposables);
}

export function planScriptFilenameSync(
  filePath: string,
  oldSource: string,
  newSource: string,
  recentSync?: RecentScriptFilenameSync
): ScriptFilenameSyncPlan | undefined {
  const oldDetection = detectUnityScriptTypes(oldSource);
  const newDetection = detectUnityScriptTypes(newSource);

  if (!oldDetection.isSafeForAutomaticRename || !newDetection.isSafeForAutomaticRename) {
    return undefined;
  }

  const oldType = oldDetection.types[0];
  const newType = newDetection.types[0];

  if (!oldType || !newType || oldType.name === newType.name) {
    return undefined;
  }

  const undoPlan = planUndoScriptFilenameSync(filePath, oldType.name, newType.name, recentSync);
  if (undoPlan) {
    return undoPlan;
  }

  if (oldType.kind !== newType.kind || oldType.namespace !== newType.namespace) {
    return undefined;
  }

  if (basename(filePath) !== `${oldType.name}.cs`) {
    return undefined;
  }

  return {
    oldClassName: oldType.name,
    newClassName: newType.name,
    oldFilePath: filePath,
    newFilePath: join(dirname(filePath), `${newType.name}.cs`),
    oldMetaPath: `${filePath}.meta`,
    newMetaPath: `${join(dirname(filePath), `${newType.name}.cs`)}.meta`,
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
): Promise<void> {
  await operations.renameFile(plan.oldFilePath, plan.newFilePath);

  if (!await operations.fileExists(plan.oldMetaPath)) {
    operations.logger.debug(`Unity script meta file was not found for ${basename(plan.oldMetaPath)}.`);
    return;
  }

  try {
    await operations.renameFile(plan.oldMetaPath, plan.newMetaPath);
    operations.logger.debug(`Renamed Unity script meta file from ${basename(plan.oldMetaPath)} to ${basename(plan.newMetaPath)}.`);
  } catch (error) {
    operations.logger.warn(`Could not rename Unity script meta file: ${errorMessage(error)}`);
  }
}

async function fileExists(runtimeVscode: typeof vscode, path: string): Promise<boolean> {
  try {
    await runtimeVscode.workspace.fs.stat(runtimeVscode.Uri.file(path));
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
