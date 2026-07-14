import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { buildUnityEventReferenceIndex } from '../../features/event-references/eventReferences';
import { findDefaultAssetFiles, findDefaultCSharpFiles } from '../../features/event-references/assetDiscovery';
import { createEventReferenceProvider } from '../../features/event-references/provider';
import { createUnityYamlCodeLensProvider } from '../../features/unity-yaml-code-lens/provider';
import type { EventReferenceRuntime, UnityEventReferenceIndexController } from '../../features/event-references/runtime';
import type { UnitySerializedAssetReferenceIndex } from '../../features/event-references/model';
import { createSerializedInstanceProvider } from '../../features/serialized-instances/provider';
import type { SerializedInstancesRuntime } from '../../features/serialized-instances/runtime';
import { readDefaultTextFile } from '../../features/event-references/utils';
import { createSharedUnityYamlAssetHandler } from '../../features/unity-yaml-assets/handler';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';
import { createLazyUnityMetadataIndex } from '../../unity/metadataIndex';
import type { UnityPlusLogger } from '../../unity/logger';
import { configureCSharpSolution, getCSharpProviderReadinessState, getUnityFixtureRoot } from './csharpProviderSetup';

const csharpReadinessTimeoutMs = 60_000;
const csharpNamespaceOnlyFastFailMs = 20_000;
const csharpReadinessLogIntervalMs = 2_000;
const notReadyCodeLensBudgetMs = 5_000;

