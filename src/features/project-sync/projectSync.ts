import * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

const csharpGlob = '**/*.cs';

export function registerProjectSyncFeature(logger: UnityPlusLogger): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const watcher = vscode.workspace.createFileSystemWatcher(csharpGlob);

  disposables.push(watcher);
  disposables.push(vscode.commands.registerCommand('unityPlus.refreshProjectFiles', async () => {
    logger.info('Project file refresh is planned but not implemented yet.');
    vscode.window.showInformationMessage('Unity Plus: project file refresh is planned for v0.3.');
  }));

  const scheduleRefresh = (uri: vscode.Uri) => {
    if (vscode.workspace.getConfiguration('unityPlus').get('projectFiles.autoRefresh') !== true) {
      return;
    }

    // The first implementation only records intent; the debounce and Unity refresh bridge belong to v0.3.
    logger.debug(`Observed C# file change that may require project refresh: ${uri.fsPath}`);
  };

  disposables.push(watcher.onDidCreate(scheduleRefresh));
  disposables.push(watcher.onDidDelete(scheduleRefresh));
  disposables.push(watcher.onDidChange(scheduleRefresh));

  return vscode.Disposable.from(...disposables);
}
