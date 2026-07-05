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

- Added parser-owned source location metadata for documents, properties, array items, and flow mapping fields.
- Added tolerant parsing for Unity object reference blocks such as `- m_Target:` followed by `fileID` fields.
- Reworked the parser runtime to use offset/span line indexing instead of whole-file `split`, copied document bodies, and second-pass source map scans.
- Added parser profiles; `eventReferences` materializes only CodeLens-relevant Unity YAML fields by default.
- The writer ignores source metadata because it is stored outside serialized `properties`.
