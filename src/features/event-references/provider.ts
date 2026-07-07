import type * as vscode from 'vscode';
import { isCSharpFile } from './assetDiscovery';
import { createCodeLensesFromIndex } from './codeLens';
import { createHoverMarkdown, showReferenceLocations } from './referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';
import { isEventReferenceAutoScanEnabled } from './settings';
import { errorMessage, isCancellationRequested, toProjectPath } from './utils';

const csharpRetryInitialDelayMilliseconds = 1000;
const csharpRetryMaximumDelayMilliseconds = 10000;

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  let csharpRetryTimer: NodeJS.Timeout | undefined;
  let csharpRetryDelayMilliseconds = csharpRetryInitialDelayMilliseconds;
  let csharpRetryLogCount = 0;

  /** Queues a bounded CodeLens refresh while the C# server is still warming up. */
  function scheduleCSharpCodeLensRetry(scriptPath: string, error: unknown): void {
    if (csharpRetryTimer) {
      return;
    }

    csharpRetryLogCount += 1;
    const message = errorMessage(error);
    if (csharpRetryLogCount === 1 || csharpRetryLogCount % 5 === 0) {
      runtime.logger.info(`UnityEvent CodeLens is waiting for C# symbols before showing method and field hints for ${scriptPath}: ${message}`);
    } else {
      runtime.logger.debug(`UnityEvent CodeLens C# symbol retry for ${scriptPath}: ${message}`);
    }

    csharpRetryTimer = setTimeout(() => {
      csharpRetryTimer = undefined;
      controller.notifyCodeLensesChanged();
      csharpRetryDelayMilliseconds = Math.min(
        csharpRetryMaximumDelayMilliseconds,
        csharpRetryDelayMilliseconds * 2
      );
    }, csharpRetryDelayMilliseconds);
  }

  /** Clears C# retry state after provider-backed symbols become available. */
  function markCSharpCodeLensReady(): void {
    if (csharpRetryTimer) {
      clearTimeout(csharpRetryTimer);
      csharpRetryTimer = undefined;
    }

    if (csharpRetryLogCount > 0) {
      runtime.logger.info('UnityEvent CodeLens C# symbols are ready; method and field hints can render.');
    }

    csharpRetryDelayMilliseconds = csharpRetryInitialDelayMilliseconds;
    csharpRetryLogCount = 0;
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
          onCSharpSymbolsUnavailable: error => scheduleCSharpCodeLensRetry(scriptPath, error),
          onCSharpSymbolsReady: markCSharpCodeLensReady
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
