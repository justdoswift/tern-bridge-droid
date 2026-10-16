# tern-bridge-droid

让 Droid 使用 **omp 原版 UI 组件**在 Tern 中对话：`Composer` 输入区、助手消息、用户气泡、工具卡片、会话选择器、审批和 AskUser。插件负责把 Droid 的数据及操作绑定到这些组件，不自行重画聊天页面，不使用 WebView，也不抓取 Droid TUI 字符。

## 环境

- Bun 1.3.14 或更新版本（运行客户端）。
- 已安装并完成认证的 Droid CLI。
- 启用原生程序界面的 Tern。
- Node.js 22 或更新版本及 npm（仅开发、检查和打包时需要）。
- 本机已验证的组合：macOS arm64、Tern 0.8.3、Droid 0.241.1、Bun 1.3.14、`@oh-my-pi/pi-tui` 18.11.0。

启动器支持 macOS/Linux 的本机窗格；本次安装包针对 **macOS arm64** 构建。原版 UI 包含平台原生扩展，其他系统或架构需要在目标平台重新构建，不能复制这份安装包后直接运行。Linux 尚未实机验证；Windows、远程主机和移动端不在本次支持范围。远程窗格中的命令不会把本机插件路径或凭据发送到远程机器。

## UI 复用边界

- 直接依赖固定版本 `@oh-my-pi/pi-tui`，使用其 `Composer`、`AttachmentChipsBand`、`AssistantMessageComponent`、`UserMessageComponent`、`ToolExecutionComponent`、`SessionSelectorComponent`、`HookSelectorComponent`、`HookEditorComponent`、`ApprovalDialogComponent`、`AskDialogComponent`、`ReportPanel`、`ContextUsageView`、`describeWorkingRow` 和 `todoChecklistPhases`；不复制或修改上游组件源码。
- 助手正文、列表、代码、表格、图片与思考区直接由原版 `AssistantMessageComponent` 渲染，不再用零散 Markdown 和 Disclosure 拼装回答。连续内容形成同一个消息段，工具卡片按 Droid 的原始消息顺序穿插；独立代码、Diff 和工具输出仍沿用原版渲染。
- Read 源码按文件路径标记语言，使用原生代码高亮，不伪造读取区间的起始行号。Grep 的内容结果按已知文件路径、实际行号和匹配/上下文标记，交给原版文件行与编号代码视图；不同语言分别着色。无法确认的内容、截断提示、文件名列表、计数、Execute 日志和错误保留原输出。预览只使用 Droid 已返回的数据，不读取本机文件补内容，也不启用 omp 工具执行器。
- 流式状态只来自实际增量及块完成事件；定稿、中断与历史恢复不会留下假运行状态。未知的逐消息用量、费用和速度保持缺省，不拿会话累计量冒充单条用量。实时思考只使用原组件观察到的本次展示计时，历史思考不补造耗时；恢复与组件身份绑定 Droid 的真实会话及消息 ID。
- 任务执行时复用原版工作栏的指示器、观察计时和步骤文字，不固定显示 `Droid`。正在运行的工具展示其 `summary` 或工具名；没有活动工具时，展示当前流式回复的首行。思考和上下文压缩使用 Droid 实际报告的状态，压缩同时使用原版不定进度条；没有具体步骤时显示工作状态。不把工具日志、历史答复或思考正文当作步骤，已结束工具不留下旧步骤。工作栏与 Todo 环形进度、完成数量一起对齐输入框，空间不足时自然换行。计时只覆盖本次观察到的运行，不补造恢复前的耗时。正文不额外插入阶段标签，停止仍由原版 Composer 按钮处理。
- Droid 执行期间，横向或竖向标签页显示小绿点；等待作者审批/回答、空闲、出错和关闭时不显示。执行状态通过原生 OSC 9;4 传给 Tern，插件只添加活动点样式，不改标签标题、作者设置的标签颜色或其他程序的状态。
- 会话选择器仍是原版组件，只省略 Droid 不提供的会话文件大小等元数据。会话列表、模型选项、执行与审批只来自 Droid。
- 底栏保留模型、推理强度、`Auto` / `Spec`、自主权限和发送/停止。四个胶囊同高、等间距，与原尺寸的发送/停止按钮共用中线，并跟随字体缩放。思考强度保留原生环形图标；自主权限使用带“权限 / Autonomy”标签的原生三格程度条，关闭/低/中/高分别为 0/1/2/3 格，不显示百分比。悬停与辅助说明提供实际级别，点击仍打开 Droid 实际可选级别并保留授权确认。
- 不显示工作目录、“会话”“更多”或输入/输出 Token 数；目录隐藏和按钮对齐样式只作用于当前 Droid 原生 surface，不改变实际工作目录、其他程序的底栏或后端用量统计。会话与其他操作放进 `/` 菜单；发送/连接出错时优先显示“重新连接会话”。窄窗格仍遵循 Tern Composer 自身的压缩规则。图片直接粘贴，不另设上传按钮。
- 输入框上方只显示上下文用量百分比，不再显示 `250,000` 一类总容量数字；悬停提示与详情保留真实用量/容量。点击用量条，或输入 `/context`，立即打开原版报告面板并读取 Droid `getContextBreakdown()`。分类、总用量、容量和剩余空间来自 Droid；保留 MCP、用户上下文、AGENTS.md 与 Droid 配置等独立类别。接口不提供自动压缩阈值，不套用 omp 的 85% 或伪造预留量。旧 CLI 不支持或读取失败时在面板内重试，不改变会话执行状态，也不发送模型请求。
- Droid 成功执行 `TodoWrite` 后，工作栏显示原生任务进度环、当前任务和完成数量，点击展开清单。读取其编号、状态标签字符串中的 `pending`、`in_progress`、`completed`；未执行、失败、中断的写入不覆盖已确认清单，成功清空时移除面板，无法识别的新格式不沿用旧清单。历史恢复展示最后一次成功写入，切换会话不保留旧任务。不推断阶段、不代替 Droid 改任务，也不注入催办提示词。
- 不创建 omp `AgentSession`，不启动 omp 的模型循环，不读取 omp 的账号、模型配置或会话数据库。不是“由 omp 调用一次 Droid 工具”。
- 插件自己的命令和提示提供中文/English；上游组件内部的英文文案保留原样。这不是 Tern 或 omp 的整套汉化包。


