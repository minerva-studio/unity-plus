import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';
import { sendUnityIdeShowUsage } from '../../unity/visualStudioMessaging';

export const metaFilesExcludePattern = '**/*.meta';

export interface MetaFilesFeatureOptions {
  root?: vscode.Uri;
  runtimeVscode?: typeof vscode;
  sendOpenInUnity?: OpenInUnitySender;
}

interface MetaFileSummary {
  guid?: string;
  importer?: string;
}

export type OpenInUnitySender = (projectRoot: string, assetPath: string) => Promise<boolean>;

export function registerMetaFilesFeature(
  logger: UnityPlusLogger,
  options: MetaFilesFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const sendOpenInUnity = options.sendOpenInUnity ?? sendUnityIdeShowUsage;
  const disposables: vscode.Disposable[] = [];

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.openMetaFile', async (resourceUri?: vscode.Uri) => {
    await openMetaFileForResource(runtimeVscode, resourceUri);
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.openInUnity', async (resourceUri?: vscode.Uri) => {
    await openResourceInUnity(runtimeVscode, options.root, resourceUri, sendOpenInUnity);
  }));

  disposables.push(runtimeVscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
    provideCodeLenses: async document => await provideMetaFileCodeLenses(runtimeVscode, document, options.root)
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
  document: Pick<vscode.TextDocument, 'uri' | 'lineCount'>,
  root?: vscode.Uri
): Promise<vscode.CodeLens[]> {
  if (document.uri.scheme !== 'file' || document.uri.fsPath.endsWith('.meta')) {
    return [];
  }

  const range = new runtimeVscode.Range(0, 0, 0, 0);
  const codeLenses: vscode.CodeLens[] = [];
  // Unity stores metadata as a sidecar file named after the asset path plus ".meta".
  const metaUri = runtimeVscode.Uri.file(`${document.uri.fsPath}.meta`);
  const content = await readOptionalTextFile(runtimeVscode, metaUri);

  if (content !== undefined) {
    codeLenses.push(new runtimeVscode.CodeLens(range, {
      title: formatMetaFileTitle(content),
      command: 'unityPlus.openMetaFile',
      arguments: [metaUri]
    }));
  }

  if (root && toUnityAssetPath(root, document.uri)) {
    codeLenses.push(new runtimeVscode.CodeLens(range, {
      title: 'Open In Unity',
      command: 'unityPlus.openInUnity',
      arguments: [document.uri]
    }));
  }

  return codeLenses;
}

export function formatMetaFileTitle(content: string): string {
  const summary = formatMetaFileSummary(content);
  return summary ? `Meta: ${summary}` : 'Meta file';
}

export function formatMetaFileSummary(content: string): string {
  const summary = parseMetaFileSummary(content);
  const parts: string[] = [];

  if (summary.guid) {
    parts.push(`guid ${shortenGuid(summary.guid)}`);
  }

  if (summary.importer) {
    parts.push(summary.importer);
  }

  return parts.length > 0 ? parts.join(', ') : 'Meta';
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

async function openResourceInUnity(
  runtimeVscode: typeof vscode,
  root: vscode.Uri | undefined,
  resourceUri: vscode.Uri | undefined,
  sendOpenInUnity: OpenInUnitySender
): Promise<void> {
  if (!root) {
    runtimeVscode.window.showWarningMessage('Unity Plus: Open a Unity project to use Open In Unity.');
    return;
  }

  const sourceUri = resourceUri ?? getActiveResourceUri(runtimeVscode);
  if (!sourceUri) {
    runtimeVscode.window.showWarningMessage('Unity Plus: No active file found for Open In Unity.');
    return;
  }

  const assetPath = toUnityAssetPath(root, sourceUri);
  if (!assetPath) {
    runtimeVscode.window.showWarningMessage('Unity Plus: Open In Unity only supports Assets folder resources.');
    return;
  }

  const opened = await sendOpenInUnity(root.fsPath, assetPath);
  if (!opened) {
    runtimeVscode.window.showWarningMessage('Unity Plus: Unity IDE messaging endpoint was not found. Open Unity and enable the Visual Studio Editor package.');
  }
}

export function toUnityAssetPath(root: vscode.Uri, resourceUri: vscode.Uri): string | undefined {
  const rootPath = normalizePath(root.fsPath);
  const resourcePath = stripMetaExtension(normalizePath(resourceUri.fsPath));
  const rootPrefix = `${rootPath}/`;

  if (!resourcePath.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
    return undefined;
  }

  const relativePath = resourcePath.slice(rootPrefix.length);
  return relativePath.toLowerCase().startsWith('assets/') ? relativePath : undefined;
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

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function stripMetaExtension(path: string): string {
  return path.endsWith('.meta') ? path.slice(0, -'.meta'.length) : path;
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
