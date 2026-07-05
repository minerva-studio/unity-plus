import type * as vscode from 'vscode';
import { isCSharpFile } from './assetDiscovery';
import { findMethodAtPosition, findUnityEventFieldAtPosition } from './csharpSource';
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
      if (!isEnabled() || !isCSharpFile(document.uri) || isCancellationRequested(token)) {
        return [];
      }

      const index = controller.getReadyIndex();
      if (!index) {
        const scriptPath = toProjectPath(runtime.metadataIndex.root, document.uri);

        if (isEventReferenceAutoScanEnabled(runtime.runtimeVscode)) {
          controller.scheduleBuild();
          return createScanStateCodeLenses(runtime, document, scriptPath, '-');
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
          return createCodeLensesFromIndex(runtime, document, priorityScan.result.index, {
            embedReferences: true,
            includeZeroSummaryLenses: true
          });
        }

        if (priorityScan.status === 'failed' && priorityScan.result) {
          return createCodeLensesFromIndex(runtime, document, priorityScan.result.index, {
            embedReferences: true,
            includeZeroSummaryLenses: true
          });
        }

        return createScanStateCodeLenses(runtime, document, scriptPath, '-');
      }

      return createCodeLensesFromIndex(runtime, document, index, {
        embedReferences: false,
        includeZeroSummaryLenses: true
      });
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
      const method = findMethodAtPosition(runtime.runtimeVscode, document, position);

      if (method) {
        const references = index.getReferences(scriptPath, method.name, method.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), method.range);
        }
      }

      const field = findUnityEventFieldAtPosition(runtime.runtimeVscode, document, position);
      if (field) {
        const references = index.getFieldReferences(scriptPath, field.name, field.typeName);
        if (references.length > 0) {
          return new runtime.runtimeVscode.Hover(createHoverMarkdown(runtime.runtimeVscode, references), field.range);
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
