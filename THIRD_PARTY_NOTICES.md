# Third-party notices

## DeepSeek Harness

deepseek-servant integrates with the published DeepSeek Harness packages at version
`0.2.1-rc.2`. The exact reference source is
[deepseek-ai/deepseek-harness, dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317).

The native browser module registration pattern follows the DSH client build
convention. DSH runtime packages remain external peer dependencies; deepseek-servant
does not vendor another copy of the host, its tool executor or its skill loader.

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

## Design and implementation references

The architecture draws on CAH's goal-oriented task continuity and agent role
separation. DeepSeek Servant implements this behavior through native DSH services.

[ChatCMD](https://github.com/int04/ChatCmd) was consulted as a reference for
local-first task management. Its code is not part of the current package.
Future third-party source reuse will retain its original notices and license terms.

## Package dependencies

The package manifest lists direct dependencies and DSH host peer dependencies.
Each dependency retains its own license and notice requirements.
