# Open Workflow

把流程图、自由白板与文字绘图放在同一个本地工作台。

Open Workflow 0.1.0 正在开发中，暂未发布正式安装包。编辑器使用自己的场景模型、SVG 绘制、节点连线、手绘、布局、撤销历史与格式转换。Vue 3 负责应用界面，Tauri 2 提供桌面外壳；没有内嵌 draw.io、Excalidraw、Mermaid 或 Vue Flow 编辑引擎。界面布局参考 [Open Office](https://github.com/ecojust/open-office)，研究方法和 REA 分析记录见 [RESEARCH.md](docs/RESEARCH.md)。

![Open Workflow 工作台](docs/screenshots/home.png)

## 当前功能

- **流程图**：矩形、椭圆、菱形、三角形、六边形、星形、平行四边形、圆柱、云形，以及文字、便签和自动布局；直线/正交连线靠近图形真实边缘时自动吸附，支持拖动端点重新连接，图形移动或缩放后连线跟随。
- **自由白板**：手绘笔迹、半透明荧光笔、按元素擦除的橡皮擦、彩色便签、本地 PNG/JPEG/WebP 图片与分区框架；拖动框架可带动完整包围的未锁定内容。提供组合/取消组合、六种对齐及水平/垂直等距分布。
- **白板模板**：头脑风暴、四象限分析、任务看板、会议复盘，一次插入可编辑图形与便签，保留已有内容；插入后可以整体撤销。
- **画布操作**：流程图和白板共享平移缩放、自适应点阵与悬浮工具栏，图形素材库默认收起。工作台、画布、文字绘图和模板入口统一使用本项目的 SVG 操作图标。
- **线条外观**：整洁/手绘、实线/虚线/点线、线宽和颜色可全局调整，也可独立修改选中图形；全局设置同时应用于现有元素与之后创建的元素，明确包含锁定元素。
- **直接编辑**：双击图形或连线修改文字，选择工具下双击空白处创建文字；右键菜单提供文字编辑、复制、锁定、删除，以及置顶、置底、上移一层、下移一层。
- **文字绘图**：自研解析、布局与绘制覆盖 22 类 Mermaid 图表，提供分类、搜索和各类模板，显示预览、行号、语法错误与兼容提示；可创建独立的流程图副本继续编辑。每类支持明确的语法子集，详见 [格式说明](docs/FORMATS.md#mermaid-子集)。
- **统一工作台**：多文档标签、重命名、最近文档搜索、浅色/深色/跟随系统外观，以及本地草稿恢复。
- **文件与导出**：原生 `.owflow`；基础 draw.io、Excalidraw、Mermaid 导入；整图或选区 SVG/PNG 导出，以及 draw.io、Excalidraw 文件导出。导入时的原始文本可单独取回。

22 类文字图表包括：流程图、时序图、类图、状态图、实体关系图、分支历史图、需求图、系统上下文图、架构图；饼图、甘特图、柱线图、象限图、桑基图、雷达图、矩形树图；思维导图、时间线、用户旅程、看板、块图和数据包图。统计图使用实际扇区、时间轴、坐标轴、流带或面积布局，生成可编辑场景元素。

![流程图编辑界面](docs/screenshots/flow.png)

[查看全局线条设置](docs/screenshots/flow-style.png) · [查看右键菜单](docs/screenshots/flow-context.png)

[查看自由白板](docs/screenshots/board.png) · [查看白板模板面板](docs/screenshots/whiteboard-templates.png) · [查看 22 类图表模板库](docs/screenshots/diagram-library.png)

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

`test:browser` 使用真实 Chromium，并在需要时启动开发服务。已有 Chromium 可通过 `CHROMIUM_EXECUTABLE` 指定；`BASE_URL` 可指定已启动的服务。基础交互、画布细节和扩展工作区测试的截图与结果默认分别写入 `/tmp/open-workflow-browser`、`/tmp/open-workflow-refinements`、`/tmp/open-workflow-expanded`，可通过 `BROWSER_ARTIFACTS` 更改。Linux 测试环境缺少浏览器系统库时，可使用 `npx playwright install --with-deps chromium`。

桌面开发使用 `npm run desktop:dev`，构建使用 `npm run desktop:build`；另需 Rust 和系统构建依赖，见 [桌面版说明](docs/DESKTOP.md)。仓库配置了 Windows x64、Mac Apple Silicon 与 Mac Intel 构建，开发产物可保存在 Actions artifacts。当前尚无正式 Release 安装包；后续发布流程见 [发布约定](.github/RELEASING.md)。

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
| 组合 / 取消组合 | `Ctrl+G` / `Ctrl+Shift+G`；普通点击选择整组，`Alt` 点击选择组内成员 |
| 复制 / 粘贴 / 创建副本 | `Ctrl+C` / `Ctrl+V` / `Ctrl+D`，作用于当前编辑器内 |
| 删除 / 微调位置 | `Delete` 或 `Backspace` / 方向键，按住 `Shift` 移动 10 个画布单位 |
| 编辑文字 / 新建文字 | 双击图形或连线；选中后按 `Enter`；选择工具下双击空白处新建 |
| 重新连接端点 | 选中连线，拖动端点圆柄；距图形真实轮廓 14 个屏幕像素内自动吸附 |
| 图层、锁定与图像导出 | 右键打开菜单；选中元素后可导出选区 SVG/PNG |
| 选择 / 平移 / 连线 / 画笔 | `V` / `H` / `L` / `P` |
| 矩形 / 椭圆 / 菱形 / 文字 / 便签 | `R` / `O` / `D` / `T` / `N` |
| 荧光笔 / 橡皮擦 / 分区框架 | `M` / `E` / `F` |

全局线条设置只统一本次调整的属性，并保存为后续创建元素的默认值。单独调整图形不会改变其他元素；再次修改同一全局属性时，会覆盖各元素此前的独立设置，包含锁定元素。普通移动、文字编辑、图层和删除操作仍遵守锁定状态。

## 第一版的边界

draw.io 和 Excalidraw 支持基础元素转换，部分分组、扩展形状和闭合图形依靠元数据恢复，不保证其他软件中的外观或往返完全一致。Mermaid 的 22 类图表均为语法子集，未知指令会报错。复杂图的自动布局可能需要手动调整。

文字图表的可编辑副本由普通画布元素组成，不与源码双向同步。类图、实体关系图的装饰端标在移动卡片后不会自动重新计算；架构图端口使用自由端点，转为副本后不自动跟随节点。白板组合为单层，框架不提供裁剪或持久父子关系；橡皮擦删除整个命中元素，不逐像素擦除。

Apple 无边记与 Microsoft Whiteboard 是便签、手绘和自由整理体验的参考；当前没有其专有文件格式导入。当前也没有多人实时协作、云同步或账号服务。文档上限与转换细节见 [FORMATS.md](docs/FORMATS.md)。

## 源码

| 目录 | 内容 |
| --- | --- |
| `src/App.vue` | 工作台、标签、保存状态与操作协调 |
| `src/components/` | 自研 SVG 画布、Mermaid 工作区与界面图标 |
| `src/core/` | 文档、历史、几何、布局、SVG、Mermaid、存储和文件操作 |
| `src/core/diagrams/` | 图表目录、模板和 22 类文字图表共用及分类编译逻辑 |
| `src/formats/` | draw.io 与 Excalidraw 转换 |
| `src-tauri/` | 原生窗口、文件选择、版本检查与写入 |
| `tests/` | 纯逻辑与真实浏览器交互测试 |

架构说明见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。项目原创代码采用 [MIT](LICENSE) 许可，依赖和参考项目说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
