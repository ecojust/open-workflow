# 第三方依赖与许可

Open Workflow 的原创代码按根目录 [LICENSE](LICENSE) 中的 MIT 许可提供。第三方软件分别适用自己的许可；本文件不把第三方代码的版权归于本项目。

## 应用依赖

直接依赖和版本见 `package.json` 与安装包元数据。JavaScript 的完整锁定树见 `package-lock.json`，Rust 的完整锁定树见 `src-tauri/Cargo.lock`。

| 软件 | 用途 | 许可 |
| --- | --- | --- |
| [Vue](https://github.com/vuejs/core) | 界面组件和状态 | MIT |
| [Tauri JavaScript API](https://github.com/tauri-apps/tauri) | 原生窗口和命令桥接 | MIT OR Apache-2.0 |
| [fflate](https://github.com/101arrowz/fflate) | 图形 XML 压缩页面解压 | MIT |

桌面直接 Rust 依赖包括 `tauri`、`tauri-plugin-dialog`、`tauri-build`、`serde`、`sha2`、`tempfile` 和 `base64`。Tauri 及其官方对话框插件采用 MIT OR Apache-2.0；其余依赖各自的许可证以对应 crate 的元数据和随附许可为准。本文件不是所有 Cargo 传递依赖或系统组件的完整许可审计。

## 开发和测试工具

| 软件 | 版本 | 声明许可 |
| --- | --- | --- |
| `@playwright/test` | 1.56.1 | Apache-2.0 |
| `@tauri-apps/cli` | 2.12.2 | MIT OR Apache-2.0 |
| `@types/node` | 24.7.0 | MIT |
| `@vitejs/plugin-vue` | 6.0.1 | MIT |
| `@xmldom/xmldom` | 0.9.12 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vite` | 7.3.7 | MIT |
| `vue-tsc` | 3.1.0 | MIT |

这些工具用于构建、类型检查或测试，不等同于应用运行时包含它们的全部功能。浏览器测试使用的 Chromium 和桌面系统 WebView 也各自受其供应方的许可条款约束。

## MIT 运行时依赖的版权与许可文本

Vue：Copyright (c) 2018-present, Yuxi (Evan) You。

fflate：Copyright (c) 2023 Arjun Barrett。

Tauri JavaScript API 的 MIT 许可：Copyright (c) 2017 - Present Tauri Apps Contributors。Tauri 的 SPDX 元数据同时列出：Copyright 2019-2025, The Tauri Programme in the Commons Conservancy。

以上版权声明对应的 MIT 条款如下；Tauri 也提供 Apache-2.0 许可选项，参见其发行包中的 `LICENSE-APACHE-2.0`。

```text
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

## 原创实现与兼容标识

场景模型、编辑交互、图表解析、布局与 SVG 绘制由本项目实现，不包含第三方编辑器、图表引擎或图形素材库。应用图标是本项目原创的节点与连线图形。文件扩展名和协议字段仅用于格式兼容，不表示官方合作、背书或完整兼容；详细范围见 [格式说明](docs/FORMATS.md)。
