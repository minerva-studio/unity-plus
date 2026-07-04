import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
  assetsCsharpGlob,
  createMonoImporterMeta,
  defaultScriptTemplate,
  handleCreatedCSharpFile,
  handleRenamedCSharpFiles,
  packagesCsharpGlob,
  registerProjectSyncFeature,
  removeScriptFromProjects,
  renderTemplate,
  shouldRegisterProjectSyncWatcher
} from '../features/project-sync/projectSync';
import { createLogger, UnityPlusLogOutput } from '../unity/logger';

describe('projectSync', () => {
  it('does not register C# watchers when auto refresh is disabled', () => {
    const runtime = createProjectSyncRuntime();

    registerProjectSyncFeature(createTestLogger(), {
      root: createUri('/Project'),
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => false
    });

    assert.strictEqual(runtime.watcherPatterns.length, 0);
    assert.strictEqual(runtime.renameFileListeners, 0);
  });

  it('registers Assets and Packages C# watchers when auto refresh is enabled', () => {
    const runtime = createProjectSyncRuntime();
    const root = createUri('/Project');

    registerProjectSyncFeature(createTestLogger(), {
      root,
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => true
    });

    assert.deepStrictEqual(runtime.watcherPatterns.map(pattern => pattern.pattern), [
      assetsCsharpGlob,
      packagesCsharpGlob
    ]);
    assert.strictEqual(runtime.watcherPatterns[0].baseUri, root);
    assert.strictEqual(runtime.createListeners, 2);
    assert.strictEqual(runtime.deleteListeners, 2);
    assert.strictEqual(runtime.changeListeners, 0);
    assert.strictEqual(runtime.renameFileListeners, 1);
  });

  it('requires both a Unity root and enabled auto refresh before watching scripts', () => {
    assert.strictEqual(shouldRegisterProjectSyncWatcher(undefined, true), false);
    assert.strictEqual(shouldRegisterProjectSyncWatcher(createUri('/Project'), false), false);
    assert.strictEqual(shouldRegisterProjectSyncWatcher(createUri('/Project'), true), true);
  });

  it('adds created scripts to the nearest asmdef project and creates a meta file', async () => {
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game.Runtime"}',
        '/Project/Game.Runtime.csproj': createCsproj()
      }
    });

    await handleCreatedCSharpFile(runtime.featureRuntime, createUri('/Project/Assets/Game/Player.cs'));

    assert.match(runtime.readFile('/Project/Game.Runtime.csproj'), /<Compile Include="Assets\/Game\/Player.cs" \/>/);
    assert.match(runtime.readFile('/Project/Assets/Game/Player.cs.meta'), /^guid: [a-f0-9]{32}$/m);
  });

  it('adds Assets scripts without asmdef to Assembly-CSharp fallback', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assembly-CSharp.csproj': createCsproj()
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Loose.cs')
    );

    assert.match(runtime.readFile('/Project/Assembly-CSharp.csproj'), /<Compile Include="Assets\/Loose.cs" \/>/);
    assert.strictEqual(output.lines.some(line => line.includes('hasEditorFolder=false')), true);
  });

  it('adds Assets scripts under Editor folders to Assembly-CSharp-Editor fallback', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assembly-CSharp.csproj': createCsproj(),
        '/Project/Assembly-CSharp-Editor.csproj': createCsproj()
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Tools/Editor/MenuTool.cs')
    );

    assert.strictEqual(runtime.readFile('/Project/Assembly-CSharp.csproj'), createCsproj());
    assert.match(runtime.readFile('/Project/Assembly-CSharp-Editor.csproj'), /<Compile Include="Assets\/Tools\/Editor\/MenuTool.cs" \/>/);
    assert.strictEqual(output.lines.some(line => line.includes('hasEditorFolder=true')), true);
  });

  it('warns and skips Assets scripts without asmdef when Assembly-CSharp fallback is missing', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime();

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Loose.cs')
    );

    assert.strictEqual(runtime.warningMessages.some(message => message.includes('Assembly-CSharp.csproj was not found')), true);
    assert.strictEqual(output.lines.some(line => line.includes('Assembly-CSharp.csproj was not found')), true);
  });

  it('warns and skips Editor scripts without asmdef when Assembly-CSharp-Editor fallback is missing', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assembly-CSharp.csproj': createCsproj()
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Editor/MenuTool.cs')
    );

    assert.strictEqual(runtime.readFile('/Project/Assembly-CSharp.csproj'), createCsproj());
    assert.strictEqual(runtime.warningMessages.some(message => message.includes('Assembly-CSharp-Editor.csproj was not found')), true);
    assert.strictEqual(output.lines.some(line => line.includes('Assembly-CSharp-Editor.csproj was not found')), true);
  });

  it('does not search past a package boundary when no asmdef exists', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Packages/Parent.asmdef': '{"name":"Parent"}',
        '/Project/Parent.csproj': createCsproj()
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Packages/com.game/Scripts/Tool.cs')
    );

    assert.strictEqual(runtime.readFile('/Project/Parent.csproj'), createCsproj());
    assert.strictEqual(output.lines.some(line => line.includes('no asmdef was found before leaving Packages/com.game')), true);
  });

  it('renames script compile includes across root projects', async () => {
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Game.csproj': createCsproj('Assets/Game/OldName.cs')
      }
    });

    await handleRenamedCSharpFiles(runtime.featureRuntime, [{
      oldUri: createUri('/Project/Assets/Game/OldName.cs'),
      newUri: createUri('/Project/Assets/Game/NewName.cs')
    }]);

    const csproj = runtime.readFile('/Project/Game.csproj');
    assert.doesNotMatch(csproj, /OldName/);
    assert.match(csproj, /Assets\/Game\/NewName.cs/);
  });

  it('removes deleted script compile includes across root projects', async () => {
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Game.csproj': createCsproj('Assets/Game/Deleted.cs')
      }
    });

    await removeScriptFromProjects(runtime.featureRuntime, createUri('/Project/Assets/Game/Deleted.cs'));

    assert.doesNotMatch(runtime.readFile('/Project/Game.csproj'), /Deleted.cs/);
  });

  it('does not duplicate compile includes for repeated create events', async () => {
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game"}',
        '/Project/Game.csproj': createCsproj('Assets/Game/Player.cs'),
        '/Project/Assets/Game/Player.cs.meta': createMonoImporterMeta('a'.repeat(32))
      }
    });

    await handleCreatedCSharpFile(runtime.featureRuntime, createUri('/Project/Assets/Game/Player.cs'));

    const matches = runtime.readFile('/Project/Game.csproj').match(/Player\.cs/g) ?? [];
    assert.strictEqual(matches.length, 1);
  });

  it('logs and skips when the asmdef csproj is missing', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Missing.Project"}'
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Game/Player.cs')
    );

    assert.strictEqual(output.lines.some(line => line.includes('Missing.Project.csproj')), true);
  });

  it('logs and skips malformed csproj files without throwing', async () => {
    const output = createMemoryOutput();
    const runtime = createProjectSyncRuntime({
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game"}',
        '/Project/Game.csproj': '<Project></Project>'
      }
    });

    await handleCreatedCSharpFile(
      { ...runtime.featureRuntime, logger: createTestLogger(output) },
      createUri('/Project/Assets/Game/Player.cs')
    );

    assert.strictEqual(output.lines.some(line => line.includes('No ItemGroup was found')), true);
  });

  it('creates MonoBehaviour scripts from the default command template', async () => {
    const runtime = createProjectSyncRuntime({
      inputBoxValue: 'Player',
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game"}',
        '/Project/Game.csproj': createCsproj()
      }
    });
    registerProjectSyncFeature(createTestLogger(), {
      root: createUri('/Project'),
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => false
    });

    await runtime.runCommand('unityPlus.createCSharpScript', createUri('/Project/Assets/Game'));

    assert.match(runtime.readFile('/Project/Assets/Game/Player.cs'), /public class Player : MonoBehaviour/);
    assert.match(runtime.readFile('/Project/Assets/Game/Player.cs.meta'), /MonoImporter:/);
    assert.match(runtime.readFile('/Project/Game.csproj'), /Assets\/Game\/Player.cs/);
  });

  it('creates ScriptableObject scripts from the default command template', async () => {
    const runtime = createProjectSyncRuntime({
      inputBoxValue: 'InventoryItem',
      files: {
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game"}',
        '/Project/Game.csproj': createCsproj()
      }
    });
    registerProjectSyncFeature(createTestLogger(), {
      root: createUri('/Project'),
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => false
    });

    await runtime.runCommand('unityPlus.createScriptableObject', createUri('/Project/Assets/Game'));

    assert.match(runtime.readFile('/Project/Assets/Game/InventoryItem.cs'), /public class InventoryItem : ScriptableObject/);
    assert.match(runtime.readFile('/Project/Assets/Game/InventoryItem.cs'), /\[CreateAssetMenu\]/);
  });

  it('prefers project template files over configured template text', async () => {
    const runtime = createProjectSyncRuntime({
      inputBoxValue: 'Player',
      configuration: {
        'templates.csharpScriptFile': 'Templates/CSharp.txt',
        'templates.csharpScript': 'public class WrongName {}'
      },
      files: {
        '/Project/Templates/CSharp.txt': 'public class ${className}FromFile {}',
        '/Project/Assets/Game/Game.asmdef': '{"name":"Game"}',
        '/Project/Game.csproj': createCsproj()
      }
    });
    registerProjectSyncFeature(createTestLogger(), {
      root: createUri('/Project'),
      runtimeVscode: runtime.runtime,
      isAutoRefreshEnabled: () => false
    });

    await runtime.runCommand('unityPlus.createCSharpScript', createUri('/Project/Assets/Game'));

    assert.strictEqual(runtime.readFile('/Project/Assets/Game/Player.cs'), 'public class PlayerFromFile {}');
  });

  it('renders supported template tokens', () => {
    assert.strictEqual(
      renderTemplate('${namespaceBlock}public class ${className} {}', {
        className: 'Gate',
        namespaceBlock: 'namespace Game;\n\n'
      }),
      'namespace Game;\n\npublic class Gate {}'
    );
  });

  it('creates standard MonoImporter meta content with the provided guid', () => {
    const content = createMonoImporterMeta('0123456789abcdef0123456789abcdef');

    assert.match(content, /^fileFormatVersion: 2$/m);
    assert.match(content, /^guid: 0123456789abcdef0123456789abcdef$/m);
    assert.match(content, /^MonoImporter:$/m);
  });

  it('keeps default templates tokenized for command rendering', () => {
    assert.match(defaultScriptTemplate('csharpScript'), /\$\{className\}/);
    assert.match(defaultScriptTemplate('scriptableObject'), /ScriptableObject/);
  });
});

