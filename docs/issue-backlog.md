# Unity Plus Issue Backlog

This file mirrors the initial GitHub issue plan while the repository is private and connector access is being configured.

## Status snapshot

Updated: 2026-07-07

Source: GitHub issue state from `minerva-studio/unity-plus`, plus local code and test inspection.

Validation note: `npm run compile` and `npm test` pass locally. `npm run lint` passes cleanly with no warnings.

Local assessment counts: Complete 21, Not started 1, Not planned 1.

| Issue | GitHub state | Local assessment | Notes |
| --- | --- | --- | --- |
| #1 | Closed | Complete | Scaffold and package scripts are present. |
| #2 | Closed | Complete | Unity workspace detector and tests are present. |
| #3 | Closed | Complete | Shared `Unity Plus` logger is present. |
| #4 | Closed | Complete | README includes the `Why Unity Plus` section. |
| #5 | Closed | Complete | README includes roadmap and limitations. |
| #6 | Closed | Complete | `.github/workflows/ci.yml` exists. |
| #7 | Closed | Complete | Metadata index maps GUIDs and watches `.meta` changes. |
| #8 | Closed | Complete | C# type detector covers Unity types. |
| #9 | Closed | Complete | Class-to-file rename path is implemented and tested. |
| #10 | Closed | Not planned | File-rename-event-to-class-update is no longer planned; rename sync stays class-to-file. |
| #11 | Closed | Complete | Rename sync now supports matching primary top-level C# type/file pairs, including `ScriptableObject`, while preserving namespaces. |
| #12 | Closed | Complete | Explicit safety preview shows affected class, script file, and Unity meta file before applying the rename. |
| #13 | Closed | Complete | `unityPlus.refreshProjectFiles` scans root `.csproj` files, removes stale script includes, and reports scanned/updated counts; Unity regeneration bridge remains out of scope. |
| #14 | Closed | Complete | Watches C# create/delete/rename, creates missing script `.meta` files, and directly updates asmdef-backed `.csproj` compile includes. |
| #15 | Closed | Complete | Missing compile entries are added for asmdef-backed scripts and default `Assembly-CSharp`/`Assembly-CSharp-Editor` fallback projects; missing fallback projects show actionable warnings. |
| #16 | Closed | Complete | Scene/prefab scanner is implemented and covered by passing event-reference tests. |
| #17 | Closed | Complete | CodeLens provider is implemented, respects `unityPlus.eventReferences.enabled`, and is covered by passing tests. |
| #18 | Closed | Complete | Hover details include scene/prefab path, GameObject, component, and event field information in passing tests. |
| #19 | Closed | Complete | Prefab scanning resolves target scripts through metadata/type lookup and appears in CodeLens/hover output. |
| #20 | Closed | Complete | `unityPlus.rescanUnityProject` rebuilds metadata (logging GUID/error counts), invalidates the event-reference cache version, and triggers a fresh background scan that logs resolved reference count and elapsed time. |
| #21 | Closed | Complete | `test-fixtures/` contains a real fixture Unity project with `Assets/Prefabs/Gate.prefab`, `Assets/Scripts/*.cs` with `.meta` files, `ProjectSettings/ProjectVersion.txt`, and `Packages/manifest.json`. Integration tests in `src/test/suite/` use `getUnityFixtureRoot()` to resolve the fixture workspace. |
| #22 | Closed | Complete | `src/test/suite/renameSync.test.ts` provides rename coverage across pure functions, real filesystem operations, real VS Code command registration, and real C# provider routing with the fixture project. |
| #23 | Open | Not started | No private-to-public checklist document was found. |

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

Status: Not planned. Rename sync intentionally stays class-to-file instead of updating source after file rename events.

Acceptance criteria:
- Detects `.cs` file rename events.
- Updates the primary Unity class name.
- Shows a safe preview before editing source.

## 11. [feature] Handle ScriptableObject class/file rename

Extend rename sync to `ScriptableObject` workflows.

Status: Complete. The current rename sync path supports any matching primary top-level C# type/file pair, including `ScriptableObject` classes.

Acceptance criteria:
- Supports `ScriptableObject` classes.
- Preserves namespaces.
- Does not modify unrelated classes.

## 12. [feature] Add rename safety preview

Preview rename edits before applying them.

