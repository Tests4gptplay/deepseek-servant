# Third-party notices

## DeepSeek Harness

deepseek-servant uses DeepSeek Harness runtime services and external host peers.
The development API reference is `0.2.1-rc.2`; alpha.39 was exercised on the
Windows `0.2.1-rc.3` host. The exact earlier reference source is
[deepseek-ai/deepseek-harness, dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317).

The native browser module registration pattern follows the DSH client build
convention. DSH runtime packages remain external peer dependencies; deepseek-servant
does not vendor another copy of the host, its tool executor or its skill loader.

The browser bundle includes the native preset display resolver from
`@deepseek-ai/dsh-agent-preset-registry/display` under the MIT license below.
Preset choices and localized descriptions come from the running DSH host.

The history calendar adapts the official `ui-schedule/src/client/DatePicker.tsx`
and `DatePicker.module.css` calendar grid, keyboard interaction and month arithmetic.
It uses the host's shared Button, MenuSurface, anchored positioning and dismissal
primitives, with DSH theme tokens and Servant-localized history controls.
These adapted sources retain the following DeepSeek MIT license.

The referenced DSH source is licensed as follows:

MIT License

Copyright (c) 2026 DeepSeek

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

## Chat Agent Harness (CAH) — design lineage

DeepSeek Servant's agent workflow design extends the goal-oriented planning,
execution, evaluation, task-continuity, recovery, and skill-learning architecture
of [Chat Agent Harness (CAH)](https://github.com/Tests4gptplay/chat-agent-harness).
DeepSeek Servant implements this workflow using native DeepSeek Harness services.

CAH's public project is distributed under AGPL-3.0-only. DeepSeek Servant
adopts the same project license; the full text is in LICENSE and this project's
copyright notice is in NOTICE.

[ChatCMD](https://github.com/int04/ChatCmd) was consulted as a reference for
local-first task management. Its code is not part of the current package.
Future third-party source reuse will retain its original notices and license terms.

## Character artwork and icons

The character artwork follows the attribution chain **上善无形 → ZipZipPipe**.
The DeepSeek Servant project artwork is supplied and adapted by **Tests4gptplay**.
These visual assets and their adaptations are licensed separately under
**[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
(CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/)**.

Covered files: `icon.png`, `assets/page-icon.png`, `assets/statusbar-icon.png`,
`assets/statusbar-icon-black.png`, `assets/welcome-character.png`,
`assets/task-empty-character.png`, and
`docs/images/deepseek-servant-mascot.png`, including their copies embedded in the
built client. The user-selected navy whale-tail maid icon was supplied on
2026-10-25. The plugin adaptation scales it to 256 × 256 pixels and preserves
its original silhouette and transparency in the plugin list and page heading.
The sidebar icon and welcome illustration retain their existing artwork.
The task-page illustration uses the additional user-supplied full-body artwork
from 2026-10-25, adapted by removing its background and ground shadow.

Character reference and source index:
[AI-gijinka character atlas](https://github.com/Tests4gptplay/ai-gijinka-art-world/blob/main/CHARACTER_ATLAS.md).
Retain the attribution, indicate changes, use the artwork noncommercially, and
share adaptations under the same license. The project's code remains
AGPL-3.0-only.

## dsh-tool-git subprocess runner

`src/experimental/private-git/vendor/git-runner.ts` is copied from
[lxj808624/dsh-tool-git v0.1.3](https://github.com/lxj808624/dsh-tool-git/tree/v0.1.3)
and bundled into the Host, with operation timeouts and explicit timeout errors added.

MIT License

Copyright (c) 2026 dsh-tool-git contributors

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

## Package dependencies

The package manifest lists direct dependencies and DSH host peer dependencies.
Each dependency retains its own license and notice requirements.
