import * as assert from 'assert';
import { hasUnityWorkspaceMarkers } from '../unity/workspaceMarkers';

describe('workspaceDetector', () => {
  it('accepts a Unity project root with canonical markers', () => {
    assert.strictEqual(hasUnityWorkspaceMarkers([
      'Assets',
      'ProjectSettings',
      'Packages/manifest.json'
    ]), true);
  });

  it('rejects a non-Unity folder', () => {
    assert.strictEqual(hasUnityWorkspaceMarkers([
      'src',
      'package.json'
    ]), false);
  });
});
