# 16. 受信任扩展

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/16-trusted-extensions) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 状态：已接受待实施（D378、ADR 0207）
> 范围：v1。v2 与 v3 事项列于 §12，不构成承诺。

## 1. 目的与术语

PI-Desktop 有两个扩展面。插件
（[01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system)）是沙箱化、由
manifest 驱动、在 agent 之外运行的。受信任扩展是第二个扩展面：在 Agent sidecar
内运行的 TypeScript 模块，接收一个 `ExtensionAPI` 对象，直接在 agent 循环上注册
工具、命令和事件处理器。`ExtensionAPI` 契约即 `@earendil-works/pi-coding-agent`
定义的契约，PI-Desktop 把它与 `pi-ai`、`pi-agent-core` 内核（ADR 0002）一起采纳为
sidecar 内的扩展契约。本文规定这一扩展面。

| 术语 | 含义 |
|---|---|
| 受信任扩展 | 面向 `ExtensionAPI` 编写的模块，从扩展目录或带 `pi` manifest 字段的包中发现，以 Agent sidecar 的信任级别运行 |
| 插件 | 带 manifest 的 PI-Desktop 插件，在独立进程中、权限网关之下运行（ADR 0008） |
| 适配层 | `packages/agent-runtime` 中在桌面运行时之上实现 `ExtensionAPI` 的层 |
| Runner | 绑定到一个桌面会话的一个 `ExtensionRunner` 实例 |

## 2. 定位与信任模型

1. 受信任扩展与插件是两个独立的扩展面。二者互不转换。
2. 受信任扩展是受信任代码。它在 Agent sidecar 内执行，而 sidecar 已持有 bash、edit
   和 write 工具，因此启用一个扩展授予的正是运行 agent 已经授予的东西。
   [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) 中的插件
   安全基线不适用于它，也不会因此被削弱。
3. 默认不启用任何扩展。D007 继续有效：PI-Desktop 永不自动导入 `~/.pi`。发现只
   列出候选；用户逐个启用。
4. 项目信任门控项目级扩展。工作区 `.pi/extensions` 下发现的扩展只在项目受信任
   后加载，`project_trust` 事件报告该状态。
5. 所有界面上的标签都是“受信任扩展”并附来源路径。市场、签名和更新流程在 v1
   不适用。

## 3. 发现与启用

### 3.1 来源

| 来源 | 路径 | 范围 |
|---|---|---|
| 用户扩展 | `~/.pi/agent/extensions/` | 所有项目 |
| 项目扩展 | `<workspace>/.pi/extensions/` | 该项目，在项目信任之后 |
| 手动路径 | 在设置中选择的任意目录或文件 | 由用户选择范围 |

来源内部的解析遵循 `pi-coding-agent` loader 规则：带 `pi.extensions` 字段的 `package.json`
声明其入口文件；否则为一层深度内的 `index.ts`、`index.js` 或直接的
`*.ts` / `*.js` 文件。不再深入递归。v1 既不读也不写 `~/.pi/agent` 下 pi CLI 的
`settings.json`；启用状态是 PI-Desktop 自己的状态。

### 3.2 启用状态

- 存储在 `~/.pi-desktop` 应用设置的 `piExtensions` 下，以扩展入口的 realpath
  为键。不改 host-core schema。
- 每条记录 `enabled`、范围（`user`、`project:<projectId>` 或 `manual`）、来源和
  最近一次加载诊断。
- 重新扫描是显式动作（设置页按钮或应用启动）。v1 没有文件监听。重新扫描永不
  翻转已启用标记；缺失的条目显示为“缺失”，直到用户移除。
- 删除项目不会删除其扩展条目；它们成为孤儿并在下次重新扫描时被移除。

## 4. 加载与运行时

### 4.1 扩展在哪里运行

扩展在 Agent sidecar 进程（`packages/agent-runtime`）内加载，永远不在 Electron
main、渲染层或插件宿主进程中。

