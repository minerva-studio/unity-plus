import * as assert from 'assert';
import { detectCSharpClasses, detectUnityScriptTypes } from '../unity/csharpTypeDetector';

describe('csharpTypeDetector', () => {
  it('detects MonoBehaviour classes', () => {
    const result = detectUnityScriptTypes([
      'using UnityEngine;',
      'public class PlayerController : MonoBehaviour',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 1);
    assert.strictEqual(result.types[0].name, 'PlayerController');
    assert.strictEqual(result.types[0].kind, 'MonoBehaviour');
    assert.strictEqual(result.isSafeForAutomaticRename, true);
  });

  it('detects ScriptableObject classes with qualified base type names', () => {
    const result = detectUnityScriptTypes([
      'public sealed class ItemDefinition : UnityEngine.ScriptableObject',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 1);
    assert.strictEqual(result.types[0].name, 'ItemDefinition');
    assert.strictEqual(result.types[0].kind, 'ScriptableObject');
  });

  it('preserves namespace names for detected Unity classes', () => {
    const result = detectUnityScriptTypes([
      'namespace Minerva.Gameplay',
      '{',
      '    public class EnemySpawner : MonoBehaviour',
      '    {',
      '    }',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 1);
    assert.strictEqual(result.types[0].namespace, 'Minerva.Gameplay');
  });

  it('marks partial Unity classes as safe only when they are the only Unity type', () => {
    const result = detectUnityScriptTypes([
      'public partial class QuestAsset : ScriptableObject',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 1);
    assert.strictEqual(result.types[0].isPartial, true);
    assert.strictEqual(result.isSafeForAutomaticRename, true);
  });

  it('handles multiple Unity classes conservatively', () => {
    const result = detectUnityScriptTypes([
      'public partial class PlayerController : MonoBehaviour',
      '{',
      '}',
      'public class EnemyController : MonoBehaviour',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 2);
    assert.strictEqual(result.isSafeForAutomaticRename, false);
  });

  it('ignores Unity class declarations inside comments and strings', () => {
    const result = detectUnityScriptTypes([
      '// public class CommentedOut : MonoBehaviour { }',
      'public class PlainUtility',
      '{',
      '    private const string Text = "class Fake : ScriptableObject { }";',
      '}'
    ].join('\n'));

    assert.strictEqual(result.types.length, 0);
    assert.strictEqual(result.isSafeForAutomaticRename, false);
  });

  it('detects ordinary C# classes for any-file rename mode', () => {
    const result = detectCSharpClasses([
      'namespace Minerva.Tools;',
      'public class PlainUtility',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.classes.length, 1);
    assert.strictEqual(result.classes[0].name, 'PlainUtility');
    assert.strictEqual(result.classes[0].namespace, 'Minerva.Tools');
    assert.deepStrictEqual(result.classes[0].baseTypes, []);
    assert.strictEqual(result.classes[0].unityKind, undefined);
    assert.strictEqual(result.isSafeForAutomaticRename, true);
  });

  it('handles multiple ordinary C# classes conservatively', () => {
    const result = detectCSharpClasses([
      'public class FirstUtility',
      '{',
      '}',
      'public class SecondUtility',
      '{',
      '}'
    ].join('\n'));

    assert.strictEqual(result.classes.length, 2);
    assert.strictEqual(result.isSafeForAutomaticRename, false);
  });
});
