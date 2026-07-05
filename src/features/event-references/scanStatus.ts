import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { UnityEventReferenceDiagnostics } from './eventReferences';

export interface UnityEventReferenceScanStatusReporter {
  /** Shows the background scan status item with the first visible phase. */
  start(phase: string, label?: string): void;
  /** Updates the status item with bounded scan progress. */
  update(status: UnityEventReferenceScanStatus): void;
  /** Hides the status item and records the final scan result. */
  finish(result: 'completed' | 'failed' | 'canceled', diagnostics?: UnityEventReferenceDiagnostics, status?: UnityEventReferenceScanStatus): void;
  /** Releases the status item when the extension feature is disposed. */
  dispose(): void;
}

interface UnityEventReferenceScanStatus {
  phase: string;
  label?: string;
  scriptPath?: string;
  scriptGuid?: string;
  metadataGuidCount?: number;
  candidateCount?: number;
  scannedCount?: number;
  totalCount?: number;
  referenceCount?: number;
  instanceCount?: number;
  elapsedMilliseconds?: number;
}

const scanStatusRetainMilliseconds = 8000;

/** Creates a status bar reporter for silent background UnityEvent scans. */
export function createUnityEventReferenceScanStatus(
  runtimeVscode: typeof vscode,
  logger: UnityPlusLogger,
  formatDiagnostics: (runtimeVscode: typeof vscode, diagnostics: UnityEventReferenceDiagnostics) => string
): UnityEventReferenceScanStatusReporter {
  const window = runtimeVscode.window as typeof runtimeVscode.window & {
    createStatusBarItem?: (alignment?: vscode.StatusBarAlignment, priority?: number) => vscode.StatusBarItem;
  };
  const item = typeof window.createStatusBarItem === 'function'
    ? window.createStatusBarItem(runtimeVscode.StatusBarAlignment?.Left, 100)
    : undefined;
  let startedAt = 0;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    start(phase, label = 'Unity refs') {
      startedAt = Date.now();
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }

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
      const label = status.label ?? 'Unity refs';
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
        const label = status?.label ?? 'Unity refs';
        const icon = result === 'completed'
          ? '$(check)'
          : result === 'canceled'
            ? '$(circle-slash)'
            : '$(warning)';
        const references = status?.referenceCount ?? diagnostics?.resolvedReferenceCount ?? 0;
        const instances = status?.instanceCount ?? diagnostics?.serializedInstanceCount ?? 0;
        item.text = `${icon} ${label}: ${references} refs, ${instances} inst`;
        item.tooltip = formatScanStatusTooltip({
          label,
          phase: status?.phase ?? result,
          candidateCount: status?.candidateCount ?? diagnostics?.candidateAssetCount,
          scannedCount: status?.scannedCount,
          totalCount: status?.totalCount,
          referenceCount: references,
          instanceCount: instances,
          metadataGuidCount: status?.metadataGuidCount,
          scriptPath: status?.scriptPath,
          scriptGuid: status?.scriptGuid,
          elapsedMilliseconds: status?.elapsedMilliseconds ?? diagnostics?.elapsedMilliseconds ?? Date.now() - startedAt
        });
        item.show();
        hideTimer = setTimeout(() => {
          item.hide();
          hideTimer = undefined;
        }, scanStatusRetainMilliseconds);
      }

      if (diagnostics) {
        logger.info(`UnityEvent background reference scan ${result}: ${formatDiagnostics(runtimeVscode, diagnostics)}.`);
      } else {
        logger.info(`UnityEvent background reference scan ${result}.`);
      }
    },
    dispose() {
      if (hideTimer) {
        clearTimeout(hideTimer);
      }

      item?.dispose();
    }
  };
}

/** Formats the status bar tooltip without allocating parser-side state. */
function formatScanStatusTooltip(status: UnityEventReferenceScanStatus): string {
  const lines = [
    `Scope: ${status.label ?? 'Unity refs'}`,
    `Phase: ${status.phase}`,
    `Script: ${status.scriptPath ?? '-'}`,
    `Script GUID: ${status.scriptGuid ?? '-'}`,
    `Metadata GUIDs: ${status.metadataGuidCount ?? '?'}`,
    `Candidates: ${status.candidateCount ?? '?'}`,
    `Scanned: ${status.scannedCount ?? 0}/${status.totalCount ?? status.candidateCount ?? '?'}`,
    `References: ${status.referenceCount ?? 0}`,
    `Instances: ${status.instanceCount ?? 0}`,
    `Elapsed: ${status.elapsedMilliseconds ?? 0}ms`
  ];
  return lines.join('\n');
}
