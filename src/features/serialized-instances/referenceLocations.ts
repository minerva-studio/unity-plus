import type * as vscode from 'vscode';
import type { SerializedInstanceLocationTarget, SerializedInstancesRuntime } from './runtime';
import type { UnitySerializedInstanceLocation } from './model';
import { toWorkspaceUri } from '../serialized-assets/utils';
import { createEmptySerializedInstanceDiagnostics } from './diagnostics';
import { collectSerializedInstancesFromParsedDocuments } from './parser';

/** Shows serialized Unity object instance locations for a class-level CodeLens target. */
export async function showSerializedInstanceLocations(
  runtime: SerializedInstancesRuntime,
  target: SerializedInstanceLocationTarget,
  isEnabled: () => boolean
): Promise<void> {
  if (!isEnabled()) {
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: Unity serialized instances are disabled.'));
    return;
  }

  if (target.scriptGuid) {
    const references = await findSerializedReferencesByGuid(runtime, target);
    await showSerializedReferences(runtime, target, references);
    return;
  }

  await showSerializedReferences(runtime, target, target.serializedInstances ?? []);
}

/** Resolves precise serialized instance locations from GUID text hits on demand. */
async function findSerializedReferencesByGuid(
  runtime: SerializedInstancesRuntime,
  target: SerializedInstanceLocationTarget
): Promise<readonly UnitySerializedInstanceLocation[]> {
  if (!target.scriptGuid) {
    return [];
  }

  if (!runtime.yamlAssets) {
    runtime.logger.error(`Unity serialized instance locations cannot resolve ${target.scriptPath}: Unity YAML asset handler is unavailable.`);
    return [];
  }

  const metadata = runtime.metadataIndex.isBuilt()
    ? await runtime.metadataIndex.getOrBuild()
    : { getAssetPath: (_guid: string) => undefined };
  const hitResult = await runtime.yamlAssets.findAssetsContainingGuid(target.scriptGuid);
  const references: UnitySerializedInstanceLocation[] = [];

  for (const uri of hitResult.files) {
    const parsedAsset = await runtime.yamlAssets.getParsedAsset(uri, 'eventReferences');
    if (!parsedAsset) {
      continue;
    }

    const diagnostics = createEmptySerializedInstanceDiagnostics();
    references.push(...collectSerializedInstancesFromParsedDocuments(
      parsedAsset.parsed.documents,
      parsedAsset.projectPath,
      parsedAsset.assetKind,
      metadata,
      diagnostics,
      {
        scriptGuid: target.scriptGuid,
        scriptPath: target.scriptPath,
        typeName: target.typeName
      }
    ));
  }

  runtime.logger.debug(`Unity serialized instance locations resolved ${references.length} location(s) for ${target.scriptPath}; GUID hits=${hitResult.files.length}, backend=${hitResult.backend}.`);
  return references;
}

/** Opens VS Code peek references for serialized instance locations. */
async function showSerializedReferences(
  runtime: SerializedInstancesRuntime,
  target: SerializedInstanceLocationTarget,
  references: readonly UnitySerializedInstanceLocation[]
): Promise<void> {
  if (references.length === 0) {
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no Unity serialized instances found for this script.'));
    return;
  }

  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    references.map(reference => toSerializedInstanceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
  );
}

/** Converts a serialized script instance into a VS Code peek location. */
function toSerializedInstanceLocation(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  reference: UnitySerializedInstanceLocation
): vscode.Location {
  const position = new runtimeVscode.Position(reference.line, reference.character);
  return new runtimeVscode.Location(toWorkspaceUri(runtimeVscode, root, reference.assetPath), position);
}
