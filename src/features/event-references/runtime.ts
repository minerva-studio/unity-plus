import type * as vscode from 'vscode';
import type { UnityPlusLogger } from '../../unity/logger';
import type { LazyUnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityTextSearchFileResult } from '../../unity/textSearch';
import type { CSharpSymbolLanguageService } from '../../unity/csharpLanguageService';
import type {
  UnityEventReference,
  UnityEventReferenceBuildContext,
  UnityEventReferenceDiagnostics,
  UnityEventReferenceScanStatusReporter,
  UnitySerializedAssetReferenceIndex
} from './model';
import type { CSharpFieldSymbolSnapshot, CSharpMethodSymbolSnapshot } from '../../unity/csharpLanguageService';

export interface EventReferenceFeatureOptions {
  metadataIndex?: LazyUnityMetadataIndex;
  runtimeVscode?: typeof vscode;
  isEnabled?: () => boolean;
  findAssetFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  findAssetFilesContainingText?: (root: vscode.Uri, runtimeVscode: typeof vscode, text: string) => Promise<readonly vscode.Uri[]>;
  searchAssetFilesContainingText?: UnityAssetTextSearch;
  findCSharpFiles?: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile?: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion?: () => number;
  resolveCSharpType?: CSharpTypeResolver;
  buildCSharpTypeIndex?: CSharpTypeIndexBuilder;
  csharpLanguageService?: CSharpSymbolLanguageService;
}

export interface EventReferenceRuntime {
  runtimeVscode: typeof vscode;
  logger: UnityPlusLogger;
  metadataIndex: LazyUnityMetadataIndex;
  findAssetFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  findAssetFilesContainingText?: (root: vscode.Uri, runtimeVscode: typeof vscode, text: string) => Promise<readonly vscode.Uri[]>;
  searchAssetFilesContainingText?: UnityAssetTextSearch;
  findCSharpFiles: (root: vscode.Uri, runtimeVscode: typeof vscode) => Promise<readonly vscode.Uri[]>;
  readTextFile: (uri: vscode.Uri, runtimeVscode: typeof vscode) => Promise<string>;
  getCacheVersion: () => number;
  resolveCSharpType?: CSharpTypeResolver;
  buildCSharpTypeIndex?: CSharpTypeIndexBuilder;
  csharpLanguageService?: CSharpSymbolLanguageService;
  scanStatus?: UnityEventReferenceScanStatusReporter;
}

export type UnityAssetTextSearch = (
  root: vscode.Uri,
  runtimeVscode: typeof vscode,
  texts: readonly string[],
  cancellationToken?: vscode.CancellationToken
) => Promise<UnityTextSearchFileResult>;

export type CSharpTypeResolver = (
  fullTypeName: string,
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'metadataIndex' | 'findCSharpFiles' | 'csharpLanguageService'>,
  context?: UnityEventReferenceBuildContext
) => Promise<string | undefined>;

export interface CSharpTypeIndex {
  /** Resolves a C# full type name or short type name to a project asset path. */
  resolve(fullTypeName: string): string | undefined;
}

export type CSharpTypeIndexBuilder = (
  runtime: Pick<EventReferenceRuntime, 'runtimeVscode' | 'logger' | 'metadataIndex' | 'findCSharpFiles' | 'csharpLanguageService'>,
  context?: UnityEventReferenceBuildContext
) => Promise<CSharpTypeIndex>;

export interface EventReferenceLocationTarget {
  kind: 'method' | 'field' | 'fieldTarget';
  scriptPath: string;
  symbolName?: string;
  typeName?: string;
  eventReferences?: readonly UnityEventReference[];
  position: vscode.Position;
}

export type UnityEventReferenceIndexStatus = 'idle' | 'building' | 'ready' | 'failed';

export interface UnityEventReferenceIndexController {
  readonly onDidChangeCodeLenses: vscode.Event<void>;
  getStatus(): UnityEventReferenceIndexStatus;
  getReadyIndex(): UnitySerializedAssetReferenceIndex | undefined;
  scheduleBuild(): void;
  forceBuild(context?: UnityEventReferenceBuildContext): Promise<UnitySerializedAssetReferenceIndex | undefined>;
  notifyCodeLensesChanged(): void;
}

export interface PriorityScanResult {
  index: UnitySerializedAssetReferenceIndex;
  diagnostics: UnityEventReferenceDiagnostics;
  scriptGuid?: string;
  reason?: string;
}

export interface PriorityScanState {
  key: string;
  status: 'pending' | 'ready' | 'failed';
  promise?: Promise<PriorityScanResult | undefined>;
  result?: PriorityScanResult;
}

export interface CodeLensRenderOptions {
  embedReferences: boolean;
  includeZeroSummaryLenses?: boolean;
  /** When true, render without method lenses while method symbol retry backoff is active. */
  skipCSharpMethods?: boolean;
  /** When true, render without UnityEvent field lenses while field symbol retry backoff is active. */
  skipCSharpFields?: boolean;
  /** Last provider-backed methods used only to keep error placeholders anchored. */
  fallbackMethods?: readonly CSharpMethodSymbolSnapshot[];
  /** Last provider-backed fields used only to keep error placeholders anchored. */
  fallbackFields?: readonly CSharpFieldSymbolSnapshot[];
  /** Called when one C# symbol category is not ready, so the provider can retry later. */
  onCSharpSymbolsUnavailable?: (kind: 'methods' | 'fields', error: unknown, canPlacePlaceholder: boolean) => void;
  /** Called after one C# symbol category is read successfully, so retry state can reset. */
  onCSharpSymbolsReady?: (kind: 'methods' | 'fields', symbols: readonly CSharpMethodSymbolSnapshot[] | readonly CSharpFieldSymbolSnapshot[]) => void;
}

export interface RunWithConcurrencyOptions {
  cancellationToken?: vscode.CancellationToken;
  yieldEvery?: number;
  onProgress?: (completedCount: number, totalCount: number) => void;
}

export const gameObjectClassId = 1;
export const monoBehaviourClassId = 114;
export const defaultAssetScanConcurrency = 4;
export const scanYieldEvery = 4;
export const backgroundScanYieldEvery = 1;
export const backgroundBuildDebounceMilliseconds = 150;
export const progressReportInterval = 10;
