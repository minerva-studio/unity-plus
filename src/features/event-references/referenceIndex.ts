import { createEmptyDiagnostics } from './diagnostics';
import type {
  UnityEventReference,
  UnityEventReferenceDiagnostics,
  UnitySerializedAssetReferenceIndex,
  UnitySerializedInstanceLocation
} from './model';
import { isUnityBuiltInTargetTypeName } from './targetTypes';

/** Builds an in-memory lookup index for UnityEvent references and serialized instances. */
export function createReferenceIndex(
  references: readonly UnityEventReference[],
  serializedInstances: readonly UnitySerializedInstanceLocation[] = [],
  diagnostics: UnityEventReferenceDiagnostics = createEmptyDiagnostics()
): UnitySerializedAssetReferenceIndex {
  const referencesByKey = new Map<string, UnityEventReference[]>();
  const referencesByTypeKey = new Map<string, UnityEventReference[]>();
  const referencesByFieldKey = new Map<string, UnityEventReference[]>();
  const referencesByFieldTypeKey = new Map<string, UnityEventReference[]>();
  const targetReferencesByFieldKey = new Map<string, UnityEventReference[]>();
  const targetReferencesByFieldTypeKey = new Map<string, UnityEventReference[]>();
  const targetReferenceKeysByFieldKey = new Map<string, Set<string>>();
  const targetReferenceKeysByFieldTypeKey = new Map<string, Set<string>>();
  const serializedInstancesByScriptPath = new Map<string, UnitySerializedInstanceLocation[]>();
  const serializedInstancesByScriptTypeName = new Map<string, UnitySerializedInstanceLocation[]>();

  for (const reference of references) {
    if (reference.scriptPath) {
      const key = referenceKey(reference.scriptPath, reference.methodName);
      appendMapValue(referencesByKey, key, reference);
    }

    if (reference.scriptTypeName && !reference.scriptPath) {
      appendMapValue(referencesByTypeKey, typeReferenceKey(reference.scriptTypeName, reference.methodName), reference);
    }

    if (reference.eventScriptPath) {
      const fieldKey = referenceKey(reference.eventScriptPath, reference.eventFieldName);
      appendMapValue(referencesByFieldKey, fieldKey, reference);

      if (isProjectUnityEventTargetReference(reference)) {
        addTargetFieldReference(targetReferencesByFieldKey, targetReferenceKeysByFieldKey, fieldKey, reference);
      }
    }

    if (reference.eventOwnerTypeName) {
      const fieldTypeKey = fieldTypeReferenceKey(reference.eventOwnerTypeName, reference.eventFieldName);
      appendMapValue(referencesByFieldTypeKey, fieldTypeKey, reference);

      if (isProjectUnityEventTargetReference(reference)) {
        addTargetFieldReference(targetReferencesByFieldTypeKey, targetReferenceKeysByFieldTypeKey, fieldTypeKey, reference);
      }
    }
  }

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

  // Keep query functions close to the maps they read so each fallback path is easy to audit.
  const getReferences = (scriptPath: string, methodName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      referencesByKey.get(referenceKey(scriptPath, methodName)),
      typeName ? referencesByTypeKey.get(typeReferenceKey(typeName, methodName)) : undefined
    );
  const getFieldReferences = (scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      filterByType(referencesByFieldKey.get(referenceKey(scriptPath, fieldName)), typeName, reference => reference.eventOwnerTypeName),
      typeName ? referencesByFieldTypeKey.get(fieldTypeReferenceKey(typeName, fieldName)) : undefined
    );
  const getFieldTargets = (scriptPath: string, fieldName: string, typeName?: string): readonly UnityEventReference[] =>
    mergeUniqueReferences(
      filterByType(targetReferencesByFieldKey.get(referenceKey(scriptPath, fieldName)), typeName, reference => reference.eventOwnerTypeName),
      typeName ? targetReferencesByFieldTypeKey.get(fieldTypeReferenceKey(typeName, fieldName)) : undefined
    );
  const getSerializedInstances = (scriptPath: string, typeName?: string): readonly UnitySerializedInstanceLocation[] =>
    mergeUniqueReferences(
      scriptPath ? serializedInstancesByScriptPath.get(pathReferenceKey(scriptPath)) : undefined,
      typeName ? serializedInstancesByScriptTypeName.get(typeKey(typeName)) : undefined
    );

  return {
    /** Returns references to a target method by script path with type-name fallback. */
    getReferences(scriptPath, methodName, typeName) {
      return getReferences(scriptPath, methodName, typeName);
    },
    /** Counts references to a target method by script path with type-name fallback. */
    getReferenceCount(scriptPath, methodName, typeName) {
      return getReferences(scriptPath, methodName, typeName).length;
    },
    /** Returns persistent calls owned by a UnityEvent field. */
    getFieldReferences(scriptPath, fieldName, typeName) {
      return getFieldReferences(scriptPath, fieldName, typeName);
    },
    /** Counts persistent calls owned by a UnityEvent field. */
    getFieldReferenceCount(scriptPath, fieldName, typeName) {
      return getFieldReferences(scriptPath, fieldName, typeName).length;
    },
    /** Returns distinct project method targets declared by a UnityEvent field. */
    getFieldTargets(scriptPath, fieldName, typeName) {
      return getFieldTargets(scriptPath, fieldName, typeName);
    },
    /** Counts distinct project method targets declared by a UnityEvent field. */
    getFieldTargetCount(scriptPath, fieldName, typeName) {
      return getFieldTargets(scriptPath, fieldName, typeName).length;
    },
    /** Returns serialized MonoBehaviour instances by script path with type-name fallback. */
    getSerializedInstances(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName);
    },
    /** Counts serialized MonoBehaviour instances by script path with type-name fallback. */
    getSerializedInstanceCount(scriptPath, typeName) {
      return getSerializedInstances(scriptPath, typeName).length;
    },
    /** Returns the original reference list for broad operations such as location filtering. */
    getAllReferences() {
      return references;
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

/** Adds a target reference once per field and target method identity.
 *  When multiple references resolve to the same target method, the one with a
 *  resolvable scriptPath is preferred so that downstream C# location lookups
 *  have a concrete file to search. */
function addTargetFieldReference(
  referencesByFieldKey: Map<string, UnityEventReference[]>,
  seenReferencesByFieldKey: Map<string, Set<string>>,
  fieldKey: string,
  reference: UnityEventReference
): void {
  const targetKey = unityEventTargetIdentityKey(reference);
  if (!targetKey) {
    return;
  }

  const seenTargets = seenReferencesByFieldKey.get(fieldKey) ?? new Set<string>();
  if (seenTargets.has(targetKey)) {
    // Same field already contributed a reference for this target method.
    // Replace the stored reference when the new one carries a scriptPath that
    // the existing representative lacks, so that downstream lookups always
    // prefer the most-resolved YAML entry.
    if (reference.scriptPath) {
      const bucket = referencesByFieldKey.get(fieldKey);
      if (bucket) {
        const index = bucket.findIndex(
          r => unityEventTargetIdentityKey(r) === targetKey && !r.scriptPath
        );
        if (index !== -1) {
          bucket[index] = reference;
        }
      }
    }
    return;
  }

  appendMapValue(referencesByFieldKey, fieldKey, reference);
  seenTargets.add(targetKey);
  seenReferencesByFieldKey.set(fieldKey, seenTargets);
}

/** Checks whether a YAML persistent call names a project C# target method. */
function isProjectUnityEventTargetReference(reference: UnityEventReference): boolean {
  const targetTypeName = reference.targetTypeName || reference.scriptTypeName;
  return !!targetTypeName &&
    !!reference.methodName &&
    !isUnityBuiltInTargetTypeName(targetTypeName);
}

/** Creates a method-level target identity from YAML type and method names. */
function unityEventTargetIdentityKey(reference: UnityEventReference): string | undefined {
  if (!isProjectUnityEventTargetReference(reference)) {
    return undefined;
  }

  const targetTypeName = reference.targetTypeName || reference.scriptTypeName;
  return `${typeKey(targetTypeName ?? '')}#${reference.methodName}`;
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

/** Narrows fallback references to the requested owner type when type metadata exists. */
function filterByType<T>(
  references: readonly T[] | undefined,
  typeName: string | undefined,
  getTypeName: (reference: T) => string | undefined
): readonly T[] | undefined {
  if (!references || !typeName) {
    return references;
  }

  const requestedTypeKey = typeKey(typeName);
  return references.filter(reference => {
    const referenceTypeName = getTypeName(reference);
    return !referenceTypeName || typeKey(referenceTypeName) === requestedTypeKey;
  });
}

/** Creates a script-path and member-name lookup key. */
function referenceKey(scriptPath: string, methodName: string): string {
  return `${pathReferenceKey(scriptPath)}#${methodName}`;
}

/** Creates a type-name and method-name lookup key. */
function typeReferenceKey(typeName: string, methodName: string): string {
  return `${typeKey(typeName)}#${methodName}`;
}

/** Creates a type-name and field-name lookup key. */
function fieldTypeReferenceKey(typeName: string, fieldName: string): string {
  return `${typeKey(typeName)}#${fieldName}`;
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
