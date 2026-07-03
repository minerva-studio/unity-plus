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

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.openMetaFile', async (metaUri: vscode.Uri) => {
    await openMetaFile(runtimeVscode, metaUri);
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

async function openMetaFile(runtimeVscode: typeof vscode, metaUri: vscode.Uri): Promise<void> {
  const document = await runtimeVscode.workspace.openTextDocument(metaUri);
  await runtimeVscode.window.showTextDocument(document, { preview: false });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