### 4.2 Loader

- sidecar 以与 `pi-ai`、`pi-agent-core` 完全相同的锁定版本依赖
  `@earendil-works/pi-coding-agent`。三者版本必须一致；漂移时 CI 失败。
- 复用 `pi-coding-agent` loader 及其 jiti 流水线。sidecar 打包产物必须保持 jiti 和 loader 在
  运行时可解析；打包步骤由 E2E-240 在其他工作落地前先行验证。
- 导入别名：`@earendil-works/pi-coding-agent`、`pi-ai`、`pi-agent-core` 和
  `typebox` 解析到 sidecar 自带的副本。`@earendil-works/pi-tui` 解析到一个桩
  模块，它把每个符号导出为惰性值，使顶层 import 永不失败。调用被桩替代的
  符号时在调用点产生一条诊断。

### 4.3 每会话一个 Runner

- 每个桌面会话拥有自己的 Runner。Runner 随会话运行时创建，随其丢弃而销毁。
- 由于 jiti 缓存模块，模块实例在 Runner 之间共享。因此模块级状态在会话之间
  共享，这与扩展作者在 pi 单进程运行多会话时看到的一致。v1 记录这一点而不
  绕开它。
- 启用、禁用或重新扫描会使所有 Runner 失效；受影响的会话在下一个回合边界重新
  加载扩展。进行中的回合永不被重新加载打断。

### 4.4 加载失败

加载错误永不导致会话失败。该扩展在诊断中标记为 `error` 并附消息和堆栈，其余
扩展继续加载，回合照常进行。当某个已启用扩展在当前会话加载失败时，composer
显示一行提示。

## 5. API 支持矩阵（v1）

每个 `ExtensionAPI` 成员恰好落入一个类别。不支持的成员仍存在于对象上，不做
任何事，返回文档规定的中性值，并按扩展、按成员各产生一条诊断。它们永不抛出，
因此只使用受��持成员的扩展即使同时触碰了不支持的成员也能工作。

| 类别 | 成员 |
|---|---|
| 支持 | `registerTool`、`registerCommand`、§6 中每个事件的 `on(...)`、`exec`、`getActiveTools`、`getAllTools`、`setActiveTools`、`getCommands`、`setModel`、`getThinkingLevel`、`setThinkingLevel`、`setSessionName`、`getSessionName`、`sendUserMessage`、`getFlag` |
| 上下文上支持 | `ui.notify`、`ui.confirm`、`ui.select`、`ui.input`、`ui.setStatus`、`ui.setWorkingMessage`、`cwd`、`modelRegistry`、`isIdle`、`abort`、`hasPendingMessages`、`getContextUsage`、`compact`、`getSystemPrompt`、`waitForIdle`、`newSession`、`fork` |
| 推迟到 v2 | `sendMessage`、`appendEntry`、`setLabel`、`sessionManager` 只读 API、`switchSession`、`registerShortcut`、`registerMarkdownTransformer`、`ui.setEditorText`、`ui.getEditorText`、`ui.addAutocompleteProvider`、`registerFlag` 值编辑 |
| 不支持 | `ui.setWidget`、`ui.setFooter`、`ui.setHeader`、`ui.setTitle`、`ui.custom`、`ui.overlay`、`ui.onTerminalInput`、`ui.setWorkingVisible`、`ui.setWorkingIndicator`、`ui.setHiddenThinkingLabel`、`ui.pasteToEditor`、`ui.editor`、`registerMessageRenderer`、`registerEntryRenderer`、`navigateTree`、`shutdown` |

中性值：`getFlag` 返回声明的默认值；`registerFlag` 记录声明使 `getFlag` 可用，
但 v1 不暴露 CLI 或 UI；`sessionManager` 访问器返回空结果；UI setter 返回空操作
的 `dispose`。

## 6. 事件映射

事件从桌面运行时现有的 hook 点触发。凡事件类型定义了返回结果的，处理器结果
均被采纳。

