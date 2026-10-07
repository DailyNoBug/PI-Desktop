# 21. CC Connect 桥接

- 状态: 当前有效
- 决策: D658 / ADR 0330
- 依赖: `19-remote-agent-control-protocol.md`（RACP 1.0、RACP-WS）、
  `07-process-model.md`、`03-tools-and-permissions.md`
- 英文源规格: [英文源规格](/spec/03-runtime/21-cc-connect-bridge)

英文页面是规范源。本页保留架构、协议映射与安全模型，便于中文读者检索；
实现必须以英文规范中的完整定义为准。

本文档规定 CC Connect 集成：通过桌面托管的、经认证的回环 RACP 桥接，由本地托管的
cc-connect 守护进程从消息平台控制真实的 PI-Desktop 项目与会话。

## 1. 架构

```
消息平台（企业微信 / 飞书 / Telegram / Discord / Slack / …）
   ↓  （平台连接：cc-connect 自带的传输层）
cc-connect 守护进程 —— 由桌面从本地已安装的可执行文件启动，
   ↓                   使用 PI 托管的 config.toml + bindings.json
agent 后端 `pidesktop`（Go，位于 cc-connect）
   ↓  RACP-WS，仅 127.0.0.1:<临时端口>，Bearer 设备令牌
桌面 RACP 桥接（Electron 主进程，`bootstrap/racp-bridge.ts`）
   ↓  进程内 Agent Host + RacpHostOperations 适配层
既有 PI 项目/会话/Agent 运行时（sidecar 执行、host-core 持久化、
   桌面队列、审批、会话记录）
   ↔  PI-Desktop 桌面 UI（同一批会话，实时可见）
```

守护进程与桥接是两个进程、生命周期各自独立；桥接服务的是桌面自己的
Agent Host，因此外部消息就是桌面消息——它们经由 `agentPrompt`/`agentStop`
等既注册的 IPC 处理器进入，共享持久化队列，沿同一事件通道流转，并走桌面
权限处理器完成审批。

## 2. 安全与威胁模型

- **认证**：每次 WS 升级都必须携带 Bearer 设备令牌（落盘仅存 SHA-256 哈希，
  常量时间比较）。桥接设备只授予 `viewer/controller/approver` 角色，绝不授予
  `owner`，因此会话删除、设备吊销、项目注册/浏览、技能与 MCP 等操作都被角色
  拒绝；桌面主身份不受影响。
- **暴露面**：监听器绑定 `127.0.0.1` 临时端口；非回环绑定被 WS 绑定层直接拒绝，
  非回环对端收到 403。发现信息位于 `<dataDir>/racp-bridge.json`（0600，不含
  令牌）；令牌单独存放在同机的另一个 0600 文件中。
- **启用**：桥接默认关闭，用户在 CC Connect 面板中启用；该选择会持久化并在
  重启后恢复。停用会关闭监听并删除发现文件。
- **守护进程**：只从本地检测到的可执行文件启动（绝不下载）；PI 托管的配置
  保存在插件数据目录——绝不读写 `~/.cc-connect`。日志摘录有上限，并对
  令牌形态的字符串（`pdt1.`/`ppt1.`）做脱敏。
- **AI 边界**：外部聊天文本与会话中的桌面输入一样属于不可信输入；每个高危
  工具调用仍然要过审批。桥接不会放宽权限上限，也绝不会自动开启
  bypass/yolo；来自桥接设备的 `allow-session` 在宿主侧被拒绝（非配对远端
  主体）。
- **附件**：上传经内容寻址的附件 blob 存储暂存（限制单文件大小、分块顺序、
  规范 base64、文件名净化、拒绝可执行扩展名）；`turn/start` 只接受与当前
  会话绑定的已暂存附件 id。远端用户无法指定可读路径。

## 3. 协议映射

线上协议即 RACP 1.0 / RACP-WS（见
`19-remote-agent-control-protocol.md`），本集成使用以下能力：

