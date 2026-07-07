import type * as vscode from 'vscode';
import { isCSharpFile } from './assetDiscovery';
import { createCodeLensesFromIndex } from './codeLens';
import { createHoverMarkdown, showReferenceLocations } from './referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';
import { isEventReferenceAutoScanEnabled } from './settings';
import { errorMessage, isCancellationRequested, toProjectPath } from './utils';

const csharpRetryInitialDelayMilliseconds = 1000;
const csharpRetryMaximumDelayMilliseconds = 10000;
type CSharpCodeLensSymbolKind = 'methods' | 'fields';

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  const csharpRetryStates = new Map<string, {
    timer: NodeJS.Timeout;
    delayMilliseconds: number;
    logCount: number;
  }>();
  const csharpRetryMemory = new Map<string, {
    delayMilliseconds: number;
    logCount: number;
  }>();

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

  /** Stores retry backoff state after a timed retry has been scheduled. */
  function setCSharpRetryDelay(scriptPath: string, kind: CSharpCodeLensSymbolKind, delayMilliseconds: number, logCount: number): void {
    csharpRetryMemory.set(csharpRetryKey(scriptPath, kind), { delayMilliseconds, logCount });
  }

  /** Clears retry backoff state once one symbol category becomes available. */
  function resetCSharpRetry(scriptPath: string, kind: CSharpCodeLensSymbolKind): void {
    csharpRetryMemory.delete(csharpRetryKey(scriptPath, kind));
  }

  /** Queues a bounded CodeLens refresh while the C# server is still warming up. */
  function scheduleCSharpCodeLensRetry(scriptPath: string, kind: CSharpCodeLensSymbolKind, error: unknown): void {
    const key = csharpRetryKey(scriptPath, kind);
    const existingState = csharpRetryStates.get(key);
    if (existingState) {
      return;
    }

    const previousLogCount = getCSharpRetryLogCount(scriptPath, kind);
    const logCount = previousLogCount + 1;
    const message = errorMessage(error);
    if (logCount === 1 || logCount % 10 === 0) {
      runtime.logger.info(`UnityEvent CodeLens is waiting for C# ${kind} before showing matching hints for ${scriptPath}: ${message}`);
    } else {
      runtime.logger.debug(`UnityEvent CodeLens C# ${kind} retry for ${scriptPath}: ${message}`);
    }

    const delayMilliseconds = getCSharpRetryDelay(scriptPath, kind);
    const timer = setTimeout(() => {
      csharpRetryStates.delete(key);
      controller.notifyCodeLensesChanged();
      setCSharpRetryDelay(scriptPath, kind, Math.min(csharpRetryMaximumDelayMilliseconds, delayMilliseconds * 2), logCount);
    }, delayMilliseconds);

    csharpRetryStates.set(key, { timer, delayMilliseconds, logCount });
  }

  /** Clears C# retry state after provider-backed symbols become available. */
  function markCSharpCodeLensReady(scriptPath: string, kind: CSharpCodeLensSymbolKind): void {
    const key = csharpRetryKey(scriptPath, kind);
    const state = csharpRetryStates.get(key);
    if (state) {
      clearTimeout(state.timer);
      csharpRetryStates.delete(key);
    }

    if (getCSharpRetryLogCount(scriptPath, kind) > 0 || state) {
      runtime.logger.info(`UnityEvent CodeLens C# ${kind} are ready for ${scriptPath}; matching hints can render.`);
    }

    resetCSharpRetry(scriptPath, kind);
  }

  /** Checks whether a script and symbol category is currently in retry backoff. */
  function isCSharpRetryBackoffActive(scriptPath: string, kind: CSharpCodeLensSymbolKind): boolean {
    return csharpRetryStates.has(csharpRetryKey(scriptPath, kind));
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

        return await createCodeLensesFromIndex(runtime, document, index, {
          embedReferences: false,
          includeZeroSummaryLenses: true,
          skipCSharpMethods: isCSharpRetryBackoffActive(scriptPath, 'methods'),
          skipCSharpFields: isCSharpRetryBackoffActive(scriptPath, 'fields'),
          onCSharpSymbolsUnavailable: (kind, error) => scheduleCSharpCodeLensRetry(scriptPath, kind, error),
          onCSharpSymbolsReady: kind => markCSharpCodeLensReady(scriptPath, kind)
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
      const method = await runtime.csharpLanguageService?.findMethodAtPosition(document.uri, position);

      if (method) {
        const references = index.getReferences(scriptPath, method.name, method.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), toVscodeRange(runtime.runtimeVscode, method.range));
        }
      }

      const field = await runtime.csharpLanguageService?.findUnityEventFieldAtPosition(document.uri, position);
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

/** Converts language-service ranges back into VS Code ranges for hover rendering. */
function toVscodeRange(runtimeVscode: typeof vscode, range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new runtimeVscode.Range(
    new runtimeVscode.Position(range.start.line, range.start.character),
    new runtimeVscode.Position(range.end.line, range.end.character)
  );
}
