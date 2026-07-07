import * as assert from 'assert';
import * as vscode from 'vscode';
import { join } from 'node:path';
import { createVscodeCSharpLanguageService } from '../../unity/csharpLanguageService';
import { configureCSharpSolution, getCSharpProviderReadinessState, getUnityFixtureRoot } from './csharpProviderSetup';

/**
 * Integration tests for CSharpLanguageService.
 *
 * These tests use:
 * - Real vscode APIs (workspace.openTextDocument, commands.executeCommand)
 * - Real .cs files included in the fixture solution
 * - Real VS Code document symbol provider from the configured C# extension
 */

let fixtureRoot: vscode.Uri;
const csharpReadinessTimeoutMs = 60_000;
const csharpNamespaceOnlyFastFailMs = 20_000;
const csharpReadinessLogIntervalMs = 2_000;

/** Waits until the production C# service can report one expected type. */
async function waitForCSharpType(uri: vscode.Uri, expectedFullName: string): Promise<void> {
  const service = createVscodeCSharpLanguageService(vscode);
  const startedAt = Date.now();
  const timeoutAt = startedAt + csharpReadinessTimeoutMs;
  let namespaceOnlySince: number | undefined;
  let nextLogAt = startedAt + csharpReadinessLogIntervalMs;
  let lastTypes: string[] = [];
  let lastError: string | undefined;

  while (Date.now() < timeoutAt) {
    const now = Date.now();
    try {
      const types = await service.findTypes(uri);
      lastTypes = types.map(type => type.fullName);
      lastError = undefined;
      namespaceOnlySince = undefined;
      if (lastTypes.some(type => matchesCSharpTypeName(type, expectedFullName))) {
        return;
      }
    } catch (error) {
      // The provider can briefly return namespace-only symbols while loading.
      lastError = error instanceof Error ? error.message : String(error);
      namespaceOnlySince = isNamespaceOnlyProviderError(lastError)
        ? namespaceOnlySince ?? now
        : undefined;
    }

    if (namespaceOnlySince !== undefined && Date.now() - namespaceOnlySince >= csharpNamespaceOnlyFastFailMs) {
      failCSharpTypeReadiness(uri, expectedFullName, lastTypes, lastError);
    }

    if (Date.now() >= nextLogAt) {
      console.log(
        `[csharp readiness] waiting for ${expectedFullName} after ${Math.round((Date.now() - startedAt) / 1000)}s. ` +
        `Last types: ${lastTypes.join(', ') || '<none>'}. Last error: ${lastError ?? '<none>'}.`
      );
      nextLogAt = Date.now() + csharpReadinessLogIntervalMs;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  failCSharpTypeReadiness(uri, expectedFullName, lastTypes, lastError);
}

/** Checks for the production service's namespace-only provider contract error. */
function isNamespaceOnlyProviderError(message: string | undefined): boolean {
  return message?.includes('namespace-only symbols') ?? false;
}

/** Fails a C# type readiness wait with the last provider state. */
function failCSharpTypeReadiness(
  uri: vscode.Uri,
  expectedFullName: string,
  lastTypes: readonly string[],
  lastError: string | undefined
): never {
  assert.fail(
    `C# language service did not include ${expectedFullName} for ${uri.fsPath}. ` +
    `Last types: ${lastTypes.join(', ') || '<none>'}. ` +
    `Last error: ${lastError ?? '<none>'}. ` +
    `C# readiness: ${JSON.stringify(getCSharpProviderReadinessState() ?? {})}.`
  );
}

suite('csharpLanguageService - VS Code Document Symbol Integration', () => {
  let service: ReturnType<typeof createVscodeCSharpLanguageService>;

  suiteSetup(async function () {
    this.timeout(120_000);
    fixtureRoot = getUnityFixtureRoot();
    await configureCSharpSolution(fixtureRoot);
    service = createVscodeCSharpLanguageService(vscode);
  });

  test('can call executeDocumentSymbolProvider on a .cs file', async function () {
    this.timeout(120_000);
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'SymbolTest.cs'));

    await waitForCSharpType(uri, 'Minerva.Gameplay.SymbolTest');
    const primaryType = await service.getPrimaryTopLevelType(uri);

    assert.strictEqual(primaryType?.name, 'SymbolTest');
  });

  test('findTypes and primary type work for an unopened .cs file', async function () {
    this.timeout(120_000);
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'UnopenedGate.cs'));

    await waitForCSharpType(uri, 'Amlos.Fixtures.UnopenedGate');
    const types = await service.findTypes(uri);
    const primaryType = await service.getPrimaryTopLevelType(uri);

    assert.strictEqual(types.some(type => matchesCSharpTypeName(type.fullName, 'Amlos.Fixtures.UnopenedGate')), true);
    assert.strictEqual(primaryType?.name, 'UnopenedGate');
    assert.ok(primaryType?.nameRange, 'primary type range should come from C# provider symbols');
  });

  test('findReferences returns an array (may be empty)', async () => {
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'SymbolTest.cs'));

    const refs = await service.findReferences(uri, { line: 5, character: 13 });

    assert.ok(Array.isArray(refs), 'findReferences should return an array');
  });

  test('returns provider symbol positions for types and UnityEvent fields', async function () {
    this.timeout(120_000);
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));

    await waitForCSharpType(uri, 'Amlos.Control.Interact.Interactable');
    const types = await service.findTypes(uri);
    const fields = await service.findUnityEventFields(uri, ['OnCheckEnable']);

    assert.strictEqual(types.some(type => matchesCSharpTypeName(type.fullName, 'Amlos.Control.Interact.Interactable')), true);
    assert.ok(types[0].range, 'type range should come from C# provider symbols');
    assert.ok(fields.find(field => field.name === 'OnCheckEnable')?.range, 'UnityEvent field range should come from C# provider symbols');
  });

  test('returns provider symbol positions for target methods', async function () {
    this.timeout(120_000);
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'Interactable.cs'));

    await waitForCSharpType(uri, 'Amlos.Control.Interact.Interactable');
    const positions = await service.findTargetMethodPosition(uri, 'Amlos.Control.Interact.Interactable', 'Interact');

    assert.strictEqual(positions.some(position => position.line === 12 && position.character === 20), true);
  });

  test('throws when C# document symbols are unavailable', async () => {
    const uri = vscode.Uri.file(join(fixtureRoot.fsPath, 'Assets', 'Scripts', 'MissingFile.cs'));

    await assert.rejects(async () => await service.findTypes(uri));
  });
});

/** Compares provider full names by exact name or by the final C# type segment. */
function matchesCSharpTypeName(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase() ||
    actual.split('.').at(-1)?.toLowerCase() === expected.split('.').at(-1)?.toLowerCase();
}
