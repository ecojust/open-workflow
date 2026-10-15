# 自研画布：参考研究与实现决定

研究日期：2026-10-15。依据用户要求，Open Workflow 自己实现场景模型、SVG 绘制、交互、历史记录和格式转换。draw.io、Excalidraw、Mermaid 用于理解数据结构与交互原则，不将这些产品的编辑器、渲染器或源码嵌入应用。

## 研究方法与证据

实际使用 **REA（`rea-agents@6.5.0`）** 的 `analyze-javascript-application` 命令，Node.js 为 v24.19.0。工具安装在 `/workspace/open-workflow-research/tools`，与产品依赖隔离。仅下载锁定提交的 10 个文件，共 529,006 字节：9 个 JavaScript/TypeScript 文件交给 REA 静态解析，1 个 Jison 语法文件直接阅读。未运行上游应用或上游脚本。

| 参考项目 | 固定提交 | 关注范围 |
| --- | --- | --- |
| Excalidraw | `4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e` | 节点绑定、箭头点位、历史与状态提交 |
| draw.io | `9034053fba80a435e27d68d374bc564b83917ae9` | 图模型 XML 读写入口 |
| mxGraph | `ff141aab158417bd866e2dfebd06c61d40773cd2` | `mxGraphModel`、单元引用与事务 |
| Mermaid | `e28fbd9ded0a07ba9569e51be4764c1ad4daa8f6` | flowchart 语法和节点、边数据库 |

可核对的记录：

- [source-manifest.json](research/source-manifest.json)：每个文件的仓库、固定 SHA、原始 URL、字节数和 SHA-256。
- [commands.json](research/commands.json)：真实执行的命令及参数，包含一次参数格式错误及更正记录。
- [rea-summary.json](research/rea-summary.json)：REA Evidence ID、原始 JSON SHA-256、统计、保留的符号观察和工具声明的局限。
- 未删改的完整 Evidence JSON 保留在独立目录 `/workspace/open-workflow-research/evidence/`，合计约 27 MB；没有将上游源码或完整分析图纳入产品目录。摘要中的文件哈希可以验证本次原始结果。

每次解析限制为 256 MiB 分析进程堆、每文件 15 秒、每文件最多 2,000 个语义节点；总体上限按项目为 2,000–6,000。四次命令均成功，9 个源码文件解析失败数为 0。保留的语义节点数分别为 draw.io 2,000、Excalidraw 6,000、Mermaid 2,000、mxGraph 2,421。

**边界说明：** 四份语义图均明确报告 `partial / truncated`；这不是完整仓库、完整调用图或运行行为的证明。REA 可为选定文件建立静态符号与关系，动态调用和未下载的依赖仍未知。以下架构结论结合了这些观察和固定版本源码的定点阅读；尤其 Jison 语法由人工阅读，没有声称 REA 能解析 Jison。没有使用 REA 分析 Apple 无边记或 Microsoft Whiteboard 的私有实现，它们仅作为白板功能和交互体验的参考。

## 可迁移的原则

### 节点与连线分开建模，端点绑定稳定 ID

