import * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

export function registerEventReferenceFeature(logger: UnityPlusLogger): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('unityPlus.showUnityEventReferences', async () => {
    logger.info('UnityEvent reference lookup is planned but not implemented yet.');
    vscode.window.showInformationMessage('Unity Plus: UnityEvent references are planned for v0.4.');
  }));

  return vscode.Disposable.from(...disposables);
}
