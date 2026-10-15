# 桌面版

Open Workflow 使用 Vue / SVG 自研编辑界面和 Tauri 2 桌面外壳。前端资源随安装包分发，以 Tauri 本地资源协议加载；没有远程编辑器、内嵌网页应用或 Office 运行时。

## 开发与构建

需要 Node.js 24、Rust stable（最低 1.90）以及平台原生构建工具。Windows 使用 Visual Studio C++ Build Tools 和 WebView2；macOS 使用 Xcode Command Line Tools。Linux 开发还需要 Tauri 2 所需的 GTK / WebKitGTK 系统库。

```sh
npm ci
npm run desktop:dev
```

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
npm run desktop:build -- -- --locked
```

不具备桌面系统库时，可以独立运行文件读写测试：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features --lib
```

默认窗口为 1360 × 900，可缩至 640 × 480。开发服务使用 `http://127.0.0.1:5199`；此地址只用于开发，发行包不启动本地 HTTP 服务。

## 文件读写行为

- 自有文档保存为 `.owflow`；“打开”的文件类型筛选支持 `.owflow`、JSON、draw.io、Excalidraw 和 Mermaid 文本，并兼容旧 `.owf` 扩展名。
- “打开”使用系统文件选择器，可选多个文件。取消返回空列表。每个文件上限 50 MB，只接受 UTF-8 文本；一次最多 16 个文件、合计 100 MB。
- 路径只有经过本次应用会话的打开或保存选择器后，才允许在原位置保存。任意路径参数不授予文件访问权限。
- 打开和保存返回 SHA-256 `stamp`。覆盖原文件时同时校验编辑版本、会话中记录的版本以及磁盘当前内容。文件被外部修改、删除或替换时会拒绝覆盖，可重新打开或另存为。
- 另存为和导出均使用系统保存选择器。取消返回 `null`。保存接受文本或二进制数据，便于导出 PNG 等文件，同样有 50 MB 上限。
- 保存先写入同目录临时文件并同步，再原子替换目标；写入失败保留原文件。保存前会再次检查目标内容及目录。文件系统没有跨平台的“按内容版本比较并替换”单条操作，因此不能保证同时写入的其他程序在最后的检查与替换间完全无法产生竞争。
- 关闭窗口先交给前端处理未保存文档；前端完成确认后调用 `closeNativeWindow()`。

原生接口见 `src/native.ts`。浏览器打开页面不会加载 Tauri 桥接，仍使用网页的文件选择和下载能力。

## 构建产物

`.github/workflows/desktop-build.yml` 在 Windows x64、Apple Silicon Mac 和 Intel Mac 分别执行前端检查、Rust 文件操作测试和原生安装包构建。产物包括安装包、`SHA256SUMS`、提交版本信息以及 MIT 许可文件，作为 Actions artifacts 保存 14 天；该工作流不会创建公开 Release。

Windows 生成 NSIS 安装程序；Mac 生成 DMG。当前配置没有商业代码签名及 Apple 公证，Mac 使用临时签名。构建成功并不等于所有平台的交互功能已完成实机验收。

`src-tauri/icons/icon.svg` 是本项目原创节点与连线图标，按项目 MIT 许可分发。PNG、ICO 与 ICNS 均由这个矢量源生成。
