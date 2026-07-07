import type * as vscode from 'vscode';
import { parseUnityMetaGuid } from '../../unity/metadataIndex';
import { isCSharpFile } from '../serialized-assets/assetDiscovery';
import { errorDetails, toProjectPath, toWorkspaceUri } from '../serialized-assets/utils';
import { createSerializedInstanceCodeLensFromGuidCount } from './codeLens';
import { showSerializedInstanceLocations } from './referenceLocations';
import type { SerializedInstanceLocationTarget, SerializedInstancesRuntime } from './runtime';

/** Creates the VS Code provider facade for serialized instance CodeLens. */
export function createSerializedInstanceProvider(
  runtime: SerializedInstancesRuntime,
  isEnabled: () => boolean
): vscode.CodeLensProvider & {
  showSerializedInstanceLocations(target: SerializedInstanceLocationTarget): Promise<void>;
  notifyCodeLensesChanged(): void;
} {
  const codeLensEvents = new runtime.runtimeVscode.EventEmitter<void>();

  return {
    onDidChangeCodeLenses: codeLensEvents.event,
    async provideCodeLenses(document) {
      if (!isEnabled() || !isCSharpFile(document.uri)) {
        return [];
      }

      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      try {
        const scriptGuid = await resolveCurrentScriptGuid(runtime, scriptPath);
        if (!scriptGuid) {
          runtime.logger.info(`Unity serialized instance CodeLens skipped for ${scriptPath}: MonoScript GUID not found; cannot prove serialized instance ownership without ${scriptPath}.meta.`);
          return [];
        }

        if (!runtime.yamlAssets) {
          runtime.logger.error(`Unity serialized instance CodeLens cannot count ${scriptPath}: Unity YAML asset handler is unavailable.`);
          return [];
        }

        const count = await runtime.yamlAssets.countGuidOccurrences(scriptGuid);
        runtime.logger.debug(`Unity serialized instance CodeLens counted ${count.count} MonoScript GUID occurrence(s) for ${scriptPath}; backend=${count.backend}, assets=${count.files.length}, read=${count.readCount}.`);
        return createSerializedInstanceCodeLensFromGuidCount(runtime, document, scriptPath, scriptGuid, count.count);
      } catch (error) {
        runtime.logger.error(`Unity serialized instance CodeLens failed for ${scriptPath}: ${errorDetails(error)}`);
        throw error;
      }
    },
    async showSerializedInstanceLocations(target) {
      await showSerializedInstanceLocations(
        runtime,
        target,
        isEnabled
      );
    },
    notifyCodeLensesChanged() {
      codeLensEvents.fire();
    }
  };
}

/** Resolves the current C# file's MonoScript GUID without waking any C# provider. */
async function resolveCurrentScriptGuid(runtime: SerializedInstancesRuntime, scriptPath: string): Promise<string | undefined> {
  if (runtime.metadataIndex.isBuilt()) {
    const metadata = await runtime.metadataIndex.getOrBuild();
    const cachedGuid = metadata.getGuid(scriptPath);
    if (cachedGuid) {
      return cachedGuid;
    }
  }

  const metaUri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, `${scriptPath}.meta`);
  try {
    const content = await runtime.readTextFile(metaUri, runtime.runtimeVscode);
    return parseUnityMetaGuid(content);
  } catch (error) {
    runtime.logger.info(`Unity serialized instance CodeLens could not read ${scriptPath}.meta: ${errorDetails(error)}`);
    return undefined;
  }
}