suite('eventReferences - VS Code CodeLens Provider', () => {
  test('returns serialized CodeLens quickly while UnityEvent index or C# symbols are not ready', async function () {
    this.timeout(60_000);

    const root = getUnityFixtureRoot();
    const metadataIndex = createLazyUnityMetadataIndex({
      root,
      logger: createMemoryLogger()
    });

    try {
      const runtime = createRealEventReferenceRuntime(metadataIndex);
      const instanceRuntime = createSerializedFixtureRuntime(runtime);
      await metadataIndex.getOrBuild();

      const eventProvider = createEventReferenceProvider(runtime, createNotReadyEventIndexController(vscode), () => true);
      const instanceProvider = createSerializedInstanceProvider(instanceRuntime, () => true);
      const disposable = vscode.Disposable.from(
        vscode.languages.registerCodeLensProvider({ language: 'csharp' }, instanceProvider),
        vscode.languages.registerCodeLensProvider({ language: 'csharp' }, eventProvider)
      );

      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs')));
        const startedAt = Date.now();
        const lenses = await executeCodeLensProvider(document.uri);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < notReadyCodeLensBudgetMs, `CodeLens provider should return before C# readiness; elapsed=${elapsedMs}ms`);
        assert.strictEqual(lenses.some(lens => lens.command?.title === '1 Unity serialized instances'), true);
      } finally {
        disposable.dispose();
      }
    } finally {
      metadataIndex.dispose();
    }
  });

  test('shows UnityEvent field CodeLens after the real C# provider exposes member ranges', async function () {
    this.timeout(120_000);

    const root = getUnityFixtureRoot();
    await configureCSharpSolution(root);
    await waitForRequiredCSharpMembers(vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs')), {
      typeFullName: 'Amlos.Control.Interact.Interactable',
      fields: [{ name: 'OnCheckEnable', detailIncludes: 'UnityEvent', line: 7, character: 26 }],
      methods: []
    });
    await waitForRequiredCSharpMembers(vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Cannon.cs')), {
      typeFullName: 'Amlos.Fixtures.Cannon',
      fields: [],
      methods: [{ name: 'Fire', line: 6, character: 16 }]
    });
    const metadataIndex = createLazyUnityMetadataIndex({
      root,
      logger: createMemoryLogger()
    });

    try {
      const runtime = createRealEventReferenceRuntime(metadataIndex);
      const instanceRuntime = createSerializedFixtureRuntime(runtime);
      const metadata = await metadataIndex.getOrBuild();
      const index = await buildUnityEventReferenceIndex(runtime, metadata, { mode: 'background' });
      const eventProvider = createEventReferenceProvider(runtime, createReadyEventIndexController(index, vscode), () => true);
      const instanceProvider = createSerializedInstanceProvider(instanceRuntime, () => true);
      const disposable = vscode.Disposable.from(
        vscode.languages.registerCodeLensProvider({ language: 'csharp' }, instanceProvider),
        vscode.languages.registerCodeLensProvider({ language: 'csharp' }, eventProvider)
      );

      try {
        const interactableUri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));
        const cannonUri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Scripts', 'Cannon.cs'));
        const interactableLenses = await waitForUnityEventCodeLenses(interactableUri, { method: false, field: true, fieldTarget: true });
        const cannonLenses = await waitForUnityEventCodeLenses(cannonUri, { method: true, methodInvokerField: true, field: false, fieldTarget: false });
        const instanceLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'serializedInstance');
        const methodLens = cannonLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');
        const invokerLens = cannonLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'methodInvokerField');
        const fieldReferenceLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'field');
        const fieldTargetLens = interactableLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');

        assert.strictEqual(instanceLens?.command?.title, '1 Unity serialized instances');
        assert.strictEqual(methodLens?.command?.title, '1 UnityEvent references');
        assert.strictEqual(invokerLens?.command?.title, '1 UnityEvent invokers');
        assert.strictEqual(fieldReferenceLens?.command?.title, '1 UnityEvent references');
        assert.strictEqual(fieldTargetLens?.command?.title, '1 UnityEvent targets');
        assert.strictEqual(fieldReferenceLens?.range.start.line, 7);
        assert.strictEqual(fieldReferenceLens?.range.start.character, 26);
        assert.strictEqual(fieldTargetLens?.range.start.line, 7);
        assert.strictEqual(fieldTargetLens?.range.start.character, 26);
        assert.strictEqual(methodLens?.range.start.line, 6);
        assert.strictEqual(methodLens?.range.start.character, 16);
        assert.strictEqual(invokerLens?.range.start.line, 6);
        assert.strictEqual(invokerLens?.range.start.character, 16);

        // Verify cached provider ranges are invalidated for both insert and delete edits.
        const cannonDocument = await vscode.workspace.openTextDocument(cannonUri);
        const insertEdit = new vscode.WorkspaceEdit();
        insertEdit.insert(cannonUri, new vscode.Position(0, 0), '\n');
        assert.strictEqual(await vscode.workspace.applyEdit(insertEdit), true);
        try {
          const shiftedLenses = await waitForUnityEventCodeLenses(cannonUri, {
            method: true,
            methodInvokerField: true,
            field: false,
            fieldTarget: false
          });
          const shiftedMethodLens = shiftedLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');
          assert.strictEqual(shiftedMethodLens?.range.start.line, 7);
        } finally {
          const deleteEdit = new vscode.WorkspaceEdit();
          deleteEdit.delete(cannonUri, new vscode.Range(0, 0, 1, 0));
          assert.strictEqual(await vscode.workspace.applyEdit(deleteEdit), true);
        }

        const restoredLenses = await waitForUnityEventCodeLenses(cannonDocument.uri, {
          method: true,
          methodInvokerField: true,
          field: false,
          fieldTarget: false
        });
        const restoredMethodLens = restoredLenses.find(lens => lens.command?.arguments?.[0]?.kind === 'method');
        assert.strictEqual(restoredMethodLens?.range.start.line, 6);
      } finally {
        disposable.dispose();
      }
    } finally {
      metadataIndex.dispose();
    }
  });

  test('shows MonoBehaviour C# script CodeLens in real Unity YAML assets', async function () {
    this.timeout(60_000);

    const root = getUnityFixtureRoot();
    const prefabUri = vscode.Uri.file(join(root.fsPath, 'Assets', 'Prefabs', 'Gate.prefab'));
    const metadataIndex = createLazyUnityMetadataIndex({
      root,
      logger: createMemoryLogger()
    });
    const cancellation = new vscode.CancellationTokenSource();

    try {
      const provider = createUnityYamlCodeLensProvider({
        runtimeVscode: vscode,
        logger: createMemoryLogger(),
        metadataIndex
      });
      const document = await vscode.workspace.openTextDocument(prefabUri);
      const lenses = await provider.provideCodeLenses?.(document, cancellation.token) ?? [];
      const scriptLens = lenses.find(lens => lens.command?.command === 'unityPlus.openUnityYamlMonoBehaviourScript' &&
        lens.command.title === 'C# script: Interactable');

      assert.ok(scriptLens, `Expected MonoBehaviour script CodeLens. Lenses: ${lenses.map(lens => lens.command?.title ?? '<none>').join(', ')}`);
      const scriptCommand = scriptLens.command;
      assert.ok(scriptCommand, 'Expected MonoBehaviour script CodeLens command.');
      assert.strictEqual(scriptLens.range.start.line, 6);
      assert.strictEqual(scriptLens.range.start.character, 0);
      const scriptFsPath = toFsPathFromCommandArgument(scriptCommand.arguments?.[0]);
      assert.strictEqual(scriptCommand.command, 'unityPlus.openUnityYamlMonoBehaviourScript');
      assert.strictEqual(
        normalizeFsPath(scriptFsPath),
        normalizeFsPath(join(root.fsPath, 'Assets', 'Scripts', 'Interactable.cs'))
      );
      const openedStat = await withStep('stat MonoBehaviour script target', async () =>
        await vscode.workspace.fs.stat(vscode.Uri.file(scriptFsPath))
      );
      assert.strictEqual(openedStat.type, vscode.FileType.File);
    } finally {
      cancellation.dispose();
      metadataIndex.dispose();
    }
  });
});