| cc-connect 需求 | RACP 操作 |
| --- | --- |
| 发现/认证 | `connection/initialize`（+ `notifications/initialized`），Bearer 设备令牌 |
| 列出项目 / 会话 | `project/list`、`session/list`、`session/get` |
| 创建 / 选择会话 | `session/create`（标题、项目、ask 模式），绑定在客户端解析 |
| 发送用户消息 | `turn/start`（admission `queue`、幂等请求 id、已暂存附件引用） |
| 流式响应 | `events/subscribe`（`session` 作用域）；`item.delta` 文本、`item.started|completed` 工具 |
| 中止 | `turn/interrupt`（活动）/ `turn/cancel`（排队） |
| 审批 | `approval.requested` 事件 → `approval/respond`（仅 `allow-once`/`deny`） |
| 附件 | `attachment/create` → `attachment/put`（≤512 KiB 分块）→ `attachment/complete` |
| 恢复 | 游标持久化 + `session/attach`（`after`），resync 时回快照 |

桌面侧的会话目录变更（create/configure/fork/rename/delete）经由既注册的
会话 IPC 处理器，使渲染进程状态与 host-core 始终走桌面路径；类
`session.changed` 的通知会刷新打开的面板。

## 4. 安装与配置

1. 本地安装 cc-connect（已在该侧配置的平台凭据仍保留在 cc-connect 自己的
   文件中）。
2. 在 PI-Desktop 中打开 **CC Connect** 工作面板，打开「启用桥接」，再点
   「启动守护进程」。插件会生成 `<plugin-data>/config/config.toml`
   （agent `pidesktop`、`token_file` 指向桌面令牌文件、`bindings_file`
   指向面板的绑定文件、`permission_mode = "ask"`），并以
   `cc-connect --config <file>` 启动。
3. 在面板中添加会话绑定；绑定持久化在插件设置中，并原子落盘为
   `bindings.json`。
4. 从已绑定的会话向机器人发消息。

诊断：面板展示可执行文件检测结果（带安装提示——绝不自动下载）、桥接
URL 与运行状态、守护进程 pid/日志；认证失败会以控制器消息原样报错。

## 5. 绑定语义

一个绑定是 `(平台, 账号, 会话)` → `(项目, 会话, 模式)`。`pidesktop`
后端在 `StartSession(sessionID)` 时解析 PI 会话：

| 模式 | 解析规则 |
| --- | --- |
| `fixed` | 绑定中的 `sessionId`；用 `session/get` 校验（会话缺失时回退重新解析） |
| `latest` | 该绑定 `project` 下 `session/list` 中 `updatedAt` 最新的会话 |
| `new` | 用配置的标题 `session/create`；引擎按会话持久化解析出的 id，后续消息自动续用 |

绑定存储在插件设置中（宿主持久化，两侧进程重启后仍在），并原子落盘为
`bindings.json`（0600）。cc-connect 引擎还会按会话持久化 agent 侧会话
id，未绑定会话的对话因此也能保留会话；`session/get` + 持久化游标使恢复
幂等——重连绝不会复制出新的 PI 会话。

## 6. 恢复与重连

- Go 客户端为每个会话维护持久化游标（`epoch`、`sequence`）。传输中断后
  以有界退避重连、重新初始化、携带游标重新 attach，并对重放的持久事件做
  恰好一次处理；`replayComplete: false` 的 resync 会重读快照后继续实时流。
- pi-host/桌面重启会更换临时端口；守护进程重读发现文件（或由握手获得新
  URL）并按游标恢复。绑定与会话连续性由 E2E-270 第二阶段覆盖。
- 桌面重启时，若此前启用过桥接会自动恢复；设备令牌文件使守护进程无需
  重新配对即可重连。

## 7. 局限

- `input.requested`（结构化 AskUserQuestion）暂不呈现到聊天；请求在宿主侧
  按既定超时过期。
- 附件为单向（聊天 → agent）；agent 产出的文件与桌面一致，以路径引用出现在
  会话记录中。
- 每台桌面对应一个本地守护进程；Gateway/多主机拓扑仍属 RACP Gateway 的
  后续工作。
- 真实消息平台与真实模型提供方属于用户协助验证（E2E-270 使用 stub 模型，
  由 Go 后端充当平台边缘）。