## 构建和安装

在本仓库目录运行：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run package
```

随后安装干净的插件包：

```sh
tern plugin install ./artifacts/package/tern-bridge-droid
```

已有安装时，先退出当前 Droid 插件会话，再覆盖更新，无需先卸载：

```sh
tern plugin install --force ./artifacts/package/tern-bridge-droid
```

开发时可以链接同一个干净包，修改源码后重新打包：

```sh
tern plugin link ./artifacts/package/tern-bridge-droid
```

安装包包含入口、客户端、原版 UI 及 Droid SDK 的**生产运行依赖**、使用说明和第三方许可，不需要在安装时联网下载 npm 依赖。必须保留包内的 `dist/node_modules`，它不是开发目录的依赖备份。不要把项目根目录的开发 `node_modules` 复制进 Tern。`dist/client.mjs` 与许可清单保留在源仓库中；平台原生二进制不加入 Git。

卸载已安装的副本使用 `tern plugin remove tern-bridge-droid`；取消开发链接使用 `tern plugin unlink tern-bridge-droid`。两者都不会删除 Droid 的历史会话。退出已打开的客户端后再移除插件。

## 使用

在 Tern 窗口按 **⌘K** 打开命令面板（macOS 默认键位），搜索 `Droid`，然后选择：

- **Droid：新建原生对话 / Droid: New native conversation**
- **Droid：恢复历史会话 / Droid: Resume a conversation**
- **Droid：在右侧分屏打开 / Droid: Open in a right split**

日常启动不使用 `tern ctl palette ...`，也不需要 `tern serve` 或开发控制 socket。插件目前不接管 Shell 中的 `droid` 命令，直接输入仍会启动官方 CLI。

新建对话使用当前本机窗格的工作目录；恢复会话使用 Droid 已保存的工作目录。恢复会话同时加载历史消息，不只恢复模型上下文。

原版输入区底部的模型、推理强度、模式和自主权限绑定到 Droid 实际提供的数据；点击 `Auto` / `Spec` 或权限 gauge，也可通过 `/mode` 和 `/autonomy` 调整。自主权限列表遵守 Droid 返回的组织策略，不展示被禁止的级别。已有选择和新会话默认值由 Droid 决定，插件不硬编码模型、不自动提升权限，也不把 Spec 切换视为接受计划。

输入 `/` 可访问会话、重命名、分叉、压缩和回退等操作，`/sessions` 直接打开原版会话选择器。回退先展示文件影响：**仅回退对话**不会请求恢复或删除文件；恢复文件必须单独确认。压缩可能调用模型并消耗当前 Droid 额度。

输入 `/help` 可打开操作选择器。支持 `/sessions`、`/new`、`/resume`（也可 `/resume 会话ID`）、`/model`、`/reasoning`、`/mode`、`/autonomy`、`/context`、`/rename`、`/fork`、`/compact`、`/rewind`、`/retry`、`/language`、`/quit`。补全跟随当前 Droid 会话的实际目录，而不是固定使用启动目录。已附图片时，输入按图片消息发送，不把消息中的 slash 文本误执行为命令；模型、推理强度、模式与权限仍可点击底栏调整，会话可用快捷键打开。


### 输入与键盘

- Enter：发送；Shift+Enter 或 Alt+Enter：换行。
- macOS 的 ⌘V：直接粘贴剪贴板图片或文字；图片自动进入原生附件区，无需选择文件。
- 选择、搜索、编辑、撤销和多行粘贴使用 omp 原组件的行为，不维护第二套键盘/光标状态机。
- Ctrl+Alt+Shift+O：打开会话选择；Ctrl+Alt+Shift+N：新建对话。不覆盖 Tern 自己的 Cmd+O/Cmd+N。
- Esc：关闭当前面板；待审批/提问时取消；任务运行时请求停止。
- Cmd/Ctrl+Z、Shift+Cmd/Ctrl+Z：撤销、重做。
- Ctrl+O：在普通输入区展开/收起工具与思考内容；阅读历史使用 Tern 的原生滚动。
- 支持 Tern 原生选区、中文输入法提交、多行粘贴与 UTF-16 光标偏移。

任务运行时可以继续写草稿，但不会偷偷排队发送。只有 Droid 确认记录了用户消息，客户端才清空相应草稿。连接失败不会自动重放消息；“重新连接”只重新加载会话。

### 图片附件

- 复制图片或截图后，在输入框按 **⌘V**，自动显示与 omp 一致的缩略图卡片、`#N` 编号和像素尺寸；不弹文件选择框，不提供上传按钮或 `/attach` 手动入口。普通文字仍按文字粘贴，也保留原生图片文件拖放。
- 支持 **JPEG、PNG、GIF、WebP**；macOS 剪贴板的 TIFF 图片由原生读取器转换后处理。附件卡片直接使用上游 `AttachmentChipsBand`，不另画预览 UI；删除输入中的图片标记会同步移除预览和待发送图片。
- 粘贴只暂存附件，不自动发送或调用模型。按 Enter 后，图片与文字一起通过 Droid SDK 的 base64 image 参数发送，也允许只发送图片。标记和本机路径不会冒充图片内容；紧接粘贴的 Enter 会等异步读取结束，不会抢先发出空消息。
- 只有 Droid 确认持久化了这条用户消息，才清空对应的文字和附件。失败、重连或迟到回执不清掉未接受的草稿；发送后继续编辑、增加附件时，也不会清掉新草稿。切换到另一个会话会移除旧会话附件，切换失败时保留可恢复的原草稿。
- 明确不支持图片的模型会阻止发送并保留草稿；能力未知时让 Droid 实际处理，失败后不剥离图片、不重试、不自动切换模型。文件须通过原版解码器和大小限制，拒绝目录、设备与无效图片。
- 只在作者显式粘贴时读取剪贴板。插件不新建持久图片缓存，不扫描目录，也不另行上传到第三方；已发送图片的保存遵循 Droid 自身的会话策略。


