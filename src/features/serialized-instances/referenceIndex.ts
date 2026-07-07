import { createEmptySerializedInstanceDiagnostics } from './diagnostics';
import type {
  UnitySerializedInstanceDiagnostics,
  UnitySerializedInstanceIndex,
  UnitySerializedInstanceLocation
} from './model';

/** Builds an in-memory lookup index for serialized Unity object instances. */
export function createSerializedInstanceIndex(
  serializedInstances: readonly UnitySerializedInstanceLocation[] = [],
  diagnostics: UnitySerializedInstanceDiagnostics = createEmptySerializedInstanceDiagnostics()
): UnitySerializedInstanceIndex {
  const serializedInstancesByScriptPath = new Map<string, UnitySerializedInstanceLocation[]>();
  const serializedInstancesByScriptTypeName = new Map<string, UnitySerializedInstanceLocation[]>();

  for (const location of serializedInstances) {
    if (location.scriptPath) {
      appendMapValue(serializedInstancesByScriptPath, pathReferenceKey(location.scriptPath), location);
    }

    if (location.scriptTypeName) {
      appendMapValue(serializedInstancesByScriptTypeName, typeKey(location.scriptTypeName), location);
      const shortKey = typeKey(shortTypeName(location.scriptTypeName));
      if (shortKey !== typeKey(location.scriptTypeName)) {
        appendMapValue(serializedInstancesByScriptTypeName, shortKey, location);
      }
    }
  }

  const getSerializedInstances = (scriptPath: string, typeName?: string): readonly UnitySerializedInstanceLocation[] =>
    mergeUniqueReferences(
      scriptPath ? serializedInstancesByScriptPath.get(pathReferenceKey(scriptPath)) : undefined,
      typeName ? serializedInstancesByScriptTypeName.get(typeKey(typeName)) : undefined
    );

  return {
    /** Returns serialized MonoBehaviour instances by script path with type-name fallback. */
    getSerializedInstances(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName);
    },
    /** Counts serialized MonoBehaviour instances by script path with type-name fallback. */
    getSerializedInstanceCount(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName).length;
    },
    /** Returns the diagnostics accumulator associated with this index build. */
    getDiagnostics() {
      return diagnostics;
    }
  };
}

/** Appends one value into a multi-value lookup bucket. */
function appendMapValue<T>(map: Map<string, T[]>, key: string, value: T): void {
  const bucket = map.get(key) ?? [];
  bucket.push(value);
  map.set(key, bucket);
}

/** Combines path-based and type-based matches without duplicating shared objects. */
function mergeUniqueReferences<T>(first: readonly T[] | undefined, second: readonly T[] | undefined): readonly T[] {
  if (!first?.length) {
    return second ?? [];
  }

  if (!second?.length) {
    return first;
  }

  const merged: T[] = [];
  const seen = new Set<T>();
  for (const value of [...first, ...second]) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    merged.push(value);
  }

  return merged;
}

/** Normalizes script paths for case-insensitive Unity asset lookups. */
export function pathReferenceKey(scriptPath: string): string {
  return scriptPath.replace(/\\/g, '/').toLowerCase();
}

/** Normalizes managed type names for case-insensitive lookups. */
export function typeKey(typeName: string): string {
  return typeName.toLowerCase();
}

/** Returns the final segment of a namespace-qualified type name. */
function shortTypeName(typeName: string): string {
  return typeName.split('.').at(-1) ?? typeName;
}