Excalidraw [`binding.ts:1321`](https://github.com/excalidraw/excalidraw/blob/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e/packages/element/src/binding.ts#L1321) 根据节点 ID 查找箭头绑定，并在目标变化后更新端点；同时移动节点和箭头时会识别已在更新的对象，避免重复位移。[`linearElementEditor.ts:1373`](https://github.com/excalidraw/excalidraw/blob/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e/packages/element/src/linearElementEditor.ts#L1373) 则区分元素局部点与全局坐标。

我们的决定：文档保存节点的 ID、类型、几何和样式；连线保存源/目标节点 ID 和自由端点。SVG 路径由几何层计算，移动或缩放节点后重新求边界交点。视口缩放、平移与文档坐标分开。矩形、圆形、菱形应各自求正确边界，不能把连线固定到节点中心。多个对象一起移动时，一个手势只应用一次位移。

### 一次用户操作形成一条历史

Excalidraw [`history.ts:117`](https://github.com/excalidraw/excalidraw/blob/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e/packages/excalidraw/history.ts#L117) 过滤空变更与历史自身产生的变更；只有实际元素变化才清空重做，避免单纯取消选中破坏重做栈。[`store.ts:183`](https://github.com/excalidraw/excalidraw/blob/4c37956ba5f04ec342a9d9d5891a38f22c5b7b4e/packages/element/src/store.ts#L183) 区分瞬态与持久提交。mxGraph [`mxGraphModel.js:1880`](https://github.com/jgraph/mxgraph/blob/ff141aab158417bd866e2dfebd06c61d40773cd2/javascript/src/js/model/mxGraphModel.js#L1880) 通过成对的更新边界把多次修改合并到一次可撤销操作。

我们的决定：画布在按下时保存操作起点，移动中只更新预览，结束时提交一次。移动、缩放、绘制、批量删除、导入各算一次；取消操作恢复起点，不产生历史。悬停、选择和平移不占用文档撤销。第一版采用有界文档快照历史，便于验证；不照搬上游的协作增量系统。

### 格式转换只落入统一文档，不另开一套编辑器

mxGraph [`mxModelCodec.js:17`](https://github.com/jgraph/mxgraph/blob/ff141aab158417bd866e2dfebd06c61d40773cd2/javascript/src/js/io/mxModelCodec.js#L17) 将图写成 `mxGraphModel/root` 下的平铺单元；[`mxCellCodec.js:20`](https://github.com/jgraph/mxgraph/blob/ff141aab158417bd866e2dfebd06c61d40773cd2/javascript/src/js/io/mxCellCodec.js#L20) 明确 `parent/source/target` 是引用。draw.io [`Editor.js:1508`](https://github.com/jgraph/drawio/blob/9034053fba80a435e27d68d374bc564b83917ae9/src/main/webapp/js/grapheditor/Editor.js#L1508) 在加载图时恢复模型与视图设置。

我们的决定：draw.io 转换先读取节点与 ID，再连接边；将外部几何映射到自己的场景。只声明实际支持的形状、样式和 XML 结构，不把“能打开一种 XML”描述成完全兼容 draw.io。压缩包装、嵌套分组、复杂样式等未支持内容要明确拒绝或提示，不能悄悄丢失后报告成功。原生文档始终使用带版本的 Open Workflow 格式。

### Mermaid 是描述语言，布局与绘制由自己实现

Mermaid [`flow.jison:327`](https://github.com/mermaid-js/mermaid/blob/e28fbd9ded0a07ba9569e51be4764c1ad4daa8f6/packages/mermaid/src/diagrams/flowchart/parser/flow.jison#L327) 定义 `graph/flowchart` 与方向；同文件 403、432、470 行分别处理连接链、节点形状和边文本。[`flowDb.ts:127`](https://github.com/mermaid-js/mermaid/blob/e28fbd9ded0a07ba9569e51be4764c1ad4daa8f6/packages/mermaid/src/diagrams/flowchart/flowDb.ts#L127) 和 353 行把语法结果写入节点与边集合。

我们的决定：实现明确的 flowchart 子集解析器，把文本转换成中立的节点/边，再以自己的分层算法布局、SVG 绘制。编辑后的节点仍可拖动和修改。对未知语法给出行号与错误，不能把不理解的部分吞掉；导出也应只产生本实现能够表达的语法。子集兼容不等于覆盖 Mermaid 全部图表类型。

## 对产品结构的约束

主界面参考 Open Office 的顶部命令区、左侧资料/形状区、中部工作区和右侧属性面板。画布可以在流程图、白板、手绘之间复用节点、连接、文本、便笺、笔迹和图片。布局参考与数据模型独立，不加载参考软件的页面。

模块分为文档模型、纯几何函数、交互控制器、SVG 视图、撤销历史、存储、格式转换。持久化仅保存用户文档；临时选框、光标、拖拽状态不写入文件。画布和导出共用几何与文本转义规则，避免屏幕显示与导出不一致。

关键验证应覆盖：节点移动后连线跟随；缩放后的命中与拖动；一次拖拽一次撤销；取消操作不污染历史；复制后的绑定重映射；删除节点后的边处理；文档刷新恢复；导入错误不破坏当前文档；支持范围内的格式往返。真实浏览器交互检查负责补足静态分析不能证明的部分。