## 审批和 AskUser

执行请求展示原始命令/文件信息和 Droid 当前实际提供的选项。持续授权会明确标识；选择非取消结果后，还需在原版审批组件中明确确认（默认 Ctrl+Enter），普通 Enter 不会直接授权。编辑计划会将提交的完整内容交回 Droid。拒绝、停止或会话替换会使旧请求失效，迟到响应不能批准新请求。AskUser 使用原版多题/多选/自定义回答组件，合并所选答案、自定义文本与备注后按 Droid 的原始问题身份提交。

当前 SDK 的明确限制：

- Spec 的 `proceed_new_session*` 选项会显示为禁用，并说明原因。SDK 没有公开可靠的新会话交接标识，不能把任意子会话通知当成新执行会话。仍支持当前会话中接受计划，以及显式分叉。
- 如果恢复结果只有旧审批/提问快照、没有可回答的实时 RPC，请求不会被伪造回复，会话保持不可发送状态；需要回到原客户端处理，或通过 Droid 确认停止后恢复。
- 锁只协调本插件的实例，无法阻止独立的 Droid CLI 同时操作同一个会话。不要在两处并发编辑同一 Droid 会话。
- Mission Control、任意 Droid 原生 TUI 页面、独立 CLI 的所有快捷键和 slash 菜单不是此客户端的界面。后端工具与技能仍由 Droid 发现和执行。

