import type * as vscode from 'vscode';
import type { CSharpFieldSymbolSnapshot, CSharpMethodSymbolSnapshot, CSharpTypeSymbolSnapshot } from '../../unity/csharpLanguageService';
import type { UnitySerializedAssetReferenceIndex, UnitySerializedInstanceLocation } from './model';
import { typeKey } from './referenceIndex';
import type { CodeLensRenderOptions, EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { toProjectPath } from './utils';

export async function createScanStateCodeLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  scriptPath: string,
  marker: '-' | '0'
): Promise<vscode.CodeLens[]> {
  const anchorRange = await findCodeLensStatusAnchorRange(runtime, document);
  const position = anchorRange.start;

  return [
    new runtime.runtimeVscode.CodeLens(anchorRange, {
      title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', { count: marker }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'serializedInstance',
        scriptPath,
        serializedInstances: marker === '0' ? [] : undefined,
        position
      } satisfies EventReferenceLocationTarget]
    }),
    new runtime.runtimeVscode.CodeLens(anchorRange, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: marker }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'method',
        scriptPath,
        eventReferences: marker === '0' ? [] : undefined,
        position
      } satisfies EventReferenceLocationTarget]
    }),
    new runtime.runtimeVscode.CodeLens(anchorRange, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent targets', { count: marker }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'fieldTarget',
        scriptPath,
        eventReferences: marker === '0' ? [] : undefined,
        position
      } satisfies EventReferenceLocationTarget]
    })
  ];
}

/** Picks a stable class-level range for scan state and zero-count summary CodeLens entries. */
async function findCodeLensStatusAnchorRange(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument
): Promise<vscode.Range> {
  const types = await safeFindTypes(runtime, document);
  return types[0] ? toVscodeRange(runtime.runtimeVscode, types[0].range) :
    new runtime.runtimeVscode.Range(new runtime.runtimeVscode.Position(0, 0), new runtime.runtimeVscode.Position(0, 0));
}

/** Converts a reference index into CodeLens entries for one C# document. */
export async function createCodeLensesFromIndex(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedAssetReferenceIndex,
  options: CodeLensRenderOptions
): Promise<vscode.CodeLens[]> {
  const csharpLanguageService = runtime.csharpLanguageService;
  if (!csharpLanguageService) {
    return [];
  }

  const methods = await safeFindMethods(runtime, document);
  const fields = await safeFindUnityEventFields(runtime, document);
  const types = await safeFindTypes(runtime, document);
  const codeLenses: vscode.CodeLens[] = [];
  const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
  const serializedInstanceAnchor = findSerializedInstanceAnchorType(types, scriptPath);
  let serializedInstanceLensCount = 0;
  let methodLensCount = 0;
  let fieldReferenceLensCount = 0;
  let fieldTargetLensCount = 0;

  for (const type of types) {
    const serializedInstances = filterSerializedInstancesForTypeLens(
      index.getSerializedInstances(scriptPath, type.fullName),
      type.fullName,
      type === serializedInstanceAnchor
    );

    if (serializedInstances.length > 0) {
      const typeRange = toVscodeRange(runtime.runtimeVscode, type.range);
      serializedInstanceLensCount += 1;
      codeLenses.push(new runtime.runtimeVscode.CodeLens(typeRange, {
        title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
          count: serializedInstances.length
        }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'serializedInstance',
          scriptPath,
          typeName: type.fullName,
          ...(options.embedReferences || type !== serializedInstanceAnchor ? { serializedInstances } : {}),
        position: typeRange.start
        } satisfies EventReferenceLocationTarget]
      }));
    }
  }

  for (const method of methods) {
    const references = index.getReferences(scriptPath, method.name, method.typeName);
    if (references.length > 0) {
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
  }

  for (const field of fields) {
    const fieldReferences = index.getFieldReferences(scriptPath, field.name, field.typeName);
    fieldReferenceLensCount += 1;
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
    fieldTargetLensCount += 1;
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

  if (options.includeZeroSummaryLenses) {
    const anchorRange = await findCodeLensStatusAnchorRange(runtime, document);
    const position = anchorRange.start;

    // Keep ready zero-count summaries aligned with the pending "-" status lenses.
    if (serializedInstanceLensCount === 0) {
      codeLenses.push(new runtime.runtimeVscode.CodeLens(anchorRange, {
        title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', { count: 0 }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'serializedInstance',
          scriptPath,
          serializedInstances: [],
          position
        } satisfies EventReferenceLocationTarget]
      }));
    }

    if (methodLensCount === 0 && fieldReferenceLensCount === 0) {
      codeLenses.push(new runtime.runtimeVscode.CodeLens(anchorRange, {
        title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: 0 }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'method',
          scriptPath,
          eventReferences: [],
          position
        } satisfies EventReferenceLocationTarget]
      }));
    }

    if (fieldTargetLensCount === 0) {
      codeLenses.push(new runtime.runtimeVscode.CodeLens(anchorRange, {
        title: runtime.runtimeVscode.l10n.t('{count} UnityEvent targets', { count: 0 }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'fieldTarget',
          scriptPath,
          eventReferences: [],
          position
        } satisfies EventReferenceLocationTarget]
      }));
    }
  }

  runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${types.length} type(s), ${fields.length} UnityEvent field(s), ${methodLensCount} method lens(es), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es), ${serializedInstanceLensCount} serialized instance lens(es).`);
  return codeLenses;
}

/** Chooses the single C# type that should receive path-based serialized instance counts. */
function findSerializedInstanceAnchorType(
  types: readonly CSharpTypeSymbolSnapshot[],
  scriptPath: string
): CSharpTypeSymbolSnapshot | undefined {
  if (types.length <= 1) {
    return types[0];
  }

  const fileName = scriptPath.split(/[\\/]/).pop() ?? '';
  const typeNameFromFile = fileName.replace(/\.cs$/i, '').toLowerCase();
  return types.find(type => type.name.toLowerCase() === typeNameFromFile) ?? types[0];
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
    runtime.logger.warn(`UnityEvent CodeLens could not read C# methods in ${document.uri.fsPath}: ${String(error)}`);
    return [];
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
    runtime.logger.warn(`UnityEvent CodeLens could not read UnityEvent fields in ${document.uri.fsPath}: ${String(error)}`);
    return [];
  }
}

/** Reads type symbols without allowing anchor lookup failures to hide placeholder CodeLens entries. */
async function safeFindTypes(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument
): Promise<CSharpTypeSymbolSnapshot[]> {
  try {
    return await runtime.csharpLanguageService?.findTypes(document.uri) ?? [];
  } catch (error) {
    runtime.logger.warn(`UnityEvent CodeLens could not read C# types in ${document.uri.fsPath}: ${String(error)}`);
    return [];
  }
}

/** Filters type-only fallback instances while keeping path hits on the selected anchor type. */
function filterSerializedInstancesForTypeLens(
  locations: readonly UnitySerializedInstanceLocation[],
  typeName: string,
  includePathInstances: boolean
): readonly UnitySerializedInstanceLocation[] {
  if (includePathInstances) {
    return locations;
  }

  return locations.filter(location =>
    !location.scriptPath &&
    location.scriptTypeName !== undefined &&
    typeKey(location.scriptTypeName) === typeKey(typeName)
  );
}
