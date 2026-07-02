import * as assert from 'assert';
import { normalize } from 'node:path';
import { planScriptFilenameSync } from '../features/rename/renameSync';

describe('renameSync', () => {
  it('plans a file rename when the primary Unity class is renamed', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      unityScript('PlayerController'),
      unityScript('HeroController')
    );

    assert.strictEqual(plan?.oldClassName, 'PlayerController');
    assert.strictEqual(plan?.newClassName, 'HeroController');
    assert.strictEqual(plan?.newFilePath, normalize('/Project/Assets/HeroController.cs'));
  });

  it('does not rename files that do not match the old class name', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/CustomName.cs'),
      unityScript('PlayerController'),
      unityScript('HeroController')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the file has multiple Unity primary classes', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      [
        'public class PlayerController : MonoBehaviour { }',
        'public class EnemyController : MonoBehaviour { }'
      ].join('\n'),
      [
        'public class HeroController : MonoBehaviour { }',
        'public class EnemyController : MonoBehaviour { }'
      ].join('\n')
    );

    assert.strictEqual(plan, undefined);
  });

  it('does not rename when the detected Unity type changes kind', () => {
    const plan = planScriptFilenameSync(
      normalize('/Project/Assets/PlayerController.cs'),
      'public class PlayerController : MonoBehaviour { }',
      'public class HeroController : ScriptableObject { }'
    );

    assert.strictEqual(plan, undefined);
  });
});

function unityScript(className: string): string {
  return `namespace Minerva.Gameplay { public class ${className} : MonoBehaviour { } }`;
}
