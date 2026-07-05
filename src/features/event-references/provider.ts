import type * as vscode from 'vscode';
import { isCSharpFile } from './assetDiscovery';
import { createCodeLensesFromIndex, createScanStateCodeLenses } from './codeLens';
import { createEmptyPriorityScanResult, buildPriorityReferenceIndex } from './priorityScan';
import { createHoverMarkdown, showReferenceLocations } from './referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime, PriorityScanState, UnityEventReferenceIndexController } from './runtime';
import { isEventReferenceAutoScanEnabled } from './settings';
import { errorMessage, isCancellationRequested, toProjectPath } from './utils';

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
  let priorityScan: PriorityScanState | undefined;

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
          if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
            controller.scheduleBuild();
            return await createScanStateCodeLenses(runtime, document, scriptPath, '-');
          }

          if (isCancellationRequested(token)) {
            return await createScanStateCodeLenses(runtime, document, scriptPath, '-');
          }

          const priorityKey = `${runtime.getCacheVersion()}:${scriptPath}`;
          if (!priorityScan || priorityScan.key !== priorityKey) {
            const state: PriorityScanState = {
              key: priorityKey,
              status: 'pending'
            };
            const promise = buildPriorityReferenceIndex(runtime, document, token)
              .then(result => {
                if (priorityScan === state) {
                  state.status = 'ready';
                  state.result = result;
                  controller.notifyCodeLensesChanged();
                }

                return result;
              })
              .catch(error => {
                if (priorityScan === state) {
                  state.status = 'failed';
                  state.result = createEmptyPriorityScanResult(runtime, scriptPath, errorMessage(error));
                  runtime.scanStatus?.finish('failed', state.result.diagnostics, {
                    label: 'Unity refs: current',
                    phase: 'Current script scan failed',
                    scriptPath,
                    referenceCount: 0,
                    instanceCount: 0
                  });
                  controller.notifyCodeLensesChanged();
                }

                runtime.logger.warn(`UnityEvent priority scan failed for ${scriptPath}: ${errorMessage(error)}`);
                return createEmptyPriorityScanResult(runtime, scriptPath, errorMessage(error));
              });
            state.promise = promise;
            priorityScan = state;
          }

          if (priorityScan.status === 'ready' && priorityScan.result) {
            return await createCodeLensesFromIndex(runtime, document, priorityScan.result.index, {
              embedReferences: true,
              includeZeroSummaryLenses: true
            });
          }

          if (priorityScan.status === 'failed' && priorityScan.result) {
            return await createCodeLensesFromIndex(runtime, document, priorityScan.result.index, {
              embedReferences: true,
              includeZeroSummaryLenses: true
            });
          }

          return await createScanStateCodeLenses(runtime, document, scriptPath, '-');
        }

        return await createCodeLensesFromIndex(runtime, document, index, {
          embedReferences: false,
          includeZeroSummaryLenses: true
        });
      } catch (error) {
        // CodeLens must stay visible even when indexing or symbol providers fail.
        runtime.logger.warn(`UnityEvent CodeLens fallback for ${scriptPath}: ${errorMessage(error)}`);
        return await createScanStateCodeLenses(runtime, document, scriptPath, '-');
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
