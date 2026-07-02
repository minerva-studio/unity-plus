import type * as vscode from 'vscode';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { detectUnityScriptTypes } from '../../unity/csharpTypeDetector';
import { UnityPlusLogger } from '../../unity/logger';

export interface ScriptFilenameSyncPlan {
  oldClassName: string;
  newClassName: string;
  newFilePath: string;
}

export function registerRenameFeature(logger: UnityPlusLogger): vscode.Disposable {
  const runtimeVscode = loadVscode();
  const disposables: vscode.Disposable[] = [];
  const previousCsharpText = new Map<string, string>();

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
      newSource
    );

    if (!plan) {
      return;
    }

    try {
      await runtimeVscode.workspace.fs.rename(
        event.document.uri,
        runtimeVscode.Uri.file(plan.newFilePath),
        { overwrite: false }
      );
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
  newSource: string
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

  if (oldType.kind !== newType.kind || oldType.namespace !== newType.namespace) {
    return undefined;
  }

  if (basename(filePath) !== `${oldType.name}.cs`) {
    return undefined;
  }

  return {
    oldClassName: oldType.name,
    newClassName: newType.name,
    newFilePath: join(dirname(filePath), `${newType.name}.cs`)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
