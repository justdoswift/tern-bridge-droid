# Tern Bridge for Droid

**在 Tern 里用 Droid，保留 omp 的对话体验。**

喜欢 Tern 中 omp 的消息排版、代码高亮和输入框，但想继续使用 Factory Droid？这个插件把两者接起来：界面使用原版 omp 组件，模型、工具、权限和历史会话仍由 Droid 管理。

[安装](#安装) · [使用](#使用) · [常见问题](#常见问题) · [反馈问题](https://github.com/justdoswift/tern-bridge-droid/issues) · [Pi 版本](https://github.com/justdoswift/tern-bridge-pi)

## 能做什么

- **读起来更清楚**：流式回复、Markdown、代码高亮、Diff，以及可展开的工具输出和思考内容。
- **直接粘贴图片**：按 `⌘V` 添加截图或图片，查看缩略图后随消息发送，不用找上传按钮。
- **接着原来的会话聊**：搜索和恢复 Droid 历史，也可以新建、重命名、分叉和回退。
- **随时调整工作方式**：在输入框底部选择模型、思考强度、`Auto` / `Spec` 和自主权限；需要授权时在界面中确认。
- **知道它在做什么**：查看当前步骤、Todo 进度和上下文用量；运行中的标签页带有活动绿点。

这是一个独立桥接插件，不是新的 AI 服务，也不是 Tern 的整套汉化包。插件操作支持中文和 English，部分上游界面仍为英文。

## 安装

先准备好：

- 支持原生程序界面的 [Tern](https://docs.stencil.so/tern/index.html)。
- 已安装、完成登录且能正常使用的 **Droid CLI**。
- **Bun 1.3.14+**、**Node.js 22+ 和 npm**，以及 Git、curl、Bash。

关闭已打开的 Droid 插件会话，在准备使用插件的机器上执行：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-droid/main/install.sh | bash
```

脚本默认执行 `install`：检查依赖、下载 `main`、在临时目录构建完整运行包，再调用 Tern 安装。缺少依赖会提示，不会替你安装系统软件、修改 Shell 配置或执行登录。已有插件不会被默认覆盖，请使用下方的 `update`。

这条命令会执行远程代码；也可以先下载并审阅 [install.sh](https://github.com/justdoswift/tern-bridge-droid/blob/main/install.sh)，再运行 `bash install.sh`。

安装后**重启 Tern，再新建一个本机 zsh 终端窗格**。在该窗格输入：

```sh
droid
```

`Droid`、`DROID` 和混合大小写也可以。插件会在当前窗格打开，使用当前工作目录；输入 `/quit` 返回终端。已有的同名 alias、function 或独立程序不会被覆盖。

> 当前验证平台为 macOS Apple Silicon。Linux 需要在目标机器构建，尚未实机验证；Windows 和远程窗格不在支持范围。安装包包含平台原生依赖，不能跨系统或架构直接复制使用。

## 使用

### 输入和快捷键

| 操作 | 快捷键 |
| --- | --- |
| 发送消息 | `Enter` |
| 换行 | `Shift+Enter` 或 `Alt+Enter` |
| 粘贴文字或图片（macOS） | `⌘V` |
| 展开 / 收起工具输出、思考与 skill 详情 | `Ctrl+O` |
| 停止任务 / 关闭当前面板 | `Esc` |
| 清空草稿并请求停止任务 | `Ctrl+C` |
| 退出插件、返回终端 | 连按两次 `Ctrl+C` |

图片粘贴后不会自动发送；发送失败时保留草稿。图片能否被模型处理，取决于你在 Droid 中选择的模型。

### 会话和设置

输入 `/` 打开菜单，不需要记住全部命令：

| 想做什么 | 命令 |
| --- | --- |
| 打开历史会话 / 新建会话 | `/sessions` / `/new` |
| 选择模型 / 思考强度 | `/model` / `/reasoning` |
| 切换 Auto、Spec / 自主权限 | `/mode` / `/autonomy` |
| 查看上下文用量 | `/context`，或点击输入框上方的用量条 |
| 重命名 / 分叉 / 回退 | `/rename` / `/fork` / `/rewind` |
| 压缩上下文 | `/compact` |
| 重新连接 / 切换界面语言 | `/retry` / `/language` |
| 刷新自定义命令与 skill 列表 | `/bridge:commands` |
| 查看操作 / 退出 | `/help` / `/quit` |

菜单也会列出当前 Droid 会话可用的**自定义命令和手动调用的 skill**，输入名称即可筛选、补全，例如 `/code-review 检查这次修改`。禁用或仅供模型自动调用的 skill 不会出现在菜单中。新增或修改 skill 后，可用 `/bridge:commands` 刷新；读取失败会明确提示，不会把未知命令当普通消息发送。

同名时优先调用 Droid 的自定义命令或 skill；插件自身的操作始终可以加 `bridge:` 前缀，例如 `/bridge:sessions`、`/bridge:help`。

调用 skill 后，会话默认显示**收起的 skill 卡片和附加要求摘要**，不再铺开整篇指令。点击卡片标题或按 `Ctrl+O` 查看全文；恢复的历史消息也采用相同展示。这里只改变显示，Droid 执行和保存的原始内容不变。

回退会先列出文件影响；**仅回退对话不会恢复文件**，恢复文件需要另行确认。压缩上下文可能调用模型并消耗 Droid 额度。重新连接不会自动重发上一条消息。

也可以按 **`⌘K`** 打开 Tern 命令面板，搜索 **Droid**，选择新建对话、恢复历史或在右侧分屏打开。

## 更新与卸载

更新前先退出已打开的 Droid 插件会话，无需手动进入仓库：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-droid/main/install.sh | bash -s -- update
```

`update` 获取最新 `main`，构建成功后才通过 Tern 的 `--force` 替换插件；下载或构建失败不会动旧版。它也可以在尚未安装时安装。更新后重启 Tern，再新建终端窗格。开发用的链接安装不会被强行覆盖或自动解除链接。

卸载：

```sh
curl -fsSL https://raw.githubusercontent.com/justdoswift/tern-bridge-droid/main/install.sh | bash -s -- uninstall
```

卸载只要求有 Tern，不要求 Node、npm、Bun 或 Droid CLI。它等同于本地执行 `tern plugin remove tern-bridge-droid`；**仅移除插件，保留插件配置、Droid 账号与历史会话，也不卸载 Droid CLI**。先退出插件会话，卸载后重启 Tern 并新建终端窗格。

## 常见问题

**还能用官方 Droid 界面吗？**

可以，运行 `command droid`。`droid --version`、`droid exec …` 等带参数命令仍交给官方 CLI。插件不修改全局 Shell 配置或 Droid 可执行文件。

**输入 `droid` 没打开插件？**

确认已经重启 Tern，并且使用新建的本机 zsh 窗格。其他 Shell 或已有同名 alias/function 时，用 `⌘K` 命令面板打开。日常使用不需要 `tern serve` 或 `tern ctl`。

**需要另外填 API Key 吗？**

插件复用本机 Droid 的认证，不要求另建 Key。先在官方 CLI 中解决登录问题；模型调用和额度仍由 Droid 管理。不要在桥接和官方 CLI 中同时操作同一个会话。

**支持 Droid 的所有功能吗？**

不支持完整复制官方 TUI。`/` 菜单包含插件操作，以及 SDK 提供的自定义命令和可手动调用的 skill，不等于官方 CLI 的全部内置页面。Mission Control 和部分专有页面不在范围内；Spec 的“在新会话执行”目前不可用，可以在当前会话执行或显式分叉。恢复的审批如果已无法响应，需要回到官方客户端处理。

<details>
<summary>找不到 Bun 或 Droid 时，如何指定路径？</summary>

在 Tern 配置目录下的 `plugin-data/tern-bridge-droid/preferences.json` 中设置：

```json
{
  "locale": "zh-CN",
  "bunPath": "/absolute/path/to/bun",
  "droidPath": "/absolute/path/to/droid"
}
```

用 `command -v bun`、`whence -p droid` 在 zsh 中查找真实可执行文件。不要把插件的 `bin/droid` 填成 `droidPath`；修改后新建终端窗格。

</details>

## English

Use Factory Droid in Tern with the original omp conversation UI. Droid keeps control of authentication, models, tools, permissions and saved sessions; this bridge provides the interface.

Install with the curl command above; it requires Tern, an installed and authenticated Droid CLI, Bun 1.3.14+, Node.js 22+, npm, Git and Bash. The script builds `main` in a temporary directory, without installing system tools or changing shell profiles. Review [install.sh](https://github.com/justdoswift/tern-bridge-droid/blob/main/install.sh) before executing remote code. Use `bash -s -- update` to explicitly replace the package only after a successful build, or `bash -s -- uninstall` to remove it. Uninstall needs only Tern and preserves plugin data, accounts, sessions and the official CLI; `tern plugin remove tern-bridge-droid` also works offline. Linked development packages are never automatically unlinked.

Restart Tern, open a new local zsh pane and run `droid` (case-insensitive unless the name is already in use). Use `/` for actions, `Cmd+V` to paste images, `/quit` or two quick presses of `Ctrl+C` to exit, and `command droid` for the official CLI. macOS Apple Silicon is the verified platform; Linux remains unverified. This is not a complete replacement for every Droid TUI feature.

The `/` menu includes Droid's available custom commands and manually invocable skills. Refresh discovery with `/bridge:commands`; disabled and automatic-only skills stay hidden. Droid commands take precedence over matching bridge aliases, while `/bridge:sessions`, `/bridge:help` and other namespaced bridge actions remain available. Skills appear as collapsed cards with an argument preview, including in restored history; click the header or press `Ctrl+O` to see the full instructions. Execution payloads and saved messages are unchanged.

## 许可与致谢

插件自有代码采用 [MIT License](LICENSE)。感谢 Tern、omp 和 Factory Droid；本项目是独立集成，不代表任何上游项目的官方产品或背书。

上游依赖保留各自许可证，见 [第三方许可](dist/THIRD_PARTY_NOTICES.txt)。Droid 名称及官方字标属于 Factory，字标不包含在本项目的 MIT 授权中；MIT 不授予第三方商标权。
