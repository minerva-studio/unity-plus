import * as assert from 'assert';
import type * as vscode from 'vscode';
import { activateUnityPlus, UnityPlusActivationContext } from '../activation';
import { EventReferenceFeatureOptions } from '../features/event-references/eventReferences';
import { ProjectSyncFeatureOptions } from '../features/project-sync/projectSync';
import { RenameFeatureOptions } from '../features/rename/renameSync';
import { UnityPlusLogger } from '../unity/logger';
import { LazyUnityMetadataIndex, UnityMetadataIndex } from '../unity/metadataIndex';

describe('activation', () => {
  it('does not rebuild the metadata index during activation', async () => {
    const root = createUri('/Project');
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    let lazyIndexCreated = 0;
    let rebuilds = 0;
    let getOrBuilds = 0;

    await activateUnityPlus(createContext(), {
      workspaceFolders: [],
      registerCommand: (command, callback) => {
        commands.set(command, callback);
        return createDisposable();
      }
    }, {
      logger: createTestLogger(),
      detectUnityWorkspace: async () => ({
        isUnityProject: true,
        root
      }),
      createLazyMetadataIndex: options => {
        lazyIndexCreated += 1;
        assert.strictEqual(options.root, root);
        return createLazyIndex(root, {
          getOrBuild: async () => {
            getOrBuilds += 1;
            return createMetadataIndex();
          },
          rebuild: async () => {
            rebuilds += 1;
            return createMetadataIndex();
          }
        });
      },
      registerRenameFeature: () => createDisposable(),
      registerProjectSyncFeature: () => createDisposable(),
      registerEventReferenceFeature: () => createDisposable(),
      registerMetaFilesFeature: () => createDisposable(),
      hideMetaFilesInExplorerIfEnabled: async () => undefined,
      checkUnityVisualStudioEditorPackage: async () => true
    });

    assert.strictEqual(lazyIndexCreated, 1);
    assert.strictEqual(getOrBuilds, 0);
    assert.strictEqual(rebuilds, 0);
    assert.strictEqual(commands.has('unityPlus.rescanUnityProject'), true);
  });

  it('passes no Unity root or metadata index to background features outside Unity workspaces', async () => {
    let lazyIndexCreated = 0;
    let renameOptions: RenameFeatureOptions | undefined;
    let projectSyncOptions: ProjectSyncFeatureOptions | undefined;
    let eventReferenceOptions: EventReferenceFeatureOptions | undefined;
    let metaFilesRegistered = 0;
    let hideMetaFilesCalls = 0;
    let packageChecks = 0;

    await activateUnityPlus(createContext(), {
      workspaceFolders: [],
      registerCommand: () => createDisposable()
    }, {
      logger: createTestLogger(),
      detectUnityWorkspace: async () => ({
        isUnityProject: false
      }),
      createLazyMetadataIndex: () => {
        lazyIndexCreated += 1;
        return createLazyIndex(createUri('/Unused'));
      },
      registerRenameFeature: (_logger: UnityPlusLogger, options?: RenameFeatureOptions) => {
        renameOptions = options;
        return createDisposable();
      },
      registerProjectSyncFeature: (_logger, options) => {
        projectSyncOptions = options;
        return createDisposable();
      },
      registerEventReferenceFeature: (_logger, options) => {
        eventReferenceOptions = options;
        return createDisposable();
      },
      registerMetaFilesFeature: () => {
        metaFilesRegistered += 1;
        return createDisposable();
      },
      hideMetaFilesInExplorerIfEnabled: async () => {
        hideMetaFilesCalls += 1;
      },
      checkUnityVisualStudioEditorPackage: async () => {
        packageChecks += 1;
        return true;
      }
    });

    assert.strictEqual(lazyIndexCreated, 0);
    assert.strictEqual(renameOptions?.isUnityWorkspace, false);
    assert.strictEqual(projectSyncOptions?.root, undefined);
    assert.strictEqual(eventReferenceOptions?.metadataIndex, undefined);
    assert.strictEqual(metaFilesRegistered, 1);
    assert.strictEqual(hideMetaFilesCalls, 0);
    assert.strictEqual(packageChecks, 0);
  });

  it('rebuilds the lazy metadata index only when the rescan command is executed', async () => {
    const root = createUri('/Project');
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    let rebuilds = 0;
    let eventReferenceOptions: EventReferenceFeatureOptions | undefined;

    await activateUnityPlus(createContext(), {
      workspaceFolders: [],
      registerCommand: (command, callback) => {
        commands.set(command, callback);
        return createDisposable();
      }
    }, {
      logger: createTestLogger(),
      detectUnityWorkspace: async () => ({
        isUnityProject: true,
        root
      }),
      createLazyMetadataIndex: () => createLazyIndex(root, {
        rebuild: async () => {
          rebuilds += 1;
          return createMetadataIndex();
        }
      }),
      registerRenameFeature: () => createDisposable(),
      registerProjectSyncFeature: () => createDisposable(),
      registerEventReferenceFeature: (_logger, options) => {
        eventReferenceOptions = options;
        return createDisposable();
      },
      registerMetaFilesFeature: () => createDisposable(),
      hideMetaFilesInExplorerIfEnabled: async () => undefined,
      checkUnityVisualStudioEditorPackage: async () => true
    });

    assert.strictEqual(rebuilds, 0);
    assert.strictEqual(eventReferenceOptions?.getCacheVersion?.(), 0);
    await Promise.resolve(commands.get('unityPlus.rescanUnityProject')?.());
    assert.strictEqual(rebuilds, 1);
    assert.strictEqual(eventReferenceOptions?.getCacheVersion?.(), 1);
  });

  it('hides meta files when a Unity workspace is detected and after a Unity rescan', async () => {
    const root = createUri('/Project');
    const commands = new Map<string, (...args: unknown[]) => unknown>();
    let hideMetaFilesCalls = 0;
    let packageChecks = 0;

    await activateUnityPlus(createContext(), {
      workspaceFolders: [],
      registerCommand: (command, callback) => {
        commands.set(command, callback);
        return createDisposable();
      }
    }, {
      logger: createTestLogger(),
      detectUnityWorkspace: async () => ({
        isUnityProject: true,
        root
      }),
      createLazyMetadataIndex: () => createLazyIndex(root),
      registerRenameFeature: () => createDisposable(),
      registerProjectSyncFeature: () => createDisposable(),
      registerEventReferenceFeature: () => createDisposable(),
      registerMetaFilesFeature: () => createDisposable(),
      hideMetaFilesInExplorerIfEnabled: async () => {
        hideMetaFilesCalls += 1;
      },
      checkUnityVisualStudioEditorPackage: async checkRoot => {
        assert.strictEqual(checkRoot, root);
        packageChecks += 1;
        return true;
      }
    });

    assert.strictEqual(hideMetaFilesCalls, 1);
    assert.strictEqual(packageChecks, 1);

    await Promise.resolve(commands.get('unityPlus.rescanUnityProject')?.());

    assert.strictEqual(hideMetaFilesCalls, 2);
    assert.strictEqual(packageChecks, 2);
  });
});

function createContext(): UnityPlusActivationContext {
  const subscriptions: vscode.Disposable[] = [];
  return {
    subscriptions: {
      push: (...disposables) => subscriptions.push(...disposables)
    }
  };
}

function createLazyIndex(
  root: vscode.Uri,
  overrides: Partial<Pick<LazyUnityMetadataIndex, 'getOrBuild' | 'rebuild' | 'isBuilt'>> = {}
): LazyUnityMetadataIndex {
  return {
    root,
    getOrBuild: overrides.getOrBuild ?? (async () => createMetadataIndex()),
    rebuild: overrides.rebuild ?? (async () => createMetadataIndex()),
    isBuilt: overrides.isBuilt ?? (() => false),
    dispose: () => undefined
  };
}

function createMetadataIndex(): UnityMetadataIndex {
  return {
    rebuild: async () => undefined,
    getAssetPath: () => undefined,
    getGuid: () => undefined,
    dispose: () => undefined
  };
}

function createTestLogger(): UnityPlusLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    dispose: () => undefined
  };
}

function createUri(fsPath: string): vscode.Uri {
  return {
    fsPath,
    path: fsPath
  } as vscode.Uri;
}

function createDisposable(): vscode.Disposable {
  return {
    dispose: () => undefined
  };
}
