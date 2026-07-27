import type { UnityTestMode, UnityTestNode } from '../testModel';
import type { UnityCliTestCase } from './unityCliProtocol';

/** Builds the best-effort CLI hierarchy while preserving first-seen test order. */
export function buildUnityCliTestTree(
  projectRoot: string,
  mode: UnityTestMode,
  tests: readonly UnityCliTestCase[]
): readonly UnityTestNode[] {
  const projectName = getProjectName(projectRoot);
  const project = createNode(
    createNodeId(mode, 'project', projectName, projectName),
    projectName,
    'container',
    projectName,
    undefined,
    [],
    { kind: 'mode' }
  );
  const assemblies = new Map<string, MutableUnityTestNode>();

  for (const test of tests) {
    const assembly = getOrCreateChild(
      project,
      assemblies,
      test.assembly,
      createNodeId(mode, 'assembly', test.assembly, test.assembly),
      test.assembly,
      'container',
      undefined,
      test.assembly,
      { kind: 'assembly', value: test.assembly }
    );
    const fullNameWithoutArguments = test.parameterizedMethodFullName ?? test.fullName;
    const segments = fullNameWithoutArguments.split('.').filter(Boolean);
    const fixtureIndex = segments.length > 1 ? segments.length - 2 : -1;
    let parent = assembly;
    let parentFullName: string | undefined;

    for (let index = 0; index < Math.max(0, fixtureIndex); index += 1) {
      parentFullName = parentFullName ? `${parentFullName}.${segments[index]}` : segments[index];
      parent = getOrCreateChild(
        parent,
        new Map(parent.children.map(child => [child.label, child])),
        segments[index],
        createNodeId(mode, 'namespace', test.assembly, parentFullName),
        segments[index],
        'container',
        parentFullName,
        undefined,
        { kind: 'testName', value: parentFullName }
      );
    }

    const fixtureName = fixtureIndex >= 0 ? segments[fixtureIndex] : undefined;
    if (fixtureName) {
      const fixtureFullName = fullNameWithoutArguments
        .split('.')
        .slice(0, fixtureIndex + 1)
        .join('.');
      parent = getOrCreateChild(
        parent,
        new Map(parent.children.map(child => [child.label, child])),
        fixtureName,
        createNodeId(mode, 'fixture', test.assembly, fixtureFullName),
        fixtureName,
        'container',
        fixtureFullName,
        undefined,
        { kind: 'testName', value: fixtureFullName }
      );
    }

    if (test.parameterizedMethodFullName) {
      const methodName = segments.at(-1) ?? test.parameterizedMethodFullName;
      const method = getOrCreateChild(
        parent,
        new Map(parent.children.map(child => [child.label, child])),
        methodName,
        createNodeId(mode, 'method', test.assembly, test.parameterizedMethodFullName),
        methodName,
        'method',
        test.parameterizedMethodFullName,
        undefined,
        { kind: 'testName', value: test.parameterizedMethodFullName }
      );
      const leaf = getOrCreateChild(
        method,
        new Map(method.children.map(child => [child.label, child])),
        test.fullName,
        createNodeId(mode, 'case', test.assembly, test.fullName),
        test.label,
        'case',
        test.fullName,
        undefined,
        { kind: 'testName', value: test.fullName }
      );
      mergeNodeMetadata(leaf, test);
      continue;
    }

    const leaf = getOrCreateChild(
      parent,
      new Map(parent.children.map(child => [child.label, child])),
      test.fullName,
      createNodeId(mode, 'case', test.assembly, test.fullName),
      test.label,
      'case',
      test.fullName,
      undefined,
      { kind: 'testName', value: test.fullName }
    );
    mergeNodeMetadata(leaf, test);
  }

  return [project];
}

/** Extracts a short project directory name from either Windows or POSIX paths. */
function getProjectName(projectRoot: string): string {
  const trimmed = projectRoot.replace(/[\\/]+$/, '');
  const separator = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return separator >= 0 ? trimmed.slice(separator + 1) : trimmed;
}

/** Creates a stable node identifier from backend, mode, assembly, kind, and full name. */
function createNodeId(
  mode: UnityTestMode,
  kind: string,
  assembly: string,
  fullName: string
): string {
  return `unity-cli:${mode}:${assembly}:${kind}:${fullName}`;
}

/** Creates one mutable node used during ordered hierarchy construction. */
function createNode(
  id: string,
  label: string,
  kind: 'container' | 'method' | 'case',
  fullName: string | undefined,
  assembly: string | undefined,
  categories: string[],
  executionScope?: UnityTestNode['executionScope']
): MutableUnityTestNode {
  return {
    id,
    label,
    fullName,
    assembly,
    executionScope,
    kind,
    categories,
    explicit: false,
    children: []
  };
}

/** Finds or appends one child without changing its parent's first-seen order. */
function getOrCreateChild(
  parent: MutableUnityTestNode,
  lookup: Map<string, MutableUnityTestNode>,
  key: string,
  id: string,
  label: string,
  kind: 'container' | 'method' | 'case',
  fullName: string | undefined,
  assembly?: string,
  executionScope?: UnityTestNode['executionScope']
): MutableUnityTestNode {
  const existing = lookup.get(key);
  if (existing) {
    return existing;
  }
  const created = createNode(
    id,
    label,
    kind,
    fullName,
    assembly ?? parent.assembly,
    [],
    executionScope
  );
  parent.children.push(created);
  lookup.set(key, created);
  return created;
}

/** Merges categories and explicit state from duplicate CLI records. */
function mergeNodeMetadata(node: MutableUnityTestNode, test: UnityCliTestCase): void {
  for (const category of test.categories) {
    if (!node.categories.includes(category)) {
      node.categories.push(category);
    }
  }
  node.explicit ||= test.explicit;
}

type MutableUnityTestNode = {
  id: string;
  label: string;
  fullName?: string;
  assembly?: string;
  categories: string[];
  explicit: boolean;
  executionScope?: UnityTestNode['executionScope'];
  kind: 'container' | 'method' | 'case';
  children: MutableUnityTestNode[];
};
