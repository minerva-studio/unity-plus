import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, parse } from 'node:path';
import { createRequire } from 'node:module';
import type * as vscode from 'vscode';
import { UnityPlusLogger } from '../../unity/logger';

export const assetsCsharpGlob = 'Assets/**/*.cs';
export const packagesCsharpGlob = 'Packages/**/*.cs';

export type ScriptKind = 'csharpScript' | 'scriptableObject';

export interface ProjectSyncRuntime {
  root: vscode.Uri;
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
}

export interface ProjectSyncResult {
  changed: number;
  scanned: number;
}

interface CreateScriptRequest {
  kind: ScriptKind;
  targetUri?: vscode.Uri;
}

interface CSharpProjectTarget {
  csprojUri: vscode.Uri;
}

export type ProjectSyncChange =
  | { kind: 'create'; uri: vscode.Uri }
  | { kind: 'delete'; uri: vscode.Uri }
  | { kind: 'rename'; oldUri: vscode.Uri; newUri: vscode.Uri };

export interface ProjectSyncCoordinator extends vscode.Disposable {
  enqueue(change: ProjectSyncChange): void;
  flush(): Promise<void>;
  runExclusive<T>(action: () => Promise<T>): Promise<T>;
}

interface TemplateConfig {
  fileSetting: string;
  textSetting: string;
  defaultTemplate: string;
}

export interface TemplateContext {
  className: string;
  namespaceBlock: string;
}

export interface ProjectSyncFeatureOptions {
  root?: vscode.Uri;
  runtimeVscode?: typeof vscode;
  isAutoRefreshEnabled?: () => boolean;
}

const compileIncludePattern = /<Compile\s+Include=(["'])([^"']+)\1\s*\/>/g;
const csharpExtension = '.cs';
const metaExtension = '.meta';
const projectWriteRetryDelaysMilliseconds = [50, 100, 200, 400, 800] as const;

export function registerProjectSyncFeature(
  logger: UnityPlusLogger,
  options: ProjectSyncFeatureOptions = {}
): vscode.Disposable {
  const runtimeVscode = options.runtimeVscode ?? loadVscode();
  const isAutoRefreshEnabled = options.isAutoRefreshEnabled ?? (() =>
    runtimeVscode.workspace.getConfiguration('unityPlus').get('projectFiles.autoRefresh') === true
  );
  const root = options.root;
  const disposables: vscode.Disposable[] = [];
  const runtime = root ? { root, runtimeVscode, logger } : undefined;
  const coordinator = runtime ? createProjectSyncCoordinator(runtime, () => getProjectSyncDebounceMilliseconds(runtimeVscode)) : undefined;
  if (coordinator) {
    disposables.push(coordinator);
  }

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.refreshProjectFiles', async () => {
    if (!runtime || !coordinator) {
      runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: Open a Unity project before refreshing project files.'));
      return;
    }

    const result = await coordinator.runExclusive(async () => await syncExistingProjectFileReferences(runtime));
    const message = runtimeVscode.l10n.t('Unity Plus: scanned {scanned} C# project file(s), updated {changed}.', {
      scanned: result.scanned,
      changed: result.changed
    });
    logger.info(message);
    runtimeVscode.window.showInformationMessage(message);
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.createCSharpScript', async (targetUri?: vscode.Uri) => {
    if (runtime && coordinator) {
      await createUnityScript(runtime, coordinator, { kind: 'csharpScript', targetUri });
    } else {
      runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: Open a Unity project before creating a C# script.'));
    }
  }));

  disposables.push(runtimeVscode.commands.registerCommand('unityPlus.createScriptableObject', async (targetUri?: vscode.Uri) => {
    if (runtime && coordinator) {
      await createUnityScript(runtime, coordinator, { kind: 'scriptableObject', targetUri });
    } else {
      runtimeVscode.window.showWarningMessage(runtimeVscode.l10n.t('Unity Plus: Open a Unity project before creating a ScriptableObject.'));
    }
  }));

  if (runtime && coordinator && shouldRegisterProjectSyncWatcher(root, isAutoRefreshEnabled())) {
    const assetsWatcher = runtimeVscode.workspace.createFileSystemWatcher(
      new runtimeVscode.RelativePattern(root, assetsCsharpGlob)
    );
    const packagesWatcher = runtimeVscode.workspace.createFileSystemWatcher(
      new runtimeVscode.RelativePattern(root, packagesCsharpGlob)
    );
    disposables.push(assetsWatcher, packagesWatcher);

    const onCreate = (uri: vscode.Uri) => {
      if (isAutoRefreshEnabled()) {
        coordinator.enqueue({ kind: 'create', uri });
      }
    };
    const onDelete = (uri: vscode.Uri) => {
      if (isAutoRefreshEnabled()) {
        coordinator.enqueue({ kind: 'delete', uri });
      }
    };

    disposables.push(assetsWatcher.onDidCreate(onCreate));
    disposables.push(assetsWatcher.onDidDelete(onDelete));
    disposables.push(packagesWatcher.onDidCreate(onCreate));
    disposables.push(packagesWatcher.onDidDelete(onDelete));
    disposables.push(runtimeVscode.workspace.onDidRenameFiles(event => {
      if (!isAutoRefreshEnabled()) {
        return;
      }

      for (const file of event.files) {
        coordinator.enqueue({ kind: 'rename', oldUri: file.oldUri, newUri: file.newUri });
      }
    }));
  }

  return runtimeVscode.Disposable.from(...disposables);
}

