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

## Private CAH and ChatCMD references

The behavioral architecture draws on CAH principles. No private CAH source,
transport implementation, private research notes, or execution records are included.

[ChatCMD](https://github.com/int04/ChatCmd) was consulted as a permitted local
runtime implementation reference. No ChatCMD source file has been copied into
this version of deepseek-servant. Future source reuse must preserve the corresponding
license and attribution at the exact reused version.

## Package dependencies

The package manifest records direct and host peer dependencies. Their original
licenses continue to apply. The license terms of each dependency remain applicable. This repository does
not by itself grant rights to unrelated third-party software.