interface RequiredCSharpMembers {
  typeFullName: string;
  fields: readonly RequiredFieldMember[];
  methods: readonly RequiredMethodMember[];
}

interface RequiredFieldMember {
  name: string;
  detailIncludes: string;
  line: number;
  character: number;
}

interface RequiredMethodMember {
  name: string;
  line: number;
  character: number;
}

interface ProviderMemberSnapshot {
  kind: vscode.SymbolKind;
  name: string;
  detail: string;
  fullTypeName?: string;
  range: vscode.Range;
}

/** Executes VS Code's real CodeLens provider command and normalizes missing results. */
async function executeCodeLensProvider(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return await vscode.commands.executeCommand<vscode.CodeLens[] | undefined>(
    'vscode.executeCodeLensProvider',
    uri
  ) ?? [];
}

/** Waits for the async C# symbol refresh behind the real CodeLens provider to publish UnityEvent lenses. */
async function waitForUnityEventCodeLenses(
  uri: vscode.Uri,
  expected: { method: boolean; methodInvokerField?: boolean; field: boolean; fieldTarget: boolean }
): Promise<vscode.CodeLens[]> {
  const timeoutAt = Date.now() + 30_000;
  let lastLenses: vscode.CodeLens[] = [];

  while (Date.now() < timeoutAt) {
    lastLenses = await executeCodeLensProvider(uri);
    const hasMethodLens = lastLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'method');
    const hasMethodInvokerLens = lastLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'methodInvokerField');
    const hasFieldLens = lastLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'field');
    const hasFieldTargetLens = lastLenses.some(lens => lens.command?.arguments?.[0]?.kind === 'fieldTarget');
    if ((!expected.method || hasMethodLens) &&
      (!expected.methodInvokerField || hasMethodInvokerLens) &&
      (!expected.field || hasFieldLens) &&
      (!expected.fieldTarget || hasFieldTargetLens)) {
      return lastLenses;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  assert.fail(
    `Timed out waiting for UnityEvent CodeLens. ` +
    `Last lenses: ${lastLenses.map(lens => lens.command?.title ?? '<unresolved>').join(', ') || '<none>'}. ` +
    `C# readiness: ${JSON.stringify(getCSharpProviderReadinessState() ?? {})}.`
  );
}

