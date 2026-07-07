import type * as vscode from 'vscode';
import type { CSharpFieldSymbolSnapshot, CSharpMethodSymbolSnapshot } from '../../unity/csharpLanguageService';
import type { UnitySerializedAssetReferenceIndex } from './model';
import type { CodeLensRenderOptions, EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { toProjectPath } from './utils';

export async function createScanStateCodeLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  scriptPath: string,
  marker: '-' | '0'
): Promise<vscode.CodeLens[]> {
  void runtime;
  void document;
  void scriptPath;
  void marker;
  // Scan-state lenses used to query C# symbols before the YAML index was ready.
  // Keeping this helper inert prevents future call sites from blocking CodeLens.
  return [];
}

/** Converts a reference index into CodeLens entries for one C# document. */
export async function createCodeLensesFromIndex(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedAssetReferenceIndex,
  options: CodeLensRenderOptions
): Promise<vscode.CodeLens[]> {
  const codeLenses: vscode.CodeLens[] = [];
  const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
  let methodLensCount = 0;
  let methodInvokerLensCount = 0;
  let methodPlaceholderCount = 0;
  let fieldReferenceLensCount = 0;
  let fieldTargetLensCount = 0;
  let fieldCount = 0;

  const methodResult = resolveMethodLenses(runtime, index, scriptPath, options);
  const fieldResult = resolveFieldLenses(runtime, index, scriptPath, options);
  codeLenses.push(...methodResult.lenses, ...fieldResult.lenses);
  methodLensCount = methodResult.lensCount;
  methodInvokerLensCount = methodResult.invokerLensCount;
  methodPlaceholderCount = methodResult.placeholderCount;
  fieldCount = fieldResult.fieldCount;
  fieldReferenceLensCount = fieldResult.referenceLensCount;
  fieldTargetLensCount = fieldResult.targetLensCount;

  if (options.includeZeroSummaryLenses) {
    // Instance CodeLens is intentionally omitted at zero because proving that a
    // C# file is a UnityEngine.Object type belongs to semantic providers.
  }

  runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${fieldCount} UnityEvent field(s), ${methodLensCount} method lens(es), ${methodInvokerLensCount} method invoker lens(es), ${methodPlaceholderCount} method placeholder(s), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es).`);
  return codeLenses;
}

/** Resolves method CodeLens entries only from cached provider-backed symbols. */
function resolveMethodLenses(
  runtime: EventReferenceRuntime,
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  options: CodeLensRenderOptions
): { lenses: vscode.CodeLens[]; lensCount: number; invokerLensCount: number; placeholderCount: number } {
  const lenses: vscode.CodeLens[] = [];
  if (!index.hasMethodReferences(scriptPath)) {
    runtime.logger.debug(`UnityEvent CodeLens skipped C# methods for ${scriptPath}: no indexed method references match this script.`);
    return { lenses, lensCount: 0, invokerLensCount: 0, placeholderCount: 0 };
  }

  if (options.methodsUnavailable) {
    const placeholderCount = appendMethodPlaceholderCodeLenses(runtime, lenses, scriptPath, options.fallbackMethods ?? []);
    if (placeholderCount === 0) {
      runtime.logger.error(`UnityEvent method symbols unavailable, cannot place method placeholder for ${scriptPath}.`);
    }
    return { lenses, lensCount: 0, invokerLensCount: 0, placeholderCount };
  }

  if (!options.cachedMethods) {
    runtime.logger.debug(`UnityEvent CodeLens has no cached C# methods yet for ${scriptPath}.`);
    return { lenses, lensCount: 0, invokerLensCount: 0, placeholderCount: 0 };
  }

  const methodLensCounts = appendMethodCodeLenses(runtime, lenses, index, scriptPath, options.cachedMethods, options);
  return {
    lenses,
    lensCount: methodLensCounts.referenceLensCount,
    invokerLensCount: methodLensCounts.invokerLensCount,
    placeholderCount: 0
  };
}

/** Resolves field CodeLens entries only from cached provider-backed symbols. */
function resolveFieldLenses(
  runtime: EventReferenceRuntime,
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  options: CodeLensRenderOptions
): { lenses: vscode.CodeLens[]; fieldCount: number; referenceLensCount: number; targetLensCount: number } {
  const lenses: vscode.CodeLens[] = [];
  if (!index.hasFieldReferences(scriptPath)) {
    runtime.logger.debug(`UnityEvent CodeLens skipped C# UnityEvent fields for ${scriptPath}: no indexed UnityEvent field references match this script.`);
    return { lenses, fieldCount: 0, referenceLensCount: 0, targetLensCount: 0 };
  }

  if (options.fieldsUnavailable) {
    const fieldLensCounts = appendFieldPlaceholderCodeLenses(runtime, lenses, scriptPath, options.fallbackFields ?? []);
    const placeholderCount = fieldLensCounts.referenceLensCount + fieldLensCounts.targetLensCount;
    if (placeholderCount === 0) {
      runtime.logger.error(`UnityEvent field symbols unavailable, cannot place field placeholder for ${scriptPath}.`);
    }
    return {
      lenses,
      fieldCount: 0,
      referenceLensCount: fieldLensCounts.referenceLensCount,
      targetLensCount: fieldLensCounts.targetLensCount
    };
  }

  if (!options.cachedFields) {
    runtime.logger.debug(`UnityEvent CodeLens has no cached C# UnityEvent fields yet for ${scriptPath}.`);
    return { lenses, fieldCount: 0, referenceLensCount: 0, targetLensCount: 0 };
  }

  const fieldLensCounts = appendFieldCodeLenses(runtime, lenses, index, scriptPath, options.cachedFields, options);
  return {
    lenses,
    fieldCount: options.cachedFields.length,
    referenceLensCount: fieldLensCounts.referenceLensCount,
    targetLensCount: fieldLensCounts.targetLensCount
  };
}

