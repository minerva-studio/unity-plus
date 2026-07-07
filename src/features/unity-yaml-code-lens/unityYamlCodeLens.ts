import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import { createUnityYamlCodeLensProvider } from './provider';
import type { UnityYamlCodeLensFeatureOptions } from './runtime';

export type { UnityYamlCodeLensFeatureOptions } from './runtime';

/** Registers CodeLens support for MonoBehaviour script links inside Unity YAML assets. */
export function registerUnityYamlCodeLensFeature(
  logger: UnityPlusLogger,
  options: UnityYamlCodeLensFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const disposables: vscode.Disposable[] = [];

  if (options.metadataIndex) {
    const metadataIndex = options.metadataIndex;
    const runtime = {
      runtimeVscode,
      logger,
      metadataIndex
    };
    const provider = createUnityYamlCodeLensProvider(runtime);
    disposables.push(
      runtimeVscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/*.{prefab,unity,asset}' }, provider),
      runtimeVscode.commands.registerCommand('unityPlus.openUnityYamlMonoBehaviourScript', async (scriptFsPath, guid) => {
        await openMonoBehaviourScript(runtimeVscode, logger, String(scriptFsPath ?? ''), String(guid ?? ''));
      })
    );
  }

  return runtimeVscode.Disposable.from(...disposables);
}

/** Opens the C# script proven by the MonoBehaviour m_Script GUID. */
async function openMonoBehaviourScript(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger,
  scriptFsPath: string,
  guid: string
): Promise<void> {
  if (!scriptFsPath) {
    logger.info(`Unity YAML MonoBehaviour script open skipped: unresolved GUID ${guid || '<unknown>'}.`);
    runtimeVscode.window.showInformationMessage(runtimeVscode.l10n.t('C# script: unresolved'));
    return;
  }

  const uri = runtimeVscode.Uri.file(scriptFsPath);
  const document = await runtimeVscode.workspace.openTextDocument(uri);
  await runtimeVscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
}

/** Loads VS Code lazily so unit tests can inject a fake runtime. */
function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