export function shouldRegisterProjectSyncWatcher(
  root: vscode.Uri | undefined,
  autoRefreshEnabled: boolean
): root is vscode.Uri {
  return root !== undefined && autoRefreshEnabled;
}

/** Reads the trailing batch delay used for automatic project-file updates. */
function getProjectSyncDebounceMilliseconds(runtimeVscode: typeof vscode): number {
  return runtimeVscode.workspace.getConfiguration('unityPlus').get(
    'projectFiles.autoRefreshDebounceMilliseconds',
    1000
  );
}

/** Owns one serialized project-sync queue for the detected Unity workspace. */
export function createProjectSyncCoordinator(
  runtime: ProjectSyncRuntime,
  getDebounceMilliseconds: () => number
): ProjectSyncCoordinator {
  let pendingChanges: ProjectSyncChange[] = [];
  let scheduledFlush: ReturnType<typeof setTimeout> | undefined;
  let operationChain: Promise<void> = Promise.resolve();
  let disposed = false;

  function enqueue(change: ProjectSyncChange): void {
    if (disposed) {
      return;
    }

    pendingChanges.push(change);
    if (scheduledFlush) {
      clearTimeout(scheduledFlush);
    }

    scheduledFlush = setTimeout(() => {
      scheduledFlush = undefined;
      void queuePendingChanges();
    }, Math.max(0, getDebounceMilliseconds()));
  }

  function queuePendingChanges(): Promise<void> {
    if (pendingChanges.length === 0 || disposed) {
      return operationChain;
    }

    const changes = pendingChanges;
    pendingChanges = [];
    operationChain = operationChain
      .then(async () => {
        await applyProjectSyncChanges(runtime, changes);
      })
      .catch(error => {
        runtime.logger.warn(`Unity Plus project sync batch failed: ${errorMessage(error)}`);
      });
    return operationChain;
  }

  async function flush(): Promise<void> {
    if (scheduledFlush) {
      clearTimeout(scheduledFlush);
      scheduledFlush = undefined;
    }

    // Changes can arrive while the current batch is running, so drain until
    // both the active operation and the pending event buffer are empty.
    do {
      await queuePendingChanges();
      await operationChain;
    } while (!disposed && pendingChanges.length > 0);
  }

  return {
    enqueue,
    flush,
    async runExclusive<T>(action: () => Promise<T>): Promise<T> {
      await flush();
      const actionPromise = operationChain.then(action);
      operationChain = actionPromise.then(() => undefined, () => undefined);
      return await actionPromise;
    },
    dispose(): void {
      disposed = true;
      pendingChanges = [];
      if (scheduledFlush) {
        clearTimeout(scheduledFlush);
        scheduledFlush = undefined;
      }
    }
  };
}

