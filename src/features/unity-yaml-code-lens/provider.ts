import { join } from 'node:path';
import type * as vscode from 'vscode';
import { getUnityYamlDocumentScriptReference, parseUnityYamlAsset } from '../../unity/unityYaml';
import type { UnityYamlCodeLensRuntime } from './runtime';

const monoBehaviourClassId = 114;

/** Creates CodeLens entries for Unity YAML MonoBehaviour script references in the current document only. */
export function createUnityYamlCodeLensProvider(
  runtime: UnityYamlCodeLensRuntime
): vscode.CodeLensProvider {
  return {
    async provideCodeLenses(document) {
      if (!isUnitySerializedAssetDocument(document)) {
        return [];
      }

      const metadata = await runtime.metadataIndex.getOrBuild();
      const parsed = parseUnityYamlAsset(document.getText(), { profile: 'eventReferences' });
      const lenses: vscode.CodeLens[] = [];

      for (const yamlDocument of parsed.documents) {
        if (yamlDocument.classId !== monoBehaviourClassId) {
          continue;
        }

        const scriptReference = getUnityYamlDocumentScriptReference(yamlDocument);
        if (!scriptReference) {
          continue;
        }

        const scriptPath = metadata.getAssetPath(scriptReference.guid);
        if (!scriptPath) {
          runtime.logger.info(`Unity YAML MonoBehaviour CodeLens could not resolve script GUID ${scriptReference.guid} in ${document.uri.fsPath}.`);
        }

        const range = createMonoBehaviourRange(runtime.runtimeVscode, yamlDocument);
        const title = scriptPath
          ? runtime.runtimeVscode.l10n.t('C# script: {type}', { type: scriptTypeNameFromPath(scriptPath) })
          : runtime.runtimeVscode.l10n.t('C# script: unresolved');
        lenses.push(new runtime.runtimeVscode.CodeLens(range, {
          title,
          command: 'unityPlus.openUnityYamlMonoBehaviourScript',
          arguments: scriptPath
            ? [toScriptFsPath(runtime.metadataIndex.root, scriptPath), scriptReference.guid]
            : ['', scriptReference.guid]
        }));
      }

      return lenses;
    }
  };
}

/** Builds a platform-correct filesystem path for a Unity project-relative script path. */
function toScriptFsPath(root: vscode.Uri, scriptPath: string): string {
  return join(root.fsPath, ...scriptPath.split(/[\\/]/).filter(Boolean));
}

/** Checks YAML asset extensions without reading any workspace-wide state. */
function isUnitySerializedAssetDocument(document: vscode.TextDocument): boolean {
  return /\.(prefab|unity|asset)$/i.test(document.uri.fsPath);
}

/** Anchors the CodeLens to the MonoBehaviour type token, falling back to the document header. */
function createMonoBehaviourRange(
  runtimeVscode: typeof vscode,
  document: { source?: { type?: { line: number; character: number }; header?: { line: number; character: number } } }
): vscode.Range {
  const location = document.source?.type ?? document.source?.header ?? { line: 0, character: 0 };
  const position = new runtimeVscode.Position(location.line, location.character);
  return new runtimeVscode.Range(position, position);
}

/** Shows the C# script type name from a Unity project asset path. */
function scriptTypeNameFromPath(scriptPath: string): string {
  const fileName = scriptPath.split(/[\\/]/).pop() ?? scriptPath;
  return fileName.replace(/\.cs$/i, '') || fileName;
}
