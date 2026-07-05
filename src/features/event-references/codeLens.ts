import type * as vscode from 'vscode';
import { findCSharpMethods, findCSharpTypes, findUnityEventFields, type CSharpTypeSnapshot } from './csharpSource';
import type { UnitySerializedAssetReferenceIndex, UnitySerializedInstanceLocation } from './model';
import { typeKey } from './referenceIndex';
import type { CodeLensRenderOptions, EventReferenceLocationTarget, EventReferenceRuntime } from './runtime';
import { toProjectPath } from './utils';

export function createScanStateCodeLenses(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  scriptPath: string,
  marker: '-' | '0'
): vscode.CodeLens[] {
  const anchorRange = findCodeLensStatusAnchorRange(runtime.runtimeVscode, document);
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
function findCodeLensStatusAnchorRange(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument
): vscode.Range {
  return findCSharpTypes(runtimeVscode, document)[0]?.range ??
    new runtimeVscode.Range(new runtimeVscode.Position(0, 0), new runtimeVscode.Position(0, 0));
}

/** Converts a reference index into CodeLens entries for one C# document. */
export function createCodeLensesFromIndex(
  runtime: EventReferenceRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedAssetReferenceIndex,
  options: CodeLensRenderOptions
): vscode.CodeLens[] {
  const methods = findCSharpMethods(runtime.runtimeVscode, document);
  const fields = findUnityEventFields(runtime.runtimeVscode, document);
  const types = findCSharpTypes(runtime.runtimeVscode, document);
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
      serializedInstanceLensCount += 1;
      codeLenses.push(new runtime.runtimeVscode.CodeLens(type.range, {
        title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
          count: serializedInstances.length
        }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'serializedInstance',
          scriptPath,
          typeName: type.fullName,
          ...(options.embedReferences || type !== serializedInstanceAnchor ? { serializedInstances } : {}),
          position: type.range.start
        } satisfies EventReferenceLocationTarget]
      }));
    }
  }

  for (const method of methods) {
    const references = index.getReferences(scriptPath, method.name, method.typeName);
    if (references.length > 0) {
      methodLensCount += 1;
      codeLenses.push(new runtime.runtimeVscode.CodeLens(method.range, {
        title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: references.length }),
        command: 'unityPlus.showUnityEventReferenceLocations',
        arguments: [{
          kind: 'method',
          scriptPath,
          symbolName: method.name,
          typeName: method.typeName,
          ...(options.embedReferences ? { eventReferences: references } : {}),
          position: method.range.start
        } satisfies EventReferenceLocationTarget]
      }));
    }
  }

  for (const field of fields) {
    const fieldReferences = index.getFieldReferences(scriptPath, field.name, field.typeName);
    fieldReferenceLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(field.range, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent references', { count: fieldReferences.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'field',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        ...(options.embedReferences ? { eventReferences: fieldReferences } : {}),
        position: field.range.start
      } satisfies EventReferenceLocationTarget]
    }));

    const fieldTargets = index.getFieldTargets(scriptPath, field.name, field.typeName);
    fieldTargetLensCount += 1;
    codeLenses.push(new runtime.runtimeVscode.CodeLens(field.range, {
      title: runtime.runtimeVscode.l10n.t('{count} UnityEvent targets', { count: fieldTargets.length }),
      command: 'unityPlus.showUnityEventReferenceLocations',
      arguments: [{
        kind: 'fieldTarget',
        scriptPath,
        symbolName: field.name,
        typeName: field.typeName,
        ...(options.embedReferences ? { eventReferences: fieldTargets } : {}),
        position: field.range.start
      } satisfies EventReferenceLocationTarget]
    }));
  }

  if (options.includeZeroSummaryLenses) {
    const anchorRange = findCodeLensStatusAnchorRange(runtime.runtimeVscode, document);
    const position = anchorRange.start;

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
  }

  runtime.logger.debug(`UnityEvent CodeLens for ${scriptPath}: ${types.length} type(s), ${fields.length} UnityEvent field(s), ${methodLensCount} method lens(es), ${fieldReferenceLensCount} field reference lens(es), ${fieldTargetLensCount} field target lens(es), ${serializedInstanceLensCount} serialized instance lens(es).`);
  return codeLenses;
}

/** Chooses the single C# type that should receive path-based serialized instance counts. */
function findSerializedInstanceAnchorType(
  types: readonly CSharpTypeSnapshot[],
  scriptPath: string
): CSharpTypeSnapshot | undefined {
  if (types.length <= 1) {
    return types[0];
  }

  const fileName = scriptPath.split(/[\\/]/).pop() ?? '';
  const typeNameFromFile = fileName.replace(/\.cs$/i, '').toLowerCase();
  return types.find(type => type.name.toLowerCase() === typeNameFromFile) ?? types[0];
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
