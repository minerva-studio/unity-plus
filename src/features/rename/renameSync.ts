import * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

export function registerRenameFeature(logger: UnityPlusLogger): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];

  disposables.push(vscode.commands.registerCommand('unityPlus.syncScriptFilename', async () => {
    logger.info('Script filename sync is planned but not implemented yet.');
    vscode.window.showInformationMessage('Unity Plus: script filename sync is planned for v0.2.');
  }));

  disposables.push(vscode.commands.registerCommand('unityPlus.syncClassName', async () => {
    logger.info('Class name sync is planned but not implemented yet.');
    vscode.window.showInformationMessage('Unity Plus: class name sync is planned for v0.2.');
  }));

  disposables.push(vscode.workspace.onDidRenameFiles(event => {
    const csharpMoves = event.files.filter(file => file.oldUri.path.endsWith('.cs') || file.newUri.path.endsWith('.cs'));
    if (csharpMoves.length > 0 && vscode.workspace.getConfiguration('unityPlus').get('rename.syncClassAndFile') === true) {
      logger.debug(`Observed ${csharpMoves.length} C# rename operation(s).`);
    }
  }));

  return vscode.Disposable.from(...disposables);
}