/** Appends method CodeLens entries from provider-backed C# method symbols. */
function appendMethodCodeLenses(
  runtime: EventReferenceRuntime,
  codeLenses: vscode.CodeLens[],
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  methods: readonly CSharpMethodSymbolSnapshot[],
  options: CodeLensRenderOptions
): { referenceLensCount: number; invokerLensCount: number } {
  let referenceLensCount = 0;
  let invokerLensCount = 0;
  for (const method of methods) {
    const references = index.getReferences(scriptPath, method.name, method.typeName);
    if (references.length === 0) {
      continue;
    }

    referenceLensCount += 1;
    const range = toVscodeRange(runtime.runtimeVscode, method.range);
    codeLenses.push(new runtime.runtimeVscode.CodeLens(range, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: references.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'method',
        scriptPath,
        symbolName: method.name,
        typeName: method.typeName,
        ...(options.embedReferences ? { eventReferences: references } : {}),
        position: range.start
      } satisfies EventReferenceLocationTarget]
    }));

    const invokers = index.getMethodInvokerFields(scriptPath, method.name, method.typeName);
    invokerLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(range, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent invokers', { count: invokers.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'methodInvokerField',
        scriptPath,
        symbolName: method.name,
        typeName: method.typeName,
        ...(options.embedReferences ? { eventReferences: invokers } : {}),
        position: range.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  return { referenceLensCount, invokerLensCount };
}

/** Appends method placeholders when provider errors happen after a previous method read. */
function appendMethodPlaceholderCodeLenses(
  runtime: EventReferenceRuntime,
  codeLenses: vscode.CodeLens[],
  scriptPath: string,
  methods: readonly CSharpMethodSymbolSnapshot[]
): number {
  let placeholderCount = 0;
  for (const method of methods) {
    placeholderCount += 1;
    const range = toVscodeRange(runtime.runtimeVscode, method.range);
    codeLenses.push(new runtime.runtimeVscode.CodeLens(range, {
      title: runtime.runtimeVscode.l10n.t('- UnityEvent references'),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'method',
        scriptPath,
        symbolName: method.name,
        typeName: method.typeName,
        eventReferences: [],
        position: range.start
      } satisfies EventReferenceLocationTarget]
    }));

    codeLenses.push(new runtime.runtimeVscode.CodeLens(range, {
      title: runtime.runtimeVscode.l10n.t('- UnityEvent invokers'),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'methodInvokerField',
        scriptPath,
        symbolName: method.name,
        typeName: method.typeName,
        eventReferences: [],
        position: range.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  return placeholderCount;
}

/** Appends UnityEvent field CodeLens entries from provider-backed C# field symbols. */
function appendFieldCodeLenses(
  runtime: EventReferenceRuntime,
  codeLenses: vscode.CodeLens[],
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  fields: readonly CSharpFieldSymbolSnapshot[],
  options: CodeLensRenderOptions
): { referenceLensCount: number; targetLensCount: number } {
  let referenceLensCount = 0;
  let targetLensCount = 0;

  for (const field of fields) {
    const fieldReferences = index.getFieldReferences(scriptPath, field.name, field.typeName);
    const fieldTargets = index.getFieldTargets(scriptPath, field.name, field.typeName);
    if (fieldReferences.length === 0 && fieldTargets.length === 0) {
      continue;
    }

    referenceLensCount += 1;
    const fieldRange = toVscodeRange(runtime.runtimeVscode, field.range);
    codeLenses.push(new runtime.runtimeVscode.CodeLens(fieldRange, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: fieldReferences.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'field',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        ...(options.embedReferences ? { eventReferences: fieldReferences } : {}),
        position: fieldRange.start
      } satisfies EventReferenceLocationTarget]
    }));

    targetLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(fieldRange, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent targets', { count: fieldTargets.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'fieldTarget',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        ...(options.embedReferences ? { eventReferences: fieldTargets } : {}),
        position: fieldRange.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  return { referenceLensCount, targetLensCount };
}

/** Appends field placeholders when provider errors happen after a previous field read. */
function appendFieldPlaceholderCodeLenses(
  runtime: EventReferenceRuntime,
  codeLenses: vscode.CodeLens[],
  scriptPath: string,
  fields: readonly CSharpFieldSymbolSnapshot[]
): { referenceLensCount: number; targetLensCount: number } {
  let referenceLensCount = 0;
  let targetLensCount = 0;

  for (const field of fields) {
    const fieldRange = toVscodeRange(runtime.runtimeVscode, field.range);
    referenceLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(fieldRange, {
      title: runtime.runtimeVscode.l10n.t('- UnityEvent references'),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'field',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        eventReferences: [],
        position: fieldRange.start
      } satisfies EventReferenceLocationTarget]
    }));

    targetLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(fieldRange, {
      title: runtime.runtimeVscode.l10n.t('- UnityEvent targets'),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'fieldTarget',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        eventReferences: [],
        position: fieldRange.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  return { referenceLensCount, targetLensCount };
}

/** Converts language-service ranges back into VS Code ranges for CodeLens rendering. */
function toVscodeRange(runtimeVscode: typeof vscode, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new runtimeVscode.Range(
    new runtimeVscode.Position(range.start.line, range.start.character),
    new runtimeVscode.Position(range.end.line, range.end.character)
  );
}
