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
  const serializedInstances = index.getSerializedInstances(scriptPath, getScriptTypeNameFromPath(scriptPath));
  let serializedInstanceLensCount = 0;
  let methodLensCount = 0;
  let fieldReferenceLensCount = 0;
  let fieldTargetLensCount = 0;

  if (serializedInstances.length > 0) {
    const typeRange = findSerializedInstanceCodeLensRange(runtime.runtimeVscode, document, scriptPath);
    serializedInstanceLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(typeRange, {
      title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
        count: serializedInstances.length
      }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'serializedInstance',
        scriptPath,
        ...(options.embedReferences ? { serializedInstances } : {}),
        position: typeRange.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  if (options.skipCSharpMethods) {
    // Method symbol retry is scoped separately so UnityEvent field lenses can
    // still render when only method symbols are warming up.
    runtime.logger.debug(`UnityEvent CodeLens skipped C# methods during retry backoff for ${scriptPath}.`);
  } else {
    try {
      const methods = await safeFindMethods(runtime, document);
      options.onCSharpSymbolsReady?.('methods');
      methodLensCount = appendMethodCodeLenses(runtime, codeLenses, index, scriptPath, methods, options);
    } catch (error) {
      // C# method symbols often arrive after VS Code first asks for CodeLens.
      // Field lenses stay independent so UnityEvent fields are not hidden here.
      runtime.logger.debug(`UnityEvent method CodeLens skipped for ${scriptPath}: ${String(error)}`);
      options.onCSharpSymbolsUnavailable?.('methods', error);
    }
  }

  let fieldCount = 0;
  if (options.skipCSharpFields) {
    // Field symbol retry is scoped separately so method and YAML instance lenses
    // can stay visible while UnityEvent field symbols are unavailable.
    runtime.logger.debug(`UnityEvent CodeLens skipped C# UnityEvent fields during retry backoff for ${scriptPath}.`);
  } else {
    try {
      const fields = await safeFindUnityEventFields(runtime, document);
      options.onCSharpSymbolsReady?.('fields');
      fieldCount = fields.length;
      const fieldLensCounts = appendFieldCodeLenses(runtime, codeLenses, index, scriptPath, fields, options);
      fieldReferenceLensCount = fieldLensCounts.referenceLensCount;
      fieldTargetLensCount = fieldLensCounts.targetLensCount;
    } catch (error) {
      // Field symbol failures should only hide field-level lenses. Method and
      // serialized instance lenses are still valid with the current index.
      runtime.logger.debug(`UnityEvent field CodeLens skipped for ${scriptPath}: ${String(error)}`);
      options.onCSharpSymbolsUnavailable?.('fields', error);
    }
  }

  if (options.includeZeroSummaryLenses) {
    // Instance CodeLens is intentionally omitted at zero because proving that a
    // C# file is a UnityEngine.Object type belongs to semantic providers.
  }

  runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${fieldCount} UnityEvent field(s), ${methodLensCount} method lens(es), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es), ${serializedInstanceLensCount} serialized instance lens(es).`);
  return codeLenses;
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

/** Converts language-service ranges back into VS Code ranges for CodeLens rendering. */
function toVscodeRange(runtimeVscode: typeof vscode, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new runtimeVscode.Range(
    new runtimeVscode.Position(range.start.line, range.start.character),
    new runtimeVscode.Position(range.end.line, range.end.character)
  );
}

/** Finds a cheap visual anchor for serialized-instance CodeLens without C# server calls. */
function findSerializedInstanceCodeLensRange(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  scriptPath: string
): vscode.Range {
  const typeNameFromFile = (scriptPath.split(/[\\/]/).pop() ?? '').replace(/\.cs$/i, '');
  const escapedTypeName = escapeRegExp(typeNameFromFile);
  const declarationPattern = new RegExp(`\\b(?:class|struct|record)\\s+(${escapedTypeName || '[A-Za-z_][A-Za-z0-9_]*'})\\b`);

  const lines = getDocumentLines(document);
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line] ?? '';
    const match = declarationPattern.exec(text);
    if (!match?.[1]) {
      continue;
    }

    const character = text.indexOf(match[1], match.index);
    const start = new runtimeVscode.Position(line, Math.max(0, character));
    const end = new runtimeVscode.Position(line, Math.max(0, character) + match[1].length);
    return new runtimeVscode.Range(start, end);
  }

  return new runtimeVscode.Range(new runtimeVscode.Position(0, 0), new runtimeVscode.Position(0, 0));
}

/** Uses the script file name as a non-semantic fallback for YAML type-only hits. */
function getScriptTypeNameFromPath(scriptPath: string): string | undefined {
  const typeName = (scriptPath.split(/[\\/]/).pop() ?? '').replace(/\.cs$/i, '');
  return typeName || undefined;
}

/** Escapes a literal C# type name for the display-anchor regexp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Reads document lines without requiring VS Code-only TextDocument helpers in unit tests. */
function getDocumentLines(document: vscode.TextDocument): string[] {
  return document.getText().split(/\r?\n/);
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
