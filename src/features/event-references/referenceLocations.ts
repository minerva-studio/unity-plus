import type * as vscode from 'vscode';
import type { UnityEventReference, UnitySerializedAssetReferenceIndex } from './model';
import type { EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { errorMessage, escapeMarkdown, toWorkspaceUri } from './utils';

/** Builds hover markdown that summarizes UnityEvent references for a C# symbol. */
export function createHoverMarkdown(
  runtimeVscode: typeof vscode,
  references: readonly UnityEventReference[]
): vscode.MarkdownString {
  const markdown = new runtimeVscode.MarkdownString();
  markdown.appendMarkdown(`**${runtimeVscode.l10n.t('{count} UnityEvent references', { count: references.length })}**\n\n`);

  for (const reference of references.slice(0, 12)) {
    const source = reference.gameObjectName
      ? `${reference.assetPath} (${reference.gameObjectName})`
      : reference.assetPath;
    const target = `${reference.targetTypeName}.${reference.methodName}`;
    // The hover text carries the Unity serialized binding context that VS Code
    // peek locations cannot attach to individual C# method declaration entries.
    markdown.appendMarkdown(`- ${runtimeVscode.l10n.t('Bound in')} ${escapeMarkdown(source)}: ${escapeMarkdown(reference.eventFieldName)} -> ${escapeMarkdown(target)}\n`);
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
): readonly UnityEventReference[] {
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

/** Creates the empty-location message for unresolved YAML or C# target locations. */
function createNoEventReferenceLocationsMessage(
  runtimeVscode: typeof vscode,
  kind: EventReferenceLocationTarget['kind']
): string {
  return kind === 'fieldTarget'
    ? runtimeVscode.l10n.t('Unity Plus: no UnityEvent target methods found for this field.')
    : runtimeVscode.l10n.t('Unity Plus: no UnityEvent references found for this symbol.');
}

/** Shows C# method declarations reached by UnityEvent target bindings. */
async function showFieldTargetMethodLocations(
  runtime: EventReferenceRuntime,
  target: EventReferenceLocationTarget,
  references: readonly UnityEventReference[]
): Promise<boolean> {
  const locations: vscode.Location[] = [];
  const seen = new Set<string>();

  if (!runtime.csharpLanguageService) {
    runtime.logger.error(`UnityEvent targets cannot resolve C# method locations for ${target.scriptPath}:${target.symbolName ?? '<unknown>'}: C# language service is unavailable.`);
    return false;
  }

  for (const reference of references) {
    const targetScriptPath = reference.scriptPath;
    const targetTypeName = reference.targetTypeName || reference.scriptTypeName;
    const methodName = reference.methodName;
    if (!targetScriptPath || !targetTypeName || !methodName) {
      runtime.logger.info(
        `UnityEvent target skipped unresolved C# method location: ` +
        `asset=${reference.assetPath}, eventScript=${reference.eventScriptPath ?? '<unknown>'}, ` +
        `field=${reference.eventFieldName}, targetScript=${targetScriptPath ?? '<unknown>'}, ` +
        `targetType=${targetTypeName ?? '<unknown>'}, method=${methodName || '<unknown>'}.`
      );
      continue;
    }

    try {
      const uri = toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, targetScriptPath);
      const positions = await runtime.csharpLanguageService.findTargetMethodPosition(uri, targetTypeName, methodName);
      for (const position of positions) {
        const key = `${uri.fsPath}:${position.line}:${position.character}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        locations.push(toCSharpLocation(runtime.runtimeVscode, uri, position));
      }
    } catch (error) {
      runtime.logger.error(
        `UnityEvent target C# method lookup failed: ` +
        `asset=${reference.assetPath}, targetScript=${targetScriptPath}, ` +
        `targetType=${targetTypeName}, method=${methodName}, error=${errorMessage(error)}`
      );
    }
  }

  if (locations.length === 0) {
    return false;
  }

  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    locations
  );
  return true;
}

/** Converts a provider-backed C# method position into a peek location. */
function toCSharpLocation(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  position: { line: number; character: number }
): vscode.Location {
  return new runtimeVscode.Location(uri, new runtimeVscode.Position(position.line, position.character));
}

/** Shows indexed Unity YAML bindings using the UnityEvent field as the stable peek anchor. */
async function showIndexedYamlLocations(
  runtime: EventReferenceRuntime,
  target: EventReferenceLocationTarget,
  references: readonly UnityEventReference[]
): Promise<void> {
  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    references.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
  );
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

/** Shows UnityEvent references for a CodeLens command target. */
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

  if (!index && target.eventReferences) {
    const eventReferences = target.eventReferences;
    if (eventReferences.length === 0) {
      runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
      return;
    }

    if (target.kind === 'fieldTarget') {
      const resolved = await showFieldTargetMethodLocations(runtime, target, eventReferences);
      if (!resolved) {
        runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
      }
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
    runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
    return;
  }

  if (target.kind === 'fieldTarget') {
    const resolved = await showFieldTargetMethodLocations(runtime, target, references);
    if (!resolved) {
      runtime.runtimeVscode.window.showInformationMessage(createNoEventReferenceLocationsMessage(runtime.runtimeVscode, target.kind));
    }
    return;
  }

  await runtime.runtimeVscode.commands.executeCommand(
    'editor.action.showReferences',
    toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, target.scriptPath),
    target.position,
    references.map(reference => toReferenceLocation(runtime.runtimeVscode, runtime.metadataIndex.root, reference))
  );
}