/** Applies one ordered watcher batch while writing each affected project once. */
export async function applyProjectSyncChanges(
  runtime: ProjectSyncRuntime,
  changes: readonly ProjectSyncChange[]
): Promise<ProjectSyncResult> {
  const uniqueChanges = dedupeProjectSyncChanges(changes);
  const needsRootProjects = uniqueChanges.some(change => change.kind !== 'create');
  const rootProjects = needsRootProjects ? await findRootCsprojFiles(runtime) : [];
  const operationsByProject = new Map<string, {
    uri: vscode.Uri;
    updates: Array<(content: string) => string>;
  }>();

  function addProjectUpdate(uri: vscode.Uri, update: (content: string) => string): void {
    const key = normalizeFileKey(uri);
    const entry = operationsByProject.get(key) ?? { uri, updates: [] };
    entry.updates.push(update);
    operationsByProject.set(key, entry);
  }

  for (const change of uniqueChanges) {
    if (change.kind === 'create') {
      if (!isCSharpUri(change.uri)) {
        continue;
      }

      await ensureUnityMetaFile(runtime, change.uri);
      const projectPath = toProjectPath(runtime.root, change.uri);
      const target = projectPath ? await findCSharpProjectTarget(runtime, change.uri) : undefined;
      if (projectPath && target) {
        addProjectUpdate(target.csprojUri, content => addInclude(content, projectPath));
      }
      continue;
    }

    if (change.kind === 'delete') {
      const projectPath = toProjectPath(runtime.root, change.uri);
      if (projectPath) {
        for (const projectUri of rootProjects) {
          addProjectUpdate(projectUri, content => removeInclude(content, projectPath));
        }
      }
      continue;
    }

    const oldProjectPath = toProjectPath(runtime.root, change.oldUri);
    const newProjectPath = toProjectPath(runtime.root, change.newUri);
    const oldIsCSharp = isCSharpUri(change.oldUri);
    const newIsCSharp = isCSharpUri(change.newUri);
    if (newIsCSharp) {
      await ensureUnityMetaFile(runtime, change.newUri);
    }

    if (oldProjectPath && oldIsCSharp) {
      for (const projectUri of rootProjects) {
        addProjectUpdate(projectUri, content => removeInclude(content, oldProjectPath));
      }
    }

    if (newProjectPath && newIsCSharp) {
      const target = await findCSharpProjectTarget(runtime, change.newUri);
      if (target) {
        addProjectUpdate(target.csprojUri, content => addInclude(content, newProjectPath));
      }
    }
  }

  let changed = 0;
  for (const entry of operationsByProject.values()) {
    const updated = await updateCompileIncludes(runtime, entry.uri, content =>
      entry.updates.reduce((current, update) => update(current), content)
    );
    if (updated) {
      changed += 1;
      runtime.logger.info(`Updated ${basename(entry.uri.fsPath)} from ${entry.updates.length} batched C# file change(s).`);
    }
  }

  return { changed, scanned: operationsByProject.size };
}

/** Collapses duplicate and chained watcher notifications into their final intent. */
function dedupeProjectSyncChanges(changes: readonly ProjectSyncChange[]): ProjectSyncChange[] {
  const results: ProjectSyncChange[] = [];
  for (const change of changes) {
    const previous = results.at(-1);
    if (previous && projectSyncChangeKey(previous) === projectSyncChangeKey(change)) {
      continue;
    }

    if (previous?.kind === 'create' && change.kind === 'delete' && sameFile(previous.uri, change.uri)) {
      results.pop();
      continue;
    }

    if (previous?.kind === 'create' && change.kind === 'rename' && sameFile(previous.uri, change.oldUri)) {
      results[results.length - 1] = { kind: 'create', uri: change.newUri };
      continue;
    }

    if (previous?.kind === 'rename' && change.kind === 'rename' && sameFile(previous.newUri, change.oldUri)) {
      results[results.length - 1] = { kind: 'rename', oldUri: previous.oldUri, newUri: change.newUri };
      continue;
    }

    if (previous?.kind === 'rename' && change.kind === 'delete' && sameFile(previous.newUri, change.uri)) {
      results[results.length - 1] = { kind: 'delete', uri: previous.oldUri };
      continue;
    }

    results.push(change);
  }
  return results;
}

/** Builds a stable identity for duplicate watcher notification removal. */
function projectSyncChangeKey(change: ProjectSyncChange): string {
  return change.kind === 'rename'
    ? `rename:${normalizeFileKey(change.oldUri)}:${normalizeFileKey(change.newUri)}`
    : `${change.kind}:${normalizeFileKey(change.uri)}`;
}

