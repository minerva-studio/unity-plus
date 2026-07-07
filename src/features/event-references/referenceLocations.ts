import type * as vscode from 'vscode';
import type { CSharpPosition, CSharpTypeSymbolSnapshot } from '../../unity/csharpLanguageService';
import type { UnityEventReference, UnitySerializedAssetReferenceIndex } from './model';
import type { EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { errorMessage, escapeMarkdown, toWorkspaceUri } from './utils';

const targetMethodLookupTimeoutMilliseconds = 8_000;
const targetMethodLookupRetryDelaysMilliseconds = [100, 200, 400, 800, 1_200];
const targetMethodLookupConcurrency = 4;

interface UnityEventTargetMethodLookup {
  reference: UnityEventReference;
  targetTypeName: string;
  methodName: string;
  secondaryScriptPath?: string;
}

interface UnityEventTargetScriptCandidate {
  uri: vscode.Uri;
  source: 'type' | 'secondaryScriptPath';
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

  const lookups = collectDistinctTargetMethodLookups(runtime, references);
  await runWithTargetLookupConcurrency(lookups, async lookup => {
    const candidate = await resolveTargetScriptCandidate(runtime, lookup);
    if (!candidate) {
      return;
    }

    try {
      const positions = await findTargetMethodPositionsWithRetry(runtime, candidate.uri, lookup);
      for (const position of positions) {
        const key = `${candidate.uri.fsPath}:${position.line}:${position.character}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        locations.push(toCSharpLocation(runtime.runtimeVscode, candidate.uri, position));
      }
    } catch (error) {
      runtime.logger.error(
        `UnityEvent target C# method lookup failed: ` +
        `asset=${lookup.reference.assetPath}, targetScript=${candidate.uri.fsPath}, ` +
        `candidateSource=${candidate.source}, targetType=${lookup.targetTypeName}, ` +
        `method=${lookup.methodName}, error=${errorMessage(error)}`
      );
    }
  });

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
      methodName,
      secondaryScriptPath: reference.scriptPath
    });
  }

  return lookups;
}

/** Resolves the script URI that should contain a target type before using YAML path hints. */
async function resolveTargetScriptCandidate(
  runtime: EventReferenceRuntime,
  lookup: UnityEventTargetMethodLookup
): Promise<UnityEventTargetScriptCandidate | undefined> {
  const typeCandidate = await resolveTargetTypeScriptCandidate(runtime, lookup);
  if (typeCandidate) {
    return typeCandidate;
  }

  const secondaryScriptPath = lookup.secondaryScriptPath;
  if (!secondaryScriptPath) {
    runtime.logger.info(`UnityEvent target skipped ${lookup.targetTypeName}.${lookup.methodName}: no provider type match and no secondary script path from YAML.`);
    return undefined;
  }

  if (!scriptPathMatchesTypeName(secondaryScriptPath, lookup.targetTypeName)) {
    runtime.logger.info(
      `UnityEvent target skipped secondary script path because it does not match target type: ` +
      `asset=${lookup.reference.assetPath}, secondaryScript=${secondaryScriptPath}, ` +
      `targetType=${lookup.targetTypeName}, method=${lookup.methodName}.`
    );
    return undefined;
  }

  runtime.logger.info(
    `UnityEvent target using secondary script path after provider type lookup did not resolve uniquely: ` +
    `targetType=${lookup.targetTypeName}, method=${lookup.methodName}, secondaryScript=${secondaryScriptPath}.`
  );
  return {
    uri: toWorkspaceUri(runtime.runtimeVscode, runtime.metadataIndex.root, secondaryScriptPath),
    source: 'secondaryScriptPath'
  };
}

/** Finds a unique provider-backed script URI for the requested target type. */
async function resolveTargetTypeScriptCandidate(
  runtime: EventReferenceRuntime,
  lookup: UnityEventTargetMethodLookup
): Promise<UnityEventTargetScriptCandidate | undefined> {
  try {
    const types = await runtime.csharpLanguageService?.findTypesByName(lookup.targetTypeName) ?? [];
    const matchingTypes = uniqueTypeSymbolsByUri(types.filter(type =>
      type.uriPath &&
      typeNameMatches(type.fullName, lookup.targetTypeName)
    ));
    if (matchingTypes.length === 1 && matchingTypes[0].uriPath) {
      return {
        uri: runtime.runtimeVscode.Uri.file(matchingTypes[0].uriPath),
        source: 'type'
      };
    }

    if (matchingTypes.length > 1) {
      runtime.logger.info(
        `UnityEvent target type lookup ambiguous: ` +
        `targetType=${lookup.targetTypeName}, method=${lookup.methodName}, ` +
        `matches=${matchingTypes.map(type => type.uriPath).join(', ')}.`
      );
    }
  } catch (error) {
    runtime.logger.info(
      `UnityEvent target type lookup unavailable: ` +
      `targetType=${lookup.targetTypeName}, method=${lookup.methodName}, error=${errorMessage(error)}`
    );
  }

  return undefined;
}

