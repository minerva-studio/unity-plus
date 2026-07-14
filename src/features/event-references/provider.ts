import type * as vscode from 'vscode';
import type { CSharpFieldSymbolSnapshot, CSharpMethodSymbolSnapshot } from '../../unity/csharpLanguageService';
import { isCSharpFile } from './assetDiscovery';
import { createCodeLensesFromIndex } from './codeLens';
import type { UnityEventReference, UnitySerializedAssetReferenceIndex } from './model';
import { createHoverMarkdown, showReferenceLocations } from './referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';
import { isEventReferenceAutoScanEnabled } from './settings';
import { errorMessage, isCancellationRequested, toProjectPath } from './utils';

const csharpRetryInitialDelayMilliseconds = 1000;
const csharpRetryMaximumDelayMilliseconds = 60000;
type CSharpCodeLensSymbolKind = 'methods' | 'fields';
interface VersionedCSharpSymbols<T> {
  documentVersion: number;
  symbols: readonly T[];
}

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & vscode.Disposable & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  const csharpRetryMemory = new Map<string, {
    documentVersion: number;
    delayMilliseconds: number;
    logCount: number;
    nextAllowedAt: number;
    refreshTimer?: ReturnType<typeof setTimeout>;
  }>();
  const lastMethodSymbolsByScriptPath = new Map<string, VersionedCSharpSymbols<CSharpMethodSymbolSnapshot>>();
  const lastFieldSymbolsByScriptPath = new Map<string, VersionedCSharpSymbols<CSharpFieldSymbolSnapshot>>();
  const csharpRefreshInFlight = new Set<string>();
  const documentEpochByScriptPath = new Map<string, number>();
  let disposed = false;

  /** Clears provider state whose symbol ranges belong to one closed document. */
  function clearDocumentState(scriptPath: string): void {
    lastMethodSymbolsByScriptPath.delete(scriptPath);
    lastFieldSymbolsByScriptPath.delete(scriptPath);
    documentEpochByScriptPath.set(scriptPath, (documentEpochByScriptPath.get(scriptPath) ?? 0) + 1);
    for (const kind of ['methods', 'fields'] as const) {
      resetCSharpRetry(scriptPath, kind);
    }
  }

  const closeDocumentDisposable = runtime.runtimeVscode.workspace.onDidCloseTextDocument?.(document => {
    if (isCSharpFile(document.uri)) {
      clearDocumentState(toProjectPath(runtime.metadataIndex.root, document.uri));
    }
  });

  /** Creates a retry key so one script or symbol kind cannot block another. */
  function csharpRetryKey(scriptPath: string, kind: CSharpCodeLensSymbolKind): string {
    return `${scriptPath.replace(/\\/g, '/').toLowerCase()}#${kind}`;
  }

  /** Reads the next retry delay for one script and symbol category. */
  function getCSharpRetryDelay(scriptPath: string, kind: CSharpCodeLensSymbolKind): number {
    return csharpRetryMemory.get(csharpRetryKey(scriptPath, kind))?.delayMilliseconds ?? csharpRetryInitialDelayMilliseconds;
  }

  /** Reads the retry log count for one script and symbol category. */
  function getCSharpRetryLogCount(scriptPath: string, kind: CSharpCodeLensSymbolKind): number {
    return csharpRetryMemory.get(csharpRetryKey(scriptPath, kind))?.logCount ?? 0;
  }

  /** Clears retry backoff state once one symbol category becomes available. */
  function resetCSharpRetry(scriptPath: string, kind: CSharpCodeLensSymbolKind): void {
    const key = csharpRetryKey(scriptPath, kind);
    const memory = csharpRetryMemory.get(key);
    if (memory?.refreshTimer) {
      clearTimeout(memory.refreshTimer);
    }

    csharpRetryMemory.delete(key);
  }

  /** Checks whether a previous provider failure should render cached placeholders. */
  function hasCSharpUnavailableState(scriptPath: string, kind: CSharpCodeLensSymbolKind, documentVersion?: number): boolean {
    const memory = csharpRetryMemory.get(csharpRetryKey(scriptPath, kind));
    return memory !== undefined && (documentVersion === undefined || memory.documentVersion === documentVersion);
  }

  /** Records C# provider unavailability without actively polling the C# server. */
  function recordCSharpCodeLensUnavailable(
    scriptPath: string,
    kind: CSharpCodeLensSymbolKind,
    documentVersion: number,
    error: unknown,
    canPlacePlaceholder: boolean
  ): void {
    const key = csharpRetryKey(scriptPath, kind);
    const previousLogCount = getCSharpRetryLogCount(scriptPath, kind);
    const logCount = previousLogCount + 1;
    const message = errorMessage(error);
    const expectedUnavailable = isExpectedCSharpUnavailableError(error);
    if (expectedUnavailable && previousLogCount > 0) {
      runtime.logger.info(`UnityEvent CodeLens C# ${kind} still unavailable for ${scriptPath}; placeholder=${canPlacePlaceholder}; occurrence=${logCount}; last=${message}`);
    } else if (expectedUnavailable) {
      runtime.logger.info(`UnityEvent CodeLens C# ${kind} unavailable for ${scriptPath}; placeholder=${canPlacePlaceholder}: ${message}`);
    } else {
      runtime.logger.error(`UnityEvent CodeLens C# ${kind} unexpected provider failure for ${scriptPath}; placeholder=${canPlacePlaceholder}; occurrence=${logCount}: ${message}`);
    }

    const delayMilliseconds = getCSharpRetryDelay(scriptPath, kind);
    const previousTimer = csharpRetryMemory.get(key)?.refreshTimer;
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    // The timer only asks VS Code to request CodeLens again; it does not call C# directly.
    const refreshTimer = setTimeout(() => controller.notifyCodeLensesChanged(), delayMilliseconds);
    csharpRetryMemory.set(key, {
      documentVersion,
      delayMilliseconds: Math.min(csharpRetryMaximumDelayMilliseconds, delayMilliseconds * 2),
      logCount,
      nextAllowedAt: Date.now() + delayMilliseconds,
      refreshTimer
    });
  }

  /** Clears C# retry state after provider-backed symbols become available. */
  function markCSharpCodeLensReady(scriptPath: string, kind: CSharpCodeLensSymbolKind): void {
    if (getCSharpRetryLogCount(scriptPath, kind) > 0) {
      runtime.logger.info(`UnityEvent CodeLens C# ${kind} are ready for ${scriptPath}; matching hints can render.`);
    }

    resetCSharpRetry(scriptPath, kind);
  }

  /** Stores the last successful symbols so unexpected failures can keep visible placeholders anchored. */
  function rememberCSharpSymbols(
    scriptPath: string,
    kind: CSharpCodeLensSymbolKind,
    documentVersion: number,
    symbols: readonly CSharpMethodSymbolSnapshot[] | readonly CSharpFieldSymbolSnapshot[]
  ): void {
    if (kind === 'methods') {
      lastMethodSymbolsByScriptPath.set(scriptPath, {
        documentVersion,
        symbols: symbols as readonly CSharpMethodSymbolSnapshot[]
      });
      return;
    }

    lastFieldSymbolsByScriptPath.set(scriptPath, {
      documentVersion,
      symbols: symbols as readonly CSharpFieldSymbolSnapshot[]
    });
  }

  /** Returns symbols only when their provider ranges match the current document version. */
  function getCurrentCSharpSymbols(
    scriptPath: string,
    kind: 'methods',
    documentVersion: number
  ): readonly CSharpMethodSymbolSnapshot[] | undefined;
  function getCurrentCSharpSymbols(
    scriptPath: string,
    kind: 'fields',
    documentVersion: number
  ): readonly CSharpFieldSymbolSnapshot[] | undefined;
  function getCurrentCSharpSymbols(
    scriptPath: string,
    kind: CSharpCodeLensSymbolKind,
    documentVersion: number
  ): readonly CSharpMethodSymbolSnapshot[] | readonly CSharpFieldSymbolSnapshot[] | undefined {
    const entry = kind === 'methods'
      ? lastMethodSymbolsByScriptPath.get(scriptPath)
      : lastFieldSymbolsByScriptPath.get(scriptPath);
    return entry !== undefined && entry.documentVersion === documentVersion ? entry.symbols : undefined;
  }

  /** Checks whether a script and symbol category is currently in retry backoff. */
  function isCSharpRetryBackoffActive(scriptPath: string, kind: CSharpCodeLensSymbolKind): boolean {
    const memory = csharpRetryMemory.get(csharpRetryKey(scriptPath, kind));
    return memory !== undefined && Date.now() < memory.nextAllowedAt;
  }

  /** Starts one asynchronous member snapshot read without blocking CodeLens or hover rendering. */
  function scheduleCSharpSymbolRefresh(
    document: vscode.TextDocument,
    index: UnitySerializedAssetReferenceIndex,
    scriptPath: string
  ): void {
    if (!runtime.csharpLanguageService || disposed) {
      return;
    }

    // Lightweight test documents may omit version; real VS Code documents always provide it.
    const requestVersion = document.version ?? 0;
    const needsMethods = index.hasMethodReferences(scriptPath);
    const needsFields = index.hasFieldReferences(scriptPath);
    const requestedKinds = (['methods', 'fields'] as const).filter(kind => kind === 'methods' ? needsMethods : needsFields);
    for (const kind of requestedKinds) {
      const retryMemory = csharpRetryMemory.get(csharpRetryKey(scriptPath, kind));
      if (retryMemory && retryMemory.documentVersion !== requestVersion) {
        resetCSharpRetry(scriptPath, kind);
      }

      const cachedVersion = kind === 'methods'
        ? lastMethodSymbolsByScriptPath.get(scriptPath)?.documentVersion
        : lastFieldSymbolsByScriptPath.get(scriptPath)?.documentVersion;
      if (cachedVersion !== undefined && cachedVersion !== requestVersion) {
        resetCSharpRetry(scriptPath, kind);
      }
    }

    const unresolvedKinds = requestedKinds.filter(kind =>
      getCurrentCSharpSymbols(scriptPath, kind as 'methods', requestVersion) === undefined ||
      hasCSharpUnavailableState(scriptPath, kind, requestVersion)
    );
    if (unresolvedKinds.length === 0 || unresolvedKinds.every(kind => isCSharpRetryBackoffActive(scriptPath, kind))) {
      return;
    }

    const key = `${scriptPath.replace(/\\/g, '/').toLowerCase()}#members#${requestVersion}`;
    if (csharpRefreshInFlight.has(key)) {
      return;
    }

    const requestEpoch = documentEpochByScriptPath.get(scriptPath) ?? 0;
    csharpRefreshInFlight.add(key);
    void (async () => {
      try {
        const snapshot = await runtime.csharpLanguageService!.findDocumentMembers(
          document.uri,
          needsMethods ? getExpectedMethodNamesForScript(index, scriptPath) : [],
          needsFields ? getExpectedFieldNamesForScript(index, scriptPath) : []
        );
        // TextDocument objects advance their version in place; never publish stale ranges.
        const currentVersion = document.version ?? 0;
        if (disposed || currentVersion !== requestVersion || (documentEpochByScriptPath.get(scriptPath) ?? 0) !== requestEpoch) {
          runtime.logger.debug(`UnityEvent member snapshot discarded stale C# symbols for ${scriptPath}: requested=${requestVersion}, current=${currentVersion}.`);
          controller.notifyCodeLensesChanged();
          return;
        }

        const newestCachedVersion = Math.max(
          lastMethodSymbolsByScriptPath.get(scriptPath)?.documentVersion ?? -1,
          lastFieldSymbolsByScriptPath.get(scriptPath)?.documentVersion ?? -1
        );
        if (newestCachedVersion > requestVersion) {
          runtime.logger.debug(`UnityEvent member snapshot ignored older C# symbols for ${scriptPath}: requested=${requestVersion}, cached=${newestCachedVersion}.`);
          return;
        }

        for (const kind of requestedKinds) {
          const available = kind === 'methods' ? snapshot.methodsAvailable : snapshot.fieldsAvailable;
          const symbols = kind === 'methods' ? snapshot.methods : snapshot.fields;
          if (available) {
            rememberCSharpSymbols(scriptPath, kind, requestVersion, symbols);
            markCSharpCodeLensReady(scriptPath, kind);
          } else {
            recordCSharpCodeLensUnavailable(
              scriptPath,
              kind,
              requestVersion,
              new Error(`C# document member snapshot is unavailable for ${kind}.`),
              false
            );
          }
        }
        controller.notifyCodeLensesChanged();
      } catch (error) {
        if (disposed || (document.version ?? 0) !== requestVersion || (documentEpochByScriptPath.get(scriptPath) ?? 0) !== requestEpoch) {
          controller.notifyCodeLensesChanged();
          return;
        }
        for (const kind of unresolvedKinds) {
          const canPlacePlaceholder = kind === 'methods'
            ? (getCurrentCSharpSymbols(scriptPath, 'methods', requestVersion)?.length ?? 0) > 0
            : (getCurrentCSharpSymbols(scriptPath, 'fields', requestVersion)?.length ?? 0) > 0;
          recordCSharpCodeLensUnavailable(scriptPath, kind, requestVersion, error, canPlacePlaceholder);
        }
      } finally {
        csharpRefreshInFlight.delete(key);
      }
    })();
  }

  return {
    onDidChangeCodeLenses: controller.onDidChangeCodeLenses,
    async provideCodeLenses(document, _token) {
      if (!isEnabled() || !isCSharpFile(document.uri)) {
        return [];
      }

      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);

      try {
        const index = controller.getReadyIndex();
        if (!index) {
          if (controller.getStatus() === 'failed') {
            throw new Error('UnityEvent reference index build failed.');
          }

          if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
            // CodeLens should start the YAML index but never wait for it. VS Code
            // will ask again after the controller fires a CodeLens refresh.
            runtime.logger.debug(`UnityEvent CodeLens requested before index was ready for ${scriptPath}; scheduling background scan.`);
            controller.scheduleBuild();
          }
          return [];
        }

        if (index.hasMethodReferences(scriptPath) || index.hasFieldReferences(scriptPath)) {
          scheduleCSharpSymbolRefresh(document, index, scriptPath);
        }

        return await createCodeLensesFromIndex(runtime, document, index, {
          embedReferences: false,
          includeZeroSummaryLenses: true,
          cachedMethods: getCurrentCSharpSymbols(scriptPath, 'methods', document.version ?? 0),
          cachedFields: getCurrentCSharpSymbols(scriptPath, 'fields', document.version ?? 0),
          methodsUnavailable: hasCSharpUnavailableState(scriptPath, 'methods', document.version ?? 0),
          fieldsUnavailable: hasCSharpUnavailableState(scriptPath, 'fields', document.version ?? 0),
          fallbackMethods: getCurrentCSharpSymbols(scriptPath, 'methods', document.version ?? 0),
          fallbackFields: getCurrentCSharpSymbols(scriptPath, 'fields', document.version ?? 0)
        });
      } catch (error) {
        runtime.logger.warn(`UnityEvent CodeLens failed for ${scriptPath}: ${errorMessage(error)}`);
        // Critical scan and symbol failures must stay visible to VS Code instead of becoming placeholder lenses.
        throw error;
      }
    },
    async provideHover(document, position, token) {
      if (!isEnabled() || !isCSharpFile(document.uri) || isCancellationRequested(token)) {
        return undefined;
      }

      const index = controller.getReadyIndex();
      if (!index) {
        if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
          controller.scheduleBuild();
        }
        return undefined;
      }

      const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);
      const documentVersion = document.version ?? 0;
      const methods = getCurrentCSharpSymbols(scriptPath, 'methods', documentVersion);
      const fields = getCurrentCSharpSymbols(scriptPath, 'fields', documentVersion);
      if (!methods && !fields) {
        // Hover must never create a second C# provider request. CodeLens owns
        // snapshot preparation and will refresh hover data asynchronously.
        return undefined;
      }

      const method = methods?.find(symbol => containsPosition(symbol.range, position));

      if (method) {
        const references = index.getReferences(scriptPath, method.name, method.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), toVscodeRange(runtime.runtimeVscode, method.range));
        }
      }

      const field = fields?.find(symbol => containsPosition(symbol.range, position));
      if (field) {
        const references = index.getFieldReferences(scriptPath, field.name, field.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), toVscodeRange(runtime.runtimeVscode, field.range));
        }
      }

      return undefined;
    },
    async showReferenceLocations(target) {
      await showReferenceLocations(
        runtime,
        controller.getReadyIndex(),
        target,
        () => controller.scheduleBuild(),
        isEnabled
      );
    },
    dispose() {
      disposed = true;
      closeDocumentDisposable?.dispose();
      for (const memory of csharpRetryMemory.values()) {
        if (memory.refreshTimer) {
          clearTimeout(memory.refreshTimer);
        }
      }
      csharpRetryMemory.clear();
      lastMethodSymbolsByScriptPath.clear();
      lastFieldSymbolsByScriptPath.clear();
      csharpRefreshInFlight.clear();
      documentEpochByScriptPath.clear();
    }
  };
}

