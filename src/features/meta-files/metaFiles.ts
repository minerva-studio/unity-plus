import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

export const metaFilesExcludePattern = '**/*.meta';

export interface MetaFilesFeatureOptions {
  runtimeVscode?: typeof vscode;
}

interface MetaFileSummary {
  guid?: string;
  importer?: string;
}

export function registerMetaFilesFeature(
  logger: UnityPlusLogger,
  options: MetaFilesFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const disposables: vscode.Disposable[] = [];

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.openMetaFile', async (resourceUri?: vscode.Uri) => {
    await openMetaFileForResource(runtimeVscode, resourceUri);
  }));

  disposables.push(runtimeVscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    provideCodeLenses: async document => await provideMetaFileCodeLenses(runtimeVscode, document)
  }));

  return runtimeVscode.Disposable.from(...disposables);
}

export async function hideMetaFilesInExplorerIfEnabled(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger
): Promise<void> {
  const enabled = runtimeVscode.workspace.getConfiguration('unityPlus').get('metaFiles.hideInExplorer') === true;

  if (enabled) {
    await ensureMetaFilesHiddenInExplorer(runtimeVscode, logger);
  }
}

export async function ensureMetaFilesHiddenInExplorer(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger
): Promise<void> {
  try {
    const configuration = runtimeVscode.workspace.getConfiguration('files');
    const currentExclude = configuration.get<Record<string, boolean>>('exclude') ?? {};

    if (currentExclude[metaFilesExcludePattern] === true) {
      return;
    }

    // Preserve existing Explorer exclusions while adding the Unity sidecar pattern.
    await configuration.update('exclude', {
      ...currentExclude,
      [metaFilesExcludePattern]: true
    }, runtimeVscode.ConfigurationTarget.Workspace);
  } catch (error) {
    logger.warn(`Could not hide Unity meta files in Explorer: ${errorMessage(error)}`);
  }
}

export async function provideMetaFileCodeLenses(
  runtimeVscode: typeof vscode,
  document: Pick<vscode.TextDocument, 'uri' | 'lineCount'>
): Promise<vscode.CodeLens[]> {
  if (document.uri.scheme !== 'file' || document.uri.fsPath.endsWith('.meta')) {
    return [];
  }

  // Unity stores metadata as a sidecar file named after the asset path plus ".meta".
  const metaUri = runtimeVscode.Uri.file(`${document.uri.fsPath}.meta`);
  const content = await readOptionalTextFile(runtimeVscode, metaUri);

  if (content === undefined) {
    return [];
  }

  return [
    new runtimeVscode.CodeLens(new runtimeVscode.Range(0, 0, 0, 0), {
      title: `${formatMetaFileSummary(content)} - Open Meta`,
      command: 'unityPlus.openMetaFile',
      arguments: [metaUri]
    })
  ];
}

export function formatMetaFileSummary(content: string): string {
  const summary = parseMetaFileSummary(content);
  const parts = ['Meta'];

  if (summary.guid) {
    parts.push(`guid ${shortenGuid(summary.guid)}`);
  }

  if (summary.importer) {
    parts.push(summary.importer);
  }

  return parts.join(' | ');
}

function parseMetaFileSummary(content: string): MetaFileSummary {
  return {
    guid: /^guid:\s*([a-fA-F0-9]{32})\s*$/m.exec(content)?.[1],
    importer: /^([A-Za-z][A-Za-z0-9_]*Importer):\s*$/m.exec(content)?.[1]
  };
}

function shortenGuid(guid: string): string {
  return guid.slice(0, 8);
}

async function openMetaFileForResource(runtimeVscode: typeof vscode, resourceUri: vscode.Uri | undefined): Promise<void> {
  const sourceUri = resourceUri ?? getActiveResourceUri(runtimeVscode);
  if (!sourceUri) {
    runtimeVscode.window.showWarningMessage('Unity Plus: No active file found for Unity meta file.');
    return;
  }

  const metaUri = toMetaFileUri(runtimeVscode, sourceUri);
  if (!await fileExists(runtimeVscode, metaUri)) {
    runtimeVscode.window.showWarningMessage(`Unity Plus: Meta file not found for ${sourceUri.fsPath}`);
    return;
  }

  const document = await runtimeVscode.workspace.openTextDocument(metaUri);
  await runtimeVscode.window.showTextDocument(document, { preview: false });
}

function getActiveResourceUri(runtimeVscode: typeof vscode): vscode.Uri | undefined {
  const editorUri = runtimeVscode.window.activeTextEditor?.document.uri;
  if (editorUri) {
    return editorUri;
  }

  const tabInput = runtimeVscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return getTabInputUri(tabInput);
}

function getTabInputUri(tabInput: unknown): vscode.Uri | undefined {
  if (!tabInput || typeof tabInput !== 'object') {
    return undefined;
  }

  const uri = (tabInput as { uri?: unknown }).uri;
  if (isUriLike(uri)) {
    return uri;
  }

  return undefined;
}

function toMetaFileUri(runtimeVscode: typeof vscode, resourceUri: vscode.Uri): vscode.Uri {
  if (resourceUri.fsPath.endsWith('.meta')) {
    return resourceUri;
  }

  return runtimeVscode.Uri.file(`${resourceUri.fsPath}.meta`);
}

async function fileExists(runtimeVscode: typeof vscode, uri: vscode.Uri): Promise<boolean> {
  try {
    await runtimeVscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalTextFile(runtimeVscode: typeof vscode, uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await runtimeVscode.workspace.fs.readFile(uri);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}

function isUriLike(value: unknown): value is vscode.Uri {
  return Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { fsPath?: unknown }).fsPath === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