/** Waits for the activated extension's YAML CodeLens provider to resolve metadata. */
async function waitForMonoBehaviourScriptCodeLens(uri: vscode.Uri, title: string): Promise<vscode.CodeLens[]> {
  const timeoutAt = Date.now() + 30_000;
  let lastLenses: vscode.CodeLens[] = [];

  while (Date.now() < timeoutAt) {
    lastLenses = await executeCodeLensProvider(uri);
    if (lastLenses.some(lens => lens.command?.title === title)) {
      return lastLenses;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  assert.fail(`Timed out waiting for ${title}. Last lenses: ${lastLenses.map(lens => lens.command?.title ?? '<unresolved>').join(', ') || '<none>'}.`);
}

/** Normalizes Windows drive casing so URI round-trips do not make assertions flaky. */
function normalizeFsPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Reads the script filesystem path returned by the YAML CodeLens command. */
function toFsPathFromCommandArgument(argument: unknown): string {
  if (typeof argument !== 'string') {
    assert.fail(`Expected script path string argument. Argument: ${JSON.stringify(argument)}`);
  }
  return argument;
}

/** Adds test-step context to opaque VS Code command-service failures. */
async function withStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const details = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${step} failed: ${details}`);
  }
}

/** Waits until the real C# provider returns the exact member ranges used by UnityEvent CodeLens. */
async function waitForRequiredCSharpMembers(uri: vscode.Uri, required: RequiredCSharpMembers): Promise<void> {
  const startedAt = Date.now();
  const timeoutAt = startedAt + csharpReadinessTimeoutMs;
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });

  const csharpLanguageService = createVscodeCSharpLanguageService(vscode);
  let namespaceOnlySince: number | undefined;
  let nextLogAt = startedAt + csharpReadinessLogIntervalMs;
  let lastMembers: ProviderMemberSnapshot[] = [];
  let lastRawSymbols: unknown[] = [];
  let lastServiceError: string | undefined;
  let lastMissing: string[] = [];

  while (Date.now() < timeoutAt) {
    const now = Date.now();
    const symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
      'vscode.executeDocumentSymbolProvider',
      document.uri
    ) ?? [];
    lastRawSymbols = describeProviderSymbolShape(symbols);
    lastMembers = collectProviderMembers(symbols);

    try {
      await assertCSharpServiceCanResolveMembers(csharpLanguageService, uri, required);
      lastServiceError = undefined;
      return;
    } catch (error) {
      lastServiceError = error instanceof Error ? error.message : String(error);
    }

    lastMissing = findMissingRequiredMembers(lastMembers, required);
    if (lastMissing.length === 0 && !lastServiceError) {
      return;
    }

    namespaceOnlySince = containsOnlyNamespaceSymbols(symbols)
      ? namespaceOnlySince ?? now
      : undefined;

    if (namespaceOnlySince !== undefined && Date.now() - namespaceOnlySince >= csharpNamespaceOnlyFastFailMs) {
      failCSharpReadiness(uri, required, lastMissing, lastMembers, lastRawSymbols, lastServiceError);
    }

    if (Date.now() >= nextLogAt) {
      console.log(
        `[csharp readiness] waiting for ${formatRequiredMembers(required)} after ${Math.round((Date.now() - startedAt) / 1000)}s. ` +
        `Missing: ${lastMissing.join(', ') || '<none>'}. ` +
        `Provider members: ${lastMembers.map(member => `${member.fullTypeName ?? '<global>'}.${member.name}`).join(', ') || '<none>'}. ` +
        `Service error: ${lastServiceError ?? '<none>'}.`
      );
      nextLogAt = Date.now() + csharpReadinessLogIntervalMs;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  failCSharpReadiness(uri, required, lastMissing, lastMembers, lastRawSymbols, lastServiceError);
}

/** Verifies the production language-service adapter sees the same required members. */
async function assertCSharpServiceCanResolveMembers(
  csharpLanguageService: ReturnType<typeof createVscodeCSharpLanguageService>,
  uri: vscode.Uri,
  required: RequiredCSharpMembers
): Promise<void> {
  const types = await csharpLanguageService.findTypes(uri);
  assert.ok(types.some(type => matchesCSharpTypeName(type.fullName, required.typeFullName)), `missing type ${required.typeFullName}`);

  if (required.fields.length > 0) {
    const fields = await csharpLanguageService.findUnityEventFields(uri, required.fields.map(field => field.name));
    for (const field of required.fields) {
      assert.ok(fields.some(candidate =>
        candidate.name === field.name &&
        candidate.range.start.line === field.line &&
        candidate.range.start.character === field.character
      ), `missing field ${required.typeFullName}.${field.name} at ${field.line}:${field.character}`);
    }
  }

  for (const method of required.methods) {
    const positions = await csharpLanguageService.findTargetMethodPosition(uri, required.typeFullName, method.name);
    assert.ok(positions.some(position =>
      position.line === method.line &&
      position.character === method.character
    ), `missing method ${required.typeFullName}.${method.name} at ${method.line}:${method.character}`);
  }
}

/** Collects member-level symbols with their nearest type full name. */
function collectProviderMembers(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): ProviderMemberSnapshot[] {
  const members: ProviderMemberSnapshot[] = [];
  for (const symbol of symbols) {
    if (isSymbolInformation(symbol)) {
      if (symbol.kind === vscode.SymbolKind.Field || symbol.kind === vscode.SymbolKind.Method) {
        members.push({
          kind: symbol.kind,
          name: normalizeSymbolName(symbol.name),
          detail: '',
          fullTypeName: normalizeContainerName(symbol.containerName),
          range: symbol.location.range
        });
      }
      continue;
    }

    collectDocumentSymbolMembers(symbol, [], members);
  }

  return members;
}

/** Recursively walks document symbols so readiness is based on real member ranges. */
function collectDocumentSymbolMembers(
  symbol: vscode.DocumentSymbol,
  ancestors: readonly vscode.DocumentSymbol[],
  members: ProviderMemberSnapshot[]
): void {
  if (symbol.kind === vscode.SymbolKind.Field || symbol.kind === vscode.SymbolKind.Method) {
    members.push({
      kind: symbol.kind,
      name: normalizeSymbolName(symbol.name),
      detail: symbol.detail,
      fullTypeName: findNearestTypeFullName(ancestors),
      range: symbol.selectionRange
    });
  }

  for (const child of symbol.children) {
    collectDocumentSymbolMembers(child, [...ancestors, symbol], members);
  }
}

/** Finds which concrete declarations are still missing from raw provider symbols. */
function findMissingRequiredMembers(members: readonly ProviderMemberSnapshot[], required: RequiredCSharpMembers): string[] {
  const missing: string[] = [];
  for (const field of required.fields) {
    if (!members.some(member =>
      member.kind === vscode.SymbolKind.Field &&
      member.name === field.name &&
      matchesCSharpTypeName(member.fullTypeName ?? '', required.typeFullName) &&
      member.detail.includes(field.detailIncludes) &&
      member.range.start.line === field.line &&
      member.range.start.character === field.character
    )) {
      missing.push(`field:${required.typeFullName}.${field.name}@${field.line}:${field.character}`);
    }
  }

  for (const method of required.methods) {
    if (!members.some(member =>
      member.kind === vscode.SymbolKind.Method &&
      member.name === method.name &&
      matchesCSharpTypeName(member.fullTypeName ?? '', required.typeFullName) &&
      member.range.start.line === method.line &&
      member.range.start.character === method.character
    )) {
      missing.push(`method:${required.typeFullName}.${method.name}@${method.line}:${method.character}`);
    }
  }

  return missing;
}

/** Converts nested namespace/type ancestors into a full C# type name. */
function findNearestTypeFullName(ancestors: readonly vscode.DocumentSymbol[]): string | undefined {
  const namespaces = ancestors
    .filter(ancestor => ancestor.kind === vscode.SymbolKind.Namespace)
    .map(ancestor => normalizeSymbolName(ancestor.name));
  const type = [...ancestors].reverse().find(ancestor =>
    ancestor.kind === vscode.SymbolKind.Class ||
    ancestor.kind === vscode.SymbolKind.Struct ||
    ancestor.kind === vscode.SymbolKind.Interface ||
    ancestor.kind === vscode.SymbolKind.Enum
  );

  return type ? [...namespaces, normalizeSymbolName(type.name)].filter(Boolean).join('.') : undefined;
}

/** Checks whether the provider is still reporting only namespace containers. */
function containsOnlyNamespaceSymbols(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): boolean {
  if (symbols.length === 0) {
    return false;
  }

  return symbols.every(symbol => {
    if (symbol.kind !== vscode.SymbolKind.Namespace) {
      return false;
    }

    return isSymbolInformation(symbol) ||
      symbol.children.length === 0 ||
      containsOnlyNamespaceSymbols(symbol.children);
  });
}

/** Formats provider symbols without dumping full VS Code object graphs. */
function describeProviderSymbolShape(symbols: readonly (vscode.DocumentSymbol | vscode.SymbolInformation)[]): unknown[] {
  return symbols.map(symbol => {
    if (isSymbolInformation(symbol)) {
      return {
        name: symbol.name,
        kind: symbol.kind,
        containerName: symbol.containerName,
        range: describeRange(symbol.location.range)
      };
    }

    return {
      name: symbol.name,
      kind: symbol.kind,
      detail: symbol.detail,
      range: describeRange(symbol.range),
      selectionRange: describeRange(symbol.selectionRange),
      children: describeProviderSymbolShape(symbol.children)
    };
  });
}

/** Formats a VS Code range into a JSON-friendly object for failure messages. */
function describeRange(range: vscode.Range): unknown {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

/** Fails readiness with raw provider shape and adapter status. */
function failCSharpReadiness(
  uri: vscode.Uri,
  required: RequiredCSharpMembers,
  missing: readonly string[],
  members: readonly ProviderMemberSnapshot[],
  rawSymbols: readonly unknown[],
  serviceError: string | undefined
): never {
  assert.fail(
    `C# provider did not expose required member ranges for ${uri.fsPath}. ` +
    `Expected: ${formatRequiredMembers(required)}. ` +
    `Missing: ${missing.join(', ') || '<none>'}. ` +
    `Members: ${members.map(member => `${member.fullTypeName ?? '<global>'}.${member.name}@${member.range.start.line}:${member.range.start.character}`).join(', ') || '<none>'}. ` +
    `Service error: ${serviceError ?? '<none>'}. ` +
    `C# readiness: ${JSON.stringify(getCSharpProviderReadinessState() ?? {})}. ` +
    `Raw symbols: ${JSON.stringify(rawSymbols)}.`
  );
}

