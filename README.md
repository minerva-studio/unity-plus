# Unity Plus

Unity Plus is a Unity + VS Code workflow repair kit.

[中文文档](README.zh-cn.md)

## Why Unity Plus

Unity developers using VS Code have been left with a second-class workflow for too long. Unity Technologies and Microsoft have maintained Unity support for VS Code far less seriously than the experience offered by Visual Studio or Rider. The result is predictable: abandoned plugins, broken workflows, stale project files, fragile rename behavior, and basic Unity-aware editor features scattered across tools that may or may not still work.

Unity Plus exists because this should not be every Unity developer's private maintenance burden.

## Features

### Rename Sync
- Auto rename `.cs` file when a `MonoBehaviour` or `ScriptableObject` class is renamed.
- Safety preview shows the affected class, script file, and `.meta` file before applying the rename.
- Supports `class`, `struct`, `enum`, `interface`, and `record` top-level types.
- Preserves namespaces; avoids unsafe multi-primary-class file changes.
- Configurable preview mode: silent, ask, or ask+warn.

### Project Sync
- Auto refresh `.csproj` files when `.cs` scripts are created, moved, or deleted.
- Creates missing `.cs.meta` files with correct `MonoImporter` metadata.
- Resolves the nearest `.asmdef` to add scripts to the correct assembly project.
- Falls back to `Assembly-CSharp` / `Assembly-CSharp-Editor` for scripts without asmdef.
- Manual refresh via `unityPlus.refreshProjectFiles` with scanned/updated counts.
- Stale compile entries are detected and removed on delete or manual refresh.

### Event References
- CodeLens shows UnityEvent reference counts above called methods in C# files.
- Hover reveals scene/prefab path, GameObject name, component, and event field details.
- Scans `.unity` scenes, `.prefab` assets, and `.asset` files for persistent calls.
- Resolves target scripts through the Unity metadata index (GUID → asset path).
- Status bar shows scan progress and final counts (references + serialized instances).
- Priority scan for the current script gives instant feedback while the background scan runs.

### Serialized Instances
- CodeLens shows `MonoBehaviour` / `ScriptableObject` serialized instance counts per script.
- Reference locations resolve via GUID metadata and editor class identifier text search.
- Diagnostics track resolved, unresolved, and deduplicated instance counts.

### Unity YAML CodeLens
- In `.unity`, `.prefab`, and `.asset` files: CodeLens links to the associated C# MonoBehaviour script.
- `unityPlus.openUnityYamlMonoBehaviourScript` command opens the script directly from YAML.

### Meta Files & Unity Integration
- `Open Meta File` command (`$(file-code)`) in the explorer context menu and editor title bar.
- `Open In Unity` command (`$(rocket)`) sends the selected asset to the Unity Editor via IDE messaging.
- Option to hide `.meta` files from the VS Code explorer (`unityPlus.metaFiles.hideInExplorer`).

### C# Script Creation
- `Create C# Script` and `Create ScriptableObject` from the explorer context menu.
- Customizable templates via `unityPlus.templates.*` settings.

## Requirements

- Install the VS Code extensions declared by Unity Plus: Microsoft's official Unity extension for VS Code (`VisualStudioToolsForUnity.vstuc`), C# Dev Kit (`ms-dotnettools.csdevkit`), and C# (`ms-dotnettools.csharp`).
- Enable Unity's official Visual Studio Editor package (`com.unity.ide.visualstudio`) in each Unity project. Unity Plus relies on that Editor-side package for project-file generation and Unity IDE messaging.

## Roadmap

- `v0.1 Foundation`: VS Code extension scaffold, Unity workspace detection, logging, and CI. ✅
- `v0.2 Rename Safety`: class/file sync for `MonoBehaviour` and `ScriptableObject`. ✅
- `v0.3 Project Sync`: manual and automatic Unity project file refresh. ✅
- `v0.4 Event References`: scene and prefab UnityEvent CodeLens, hover, serialized instances, and Unity YAML CodeLens. ✅

## Known Limitations

- Unity Plus starts as a VS Code extension only.
- A Unity Editor companion package is intentionally out of scope for the first private prototype.
- Rider and Visual Studio workflows are not targeted by this extension.
- Unity Plus depends on Microsoft's official Unity extension for VS Code, plus the Microsoft C# and C# Dev Kit extensions for language-service features. Unity projects also need the Unity `Visual Studio Editor` package enabled on the Editor side for project-file generation and Unity IDE messaging.

## Contributing

This repository starts private while the first working prototype is built. The issue tracker is the source of truth for planned work.

## Local Packaging

- Run `npm run package:vsix` to build `dist/unity-plus-<version>.vsix`.
- Run `npm run package:install` to build the VSIX and install it into VS Code for local testing.
- Set `CODE_CLI` to a custom VS Code CLI path if `code` is not available on `PATH`.