/** Compares local file URIs using Windows-safe case-insensitive paths. */
function sameFile(left: vscode.Uri, right: vscode.Uri): boolean {
  return normalizeFileKey(left) === normalizeFileKey(right);
}

/** Creates a case-insensitive local file key for project batching. */
function normalizeFileKey(uri: vscode.Uri): string {
  return uri.fsPath.replace(/\\/g, '/').toLowerCase();
}

export async function handleCreatedCSharpFile(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<void> {
  if (!isCSharpUri(uri)) {
    return;
  }

  const projectPath = toProjectPath(runtime.root, uri);
  if (!projectPath || !isUnityScriptProjectPath(projectPath)) {
    runtime.logger.debug(`C# project sync skipped non-Unity script path: ${uri.fsPath}`);
    return;
  }

  await ensureUnityMetaFile(runtime, uri);
  await addScriptToAsmdefProject(runtime, uri);
}

export async function handleRenamedCSharpFiles(
  runtime: ProjectSyncRuntime,
  files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]
): Promise<void> {
  for (const file of files) {
    if (isCSharpUri(file.oldUri) && isCSharpUri(file.newUri)) {
      await renameScriptInProjects(runtime, file.oldUri, file.newUri);
      await ensureUnityMetaFile(runtime, file.newUri);
      continue;
    }

    if (isCSharpUri(file.oldUri)) {
      await removeScriptFromProjects(runtime, file.oldUri);
      continue;
    }

    if (isCSharpUri(file.newUri)) {
      await handleCreatedCSharpFile(runtime, file.newUri);
    }
  }
}

