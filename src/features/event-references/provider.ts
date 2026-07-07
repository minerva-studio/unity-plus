import type * as vscode from 'vscode';
import { isCSharpFile } from './assetDiscovery';
import { createCodeLensesFromIndex } from './codeLens';
import { createHoverMarkdown, showReferenceLocations } from './referenceLocations';
import type { EventReferenceLocationTarget, EventReferenceRuntime, UnityEventReferenceIndexController } from './runtime';
import { isEventReferenceAutoScanEnabled } from './settings';
import { errorMessage, isCancellationRequested, toProjectPath } from './utils';

/** Creates the VS Code provider facade that delegates scanning, rendering, and location display. */
export function createEventReferenceProvider(
  runtime: EventReferenceRuntime,
  controller: UnityEventReferenceIndexController,
  isEnabled: () => boolean
): vscode.CodeLensProvider & vscode.HoverProvider & { showReferenceLocations(target: EventReferenceLocationTarget): Promise<void> } {
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
            controller.scheduleBuild();
          }

          // CodeLens requests must stay cheap while the serialized-asset index
          // is unavailable. Returning no UnityEvent lenses keeps other providers
          // responsive and avoids waking the C# server before it is ready.
          return [];
        }

        return await createCodeLensesFromIndex(runtime, document, index, {
          embedReferences: false,
          includeZeroSummaryLenses: true
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