Status: Complete. The explicit rename command previews the affected class, script file, and Unity meta file after preflight and before applying the workspace edit; canceling the preview stops the rename without falling back.

Acceptance criteria:
- Shows affected file and class.
- Allows canceling.
- Explains unsafe cases clearly.

## 13. [feature] Refresh csproj/sln manually

Provide a manual project file refresh command.

Status: Complete. `unityPlus.refreshProjectFiles` scans Unity root `.csproj` files, removes stale script includes for missing `.cs` files, logs scanned/updated project counts, and warns on read/update failures. Unity regeneration and C# server refresh remain out of scope for this issue.

Acceptance criteria:
- `unityPlus.refreshProjectFiles` scans Unity root `.csproj` files.
- Removes stale `<Compile Include>` entries that point to missing `.cs` files.
- Logs scanned/updated project counts and actionable read/update failures.

## 14. [feature] Auto refresh csproj on C# create/move/delete

Refresh project files when C# file structure changes.

Acceptance criteria:
- Watches `.cs` create/delete/rename under `Assets` and embedded `Packages`.
- Creates missing `.cs.meta` files with standard `MonoImporter` metadata.
- Adds created scripts to the nearest asmdef-backed `.csproj`.
- Rewrites or removes existing compile entries on move/rename/delete.
- Respects `unityPlus.projectFiles.autoRefresh`.

## 15. [feature] Detect stale csproj entries

Warn when project files appear stale.

Status: Complete. Manual refresh/delete handling removes stale script includes, create handling adds missing compile entries for asmdef-backed scripts, and Assets scripts without asmdefs now fallback to Unity default assembly projects. Scripts under an `Editor` path segment use `Assembly-CSharp-Editor.csproj`; other loose Assets scripts use `Assembly-CSharp.csproj`. Missing fallback projects are skipped with a warning that the class may have been created in the wrong folder.

Acceptance criteria:
- Detects references to deleted scripts during manual refresh/delete handling.
- Adds missing compile entries for new scripts when an asmdef-backed project or Unity default assembly fallback project can be resolved.
- Offers refresh command with actionable warnings when project files cannot be updated.

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

Status: Complete. `unityPlus.rescanUnityProject` rebuilds the metadata index (logging found/parsed/malformed GUID counts and read errors), invalidates the event-reference cache version, and triggers a fresh background scan. The background scan logs resolved reference count and elapsed time to the output channel and updates the status bar.

Acceptance criteria:
- `unityPlus.rescanUnityProject` rebuilds caches.
- Watchers invalidate affected entries.
- Rescan logs summary counts.

## 21. [test] Add fixture Unity project

Add a small Unity-like fixture for repeatable tests.

Status: Complete. `test-fixtures/` contains a real fixture Unity project with `Assets/Prefabs/Gate.prefab` (Unity YAML with persistent calls), `Assets/Scripts/*.cs` with `.meta` files, `ProjectSettings/ProjectVersion.txt`, `Packages/manifest.json`, and `UnityEventFixture.sln`. Integration tests in `src/test/suite/` resolve the fixture root via `getUnityFixtureRoot()`.

Acceptance criteria:
- Fixture includes scripts, metadata, scene YAML, and prefab YAML.
- Fixture is small enough for source control.

## 22. [test] Add integration tests for rename flows

Cover rename behavior end to end.

Status: Complete. `src/test/suite/renameSync.test.ts` covers pure function logic (plan, invert), real filesystem operations (temp directories), real VS Code command registration, and real C# provider routing using the fixture project. All rename tests pass against real VS Code APIs — no mock-based C# semantics.

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

---

## Beyond the original backlog

The following features have been implemented since the initial 23-issue plan but are not yet tracked as individual GitHub issues:

- **Serialized Instances** (`src/features/serialized-instances/`): CodeLens, diagnostics, and reference locations for `MonoBehaviour` / `ScriptableObject` serialized instances in Unity YAML assets. Resolves instance scripts through GUID metadata and editor class identifier text search.
- **Unity YAML CodeLens** (`src/features/unity-yaml-code-lens/`): CodeLens provider that shows the associated C# MonoBehaviour script directly in `.unity`, `.prefab`, and `.asset` YAML files, with a command to open the script (`unityPlus.openUnityYamlMonoBehaviourScript`).