/** Collects target method names that YAML already associates with the current script. */
function getExpectedMethodNamesForScript(index: UnitySerializedAssetReferenceIndex, scriptPath: string): readonly string[] {
  return uniqueNames(index.getAllReferences()
    .filter(reference => referenceMatchesTargetScript(reference, scriptPath))
    .map(reference => reference.methodName));
}

/** Collects UnityEvent field names that YAML already associates with the current owner script. */
function getExpectedFieldNamesForScript(index: UnitySerializedAssetReferenceIndex, scriptPath: string): readonly string[] {
  return uniqueNames(index.getAllReferences()
    .filter(reference => referenceMatchesEventOwnerScript(reference, scriptPath))
    .map(reference => reference.eventFieldName));
}

/** Matches references resolved by script path or by type name before provider symbols supply full type names. */
function referenceMatchesTargetScript(reference: UnityEventReference, scriptPath: string): boolean {
  if (reference.scriptPath && sameProjectPath(reference.scriptPath, scriptPath)) {
    return true;
  }

  return !reference.scriptPath &&
    !!reference.scriptTypeName &&
    sameShortTypeName(reference.scriptTypeName, scriptTypeNameFromPath(scriptPath));
}

/** Matches UnityEvent owner fields resolved by script path or by owner type name. */
function referenceMatchesEventOwnerScript(reference: UnityEventReference, scriptPath: string): boolean {
  if (reference.eventScriptPath && sameProjectPath(reference.eventScriptPath, scriptPath)) {
    return true;
  }

  return !reference.eventScriptPath &&
    !!reference.eventOwnerTypeName &&
    sameShortTypeName(reference.eventOwnerTypeName, scriptTypeNameFromPath(scriptPath));
}

