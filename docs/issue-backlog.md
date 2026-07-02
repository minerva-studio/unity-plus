# Unity Plus Issue Backlog

This file mirrors the initial GitHub issue plan while the repository is private and connector access is being configured.

## 1. [infra] Scaffold Unity Plus VS Code extension

Create the baseline VS Code extension project.

Acceptance criteria:
- TypeScript extension scaffold exists.
- `npm run compile`, `npm run lint`, and `npm test` pass.
- Core commands are registered in `package.json`.

## 2. [infra] Add Unity workspace detector

Detect Unity projects from canonical workspace markers.

Acceptance criteria:
- Detects `Assets`, `ProjectSettings`, and `Packages/manifest.json`.
- Exposes a shared detector for feature activation.
- Includes unit tests.

## 3. [infra] Add shared logging and output channel

Add a single logging surface for all Unity Plus features.

Acceptance criteria:
- Output channel is named `Unity Plus`.
- Logging level respects `unityPlus.logging.level`.
- Feature modules use the shared logger.

## 4. [docs] Write README with Why Unity Plus statement

Document the project motivation and the Unity VS Code maintenance gap.

Acceptance criteria:
- README includes `Why Unity Plus`.
- Tone is sharp but professional.
- Unity Technologies and Microsoft are named directly.

## 5. [docs] Add roadmap and known limitations

Document staged delivery and current boundaries.

Acceptance criteria:
- README includes roadmap sections for v0.1 through v0.4.
- Known limitations mention VS Code-only first prototype.

## 6. [infra] Add GitHub Actions CI

Run project checks on push and pull request.

Acceptance criteria:
- CI installs dependencies with `npm ci`.
- CI runs compile, lint, and tests.

## 7. [feature] Build Unity metadata index

Index Unity `.meta` files for GUID-based lookup.

Acceptance criteria:
- Maps GUID to asset path.
- Watches `.meta` create/change/delete events.
- Handles malformed metadata without breaking the extension.

## 8. [feature] Add C# Unity type detector

Detect Unity script types from C# source.

Acceptance criteria:
- Detects `MonoBehaviour`.
- Detects `ScriptableObject`.
- Handles namespaces and partial classes conservatively.

## 9. [feature] Auto rename file when Unity class is renamed

Keep Unity script file names aligned with primary Unity class names.

Acceptance criteria:
- Detects a Unity class rename.
- Renames the matching `.cs` file.
- Avoids automatic changes for multi-primary-class files.

## 10. [feature] Auto rename Unity class when file is renamed

Keep primary Unity class names aligned with file renames.

Acceptance criteria:
- Detects `.cs` file rename events.
- Updates the primary Unity class name.
- Shows a safe preview before editing source.

## 11. [feature] Handle ScriptableObject class/file rename

Extend rename sync to `ScriptableObject` workflows.

Acceptance criteria:
- Supports `ScriptableObject` classes.
- Preserves namespaces.
- Does not modify unrelated classes.

## 12. [feature] Add rename safety preview

Preview rename edits before applying them.

Acceptance criteria:
- Shows affected file and class.
- Allows canceling.
- Explains unsafe cases clearly.

## 13. [feature] Refresh csproj/sln manually

Provide a manual project file refresh command.

Acceptance criteria:
- `unityPlus.refreshProjectFiles` exists.
- The command logs what strategy was attempted.
- Failure messages are actionable.

## 14. [feature] Auto refresh csproj on C# create/move/delete

Refresh project files when C# file structure changes.

Acceptance criteria:
- Watches `.cs` create/delete/rename.
- Debounces repeated file events.
- Respects `unityPlus.projectFiles.autoRefresh`.

## 15. [feature] Detect stale csproj entries

Warn when project files appear stale.

Acceptance criteria:
- Detects missing compile entries.
- Detects references to deleted scripts.
- Offers refresh command.

## 16. [feature] UnityEvent reference scanner

Scan serialized Unity assets for persistent calls.

Acceptance criteria:
- Parses `.unity` scenes.
- Parses `.prefab` assets.
- Handles broken YAML documents without aborting the scan.

## 17. [feature] UnityEvent CodeLens provider

Show Unity event references above called methods.

Acceptance criteria:
- Adds CodeLens for methods referenced by Unity events.
- Shows reference count.
- Respects `unityPlus.eventReferences.enabled`.

## 18. [feature] UnityEvent hover details

Show detailed event reference information on hover.

Acceptance criteria:
- Shows scene or prefab path.
- Shows GameObject name when available.
- Shows component and event field when available.

## 19. [feature] Include prefab event references

Support prefab-based persistent calls.

Acceptance criteria:
- Scans prefabs under `Assets`.
- Resolves target scripts through metadata index.
- Includes prefab references in CodeLens and hover output.

## 20. [feature] Add rescan command and cache invalidation

Keep Unity indices fresh.

Acceptance criteria:
- `unityPlus.rescanUnityProject` rebuilds caches.
- Watchers invalidate affected entries.
- Rescan logs summary counts.

## 21. [test] Add fixture Unity project

Add a small Unity-like fixture for repeatable tests.

Acceptance criteria:
- Fixture includes scripts, metadata, scene YAML, and prefab YAML.
- Fixture is small enough for source control.

## 22. [test] Add integration tests for rename flows

Cover rename behavior end to end.

Acceptance criteria:
- Tests class-to-file rename.
- Tests file-to-class rename.
- Tests unsafe multi-class file behavior.

## 23. [release] Prepare private-to-public checklist

Define what must be true before opening the repo.

Acceptance criteria:
- Checklist includes README review.
- Checklist includes CI status.
- Checklist includes at least one working core feature.
