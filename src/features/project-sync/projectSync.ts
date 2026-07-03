import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

export const assetsCsharpGlob = 'Assets/**/*.cs';

export interface ProjectSyncFeatureOptions {
  root?: vscode.Uri;
  runtimeVscode?: typeof vscode;
  isAutoRefreshEnabled?: () => boolean;
}

export function registerProjectSyncFeature(
  logger: UnityPlusLogger,
  options: ProjectSyncFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isAutoRefreshEnabled = options.isAutoRefreshEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('projectFiles.autoRefresh') === true
  );
  const root = options.root;
  const disposables: vscode.Disposable[] = [];
  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.refreshProjectFiles', async () => {
    logger.info('Project file refresh is planned but not implemented yet.');
    runtimeVscode.window.showInformationMessage('Unity Plus: project file refresh is planned for v0.3.');
  }));

  if (shouldRegisterProjectSyncWatcher(root, isAutoRefreshEnabled())) {
    const watcher = runtimeVscode.workspace.createFileSystemWatcher(
      new runtimeVscode.RelativePattern(root, assetsCsharpGlob)
    );
    disposables.push(watcher);

    const scheduleRefresh = (uri: vscode.Uri) => {
      if (!isAutoRefreshEnabled()) {
        return;
      }

      // The first implementation only records intent; the debounce and Unity refresh bridge belong to v0.3.
      logger.debug(`Observed C# file structure change that may require project refresh: ${uri.fsPath}`);
    };

    disposables.push(watcher.onDidCreate(scheduleRefresh));
    disposables.push(watcher.onDidDelete(scheduleRefresh));
  }

  return runtimeVscode.Disposable.from(...disposables);
}

export function shouldRegisterProjectSyncWatcher(
  root: vscode.Uri | undefined,
  autoRefreshEnabled: boolean
): root is vscode.Uri {
  return root !== undefined && autoRefreshEnabled;
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
