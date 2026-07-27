import * as vscode from 'vscode';
import { basename } from 'node:path';
import { activateUnityPlus } from './activation';
import { registerEventReferenceFeature } from './features/event-references/eventReferences';
import { hideMetaFilesInExplorerIfEnabled, registerMetaFilesFeature } from './features/meta-files/metaFiles';
import { registerProjectSyncFeature } from './features/project-sync/projectSync';
import { registerRenameFeature } from './features/rename/renameSync';
import { registerSerializedInstancesFeature } from './features/serialized-instances/serializedInstances';
import { registerUnityYamlCodeLensFeature } from './features/unity-yaml-code-lens/unityYamlCodeLens';
import { registerUnityTestRunnerFeature } from './features/unity-test-runner/unityTestRunner';
import { createUnityTestBridge } from './features/unity-test-runner/ide-package/unityTestBridge';
import { createLogger } from './unity/logger';
import { createLazyUnityMetadataIndex } from './unity/metadataIndex';
import { checkUnityVisualStudioEditorPackage } from './unity/visualStudioEditorPackage';
import {
  createUnityIdeMessagingEndpointResolver,
  sendUnityIdeShowUsage,
  type UnityIdeMessagingEndpoint
} from './unity/visualStudioMessaging';
import { detectUnityWorkspace } from './unity/workspaceDetector';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = createLogger();
  const endpointResolver = createUnityIdeMessagingEndpointResolver({
    selectEndpoint: async (projectRoot, endpoints) => await selectUnityEditor(projectRoot, endpoints)
  });

  await activateUnityPlus(context, {
    workspaceFolders: vscode.workspace.workspaceFolders,
    registerCommand: (command, callback) => vscode.commands.registerCommand(command, callback)
  }, {
    logger,
    detectUnityWorkspace,
    createLazyMetadataIndex: createLazyUnityMetadataIndex,
    registerRenameFeature,
    registerProjectSyncFeature,
    registerEventReferenceFeature,
    registerSerializedInstancesFeature,
    registerUnityYamlCodeLensFeature,
    registerMetaFilesFeature: (featureLogger, options) => registerMetaFilesFeature(featureLogger, {
      ...options,
      sendOpenInUnity: async (projectRoot, assetPath) => await sendUnityIdeShowUsage(projectRoot, assetPath, {
        findEndpoint: async root => await endpointResolver.resolve(root)
      })
    }),
    registerUnityTestRunnerFeature: (featureLogger, options) => registerUnityTestRunnerFeature(featureLogger, {
      ...options,
      createBridge: () => createUnityTestBridge({
        findEndpoint: async projectRoot => await endpointResolver.resolve(projectRoot)
      })
    }),
    hideMetaFilesInExplorerIfEnabled: async logger => await hideMetaFilesInExplorerIfEnabled(vscode, logger),
    checkUnityVisualStudioEditorPackage: async root => await checkUnityVisualStudioEditorPackage(root, {
      runtimeVscode: vscode,
      logger
    })
  });

  context.subscriptions.push(vscode.commands.registerCommand('unityPlus.selectUnityEditor', async () => {
    const workspace = await detectUnityWorkspace(vscode.workspace.workspaceFolders ?? []);
    if (!workspace.root) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Unity Plus: Open a Unity project before selecting a Unity Editor.'));
      return;
    }

    endpointResolver.forget(workspace.root.fsPath);
    const selectedPort = await endpointResolver.resolve(workspace.root.fsPath, true);
    if (selectedPort === undefined) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Unity Plus: No Unity Editor was selected for the current project.'));
    }
  }));
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}

/** Shows enough verified identity to distinguish same-project Editor endpoints. */
async function selectUnityEditor(
  projectRoot: string,
  endpoints: readonly UnityIdeMessagingEndpoint[]
): Promise<UnityIdeMessagingEndpoint | undefined> {
  const items = endpoints.map(endpoint => ({
    label: endpoint.processId === undefined
      ? vscode.l10n.t('Unity Editor on port {port}', { port: endpoint.port })
      : vscode.l10n.t('Unity Editor PID {processId}', { processId: endpoint.processId }),
    description: `127.0.0.1:${endpoint.port}`,
    detail: `${basename(projectRoot)} — ${projectRoot}`,
    endpoint
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select the Unity Editor for {projectName}', {
      projectName: basename(projectRoot)
    }),
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected?.endpoint;
}
