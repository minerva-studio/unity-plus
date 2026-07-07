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
  let methodPlaceholderCount = 0;
  let fieldReferenceLensCount = 0;
  let fieldTargetLensCount = 0;
  let fieldCount = 0;

  const [methodResult, fieldResult] = await Promise.all([
    resolveMethodLenses(runtime, document, index, scriptPath, options),
    resolveFieldLenses(runtime, document, index, scriptPath, options)
  ]);
  codeLenses.push(...methodResult.lenses, ...fieldResult.lenses);
  methodLensCount = methodResult.lensCount;
  methodPlaceholderCount = methodResult.placeholderCount;
  fieldCount = fieldResult.fieldCount;
  fieldReferenceLensCount = fieldResult.referenceLensCount;
  fieldTargetLensCount = fieldResult.targetLensCount;

  if (options.includeZeroSummaryLenses) {
    // Instance CodeLens is intentionally omitted at zero because proving that a
    // C# file is a UnityEngine.Object type belongs to semantic providers.
  }

  runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${fieldCount} UnityEvent field(s), ${methodLensCount} method lens(es), ${methodPlaceholderCount} method placeholder(s), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es).`);
  return codeLenses;
}

/** Resolves method CodeLens entries without blocking field lenses. */
async function resolveMethodLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  options: CodeLensRenderOptions
): Promise<{ lenses: vscode.CodeLens[]; lensCount: number; placeholderCount: number }> {
  const lenses: vscode.CodeLens[] = [];
  if (!index.hasMethodReferences(scriptPath)) {
    return { lenses, lensCount: 0, placeholderCount: 0 };
  }

  if (options.skipCSharpMethods) {
    runtime.logger.debug(`UnityEvent CodeLens skipped C# methods during retry backoff for ${scriptPath}.`);
    return { lenses, lensCount: 0, placeholderCount: 0 };
  }

  try {
    const methods = await safeFindMethods(runtime, document);
    options.onCSharpSymbolsReady?.('methods', methods);
    return {
      lenses,
      lensCount: appendMethodCodeLenses(runtime, lenses, index, scriptPath, methods, options),
      placeholderCount: 0
    };
  } catch (error) {
    const placeholderCount = appendMethodPlaceholderCodeLenses(runtime, lenses, scriptPath, options.fallbackMethods ?? []);
    runtime.logger.error(`UnityEvent method CodeLens failed for ${scriptPath}; placeholders=${placeholderCount}: ${formatErrorDetails(error)}`);
    options.onCSharpSymbolsUnavailable?.('methods', error, placeholderCount > 0);
    return { lenses, lensCount: 0, placeholderCount };
  }
}

/** Resolves field CodeLens entries without waiting for method symbols. */
async function resolveFieldLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  options: CodeLensRenderOptions
): Promise<{ lenses: vscode.CodeLens[]; fieldCount: number; referenceLensCount: number; targetLensCount: number }> {
  const lenses: vscode.CodeLens[] = [];
  if (!index.hasFieldReferences(scriptPath)) {
    return { lenses, fieldCount: 0, referenceLensCount: 0, targetLensCount: 0 };
  }

  if (options.skipCSharpFields) {
    runtime.logger.debug(`UnityEvent CodeLens skipped C# UnityEvent fields during retry backoff for ${scriptPath}.`);
    return { lenses, fieldCount: 0, referenceLensCount: 0, targetLensCount: 0 };
  }

  try {
    const fields = await safeFindUnityEventFields(runtime, document);
    options.onCSharpSymbolsReady?.('fields', fields);
    const fieldLensCounts = appendFieldCodeLenses(runtime, lenses, index, scriptPath, fields, options);
    return {
      lenses,
      fieldCount: fields.length,
      referenceLensCount: fieldLensCounts.referenceLensCount,
      targetLensCount: fieldLensCounts.targetLensCount
    };
  } catch (error) {
    const fieldLensCounts = appendFieldPlaceholderCodeLenses(runtime, lenses, scriptPath, options.fallbackFields ?? []);
    const placeholderCount = fieldLensCounts.referenceLensCount + fieldLensCounts.targetLensCount;
    runtime.logger.error(`UnityEvent field CodeLens failed for ${scriptPath}; placeholders=${placeholderCount}: ${formatErrorDetails(error)}`);
    if (placeholderCount === 0) {
      runtime.logger.error(`UnityEvent field symbols unavailable, cannot place field placeholder for ${scriptPath}.`);
    }
    options.onCSharpSymbolsUnavailable?.('fields', error, placeholderCount > 0);
    return {
      lenses,
      fieldCount: 0,
      referenceLensCount: fieldLensCounts.referenceLensCount,
      targetLensCount: fieldLensCounts.targetLensCount
    };
  }
}

/** Appends method CodeLens entries from provider-backed C# method symbols. */
function appendMethodCodeLenses(
  runtime: EventReferenceRuntime,
  codeLenses: vscode.CodeLens[],
  index: UnitySerializedAssetReferenceIndex,
  scriptPath: string,
  methods: readonly CSharpMethodSymbolSnapshot[],
  options: CodeLensRenderOptions
): number {
  let methodLensCount = 0;
  for (const method of methods) {
    const references = index.getReferences(scriptPath, method.name, method.typeName);
    if (references.length === 0) {
      continue;
    }

    methodLensCount += 1;
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
  }

  return methodLensCount;
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

    const fieldTargets = index.getFieldTargets(scriptPath, field.name, field.typeName);
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

/** Reads method symbols without allowing language-server failures to hide all CodeLens entries. */
async function safeFindMethods(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument
): Promise<CSharpMethodSymbolSnapshot[]> {
  try {
    return await runtime.csharpLanguageService?.findMethods(document.uri) ?? [];
  } catch (error) {
    runtime.logger.debug(`UnityEvent CodeLens could not read C# methods in ${document.uri.fsPath}: ${String(error)}`);
    throw error;
  }
}

/** Formats provider failures with stack traces when available. */
function formatErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }

  return String(error);
}

/** Reads UnityEvent field symbols without allowing language-server failures to hide summaries. */
async function safeFindUnityEventFields(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument
): Promise<CSharpFieldSymbolSnapshot[]> {
  try {
    return await runtime.csharpLanguageService?.findUnityEventFields(document.uri) ?? [];
  } catch (error) {
    runtime.logger.debug(`UnityEvent CodeLens could not read UnityEvent fields in ${document.uri.fsPath}: ${String(error)}`);
    throw error;
  }
}
