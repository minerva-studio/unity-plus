import type * as vscode from 'vscode';
import type { UnityEventReference, UnitySerializedAssetReferenceIndex, UnitySerializedInstanceLocation } from './model';
import type { EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { isUnityBuiltInTargetTypeName } from './targetTypes';
import { escapeMarkdown, toWorkspaceUri } from './utils';

/** Builds hover markdown that summarizes UnityEvent references for a C# symbol. */
export function createHoverMarkdown(
  runtimeVscode: typeof vscode,
  references: readonly UnityEventReference[]
): vscode.MarkdownString {
  const markdown = new runtimeVscode.MarkdownString();
  markdown.appendMarkdown(`**${runtimeVscode.l10n.t('{count} UnityEvent references', { count: references.length })}**\n\n`);

  for (const reference of references.slice(0, 12)) {
    const location = reference.gameObjectName
      ? `${reference.assetPath} (${reference.gameObjectName})`
      : reference.assetPath;
    markdown.appendMarkdown(`- ${escapeMarkdown(location)}: ${escapeMarkdown(reference.eventFieldName)} -> ${escapeMarkdown(reference.targetTypeName)}.${escapeMarkdown(reference.methodName)}\n`);
  }

  if (references.length > 12) {
    markdown.appendMarkdown(`- ${runtimeVscode.l10n.t('... {count} more', { count: references.length - 12 })}\n`);
  }

  return markdown;
}

/** Resolves a CodeLens command target into the matching indexed references. */
function getReferencesForLocationTarget(
  index: UnitySerializedAssetReferenceIndex,
  target: EventReferenceLocationTarget
): readonly (UnityEventReference | UnitySerializedInstanceLocation)[] {
  if (target.kind === 'serializedInstance') {
    if (target.serializedInstances) {
      return target.serializedInstances;
    }

    return index.getSerializedInstances(target.scriptPath, target.typeName);
  }

  if (!target.symbolName) {
    return [];
  }

  if (target.kind === 'method') {
    return index.getReferences(target.scriptPath, target.symbolName, target.typeName);
  }

  if (target.kind === 'fieldTarget') {
    return index.getFieldTargets(target.scriptPath, target.symbolName, target.typeName);
  }

  return index.getFieldReferences(target.scriptPath, target.symbolName, target.typeName);
}

/** Creates the empty-location message for field targets without implying C# Invoke references. */
function createNoEventReferenceLocationsMessage(
  runtimeVscode: typeof vscode,
  kind: EventReferenceLocationTarget['kind']
): string {
  return kind === 'fieldTarget'
    ? runtimeVscode.l10n.t('Unity Plus: no UnityEvent target methods found for this field.')
    : runtimeVscode.l10n.t('Unity Plus: no UnityEvent references found for this symbol.');
}

/** Creates declaration locations for YAML-declared target methods without running click-time target inference. */
async function createTargetMethodLocations(
  runtime: EventReferenceRuntime,
  references: readonly UnityEventReference[]
): Promise<vscode.Location[]> {
  const locations: vscode.Location[] = [];
  const seenLocations = new Set<string>();

  for (const reference of references) {
    if (!reference.scriptPath || !reference.targetTypeName || isUnityBuiltInTargetTypeName(reference.targetTypeName)) {
      continue;
    }

    const uri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, reference.scriptPath);
    try {
      const position = await runtime.csharpLanguageService?.findTargetMethodPosition(
        uri,
        reference.targetTypeName,
        reference.methodName
      );
      if (position) {
        appendUniqueLocation(locations, seenLocations, new runtime.runtimeVscode.Location(uri, toVscodePosition(runtime.runtimeVscode, position)));
      }
    } catch {
      // Missing or unreadable scripts cannot provide target locations, but other targets may still resolve.
    }
  }

  return locations;
}

/** Shows YAML-declared target methods using the UnityEvent field as the stable peek anchor. */
async function showTargetMethodLocations(
  runtime: EventReferenceRuntime,
  target: EventReferenceLocationTarget,
  locations: readonly vscode.Location[]
): Promise<void> {
  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    locations
  );
}

/** Appends one location while avoiding repeated target declarations in the peek list. */
function appendUniqueLocation(
  locations: vscode.Location[],
  seenLocations: Set<string>,
  location: vscode.Location
): void {
  const key = `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
  if (seenLocations.has(key)) {
    return;
  }

  seenLocations.add(key);
  locations.push(location);
}

/** Converts a UnityEvent YAML reference into a VS Code peek location. */
function toReferenceLocation(
  runtimeVscode: typeof vscode,
  root: vscode.Uri,
  reference: UnityEventReference
): vscode.Location {
  const position = new runtimeVscode.Position(reference.line, reference.character);
  return new runtimeVscode.Location(toWorkspaceUri(runtimeVscode, root, reference.assetPath), position);
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

/** Converts language-service positions back into VS Code positions for peek locations. */
function toVscodePosition(runtimeVscode: typeof vscode, position: { line: number; character: number }): vscode.Position {
  return new runtimeVscode.Position(position.line, position.character);
}

/** Shows references or serialized instances for a CodeLens command target. */
export async function showReferenceLocations(
  runtime: EventReferenceRuntime,
  index: UnitySerializedAssetReferenceIndex | undefined,
  target: EventReferenceLocationTarget,
  scheduleBuild: () => void,
  isEnabled: () => boolean
): Promise<void> {
  if (!isEnabled()) {
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: UnityEvent references are disabled.'));
    return;
  }

  if (!index && target.kind === 'serializedInstance' && target.serializedInstances) {
    const serializedReferences = target.serializedInstances;
    if (serializedReferences.length === 0) {
      runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no Unity serialized instances found for this script.'));
      return;
    }

    await runtime.runtimeVscode.commands.executeCommand(
      'editor.action.showReferences',
      toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
      target.position,
      serializedReferences.map(reference => toSerializedInstanceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
    );
    return;
  }

  if (!index && target.kind !== 'serializedInstance' && target.eventReferences) {
    const eventReferences = target.eventReferences;
    if (eventReferences.length === 0) {
      runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
      return;
    }

    if (target.kind === 'fieldTarget') {
      const locations = await createTargetMethodLocations(runtime, eventReferences);
      if (locations.length === 0) {
        runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
        return;
      }

      await showTargetMethodLocations(runtime, target, locations);
      return;
    }

    await runtime.runtimeVscode.commands.executeCommand(
      'editor.action.showReferences',
      toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
      target.position,
      eventReferences.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
    );
    return;
  }

  if (!index) {
    scheduleBuild();
    runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: UnityEvent reference index is still building.'));
    return;
  }

  const references = getReferencesForLocationTarget(index, target);

  if (references.length === 0) {
    if (target.kind === 'serializedInstance') {
      runtime.runtimeVscode.window.showInformationMessage(runtime.runtimeVscode.l10n.t('Unity Plus: no Unity serialized instances found for this script.'));
      return;
    }

    runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
    return;
  }

  if (target.kind === 'serializedInstance') {
    const serializedReferences = references as readonly UnitySerializedInstanceLocation[];
    await runtime.runtimeVscode.commands.executeCommand(
      'editor.action.showReferences',
      toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
      target.position,
      serializedReferences.map(reference => toSerializedInstanceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
    );
    return;
  }

  const eventReferences = references as readonly UnityEventReference[];

  if (target.kind === 'fieldTarget') {
    const locations = await createTargetMethodLocations(runtime, eventReferences);
    if (locations.length === 0) {
      runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
      return;
    }

    await showTargetMethodLocations(runtime, target, locations);
    return;
  }

  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    eventReferences.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
  );
}