/** Removes duplicate provider type symbols that point at the same source file. */
function uniqueTypeSymbolsByUri(types: readonly CSharpTypeSymbolSnapshot[]): CSharpTypeSymbolSnapshot[] {
  const seen = new Set<string>();
  return types.filter(type => {
    const key = (type.uriPath ?? '').replace(/\\/g, '/').toLowerCase();
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/** Finds target method positions while allowing the C# provider a short warm-up window. */
async function findTargetMethodPositionsWithRetry(
  runtime: EventReferenceRuntime,
  uri: vscode.Uri,
  lookup: UnityEventTargetMethodLookup
): Promise<CSharpPosition[]> {
  const startedAt = Date.now();
  let attempt = 0;
  let lastUnavailableError: unknown;

  while (Date.now() - startedAt <= targetMethodLookupTimeoutMilliseconds) {
    try {
      return await runtime.csharpLanguageService!.findTargetMethodPosition(uri, lookup.targetTypeName, lookup.methodName);
    } catch (error) {
      if (!isCSharpProviderUnavailableError(error)) {
        throw error;
      }

      lastUnavailableError = error;
      const elapsedMilliseconds = Date.now() - startedAt;
      runtime.logger.debug(
        `UnityEvent target C# provider unavailable; retrying lookup: ` +
        `targetScript=${uri.fsPath}, targetType=${lookup.targetTypeName}, method=${lookup.methodName}, ` +
        `attempt=${attempt + 1}, elapsed=${elapsedMilliseconds}ms, error=${errorMessage(error)}`
      );
      const delay = targetMethodLookupRetryDelaysMilliseconds[Math.min(attempt, targetMethodLookupRetryDelaysMilliseconds.length - 1)];
      attempt += 1;
      await delayMilliseconds(delay);
    }
  }

  throw new Error(
    `C# provider stayed unavailable for ${lookup.targetTypeName}.${lookup.methodName} ` +
    `in ${uri.fsPath} after ${Date.now() - startedAt}ms: ${errorMessage(lastUnavailableError)}`
  );
}

/** Runs C# target lookups with a small concurrency cap so one click does not flood the provider. */
async function runWithTargetLookupConcurrency<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(targetMethodLookupConcurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/** Checks provider-warmup errors that are worth retrying inside the click command. */
function isCSharpProviderUnavailableError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('namespace-only symbols') ||
    message.includes('empty symbols') ||
    message.includes('returned no result');
}

/** Waits without blocking the extension host event loop. */
async function delayMilliseconds(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Converts a provider-backed C# method position into a peek location. */
function toCSharpLocation(
  runtimeVscode: typeof vscode,
  uri: vscode.Uri,
  position: { line: number; character: number }
): vscode.Location {
  return new runtimeVscode.Location(uri, new runtimeVscode.Position(position.line, position.character));
}

/** Checks whether a secondary YAML script path plausibly names the target type. */
function scriptPathMatchesTypeName(scriptPath: string, typeName: string): boolean {
  const fileName = scriptPath.split(/[\\/]/).pop() ?? '';
  const scriptTypeName = fileName.replace(/\.cs$/i, '');
  return typeLookupKey(scriptTypeName) === shortTypeLookupKey(typeName);
}

/** Compares full or short provider type names against the YAML target type. */
function typeNameMatches(candidateTypeName: string, targetTypeName: string): boolean {
  return typeLookupKey(candidateTypeName) === typeLookupKey(targetTypeName) ||
    shortTypeLookupKey(candidateTypeName) === shortTypeLookupKey(targetTypeName);
}

/** Normalizes C# type names from YAML and provider labels. */
function typeLookupKey(typeName: string): string {
  return typeName.split(',')[0]?.trim().replace(/\s+/g, '').toLowerCase() ?? typeName.toLowerCase();
}

/** Normalizes the short C# type name for script-path sanity checks. */
function shortTypeLookupKey(typeName: string): string {
  return typeLookupKey(typeName).split('.').at(-1) ?? typeLookupKey(typeName);
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
