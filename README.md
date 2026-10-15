# Open Workflow

把流程图、自由白板与文字绘图放在同一个本地工作台。

Open Workflow 0.1.0 是自研编辑器的第一版：使用自己的场景模型、SVG 绘制、节点连线、手绘、布局、撤销历史与格式转换。Vue 3 负责应用界面，Tauri 2 提供桌面外壳；没有内嵌 draw.io、Excalidraw、Mermaid 或 Vue Flow 编辑引擎。界面布局参考 [Open Office](https://github.com/ecojust/open-office)，研究方法和 REA 分析记录见 [RESEARCH.md](docs/RESEARCH.md)。

![Open Workflow 工作台](docs/screenshots/home.png)

## 当前功能

- **流程图**：矩形、椭圆、菱形、文字、便签；绑定节点的直线/正交连线；拖动、缩放图形、框选、复制、锁定、层级和自动布局。
- **自由白板**：共享同一套画布，支持手绘笔迹、便签、本地 PNG/JPEG/WebP 图片、平移缩放与属性调整。
- **Mermaid 工作区**：自己解析基础流程图和时序图，显示预览、行号及语法错误；可创建独立的流程图副本继续编辑。支持范围见 [格式说明](docs/FORMATS.md#mermaid-子集)。
- **统一工作台**：多文档标签、重命名、最近文档搜索、浅色/深色/跟随系统外观，以及本地草稿恢复。
- **文件与导出**：原生 `.owflow`；基础 draw.io、Excalidraw、Mermaid 导入；SVG、PNG、draw.io、Excalidraw 导出。导入时的原始文本可单独取回。

![流程图编辑界面](docs/screenshots/flow.png)

## 运行

需要 Node.js 24 和 npm。

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:5199>。生产构建和预览：

```sh
npm run build
npm run preview
```

检查与浏览器测试：

```sh
npm test
npx playwright install chromium
npm run test:browser
```

`test:browser` 使用真实 Chromium，并在需要时启动开发服务。已有 Chromium 可通过 `CHROMIUM_EXECUTABLE` 指定；`BASE_URL` 可指定已启动的服务。截图与结果默认写入 `/tmp/open-workflow-browser`，可通过 `BROWSER_ARTIFACTS` 更改。Linux 测试环境缺少浏览器系统库时，可使用 `npx playwright install --with-deps chromium`。

桌面开发使用 `npm run desktop:dev`，构建使用 `npm run desktop:build`；另需 Rust 和系统构建依赖，见 [桌面版说明](docs/DESKTOP.md)。GitHub Actions 配置了 Windows x64、Mac Apple Silicon 与 Mac Intel 构建，安装包保存在 Actions artifacts；这不代表已经创建公开 Release。

## 保存到哪里

修改后，文档自动写入当前浏览器或桌面工作区的 **IndexedDB 草稿库**；状态栏分别显示草稿状态与文件保存状态。草稿只属于当前设备和工作区，清除站点数据会移除草稿。需要备份、迁移或分享时，请保存 `.owflow` 文件。

浏览器中的“保存”下载文件。桌面版使用系统文件选择器，可以保存回本次会话中打开的原生文件；覆盖前会检查文件是否被其他程序修改。从草稿恢复的文档需要重新选择保存位置。关闭有未保存文件修改的标签时，可保存、放弃或取消；**放弃修改同时移除该文档的本地草稿**。

导入 draw.io、Excalidraw 或 Mermaid 后，保存会生成 `.owflow` 副本。转换限制会在导入结果中显示，原始文本保留在副本中，“导出 → 导入时的原文件”可取回导入时的内容。

## 常用操作

下表中的 `Ctrl` 在 macOS 上也可使用 `⌘`。画布快捷键需要焦点位于画布；输入文字时保留文本编辑行为。

| 操作 | 快捷键 / 手势 |
| --- | --- |
| 新建流程图 / 打开文件 | `Ctrl+N` / `Ctrl+O` |
| 保存 / 另存为 | `Ctrl+S` / `Ctrl+Shift+S` |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` 或 `Ctrl+Y` |
| 平移画布 | 普通滚轮；按住空格拖动；鼠标中键拖动 |
| 缩放画布 / 适应内容 | `Ctrl` + 滚轮 / `0` |
| 多选 / 框选 | `Shift` 点击 / 在空白处拖动 |
| 复制 / 粘贴 / 创建副本 | `Ctrl+C` / `Ctrl+V` / `Ctrl+D`，作用于当前编辑器内 |
| 删除 / 微调位置 | `Delete` 或 `Backspace` / 方向键，按住 `Shift` 移动 10 个画布单位 |
| 编辑图形文字 | 双击图形或选中后按 `Enter` |
| 选择 / 平移 / 连线 / 画笔 | `V` / `H` / `L` / `P` |
| 矩形 / 椭圆 / 菱形 / 文字 / 便签 | `R` / `O` / `D` / `T` / `N` |

## 第一版的边界

draw.io 和 Excalidraw 支持基础元素转换，不保证高级样式、旋转、分组、路由或字体外观完全一致。Mermaid 支持明确的语法子集，不支持全部图表类型。复杂图的自动布局采用基础分层算法，可能需要手动调整。

Apple 无边记与 Microsoft Whiteboard 是便签、手绘和自由整理体验的参考；当前没有其专有文件格式导入。当前也没有多人实时协作、云同步或账号服务。文档上限与转换细节见 [FORMATS.md](docs/FORMATS.md)。

## 源码

| 目录 | 内容 |
| --- | --- |
| `src/App.vue` | 工作台、标签、保存状态与操作协调 |
| `src/components/` | 自研 SVG 画布、Mermaid 工作区与界面图标 |
| `src/core/` | 文档、历史、几何、布局、SVG、Mermaid、存储和文件操作 |
| `src/formats/` | draw.io 与 Excalidraw 转换 |
| `src-tauri/` | 原生窗口、文件选择、版本检查与写入 |
| `tests/` | 纯逻辑与真实浏览器交互测试 |

架构说明见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。项目原创代码采用 [MIT](LICENSE) 许可，依赖和参考项目说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
