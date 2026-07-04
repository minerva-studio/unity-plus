# Unity Plus

Unity Plus is a Unity + VS Code workflow repair kit.

## Why Unity Plus

Unity developers using VS Code have been left with a second-class workflow for too long. Unity Technologies and Microsoft have maintained Unity support for VS Code far less seriously than the experience offered by Visual Studio or Rider. The result is predictable: abandoned plugins, broken workflows, stale project files, fragile rename behavior, and basic Unity-aware editor features scattered across tools that may or may not still work.

Unity Plus exists because this should not be every Unity developer's private maintenance burden.

## Features

- Auto rename `MonoBehaviour` and `ScriptableObject` classes and files.
- Auto refresh project files when `.cs` files are created, moved, or deleted.
- Show UnityEvent references from scenes and prefabs inside C# files.

## Roadmap

- `v0.1 Foundation`: VS Code extension scaffold, Unity workspace detection, logging, and CI.
- `v0.2 Rename Safety`: class/file sync for `MonoBehaviour` and `ScriptableObject`.
- `v0.3 Project Sync`: manual and automatic Unity project file refresh.
- `v0.4 Event References`: scene and prefab UnityEvent CodeLens and hover support.

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