interface ProjectSyncRuntime {
  runtime: typeof vscode;
  featureRuntime: Parameters<typeof handleCreatedCSharpFile>[0];
  watcherPatterns: FakeRelativePattern[];
  createListeners: number;
  deleteListeners: number;
  changeListeners: number;
  renameFileListeners: number;
  warningMessages: string[];
  readFile(path: string): string;
  runCommand(command: string, ...args: unknown[]): Promise<unknown>;
}

interface ProjectSyncRuntimeOptions {
  files?: Record<string, string>;
  configuration?: Record<string, string | boolean>;
  inputBoxValue?: string;
}

class FakeRelativePattern {
  public constructor(
    public readonly baseUri: vscode.Uri,
    public readonly pattern: string
  ) {}
}

function createProjectSyncRuntime(options: ProjectSyncRuntimeOptions = {}): ProjectSyncRuntime {
  const files = new Map<string, string>();
  Object.entries(options.files ?? {}).forEach(([path, content]) => files.set(normalizePath(path), content));
  const commands = new Map<string, (...args: unknown[]) => unknown>();
  const state = {
    watcherPatterns: [] as FakeRelativePattern[],
    createListeners: 0,
    deleteListeners: 0,
    changeListeners: 0,
    renameFileListeners: 0,
    warningMessages: [] as string[]
  };
  const fileType = {
    File: 1,
    Directory: 2
  };
  const watcher = {
    onDidCreate: () => {
      state.createListeners += 1;
      return createDisposable();
    },
    onDidDelete: () => {
      state.deleteListeners += 1;
      return createDisposable();
    },
    onDidChange: () => {
      state.changeListeners += 1;
      return createDisposable();
    },
    dispose: () => undefined
  };
  const runtime = {
    commands: {
      registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => {
        commands.set(command, callback);
        return createDisposable();
      }
    },
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string, fallback?: T) => (options.configuration?.[key] ?? fallback) as T
      }),
      createFileSystemWatcher: (pattern: FakeRelativePattern) => {
        state.watcherPatterns.push(pattern);
        return watcher;
      },
      onDidRenameFiles: () => {
        state.renameFileListeners += 1;
        return createDisposable();
      },
      fs: {
        readFile: async (uri: vscode.Uri) => {
          const content = files.get(normalizePath(uri.fsPath));
          if (content === undefined) {
            throw new Error(`Missing file: ${uri.fsPath}`);
          }
          return Buffer.from(content, 'utf8');
        },
        writeFile: async (uri: vscode.Uri, bytes: Uint8Array) => {
          files.set(normalizePath(uri.fsPath), Buffer.from(bytes).toString('utf8'));
        },
        readDirectory: async (uri: vscode.Uri) => readDirectory(files, uri.fsPath, fileType),
        stat: async (uri: vscode.Uri) => {
          const path = normalizePath(uri.fsPath);
          if (files.has(path)) {
            return { type: fileType.File };
          }

          if (hasDirectory(files, path)) {
            return { type: fileType.Directory };
          }

          throw new Error(`Missing path: ${uri.fsPath}`);
        }
      }
    },
    window: {
      activeTextEditor: undefined,
      showInputBox: async () => options.inputBoxValue,
      showInformationMessage: () => undefined,
      showWarningMessage: (message: string) => {
        state.warningMessages.push(message);
        return undefined;
      },
      showTextDocument: async () => undefined
    },
    Disposable: {
      from: (..._disposables: vscode.Disposable[]) => createDisposable()
    },
    RelativePattern: FakeRelativePattern,
    FileType: fileType,
    Uri: {
      file: createUri
    },
    l10n: {
      t: localize
    }
  } as unknown as typeof vscode;

  return {
    runtime,
    featureRuntime: {
      root: createUri('/Project'),
      runtimeVscode: runtime,
      logger: createTestLogger()
    },
    get watcherPatterns() {
      return state.watcherPatterns;
    },
    get createListeners() {
      return state.createListeners;
    },
    get deleteListeners() {
      return state.deleteListeners;
    },
    get changeListeners() {
      return state.changeListeners;
    },
    get renameFileListeners() {
      return state.renameFileListeners;
    },
    get warningMessages() {
      return state.warningMessages;
    },
    readFile(path: string): string {
      const content = files.get(normalizePath(path));
      if (content === undefined) {
        throw new Error(`Missing file: ${path}`);
      }
      return content;
    },
    async runCommand(command: string, ...args: unknown[]): Promise<unknown> {
      const callback = commands.get(command);
      if (!callback) {
        throw new Error(`Command was not registered: ${command}`);
      }

      return await callback(...args);
    }
  };
}