| 事件 | 桌面 hook 点 | 是否采纳结果 |
|---|---|---|
| `session_start`、`session_shutdown` | Runner 创建与销毁 | 否 |
| `session_info_changed` | 会话改名 | 否 |
| `project_trust` | 加载时的项目信任查询 | 否 |
| `resources_discover` | skills 与提示模板发现 | 是，新增资源加入目录 |
| `before_agent_start` | 回合内首个 provider 请求之前 | 是，系统提示与消息编辑 |
| `context` | `prepareNextTurn` | 是，替换消息列表 |
| `before_provider_request`、`before_provider_headers`、`after_provider_response` | provider 调用包装 | 请求与头部为是 |
| `agent_start`、`agent_end`、`agent_settled` | Agent 循环边界 | 否 |
| `turn_start`、`turn_end` | 回合边界 | 否 |
| `message_start`、`message_update`、`message_end` | Agent 消息事件 | `message_end` 为是 |
| `tool_call` | `beforeToolCall` | 是，可带理由阻止 |
| `tool_execution_start`、`tool_execution_update`、`tool_execution_end` | 工具执行流 | 否 |
| `tool_result` | `afterToolCall` | 是，替换结果 |
| `model_select`、`thinking_level_select` | provider 绑定变更 | 否 |
| `session_before_compact`、`session_compact`、`session_compact_failed` | 压缩流水线 | `session_before_compact` 为是 |
| `session_before_fork` | `session.fork` | 是 |
| `input` | Host 队列准入 | 是，编辑或丢弃 |
| `user_bash`、`session_before_switch`、`session_before_tree`、`session_tree`、`ui_prompt_start`、`ui_prompt_end` | v1 不触发 | 不适用 |

抛出异常的处理器记为诊断并视为返回 `undefined`。带返回结果的事件若处理器超过
30 秒，则放弃并记诊断，回合以未修改的值继续。

## 7. 工具

1. 注册的工具以其声明名称加入会话工具目录。与核心工具、插件工具或用户 MCP
   工具同名的注册被拒绝并记诊断；先注册者胜出。
2. 扩展工具是非核心工具：与插件工具遵循相同的模式门控和 ToolSearch 延迟。它们
   在 Agent 模式可用，其他模式遵循现有的按模式白名单。
3. 执行在 sidecar 内按 `ExtensionAPI` 的 `execute` 签名进行。不弹出宿主权限提示；信任决定已
   在启用时做出。`onUpdate` 流映射到工具执行更新事件。
4. 每次执行写一条审计记录，含扩展 id、工具名和耗时。不记录参数。
5. `exec` 在 sidecar 内以会话工作目录、会话代理和环境设置运行。

## 8. 命令

1. `registerCommand` 条目出现在全局搜索的 Commands 区（见
   [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette)），
   形式为 `/<name>`，来源显示扩展标签，排在内置和插件命令之后。
2. 命令在 sidecar 内运行，扩展命令上下文绑定到当前会话。它需要一个活动会话；
   否则条目禁用并显示提示。
3. composer 中输入的 `/<name>` 按此顺序解析：内置、提示模板、插件、扩展。冲突
   记为诊断。
4. 运行中的命令与插件命令一样阻止 composer 提交，可从状态栏取消。

## 9. UI 桥接

交互式上下文调用经 sidecar → Electron main → 渲染层往返。

| 调用 | 渲染层界面 | 超时 | 中止时 |
|---|---|---|---|
| `ui.notify` | Toast | 无 | 丢弃 |
| `ui.confirm` | 双动作模态框 | 5 分钟 | 解析为 `false` |
| `ui.select` | 模态列表 | 5 分钟 | 解析为 `undefined` |
| `ui.input` | 模态文本框 | 5 分钟 | 解析为 `undefined` |
| `ui.setStatus`、`ui.setWorkingMessage` | composer 状态栏 | 无 | 清空 |

规则：

