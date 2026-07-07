import type * as vscode from 'vscode';
import type { SerializedInstanceLocationTarget, SerializedInstancesRuntime } from './runtime';
import type { UnitySerializedInstanceIndex, UnitySerializedInstanceLocation } from './model';
import { toWorkspaceUri } from '../serialized-assets/utils';

/** Shows serialized Unity object instance locations for a class-level CodeLens target. */
export async function showSerializedInstanceLocations(
  runtime: SerializedInstancesRuntime,
  index: UnitySerializedInstanceIndex | undefined,
  target: SerializedInstanceLocationTarget,
  scheduleBuild: () => void,
  isEnabled: () => boolean
): Promise<void> {
  if (!isEnabled()) {
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: Unity serialized instances are disabled.'));
    return;
  }

  if (!index && target.serializedInstances) {
    await showSerializedReferences(runtime, target, target.serializedInstances);
    return;
  }

  if (!index) {
    scheduleBuild();
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: Unity serialized instance index is still building.'));
    return;
  }

  const references = index.getSerializedInstances(target.scriptPath, target.typeName);
  await showSerializedReferences(runtime, target, references);
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
