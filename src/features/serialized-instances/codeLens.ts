import type * as vscode from 'vscode';
import type { SerializedInstanceLocationTarget, SerializedInstancesRuntime } from './runtime';
import type { UnitySerializedInstanceIndex } from './model';
import { toProjectPath } from '../serialized-assets/utils';

/** Converts a serialized instance index into class-level CodeLens entries. */
export function createSerializedInstanceCodeLensesFromIndex(
  runtime: SerializedInstancesRuntime,
  document: vscode.TextDocument,
  index: UnitySerializedInstanceIndex,
  embedReferences: boolean
): vscode.CodeLens[] {
  const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
  const typeName = getScriptTypeNameFromPath(scriptPath);
  const serializedInstances = index.getSerializedInstances(scriptPath, typeName);
  if (serializedInstances.length === 0) {
    return [];
  }

  const typeRange = findSerializedInstanceCodeLensRange(runtime.runtimeVscode, document, scriptPath);
  return [
    new runtime.runtimeVscode.CodeLens(typeRange, {
      title: runtime.runtimeVscode.l10n.t('{count} Unity serialized instances', {
        count: serializedInstances.length
      }),
      command: 'unityPlus.showUnitySerializedInstanceLocations',
      arguments: [{
        kind: 'serializedInstance',
        scriptPath,
        typeName,
        ...(embedReferences ? { serializedInstances } : {}),
        position: typeRange.start
      } satisfies SerializedInstanceLocationTarget]
    })
  ];
}

/** Finds a cheap visual anchor for serialized-instance CodeLens without C# server calls. */
function findSerializedInstanceCodeLensRange(
  runtimeVscode: typeof vscode,
  document: vscode.TextDocument,
  scriptPath: string
): vscode.Range {
  const typeNameFromFile = getScriptTypeNameFromPath(scriptPath) ?? '';
  const escapedTypeName = escapeRegExp(typeNameFromFile);
  const declarationPattern = new RegExp(`\\b(?:class|struct|record)\\s+(${escapedTypeName || '[A-Za-z_][A-Za-z0-9_]*'})\\b`);

  const lines = document.getText().split(/\r?\n/);
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

/** Uses the script file name as a non-semantic display key for type-only YAML hits. */
function getScriptTypeNameFromPath(scriptPath: string): string | undefined {
  const typeName = (scriptPath.split(/[\\/]/).pop() ?? '').replace(/\.cs$/i, '');
  return typeName || undefined;
}

/** Escapes a literal C# type name for the display-anchor regexp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