/** Creates a human-readable readiness target summary. */
function formatRequiredMembers(required: RequiredCSharpMembers): string {
  return [
    required.typeFullName,
    ...required.fields.map(field => `field:${field.name}@${field.line}:${field.character}`),
    ...required.methods.map(method => `method:${method.name}@${method.line}:${method.character}`)
  ].join(', ');
}

/** Checks for SymbolInformation without relying on instanceof across extension-host boundaries. */
function isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
  return 'location' in symbol;
}

/** Normalizes C# provider labels such as Fire() and trailing namespace dots. */
function normalizeSymbolName(name: string): string {
  return name.replace(/\(.*\)$/, '').replace(/\.$/, '');
}

/** Normalizes provider container names to match full type names. */
function normalizeContainerName(name: string | undefined): string | undefined {
  return name?.replace(/\.$/, '');
}

/** Compares provider full names by exact name or by the final C# type segment. */
function matchesCSharpTypeName(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase() ||
    actual.split('.').at(-1)?.toLowerCase() === expected.split('.').at(-1)?.toLowerCase();
}

/** Creates the serialized-instance runtime view over the same fixture services. */
function createSerializedFixtureRuntime(runtime: EventReferenceRuntime): SerializedInstancesRuntime {
  return {
    runtimeVscode: runtime.runtimeVscode,
    logger: runtime.logger,
    metadataIndex: runtime.metadataIndex,
    findAssetFiles: runtime.findAssetFiles,
    readTextFile: runtime.readTextFile,
    yamlAssets: runtime.yamlAssets,
    getCacheVersion: runtime.getCacheVersion
  };
}