function readDirectory(
  files: ReadonlyMap<string, string>,
  rawPath: string,
  fileType: { File: number; Directory: number }
): [string, vscode.FileType][] {
  const path = normalizePath(rawPath);
  const prefix = `${path}/`;
  const names = new Map<string, vscode.FileType>();

  for (const filePath of files.keys()) {
    if (!filePath.startsWith(prefix)) {
      continue;
    }

    const rest = filePath.slice(prefix.length);
    const [name, ...children] = rest.split('/');
    names.set(name, (children.length === 0 ? fileType.File : fileType.Directory) as vscode.FileType);
  }

  return [...names.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function hasDirectory(files: ReadonlyMap<string, string>, rawPath: string): boolean {
  const path = normalizePath(rawPath);
  return [...files.keys()].some(filePath => filePath.startsWith(`${path}/`));
}

interface MemoryLogOutput extends UnityPlusLogOutput {
  lines: string[];
}

function createMemoryOutput(): MemoryLogOutput {
  return {
    lines: [],
    appendLine(message: string): void {
      this.lines.push(message);
    },
    dispose(): void {
      this.lines = [];
    }
  };
}

function createTestLogger(output: MemoryLogOutput = createMemoryOutput()) {
  return createLogger({
    output,
    getLevel: () => 'debug'
  });
}

function createCsproj(include?: string): string {
  const compileLine = include ? `    <Compile Include="${include}" />\n` : '';
  return `<Project>\n  <ItemGroup>\n${compileLine}  </ItemGroup>\n</Project>\n`;
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

function localize(message: string, args?: Record<string, string | number | boolean>): string {
  return Object.entries(args ?? {}).reduce((current, [key, value]) =>
    current.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value)), message
  );
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}