- 每会话同一时刻只有一个待处理交互提示。第二个调用排在第一个之后。
- 中止回合时以上述中止值取消待处理提示。
- 远程控制（MVP 后）下提示立即以 `UNSUPPORTED` 失败，直到远程协议路由它；该
  路由属于 v3。
- 提示显示扩展标签和来源路径，让用户知道是谁在询问。

## 10. 协议与 IPC 新增

v1 不改任何 host-core RPC 方法、协议版本或 SQLite schema。

### 10.1 sidecar → main（host.proxy 白名单）

| 方法 | 用途 |
|---|---|
| `extensions.commands.publish` | 替换会话已注册的命令列表 |
| `extensions.ui.request` | §9 中的一次交互或状态调用 |
| `extensions.diagnostics.publish` | 替换会话的诊断列表 |
| `session.rename`、`session.create`、`session.fork` | 已有方法，现可从适配层到达 |

### 10.2 main ↔ 渲染层（Electron IPC）

| 通道 | 方向 | 用途 |
|---|---|---|
| `extensions/list` | 请求 | 候选及其范围、状态和诊断 |
| `extensions/setEnabled` | 请求 | 切换一条记录 |
| `extensions/rescan` | 请求 | 重新运行发现 |
| `extensions/addPath` | 请求 | 经原生选择器令牌的手动来源（D344 规则） |
| `extensions/commands/run` | 请求 | 在当前会话运行已注册命令 |
| `extensions/ui/respond` | 请求 | 回答一个待处理提示 |
| `extensions/changed` | 事件 | 列表或诊断发生变化 |
| `extensions/ui/prompt` | 事件 | 有提示待处理 |

所有通道像其他插件通道一样做 sender 校验，并且不在 MCP 控制面
`pi_desktop_invoke` 的白名单中。

## 11. 设置界面

设置 → 扩展页在 MCP、Skills、子代理旁新增“扩展”标签：

- 按来源分组的列表，含标签、入口路径、范围、启用开关和状态标记（`disabled`、
  `loaded`、`error`、`missing`）。
- 每条记录的诊断抽屉：加载错误、不支持的 API 调用及计数、被拒绝的注册、处理器
  超时。
- “重新扫描”与“添加路径”动作。
- 列表上方一段简短的信任说明，陈述启用意味着授予什么。

## 12. 分阶段

| 阶段 | 内容 | 承诺 |
|---|---|---|
| v1 | §2 至 §11：发现、loader、每会话 Runner、支持矩阵、事件、工具、命令、UI 桥接、设置标签 | 已承诺（D378） |
| v2 | 自定义会话条目（`sendMessage`、`appendEntry`）含 schema 升版和通用渲染、`sessionManager` 只读 shim、`switchSession`、编辑器读写、补全 provider、`registerShortcut`、markdown 转换器 | 已规划，需先决定条目持久化与压缩 |
| v3 | `pi` 包 manifest 与安装、pi CLI `settings.json` 的只读提示、统一 skill 与提示发现、提示的远程控制路由、市场列出 | 未排期 |

v1 交付顺序：打包 spike（E2E-240）、shared 协议类型，然后运行时、main、渲染层
三条线并行。

## 13. 版本策略

- 升级任一 pi 包即同时升级三个包。
- 一组覆盖每个受支持成员的样例扩展在每次升级时作为契约测试运行。
- 新增的 `ExtensionAPI` 成员先落入“不支持”类别并产生诊断，直到后续决策
  移动它们。
- 对外文档只承诺 §5 中“支持”和“上下文上支持”两个类别。

## 14. 待决事项

| 问题 | 决定前的默认 |
|---|---|
| v2 自定义条目是否持久化到 host-core 并参与压缩？ | 持久化；不进入压缩摘要 |
| v3 是否把 pi CLI `settings.json` 的启用路径作为发现提示读取？ | 只读提示，永不写入 |
| 扩展工具是否像插件工具一样按项目可选？ | §3.2 的范围是唯一门控 |
