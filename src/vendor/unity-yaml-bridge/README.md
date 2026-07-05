# Vendored Unity YAML Bridge Parser/Writer

This folder contains a scoped vendored copy of parser/writer code from:

- Repository: https://github.com/yulcat/unity-yaml-bridge
- Source commit: 1efafce4da2fcacd3e63f5c3151505cc8050d373
- Commit URL: https://github.com/yulcat/unity-yaml-bridge/commit/1efafce4da2fcacd3e63f5c3151505cc8050d373

Copied files:

- `types.ts`
- `unity-yaml-parser.ts`
- `unity-yaml-writer.ts`

Intentionally not copied:

- `.ubridge` compact reader/writer
- compact merge logic
- CLI
- path-reference editing helpers
- tests and samples

License evidence:

- Upstream `package.json` at the source commit declares `"license": "MIT"`.
- Upstream `README.md` at the source commit has a "License" section that states "MIT".
- Root upstream `LICENSE` was not present when vendored, so this repository records the evidence in `THIRD_PARTY_NOTICES.md`.

Local modifications:

- None at initial import.
