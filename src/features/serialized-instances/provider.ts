import type * as vscode from 'vscode';
import { isCSharpFile } from '../serialized-assets/assetDiscovery';
import { errorDetails, toProjectPath } from '../serialized-assets/utils';
import { createSerializedInstanceCodeLensesFromIndex } from './codeLens';
import { showSerializedInstanceLocations } from './referenceLocations';
import type { SerializedInstanceIndexController, SerializedInstanceLocationTarget, SerializedInstancesRuntime } from './runtime';

/** Creates the VS Code provider facade for serialized instance CodeLens. */
export function createSerializedInstanceProvider(
  runtime: SerializedInstancesRuntime,
  controller: SerializedInstanceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & { showSerializedInstanceLocations(target: SerializedInstanceLocationTarget): Promise<void> } {
  return {
    onDidChangeCodeLenses: controller.onDidChangeCodeLenses,
    async provideCodeLenses(document) {
      if (!isEnabled() || !isCSharpFile(document.uri)) {
        return [];
      }

      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      try {
        const index = controller.getReadyIndex();
        if (!index) {
          if (controller.getStatus() === 'failed') {
            throw new Error('Unity serialized instance index build failed.');
          }

          controller.scheduleBuild();
          return [];
        }

        return createSerializedInstanceCodeLensesFromIndex(runtime, document, index, false);
      } catch (error) {
        runtime.logger.error(`Unity serialized instance CodeLens failed for ${scriptPath}: ${errorDetails(error)}`);
        throw error;
      }
    },
    async showSerializedInstanceLocations(target) {
      await showSerializedInstanceLocations(
        runtime,
        controller.getReadyIndex(),
        target,
        () => controller.scheduleBuild(),
        isEnabled
      );
    }
  };
}