/** Creates a stable unique list while removing empty YAML values. */
function uniqueNames(names: readonly string[]): readonly string[] {
  return [...new Set(names.map(name => name.trim()).filter(Boolean))];
}

/** Compares Unity project paths case-insensitively across slash styles. */
function sameProjectPath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

/** Compares namespace-qualified and short type names. */
function sameShortTypeName(left: string, right: string | undefined): boolean {
  return !!right && left.split('.').at(-1)?.toLowerCase() === right.toLowerCase();
}

/** Uses the script file name as a pre-provider type hint. */
function scriptTypeNameFromPath(scriptPath: string): string | undefined {
  const fileName = scriptPath.split(/[\\/]/).pop() ?? '';
  const typeName = fileName.replace(/\.cs$/i, '');
  return typeName || undefined;
}

/** Treats namespace-only and empty provider results as unavailable rather than unexpected provider crashes. */
function isExpectedCSharpUnavailableError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('namespace-only') ||
    message.includes('not ready') ||
    message.includes('unavailable') ||
    message.includes('canceled') ||
    message.includes('cancelled');
}

/** Checks whether a provider-backed member range contains the current editor position. */
function containsPosition(
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
  position: vscode.Position
): boolean {
  const afterStart = position.line > range.start.line ||
    (position.line === range.start.line && position.character >= range.start.character);
  const beforeEnd = position.line < range.end.line ||
    (position.line === range.end.line && position.character <= range.end.character);
  return afterStart && beforeEnd;
}

/** Converts language-service ranges back into VS Code ranges for hover rendering. */
function toVscodeRange(runtimeVscode: typeof vscode, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new runtimeVscode.Range(
    new runtimeVscode.Position(range.start.line, range.start.character),
    new runtimeVscode.Position(range.end.line, range.end.character)
  );
}
