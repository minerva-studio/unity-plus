import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { UnitySerializedInstanceDiagnostics, UnitySerializedInstanceScanStatus, UnitySerializedInstanceScanStatusReporter } from './model';

/** Creates a persistent status bar reporter for background serialized instance scans. */
export function createSerializedInstanceScanStatus(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger,
  formatDiagnostics: (runtimeVscode: typeof vscode, diagnostics: UnitySerializedInstanceDiagnostics) => string
): UnitySerializedInstanceScanStatusReporter {
  void formatDiagnostics;
  const window = runtimeVscode.window as typeof runtimeVscode.window & {
    createStatusBarItem?: (alignment?: vscode.StatusBarAlignment, priority?: number) => vscode.StatusBarItem;
  };
  const item = typeof window.createStatusBarItem === 'function'
    ? window.createStatusBarItem(runtimeVscode.StatusBarAlignment?.Left, 99)
    : undefined;
  let startedAt = 0;

  return {
    start(phase, label = 'Unity inst') {
      startedAt = Date.now();
      if (!item) {
        return;
      }

      item.text = `$(sync~spin) ${label}: 0/?`;
      item.tooltip = formatScanStatusTooltip({ label, phase, elapsedMilliseconds: 0 });
      item.show();
    },
    update(status) {
      if (!item) {
        return;
      }

      const scannedCount = status.scannedCount ?? 0;
      const totalCount = status.totalCount ?? status.candidateCount;
      const label = status.label ?? 'Unity inst';
      const progressText = status.metadataGuidCount !== undefined
        ? `${status.metadataGuidCount} GUIDs`
        : `${scannedCount}/${totalCount ?? '?'}`;
      item.text = `$(sync~spin) ${label}: ${progressText}`;
      item.tooltip = formatScanStatusTooltip({
        ...status,
        elapsedMilliseconds: status.elapsedMilliseconds ?? Date.now() - startedAt
      });
      item.show();
    },
    finish(result, diagnostics, status) {
      if (item) {
        const label = status?.label ?? 'Unity inst';
        const icon = result === 'completed'
          ? '$(check)'
          : result === 'canceled'
            ? '$(circle-slash)'
            : '$(warning)';
        const instances = status?.instanceCount ?? diagnostics?.serializedInstanceCount ?? 0;
        item.text = `${icon} ${label}: ${instances} inst`;
        item.tooltip = formatScanStatusTooltip({
          label,
          phase: status?.phase ?? result,
          candidateCount: status?.candidateCount ?? diagnostics?.candidateAssetCount,
          scannedCount: status?.scannedCount,
          totalCount: status?.totalCount,
          instanceCount: instances,
          metadataGuidCount: status?.metadataGuidCount,
          scriptPath: status?.scriptPath,
          scriptGuid: status?.scriptGuid,
          elapsedMilliseconds: status?.elapsedMilliseconds ?? diagnostics?.elapsedMilliseconds ?? Date.now() - startedAt
        });
        item.show();
      }

      if (diagnostics) {
        logger.info(`Unity serialized instance background scan ${result}: ${formatDiagnosticsForLog(diagnostics)}.`);
      } else {
        logger.info(`Unity serialized instance background scan ${result}.`);
      }
    },
    dispose() {
      item?.dispose();
    }
  };
}

/** Formats scan diagnostics for logs without localized UI text or encoding risk. */
function formatDiagnosticsForLog(diagnostics: UnitySerializedInstanceDiagnostics): string {
  return [
    `${diagnostics.candidateAssetCount} candidate asset(s)`,
    `${diagnostics.assetReadCount} read`,
    `${diagnostics.prefabCount} prefab(s)`,
    `${diagnostics.sceneCount} scene(s)`,
    `${diagnostics.assetCount} asset file(s)`,
    `${diagnostics.serializedInstanceCount} serialized instance(s)`,
    `${diagnostics.elapsedMilliseconds}ms`
  ].join(', ');
}

/** Formats the persistent status bar tooltip. */
function formatScanStatusTooltip(status: UnitySerializedInstanceScanStatus): string {
  const lines = [
    `Scope: ${status.label ?? 'Unity inst'}`,
    `Phase: ${status.phase}`,
    `Script: ${status.scriptPath ?? '-'}`,
    `Script GUID: ${status.scriptGuid ?? '-'}`,
    `Metadata GUIDs: ${status.metadataGuidCount ?? '?'}`,
    `Candidates: ${status.candidateCount ?? '?'}`,
    `Scanned: ${status.scannedCount ?? 0}/${status.totalCount ?? status.candidateCount ?? '?'}`,
    `Instances: ${status.instanceCount ?? 0}`,
    `Elapsed: ${status.elapsedMilliseconds ?? 0}ms`
  ];
  return lines.join('\n');
}
