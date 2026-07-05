import type * as vscode from 'vscode';
import { defaultAssetScanConcurrency } from './runtime';

/** Reads the opt-in flag that permits CodeLens to start a full asset scan. */
export function isEventReferenceAutoScanEnabled(runtimeVscode: typeof vscode): boolean {
  return runtimeVscode.workspace
    .getConfiguration('unityPlus')
    .get<boolean>('eventReferences.autoScan', false) === true;
}

/** Reads the bounded background scan concurrency setting. */
export function getBackgroundScanConcurrency(runtimeVscode: typeof vscode): number {
  const configured = runtimeVscode.workspace
    .getConfiguration('unityPlus')
    .get<number>('eventReferences.backgroundScanConcurrency', defaultAssetScanConcurrency);
  const numericValue = Number.isFinite(configured) ? Math.floor(configured) : defaultAssetScanConcurrency;
  return Math.min(16, Math.max(1, numericValue));
}

/** Reads whether scene scans should include scenes omitted from Unity Build Settings. */
export function shouldIncludeScenesOutsideBuildSettings(runtimeVscode: typeof vscode): boolean {
  return runtimeVscode.workspace
    .getConfiguration('unityPlus')
    .get<boolean>('scan.includeScenesOutsideBuildSettings', true) !== false;
}