export async function addScriptToAsmdefProject(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<boolean> {
  const projectPath = toProjectPath(runtime.root, uri);
  if (!projectPath) {
    return false;
  }

  const target = await findCSharpProjectTarget(runtime, uri);
  if (!target) {
    return false;
  }

  const updated = await updateCompileIncludes(runtime, target.csprojUri, current => addInclude(current, projectPath));
  if (updated) {
    runtime.logger.info(`Added ${projectPath} to ${basename(target.csprojUri.fsPath)}.`);
  }

  return updated;
}

export async function renameScriptInProjects(
  runtime: ProjectSyncRuntime,
  oldUri: vscode.Uri,
  newUri: vscode.Uri
): Promise<ProjectSyncResult> {
  const oldProjectPath = toProjectPath(runtime.root, oldUri);
  const newProjectPath = toProjectPath(runtime.root, newUri);
  if (!oldProjectPath || !newProjectPath) {
    return { changed: 0, scanned: 0 };
  }

  return await updateRootProjects(runtime, current => renameInclude(current, oldProjectPath, newProjectPath));
}

export async function removeScriptFromProjects(
  runtime: ProjectSyncRuntime,
  uri: vscode.Uri
): Promise<ProjectSyncResult> {
  const projectPath = toProjectPath(runtime.root, uri);
  if (!projectPath) {
    return { changed: 0, scanned: 0 };
  }

  return await updateRootProjects(runtime, current => removeInclude(current, projectPath));
}

export async function ensureUnityMetaFile(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<boolean> {
  const metaUri = runtime.runtimeVscode.Uri.file(`${uri.fsPath}${metaExtension}`);
  if (await fileExists(runtime, metaUri)) {
    return false;
  }

  const content = createMonoImporterMeta(generateGuid());
  await writeTextFile(runtime, metaUri, content);
  runtime.logger.info(`Created Unity meta file for ${basename(uri.fsPath)}.`);
  return true;
}

export function createMonoImporterMeta(guid: string): string {
  return [
    'fileFormatVersion: 2',
    `guid: ${guid}`,
    'MonoImporter:',
    '  externalObjects: {}',
    '  serializedVersion: 2',
    '  defaultReferences: []',
    '  executionOrder: 0',
    '  icon: {instanceID: 0}',
    '  userData: ',
    '  assetBundleName: ',
    '  assetBundleVariant: ',
    ''
  ].join('\n');
}

export function renderTemplate(template: string, context: TemplateContext): string {
  return template
    .replace(/\$\{className\}/g, context.className)
    .replace(/\$\{namespaceBlock\}/g, context.namespaceBlock);
}

export function defaultScriptTemplate(kind: ScriptKind): string {
  if (kind === 'scriptableObject') {
    return [
      'using UnityEngine;',
      '',
      '[CreateAssetMenu]',
      '${namespaceBlock}public class ${className} : ScriptableObject',
      '{',
      '}',
      ''
    ].join('\n');
  }

  return [
    'using UnityEngine;',
    '',
    '${namespaceBlock}public class ${className} : MonoBehaviour',
    '{',
    '}',
    ''
  ].join('\n');
}

export function toProjectPath(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  const rootPath = normalizePath(root.fsPath);
  const filePath = normalizePath(uri.fsPath);
  if (filePath === rootPath) {
    return '';
  }

  if (!filePath.startsWith(`${rootPath}/`)) {
    return undefined;
  }

  return filePath.slice(rootPath.length + 1);
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function hasPathSegment(path: string, segment: string): boolean {
  const normalizedSegment = segment.toLowerCase();
  return path.replace(/\\/g, '/').split('/').some(part => part.toLowerCase() === normalizedSegment);
}

async function createUnityScript(
  runtime: ProjectSyncRuntime,
  coordinator: ProjectSyncCoordinator,
  request: CreateScriptRequest
): Promise<void> {
  const folderUri = await resolveCreateTargetFolder(runtime, request.targetUri);
  if (!folderUri) {
    return;
  }

  const rawName = await runtime.runtimeVscode.window.showInputBox({
    prompt: request.kind === 'scriptableObject'
      ? runtime.runtimeVscode.l10n.t('Create ScriptableObject script')
      : runtime.runtimeVscode.l10n.t('Create C# script'),
    placeHolder: request.kind === 'scriptableObject' ? 'NewScriptableObject' : 'NewBehaviour'
  });
  const className = sanitizeClassName(rawName ?? '');
  if (!className) {
    return;
  }

  const scriptUri = runtime.runtimeVscode.Uri.file(join(folderUri.fsPath, `${className}${csharpExtension}`));
  if (await fileExists(runtime, scriptUri)) {
    runtime.runtimeVscode.window.showWarningMessage(runtime.runtimeVscode.l10n.t('Unity Plus: {fileName} already exists.', {
      fileName: `${className}.cs`
    }));
    return;
  }

  const template = await resolveTemplate(runtime, request.kind);
  const source = renderTemplate(template, {
    className,
    namespaceBlock: ''
  });

  await writeTextFile(runtime, scriptUri, source);
  await ensureUnityMetaFile(runtime, scriptUri);
  coordinator.enqueue({ kind: 'create', uri: scriptUri });
  await runtime.runtimeVscode.window.showTextDocument(scriptUri);
}

async function resolveCreateTargetFolder(
  runtime: ProjectSyncRuntime,
  targetUri: vscode.Uri | undefined
): Promise<vscode.Uri | undefined> {
  if (!targetUri) {
    const activeUri = runtime.runtimeVscode.window.activeTextEditor?.document.uri;
    return activeUri ? runtime.runtimeVscode.Uri.file(dirname(activeUri.fsPath)) : runtime.root;
  }

  if (await isDirectory(runtime, targetUri)) {
    return targetUri;
  }

  return runtime.runtimeVscode.Uri.file(dirname(targetUri.fsPath));
}

async function resolveTemplate(runtime: ProjectSyncRuntime, kind: ScriptKind): Promise<string> {
  const config = templateConfig(kind);
  const workspaceConfig = runtime.runtimeVscode.workspace.getConfiguration('unityPlus');
  const templateFile = workspaceConfig.get<string>(config.fileSetting, '');

  if (templateFile.trim().length > 0) {
    const templateUri = resolveTemplateFileUri(runtime, templateFile);
    const templateText = await readOptionalTextFile(runtime, templateUri);
    if (templateText !== undefined) {
      return templateText;
    }

    runtime.logger.warn(`Unity Plus template file was not found or could not be read: ${templateFile}`);
  }

  const configuredTemplate = workspaceConfig.get<string>(config.textSetting, '');
  return configuredTemplate.trim().length > 0 ? configuredTemplate : config.defaultTemplate;
}

function resolveTemplateFileUri(runtime: ProjectSyncRuntime, templateFile: string): vscode.Uri {
  return runtime.runtimeVscode.Uri.file(isAbsolute(templateFile) ? templateFile : join(runtime.root.fsPath, templateFile));
}

function templateConfig(kind: ScriptKind): TemplateConfig {
  return kind === 'scriptableObject'
    ? {
        fileSetting: 'templates.scriptableObjectFile',
        textSetting: 'templates.scriptableObject',
        defaultTemplate: defaultScriptTemplate(kind)
      }
    : {
        fileSetting: 'templates.csharpScriptFile',
        textSetting: 'templates.csharpScript',
        defaultTemplate: defaultScriptTemplate(kind)
      };
}

async function syncExistingProjectFileReferences(runtime: ProjectSyncRuntime): Promise<ProjectSyncResult> {
  // Manual refresh is intentionally conservative: it removes stale missing script includes only.
  const projectUris = await findRootCsprojFiles(runtime);
  let changed = 0;

  for (const projectUri of projectUris) {
    if (await updateCompileIncludes(runtime, projectUri, current => removeMissingIncludes(runtime, current))) {
      changed += 1;
    }
  }

  return { changed, scanned: projectUris.length };
}

async function removeMissingIncludes(
  runtime: ProjectSyncRuntime,
  content: string
): Promise<string> {
  const matches = [...content.matchAll(compileIncludePattern)];
  let updated = content;

  for (const match of matches) {
    const include = match[2];
    if (!include.toLowerCase().endsWith(csharpExtension)) {
      continue;
    }

    const uri = runtime.runtimeVscode.Uri.file(join(runtime.root.fsPath, include));
    if (!await fileExists(runtime, uri)) {
      updated = removeInclude(updated, include);
    }
  }

  return updated;
}

async function findCSharpProjectTarget(
  runtime: ProjectSyncRuntime,
  scriptUri: vscode.Uri
): Promise<CSharpProjectTarget | undefined> {
  const projectPath = toProjectPath(runtime.root, scriptUri);
  if (!projectPath) {
    return undefined;
  }

  const boundary = findAsmdefSearchBoundary(projectPath);
  if (!boundary) {
    runtime.logger.debug(`C# project sync skipped path outside Assets or Packages: ${projectPath}`);
    return undefined;
  }

  const asmdefUri = await findNearestAsmdef(runtime, runtime.runtimeVscode.Uri.file(dirname(scriptUri.fsPath)), boundary);
  if (!asmdefUri) {
    if (boundary === 'Assets') {
      return await findDefaultAssemblyProjectTarget(runtime, projectPath);
    } else {
      runtime.logger.warn(`Unity Plus skipped ${projectPath}: no asmdef was found before leaving ${boundary}.`);
    }
    return undefined;
  }

  const asmdefName = await readAsmdefAssemblyName(runtime, asmdefUri);
  const csprojUri = runtime.runtimeVscode.Uri.file(join(runtime.root.fsPath, `${asmdefName}.csproj`));
  if (!await fileExists(runtime, csprojUri)) {
    runtime.logger.warn(`Unity Plus could not find ${asmdefName}.csproj for ${projectPath}.`);
    return undefined;
  }

  return { csprojUri };
}

async function findDefaultAssemblyProjectTarget(
  runtime: ProjectSyncRuntime,
  projectPath: string
): Promise<CSharpProjectTarget | undefined> {
  // Unity routes scripts inside Editor folders to the default editor assembly project.
  const hasEditorFolder = hasPathSegment(projectPath, 'Editor');
  const projectFileName = hasEditorFolder ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
  const csprojUri = runtime.runtimeVscode.Uri.file(join(runtime.root.fsPath, projectFileName));

  runtime.logger.debug(`Unity Plus using ${projectFileName} fallback for ${projectPath}; hasEditorFolder=${hasEditorFolder}.`);
  if (await fileExists(runtime, csprojUri)) {
    return { csprojUri };
  }

  const message = runtime.runtimeVscode.l10n.t(
    'Unity Plus: {projectFileName} was not found. This project may not contain code without assembly definitions; creating {scriptPath} may have targeted the wrong folder.',
    {
      projectFileName,
      scriptPath: projectPath
    }
  );
  runtime.logger.warn(message);
  runtime.runtimeVscode.window.showWarningMessage(message);
  return undefined;
}

function findAsmdefSearchBoundary(projectPath: string): string | undefined {
  const normalized = normalizeProjectPath(projectPath);
  if (normalized === 'assets' || normalized.startsWith('assets/')) {
    return 'Assets';
  }

  const parts = projectPath.replace(/\\/g, '/').split('/');
  if (parts.length >= 2 && parts[0] === 'Packages') {
    return `${parts[0]}/${parts[1]}`;
  }

  return undefined;
}

async function findNearestAsmdef(
  runtime: ProjectSyncRuntime,
  startFolder: vscode.Uri,
  boundary: string
): Promise<vscode.Uri | undefined> {
  let current = normalizePath(startFolder.fsPath);
  const boundaryPath = normalizePath(join(runtime.root.fsPath, boundary));

  while (current === boundaryPath || current.startsWith(`${boundaryPath}/`)) {
    const directoryUri = runtime.runtimeVscode.Uri.file(current);
    const entries = await readDirectorySafe(runtime, directoryUri);
    const asmdef = entries
      .map(([name]) => name)
      .filter(name => name.endsWith('.asmdef'))
      .sort()[0];
    if (asmdef) {
      return runtime.runtimeVscode.Uri.file(join(current, asmdef));
    }

    const next = normalizePath(dirname(current));
    if (next === current) {
      break;
    }
    current = next;
  }

  return undefined;
}

async function readAsmdefAssemblyName(runtime: ProjectSyncRuntime, asmdefUri: vscode.Uri): Promise<string> {
  const fallbackName = basename(asmdefUri.fsPath, '.asmdef');
  const content = await readOptionalTextFile(runtime, asmdefUri);
  if (!content) {
    return fallbackName;
  }

  try {
    const parsed = JSON.parse(content) as { name?: unknown };
    return typeof parsed.name === 'string' && parsed.name.trim().length > 0 ? parsed.name.trim() : fallbackName;
  } catch {
    runtime.logger.warn(`Unity Plus could not parse ${basename(asmdefUri.fsPath)}; using the file name for csproj lookup.`);
    return fallbackName;
  }
}

async function updateRootProjects(
  runtime: ProjectSyncRuntime,
  update: (content: string) => string | Promise<string>
): Promise<ProjectSyncResult> {
  const projectUris = await findRootCsprojFiles(runtime);
  let changed = 0;

  for (const projectUri of projectUris) {
    if (await updateCompileIncludes(runtime, projectUri, update)) {
      changed += 1;
    }
  }

  return { changed, scanned: projectUris.length };
}

async function findRootCsprojFiles(runtime: ProjectSyncRuntime): Promise<vscode.Uri[]> {
  const entries = await readDirectorySafe(runtime, runtime.root);
  return entries
    .map(([name, type]) => ({ name, type }))
    .filter(entry => entry.type === runtime.runtimeVscode.FileType.File && entry.name.endsWith('.csproj'))
    .map(entry => runtime.runtimeVscode.Uri.file(join(runtime.root.fsPath, entry.name)));
}

async function updateCompileIncludes(
  runtime: ProjectSyncRuntime,
  projectUri: vscode.Uri,
  update: (content: string) => string | Promise<string>
): Promise<boolean> {
  for (let attempt = 0; attempt <= projectWriteRetryDelaysMilliseconds.length; attempt += 1) {
    const content = await readOptionalTextFile(runtime, projectUri);
    if (content === undefined) {
      if (attempt < projectWriteRetryDelaysMilliseconds.length) {
        await waitForProjectWriteRetry(attempt);
        continue;
      }

      runtime.logger.warn(`Unity Plus could not read ${basename(projectUri.fsPath)} for project sync.`);
      return false;
    }

    try {
      const updated = await update(content);
      if (updated === content) {
        return false;
      }

      const latestContent = await readOptionalTextFile(runtime, projectUri);
      if (latestContent !== content) {
        // Unity regenerated the project after our read. Reapply the complete
        // transformation to its newer file instead of overwriting its state.
        continue;
      }

      // Preserve the existing project file identity. Replacing it through a
      // temporary-file rename makes C# Dev Kit observe a project deletion and
      // can invalidate downstream ProjectReference graphs or leave source files
      // attached to its miscellaneous project.
      await writeTextFile(runtime, projectUri, updated);
      const writtenContent = await readOptionalTextFile(runtime, projectUri);
      if (writtenContent === updated) {
        return true;
      }

      // Another writer changed the project immediately after our write.
      // Retry the transformation against the newest complete project content.
    } catch (error) {
      if (isRetryableProjectFileError(error) && attempt < projectWriteRetryDelaysMilliseconds.length) {
        await waitForProjectWriteRetry(attempt);
        continue;
      }

      runtime.logger.warn(`Unity Plus could not update ${basename(projectUri.fsPath)}: ${errorMessage(error)}`);
      return false;
    }
  }

  return false;
}

/** Waits between bounded retries so transient Windows sharing locks can clear. */
async function waitForProjectWriteRetry(attempt: number): Promise<void> {
  const delay = projectWriteRetryDelaysMilliseconds[Math.min(attempt, projectWriteRetryDelaysMilliseconds.length - 1)];
  await new Promise(resolve => setTimeout(resolve, delay));
}

/** Identifies transient Windows file sharing errors without hiding other failures. */
function isRetryableProjectFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return true;
  }

  const message = errorMessage(error).toLowerCase();
  return message.includes('used by another process') || message.includes('being used by another process');
}

function addInclude(content: string, projectPath: string): string {
  if (hasCompileInclude(content, projectPath)) {
    return content;
  }

  const newline = detectNewline(content);
  const include = toIncludePath(projectPath, content);
  const itemGroupPattern = /(\s*)<\/ItemGroup>/;
  const itemGroupMatch = itemGroupPattern.exec(content);
  if (!itemGroupMatch) {
    throw new Error('No ItemGroup was found for Compile Include insertion.');
  }

  const indent = `${itemGroupMatch[1]}  `;
  const line = `${indent}<Compile Include="${include}" />${newline}`;
  return `${content.slice(0, itemGroupMatch.index)}${line}${content.slice(itemGroupMatch.index)}`;
}

function renameInclude(content: string, oldProjectPath: string, newProjectPath: string): string {
  return content.replace(compileIncludePattern, (match, quote: string, include: string) => {
    if (normalizeProjectPath(include) !== normalizeProjectPath(oldProjectPath)) {
      return match;
    }

    return match.replace(`${quote}${include}${quote}`, `${quote}${toIncludePath(newProjectPath, content)}${quote}`);
  });
}

function removeInclude(content: string, projectPath: string): string {
  return content.replace(/^.*<Compile\s+Include=(["'])([^"']+)\1\s*\/>.*(?:\r?\n|$)/gm, (line, _quote: string, include: string) =>
    normalizeProjectPath(include) === normalizeProjectPath(projectPath) ? '' : line
  );
}

function hasCompileInclude(content: string, projectPath: string): boolean {
  return [...content.matchAll(compileIncludePattern)]
    .some(match => normalizeProjectPath(match[2]) === normalizeProjectPath(projectPath));
}

function toIncludePath(projectPath: string, content: string): string {
  const existing = [...content.matchAll(compileIncludePattern)].find(match => match[2].includes('\\'));
  return existing ? projectPath.replace(/\//g, '\\') : projectPath.replace(/\\/g, '/');
}

function detectNewline(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

async function readOptionalTextFile(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await runtime.runtimeVscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

async function writeTextFile(runtime: ProjectSyncRuntime, uri: vscode.Uri, content: string): Promise<void> {
  await runtime.runtimeVscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function readDirectorySafe(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
  try {
    return await runtime.runtimeVscode.workspace.fs.readDirectory(uri);
  } catch {
    return [];
  }
}

async function fileExists(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<boolean> {
  try {
    await runtime.runtimeVscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(runtime: ProjectSyncRuntime, uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await runtime.runtimeVscode.workspace.fs.stat(uri);
    return stat.type === runtime.runtimeVscode.FileType.Directory;
  } catch {
    return false;
  }
}

function isCSharpUri(uri: vscode.Uri): boolean {
  return extname(uri.fsPath) === csharpExtension;
}

function isUnityScriptProjectPath(projectPath: string): boolean {
  const normalized = normalizeProjectPath(projectPath);
  return normalized.startsWith('assets/') || /^packages\/[^/]+\//.test(normalized);
}

function sanitizeClassName(value: string): string | undefined {
  const parsedName = parse(value.trim()).name;
  const sanitized = parsedName.replace(/[^A-Za-z0-9_]/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(sanitized)) {
    return undefined;
  }

  return sanitized;
}

function generateGuid(): string {
  return randomBytes(16).toString('hex');
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadVscode(): typeof vscode {
  return createRequire(__filename)('vscode') as typeof vscode;
}