/** Creates a runtime that uses the real VS Code C# provider and real Unity fixture files. */
function createRealEventReferenceRuntime(metadataIndex: EventReferenceRuntime['metadataIndex']): EventReferenceRuntime {
  const logger = createMemoryLogger();
  return {
    runtimeVscode: vscode,
    logger,
    metadataIndex,
    findAssetFiles: findDefaultAssetFiles,
    findCSharpFiles: findDefaultCSharpFiles,
    readTextFile: readDefaultTextFile,
    yamlAssets: createSharedUnityYamlAssetHandler({
      root: metadataIndex.root,
      runtimeVscode: vscode,
      logger,
      findAssetFiles: findDefaultAssetFiles,
      readTextFile: readDefaultTextFile
    }),
    getCacheVersion: () => 0,
    csharpLanguageService: createVscodeCSharpLanguageService(vscode)
  };
}

/** Creates a controller whose index is intentionally not ready. */
function createNotReadyEventIndexController(runtimeVscode: typeof vscode): UnityEventReferenceIndexController {
  const emitter = new runtimeVscode.EventEmitter<void>();
  return {
    onDidChangeCodeLenses: emitter.event,
    getStatus: () => 'building',
    getReadyIndex: () => undefined,
    scheduleBuild: () => undefined,
    forceBuild: async () => undefined,
    notifyCodeLensesChanged: () => emitter.fire(),
    dispose: () => emitter.dispose()
  };
}

/** Creates a controller whose index is already built for deterministic CodeLens provider checks. */
function createReadyEventIndexController(
  index: UnitySerializedAssetReferenceIndex,
  runtimeVscode: typeof vscode
): UnityEventReferenceIndexController {
  const emitter = new runtimeVscode.EventEmitter<void>();
  return {
    onDidChangeCodeLenses: emitter.event,
    getStatus: () => 'ready',
    getReadyIndex: () => index,
    scheduleBuild: () => undefined,
    forceBuild: async () => index,
    notifyCodeLensesChanged: () => emitter.fire(),
    dispose: () => emitter.dispose()
  };
}

/** Creates a quiet logger for integration fixtures. */
function createMemoryLogger(): UnityPlusLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    dispose: () => undefined
  };
}