## 配置和认证

本客户端通过官方 SDK 的底层 `ProcessTransport` / `DroidClient` 复用本机 Droid CLI 认证。已实测不需要额外创建 Factory API Key；已有 `FACTORY_API_KEY` 环境变量仍由 Droid 使用。认证错误应在 Droid 官方 CLI 中处理，插件不读取、复制或保存 token 文件。

通过 `/language` 切换插件文案的中文/English。偏好保存在 Tern 插件数据目录 `plugin-data/tern-bridge-droid/preferences.json`，可配置 `locale`、`bunPath`、`droidPath`。找不到可执行文件时，在终端运行 `command -v bun`、`command -v droid`，将得到的绝对路径填入对应字段。旧的 `nodePath` 不再用于启动。命令面板标题会在下次插件重载时采用保存的语言。

插件不修改全局 Droid 默认设置，不新增会话数据库，不自动重试模型请求；主动关闭 Droid 传输日志和共享 UI 的 TSP 录制。Droid 自身的保存/云同步设置及 Tern 自身的屏幕快照机制仍适用。关闭窗格会关闭客户端及 Droid 子进程；已保存历史仍可恢复。仅关闭窗口时，进程是否保留由 Tern 守护进程的正常生命周期决定；守护进程重启不承诺自动恢复正在执行的模型任务。

## 开发

```sh
npm run check
npm test
npm run build
```

直接在 Tern 的 Shell 窗格运行构建后的客户端：

```sh
bun dist/client.mjs --cwd . --data-dir ./artifacts/development-data
```

可选参数：`--session ID`、`--pick-session`、`--locale zh-CN|en-US`、`--droid PATH`。`--help` 不连接 Droid；在非 Tern 终端中启动会明确失败，不生成伪造的回复或降级成假聊天界面。

实现分为 Luau 启动器/标签活动样式、原版 omp UI 的数据/操作绑定、Droid 协议与会话控制、历史消息归一化和跨进程会话锁。行为测试覆盖协议身份、消息合并、审批与取消、回退计划、锁归属、运行步骤及真实原组件的图片草稿生命周期；实际 Tern 检查覆盖原版组件呈现、会话恢复、中文/多行输入、审批、AskUser、图片附件、任务工作栏和错误恢复。协议夹具不证明模型质量；仅一次已授权的真实 Droid 工具调用用于验证端到端连接，之后不重复付费请求。
