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

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  const csharpRetryMemory = new Map<string, {
    delayMilliseconds: number;
    logCount: number;
    nextAllowedAt: number;
    refreshTimer?: ReturnType<typeof setTimeout>;
  }>();
  const lastMethodSymbolsByScriptPath = new Map<string, readonly CSharpMethodSymbolSnapshot[]>();
  const lastFieldSymbolsByScriptPath = new Map<string, readonly CSharpFieldSymbolSnapshot[]>();
  const csharpRefreshInFlight = new Set<string>();

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
  function hasCSharpUnavailableState(scriptPath: string, kind: CSharpCodeLensSymbolKind): boolean {
    return csharpRetryMemory.has(csharpRetryKey(scriptPath, kind));
  }

  /** Records C# provider unavailability without actively polling the C# server. */
  function recordCSharpCodeLensUnavailable(scriptPath: string, kind: CSharpCodeLensSymbolKind, error: unknown, canPlacePlaceholder: boolean): void {
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
    symbols: readonly CSharpMethodSymbolSnapshot[] | readonly CSharpFieldSymbolSnapshot[]
  ): void {
    if (kind === 'methods') {
      lastMethodSymbolsByScriptPath.set(scriptPath, symbols as readonly CSharpMethodSymbolSnapshot[]);
      return;
    }

    lastFieldSymbolsByScriptPath.set(scriptPath, symbols as readonly CSharpFieldSymbolSnapshot[]);
  }

  /** Checks whether a script and symbol category is currently in retry backoff. */
  function isCSharpRetryBackoffActive(scriptPath: string, kind: CSharpCodeLensSymbolKind): boolean {
    const memory = csharpRetryMemory.get(csharpRetryKey(scriptPath, kind));
    return memory !== undefined && Date.now() < memory.nextAllowedAt;
  }

  /** Starts an asynchronous C# symbol read without blocking VS Code CodeLens rendering. */
  function scheduleCSharpSymbolRefresh(
    document: vscode.TextDocument,
    index: UnitySerializedAssetReferenceIndex,
    scriptPath: string,
    kind: CSharpCodeLensSymbolKind
  ): void {
    if (!runtime.csharpLanguageService || isCSharpRetryBackoffActive(scriptPath, kind)) {
      return;
    }

    const hasCachedSymbols = kind === 'methods'
      ? lastMethodSymbolsByScriptPath.has(scriptPath)
      : lastFieldSymbolsByScriptPath.has(scriptPath);
    if (hasCachedSymbols && !hasCSharpUnavailableState(scriptPath, kind)) {
      return;
    }

    const key = csharpRetryKey(scriptPath, kind);
    if (csharpRefreshInFlight.has(key)) {
      return;
    }

    csharpRefreshInFlight.add(key);
    void (async () => {
      try {
        const expectedNames = kind === 'methods'
          ? getExpectedMethodNamesForScript(index, scriptPath)
          : getExpectedFieldNamesForScript(index, scriptPath);
        const symbols = kind === 'methods'
          ? await runtime.csharpLanguageService?.findMethods(document.uri, expectedNames) ?? []
          : await runtime.csharpLanguageService?.findUnityEventFields(document.uri, expectedNames) ?? [];
        rememberCSharpSymbols(scriptPath, kind, symbols);
        markCSharpCodeLensReady(scriptPath, kind);
        controller.notifyCodeLensesChanged();
      } catch (error) {
        const canPlacePlaceholder = kind === 'methods'
          ? (lastMethodSymbolsByScriptPath.get(scriptPath)?.length ?? 0) > 0
          : (lastFieldSymbolsByScriptPath.get(scriptPath)?.length ?? 0) > 0;
        recordCSharpCodeLensUnavailable(scriptPath, kind, error, canPlacePlaceholder);
      } finally {
        csharpRefreshInFlight.delete(key);
      }
    })();
  }

  return {
    onDidChangeCodeLenses: controller.onDidChangeCodeLenses,
    async provideCodeLenses(document, token) {
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

        if (index.hasMethodReferences(scriptPath)) {
          scheduleCSharpSymbolRefresh(document, index, scriptPath, 'methods');
        }

        if (index.hasFieldReferences(scriptPath)) {
          scheduleCSharpSymbolRefresh(document, index, scriptPath, 'fields');
        }

        return await createCodeLensesFromIndex(runtime, document, index, {
          embedReferences: false,
          includeZeroSummaryLenses: true,
          cachedMethods: lastMethodSymbolsByScriptPath.get(scriptPath),
          cachedFields: lastFieldSymbolsByScriptPath.get(scriptPath),
          methodsUnavailable: hasCSharpUnavailableState(scriptPath, 'methods'),
          fieldsUnavailable: hasCSharpUnavailableState(scriptPath, 'fields'),
          fallbackMethods: lastMethodSymbolsByScriptPath.get(scriptPath),
          fallbackFields: lastFieldSymbolsByScriptPath.get(scriptPath)
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
      const method = await findMethodAtHoverPosition(runtime, document.uri, position, scriptPath);

      if (method) {
        const references = index.getReferences(scriptPath, method.name, method.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), toVscodeRange(runtime.runtimeVscode, method.range));
        }
      }

      const field = await findFieldAtHoverPosition(runtime, document.uri, position, scriptPath);
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
    }
  };
}

/** Reads the hovered method symbol without letting C# provider errors escape into VS Code hover plumbing. */
async function findMethodAtHoverPosition(
  runtime: EventReferenceRuntime,
  uri: vscode.Uri,
  position: vscode.Position,
  scriptPath: string
): Promise<CSharpMethodSymbolSnapshot | undefined> {
  try {
    return await runtime.csharpLanguageService?.findMethodAtPosition(uri, position);
  } catch (error) {
    logHoverCSharpProviderError(runtime, scriptPath, 'methods', error);
    return undefined;
  }
}

/** Reads the hovered UnityEvent field symbol without turning provider readiness into hover failures. */
async function findFieldAtHoverPosition(
  runtime: EventReferenceRuntime,
  uri: vscode.Uri,
  position: vscode.Position,
  scriptPath: string
): Promise<CSharpFieldSymbolSnapshot | undefined> {
  try {
    return await runtime.csharpLanguageService?.findUnityEventFieldAtPosition(uri, position);
  } catch (error) {
    logHoverCSharpProviderError(runtime, scriptPath, 'fields', error);
    return undefined;
  }
}

/** Logs C# hover lookup failures visibly while keeping the editor hover responsive. */
function logHoverCSharpProviderError(
  runtime: EventReferenceRuntime,
  scriptPath: string,
  kind: CSharpCodeLensSymbolKind,
  error: unknown
): void {
  const message = errorMessage(error);
  if (isExpectedCSharpUnavailableError(error)) {
    runtime.logger.info(`UnityEvent hover C# ${kind} unavailable for ${scriptPath}: ${message}`);
    return;
  }

  runtime.logger.error(`UnityEvent hover C# ${kind} unexpected provider failure for ${scriptPath}: ${message}`);
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

/** Converts language-service ranges back into VS Code ranges for hover rendering. */
function toVscodeRange(runtimeVscode: typeof vscode, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new runtimeVscode.Range(
    new runtimeVscode.Position(range.start.line, range.start.character),
    new runtimeVscode.Position(range.end.line, range.end.character)
  );
}
