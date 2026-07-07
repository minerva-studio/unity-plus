import type * as vscode from 'vscode';
import type { UnityEventReference, UnitySerializedAssetReferenceIndex } from './model';
import type { EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { errorMessage, escapeMarkdown, toWorkspaceUri } from './utils';

interface UnityEventTargetMethodLookup {
  reference: UnityEventReference;
  targetTypeName: string;
  methodName: string;
}

interface UnityEventInvokerFieldLookup {
  reference: UnityEventReference;
  ownerTypeName: string;
  fieldName: string;
}

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

  if (target.kind === 'methodInvokerField') {
    return index.getMethodInvokerFields(target.scriptPath, target.symbolName, target.typeName);
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
    : kind === 'methodInvokerField'
      ? runtimeVscode.l10n.t('Unity Plus: no UnityEvent invoker fields found for this method.')
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

  const lookups = collectDistinctTargetMethodLookups(runtime, references);
  for (const lookup of lookups) {
    try {
      const resolved = await runtime.csharpLanguageService.resolveMember(lookup.targetTypeName, lookup.methodName, 'method');
      if (resolved.length === 0) {
        runtime.logger.error(
          `UnityEvent target C# method lookup found no provider-backed location: ` +
          `asset=${lookup.reference.assetPath}, targetType=${lookup.targetTypeName}, ` +
          `method=${lookup.methodName}.`
        );
      }

      for (const location of resolved) {
        const uri = runtime.runtimeVscode.Uri.file(location.uriPath);
        const key = `${uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        locations.push(toCSharpLocation(runtime.runtimeVscode, uri, location.range.start));
      }
    } catch (error) {
      runtime.logger.error(
        `UnityEvent target C# method lookup failed: ` +
        `asset=${lookup.reference.assetPath}, targetType=${lookup.targetTypeName}, ` +
        `method=${lookup.methodName}, error=${errorMessage(error)}`
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

/** Shows C# UnityEvent field declarations that can invoke the current target method. */
async function showMethodInvokerFieldLocations(
  runtime: EventReferenceRuntime,
  target: EventReferenceLocationTarget,
  references: readonly UnityEventReference[]
): Promise<boolean> {
  const locations: vscode.Location[] = [];
  const seen = new Set<string>();

  if (!runtime.csharpLanguageService) {
    runtime.logger.error(`UnityEvent invokers cannot resolve C# field locations for ${target.scriptPath}:${target.symbolName ?? '<unknown>'}: C# language service is unavailable.`);
    return false;
  }

  const lookups = collectDistinctInvokerFieldLookups(runtime, references);
  for (const lookup of lookups) {
    try {
      const resolved = await runtime.csharpLanguageService.resolveMember(lookup.ownerTypeName, lookup.fieldName, 'field');
      if (resolved.length === 0) {
        runtime.logger.error(
          `UnityEvent invoker C# field lookup found no provider-backed location: ` +
          `asset=${lookup.reference.assetPath}, ownerType=${lookup.ownerTypeName}, ` +
          `field=${lookup.fieldName}.`
        );
      }

      for (const location of resolved) {
        const uri = runtime.runtimeVscode.Uri.file(location.uriPath);
        const key = `${uri.fsPath}:${location.range.start.line}:${location.range.start.character}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        locations.push(toCSharpLocation(runtime.runtimeVscode, uri, location.range.start));
      }
    } catch (error) {
      runtime.logger.error(
        `UnityEvent invoker C# field lookup failed: ` +
        `asset=${lookup.reference.assetPath}, ownerType=${lookup.ownerTypeName}, ` +
        `field=${lookup.fieldName}, error=${errorMessage(error)}`
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

/** Creates distinct target method lookup requests from YAML references. */
function collectDistinctTargetMethodLookups(
  runtime: EventReferenceRuntime,
  references: readonly UnityEventReference[]
): UnityEventTargetMethodLookup[] {
  const lookups: UnityEventTargetMethodLookup[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    const targetTypeName = reference.targetTypeName || reference.scriptTypeName;
    const methodName = reference.methodName;
    if (!targetTypeName || !methodName) {
      runtime.logger.info(
        `UnityEvent target skipped unresolved C# method location: ` +
        `asset=${reference.assetPath}, eventScript=${reference.eventScriptPath ?? '<unknown>'}, ` +
        `field=${reference.eventFieldName}, targetScript=${reference.scriptPath ?? '<unknown>'}, ` +
        `targetType=${targetTypeName ?? '<unknown>'}, method=${methodName || '<unknown>'}.`
      );
      continue;
    }

    const key = `${typeLookupKey(targetTypeName)}#${methodName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    lookups.push({
      reference,
      targetTypeName,
      methodName
    });
  }

  return lookups;
}

/** Creates distinct invoker field lookups from YAML references. */
function collectDistinctInvokerFieldLookups(
  runtime: EventReferenceRuntime,
  references: readonly UnityEventReference[]
): UnityEventInvokerFieldLookup[] {
  const lookups: UnityEventInvokerFieldLookup[] = [];
  const seen = new Set<string>();

  for (const reference of references) {
    const ownerTypeName = reference.eventOwnerTypeName || scriptTypeNameFromPath(reference.eventScriptPath);
    const fieldName = reference.eventFieldName;
    if (!ownerTypeName || !fieldName) {
      runtime.logger.info(
        `UnityEvent invoker skipped unresolved C# field location: ` +
        `asset=${reference.assetPath}, eventScript=${reference.eventScriptPath ?? '<unknown>'}, ` +
        `ownerType=${ownerTypeName ?? '<unknown>'}, field=${fieldName || '<unknown>'}.`
      );
      continue;
    }

    const key = `${typeLookupKey(ownerTypeName)}#${fieldName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    lookups.push({
      reference,
      ownerTypeName,
      fieldName
    });
  }

  return lookups;
}

/** Uses the event owner script filename as a provider query hint when YAML lacks a full owner type. */
function scriptTypeNameFromPath(scriptPath: string | undefined): string | undefined {
  const fileName = scriptPath?.split(/[\\/]/).pop() ?? '';
  const typeName = fileName.replace(/\.cs$/i, '');
  return typeName || undefined;
}

/** Converts a provider-backed C# method position into a peek location. */
function toCSharpLocation(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  position: { line: number; character: number }
): vscode.Location {
  return new runtimeVscode.Location(uri, new runtimeVscode.Position(position.line, position.character));
}

/** Normalizes C# type names from YAML and provider labels. */
function typeLookupKey(typeName: string): string {
  return typeName.split(',')[0]?.trim().replace(/\s+/g, '').toLowerCase() ?? typeName.toLowerCase();
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

    if (target.kind === 'methodInvokerField') {
      const resolved = await showMethodInvokerFieldLocations(runtime, target, eventReferences);
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

  if (target.kind === 'methodInvokerField') {
    const resolved = await showMethodInvokerFieldLocations(runtime, target, references);
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
