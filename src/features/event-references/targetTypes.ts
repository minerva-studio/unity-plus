/** Removes the assembly suffix from a serialized Unity type name. */
export function simplifyAssemblyTypeName(typeName: string): string {
  return typeName.split(',')[0]?.trim() ?? typeName;
}

/** Checks whether a serialized persistent-call target belongs to Unity itself. */
export function isUnityBuiltInTargetTypeName(typeName: string): boolean {
  const normalized = simplifyAssemblyTypeName(typeName);
  return normalized === 'UnityEngine' ||
    normalized.startsWith('UnityEngine.') ||
    normalized === 'UnityEditor' ||
    normalized.startsWith('UnityEditor.');
}
