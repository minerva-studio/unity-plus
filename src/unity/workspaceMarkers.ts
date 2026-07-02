export const unityWorkspaceMarkers = [
  'Assets',
  'ProjectSettings',
  'Packages/manifest.json'
];

export function hasUnityWorkspaceMarkers(paths: readonly string[]): boolean {
  const normalized = new Set(paths.map(path => path.replace(/\\/g, '/')));
  return unityWorkspaceMarkers.every(marker => normalized.has(marker));
}
