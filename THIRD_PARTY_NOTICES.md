# 第三方声明

QQ Agent Gateway 自有代码使用根目录 [MIT 许可证](LICENSE)。以下为 `package-lock.json` 锁定的运行依赖；Windows 程序包保留各依赖的原始许可文件，源码使用者通过 `npm ci` 获取相同依赖。

| 组件 | 锁定版本 | 许可 | 来源 |
| --- | --- | --- | --- |
| `@tencent-connect/qqbot-nodejs` | 1.0.5 | MIT | [Tencent QQ Bot Node.js SDK](https://github.com/tencent-connect/qqbot-nodejs) |
| `ws` | 8.22.0 | MIT | [ws](https://github.com/websockets/ws) |

当前锁文件不包含 SDK 的可选语音解码 peer 依赖或 `ws` 的可选原生加速 peer 依赖；此表不将它们描述为已随包分发。依赖版本变化时，应同步核对锁文件和本声明。

Node.js、Codex CLI、Codex 桌面与 QQ/OpenAI 服务由用户独立安装或使用，不包含在本项目源码或程序 ZIP 中；其许可证、商标和服务条款分别由对应提供者管理。本项目不代表这些提供者发布。

## Codex 协议测试夹具

源码包中的 `tests/fixtures/codex/reviewed-alpha6-protocol.json` 源自官方 Codex CLI `0.166.0-alpha.6` 导出的 app-server JSON schema，用于固定版本的离线协议测试。它不是执行证明，不包含登录、会话或用户数据，也不代表当前版本的全部协议。

上游是 [openai/codex](https://github.com/openai/codex)，采用 Apache-2.0。源码包保留 [Codex 上游 LICENSE](licenses/codex-LICENSE.txt) 与 [NOTICE](licenses/codex-NOTICE.txt)。Windows 程序包不分发测试夹具；自有适配代码与上游 schema 的许可分别适用。

## Tencent QQ Bot Node.js SDK

以下为所分发版本 `node_modules/@tencent-connect/qqbot-nodejs/LICENSE` 的许可声明：

```text
MIT License

Copyright (c) 2026 Tencent

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
```

## ws

以下为所分发版本 `node_modules/ws/LICENSE` 的许可声明：

```text
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
