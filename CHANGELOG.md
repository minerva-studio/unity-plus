# Changelog

All notable changes to Unity Plus are documented in this file.

## Unreleased

### Added

- Added explicit Unity Editor instance selection shared by Open In Unity and the Unity Test Runner.
- Added a `Select Unity Editor` command for changing the current live endpoint.

### Fixed

- Discover all responsive local Unity IDE messaging endpoints instead of treating the first response as the only global Editor.
- Revalidate the selected project endpoint before every operation and ask again when a Unity restart changes its PID-derived port.

## 0.5.1 - 2026-07-09

### Added

- Added visible progress while connecting to Unity and discovering EditMode and PlayMode tests.
- Added completion messages that report the discovered EditMode and PlayMode test counts.
- Added the native Testing view refresh handler alongside the Unity Plus refresh command.
- Added localized English and Simplified Chinese messages for Unity test discovery and unresponsive Editor states.

### Fixed

- Revalidate the Unity `ProjectPath` endpoint before every test refresh and run instead of trusting an open local UDP socket.
- Rebuild the persistent test bridge when a restarted Unity Editor moves to a different PID-derived port.
- Stop test discovery after an unresponsive timeout, preserve the previous test tree, and show one actionable warning instead of retrying forever.
- Wait for test completion, cancellation, or startup failure before resolving a test execution request.
- Treat `TestFinished` and `RunFinished` as proof that Unity started the run when a UDP start message was lost.
- Process the complete result tree carried by Unity's `RunFinished` message instead of incorrectly marking successful pending tests as errors.
- Invalidate UnityEvent method and field CodeLens ranges when the text document version changes.
- Discard stale C# provider results when an older asynchronous symbol request completes after a newer document version.

## 0.5.0 - 2026-07-08

### Added

- Added Unity Test Explorer integration for discovering EditMode and PlayMode tests through `com.unity.ide.visualstudio` messaging.
- Added test execution from the VS Code Testing view, including individual tests, suites, and multiple selections.
- Added Unity test result mapping for passed, failed, skipped, and inconclusive results.

### Changed

- Expanded parent selections into the Unity test scopes needed to run their leaf tests while preserving VS Code `TestItem` identities for reporting.

## 0.4.0 - 2026-07-07

### Added

- Added UnityEvent CodeLens for method references, UnityEvent fields, target methods, and invoker fields.
- Added CodeLens navigation for Unity serialized script instances and MonoBehaviour script references in Unity YAML assets.
- Added prefab override support and package-asset support for UnityEvent reference discovery.
- Added real VS Code C# provider integration tests for symbol ranges, references, rename behavior, and CodeLens rendering.
- Added an extension icon, expanded English and Simplified Chinese documentation, and clarified the project's independent status.

### Changed

- Moved C# semantic operations to VS Code/C# server providers and removed source-text semantic fallbacks.
- Improved UnityEvent scanning responsiveness with background indexing, targeted YAML parsing profiles, ripgrep prefiltering, and visible diagnostics.
- Split UnityEvent references, serialized instances, shared YAML handling, and C# language services into focused modules.

## 0.1.0 - 2026-07-03

### Added

- Added Unity workspace detection, shared logging, metadata GUID indexing, and VSIX packaging.
- Added C# type and script filename synchronization with Unity `.meta` preservation and undo support.
- Added configurable rename modes, preview controls, and optional atomic F2 rename handling.
- Added Unity C# project file synchronization and configurable asset/meta move handling.
- Added the initial UnityEvent reference scanner, Open In Unity command, meta-file navigation, and CodeLens support.
- Added Simplified Chinese localization and checks for the official Unity Visual Studio Editor package.

### Changed

- Made activation and UnityEvent indexing asynchronous to reduce startup and editor blocking.

## 0.0.1 - 2026-07-02

### Added

- Created the initial Unity Plus VS Code extension scaffold.
- Added the first workspace, packaging, CI, and test infrastructure.
