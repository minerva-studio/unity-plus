# Third-Party Notices

## unity-yaml-bridge parser/writer

- Source: https://github.com/yulcat/unity-yaml-bridge
- Vendored commit: 1efafce4da2fcacd3e63f5c3151505cc8050d373
- Commit URL: https://github.com/yulcat/unity-yaml-bridge/commit/1efafce4da2fcacd3e63f5c3151505cc8050d373
- Vendored files: `types.ts`, `unity-yaml-parser.ts`, `unity-yaml-writer.ts`
- Excluded files: `.ubridge` compact format, compact merge logic, CLI, tests, and samples
- License evidence: upstream `package.json` declares MIT, and upstream `README.md` contains a "License" section stating MIT.

The upstream repository did not include a root `LICENSE` file at the vendored commit, so this notice records the package metadata and README license evidence used for the scoped copy.

## @vscode/ripgrep

- Source: https://github.com/microsoft/vscode-ripgrep
- Package: `@vscode/ripgrep` 1.18.0 and platform package `@vscode/ripgrep-win32-x64` 1.18.0
- Purpose: bundled ripgrep binary for fast Unity YAML candidate search.
- License: MIT, as declared by the package metadata. The package `LICENSE` files are included in the VSIX with the runtime dependency.

MIT License text:

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
