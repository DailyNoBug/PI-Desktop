# 20. Remote SSH 桌面客户端

- 状态：已接受待实现
- 决策：D434 / ADR 0294
- 传输：系统 OpenSSH 本地端口转发上的 `RACP-WS`
- 远端 Host：Linux x64 / arm64 `pi-host`
- 英文源规格：[英文源规格](/spec/03-runtime/20-remote-ssh-desktop)

英文页面是规范源。本页为中文读者概述 Desktop 侧职责；字段、操作和错误
语义以英文源规格为准。

Desktop 侧负责 SSH Host 发现与管理、bootstrap、配对、端口转发、重连、
远程项目、renderer 路由、provider 同步与诊断。RACP wire 合同由
`19-remote-agent-control-protocol.md` 定义，远端执行由 `packages/pi-host`
拥有。

```text
RemoteConnection
    └── RemoteHost
          ├── RemoteProject A
          │     ├── Session A1
          │     └── Session A2
          └── RemoteProject B
                └── Session B1
```

禁止 SSHFS、SFTP mount、仓库同步和逐命令 `ssh host "…"`。远端 Host 是
工作区、Shell、会话、队列、审批和秘密的权威边界。

- `RemoteConnection` / `RemoteHost` / `RemoteProject` 分离，多个项目和会话可共享同一 Host。
- Renderer 看到的项目路径是 `ssh://<connection-key><absolute-path>`。
- 远端会话携带 `hostId`，没有该字段表示本地 Host。
- Device token 只保存在本机 host-core secret store；私钥、provider key 和 token 不进入 Renderer。Managed SSH 密码只允许一次性写入，绝不回读给 Renderer，也不进入连接 JSON、普通 SQLite、URL 或日志。
- 未知 Host key 必须显示指纹并经用户确认；绝不注入 `StrictHostKeyChecking=no`。
- 未知 Host key 通过同一 system-OpenSSH 连接选项（含 alias、`ProxyJump`、
  `ProxyCommand`）写入私有临时 `known_hosts` 以提出指纹；用户确认后才用
  `StrictHostKeyChecking=accept-new` 确认，校验指纹一致，再写入真实
  `known_hosts`。
- 每个连接提供状态、来源、最近连接时间、Host 版本、连接/断开、测试、显式升级/重启到当前 Desktop 版本、device token 撤销、刷新、编辑、移除、远程项目选择和诊断复制。
- 用户可手工创建连接，字段包含显示名、`user@host` 或 `host`、port，以及 agent、密码或 identity file 三选一的显式认证方式。显式 target user 始终生效，即使 OpenSSH alias 或配置文件提供其他用户。
- 密码输入只写入 host-core secret backend，不进入连接 JSON、导出/导入、诊断或日志；连接时通过不含秘密的临时 askpass launcher 交给 system OpenSSH。Identity 模式只保存路径，不读取私钥字节。
- 连接可以导出/导入版本化 JSON。文档只含非秘密连接元数据，绝不包含 device token、provider 凭据、私钥字节、Host 记录或项目。导入逐项校验，并更新既有 alias 或 managed endpoint 而不是制造重复记录。

Desktop 通过 SSH 检测 Linux 架构，获取同版本 GitHub Release checksum，上传 bootstrap 脚本，在远端用户目录 SHA-256 验证并安装 `pi-host`，以 `setsid` 显式启动 daemon，再通过 RACP 初始化交换一次性 pairing token。之后建立只绑定 loopback 的本地端口转发。

协议或存储版本不兼容时终止本次连接并提示升级，不能运行 Agent。显式升级会关闭本地传输，用强制重启重新执行带 checksum 的 bootstrap，并沿同一配对路径重连；绝不安装未校验包或绕过版本协商。
只有较旧的 Host 才会自动或显式升级到 Desktop 当前版本。较新的 Host 进入
`incompatible` 并要求升级 Desktop；PI-Desktop 绝不降级它。

撤销 device token 会断开本地 RACP 客户端、停止远端 Host、清除 owner-only
token 文件、删除本地 secret，并在下次连接前要求重新配对。

重连使用 `0s, 1s, 2s, 4s, 8s, 15s, 30s, 30s…`；认证、Host key、token、checksum 或协议不兼容错误不盲目重试。RACP 订阅保留 `{ epoch, sequence }` cursor，重连后按 cursor 或 snapshot 恢复，不重复执行已完成的工具调用或已准入 prompt。

Renderer 继续调用 `lib/api.ts`，没有 SSH、child process、key 或 token API。Electron Main 按 `hostId` 和 `ssh://` 项目 URI 路由 session、turn、queue、审批、AskTool、Files 和 Review diff 操作。远端事件转换回共享 `AgentEventEnvelope` 后进入现有 transcript reducer。

远程项目 prompt 从远端 Host 自己的 `~/.agents` 与 `<workspace>/.agents` 注册表解析启用的全局/项目 Skills。模型目录只含 id、名称和描述；`Skill` 调用由远端 Host 通过 `skills.read` 应答，因此技能文档与执行都留在该 Host。Plan 模式与本地 runtime 一样拒绝 Skill 工具。

远程项目选择器通过 `workspace/browse` 浏览，接受远端绝对路径，提供 Host
主目录，并列出该连接持久化 `RemoteProject` 记录中的最近规范化路径。

Settings 会把 Skill 列表、创建/编辑、删除、启用/作用域、读取和本地 Markdown 导入路由到这些远端注册表。导入只在 Electron Main 读取一次本地文档，然后通过 RACP 写入正文，不 mount 远端文件系统。本地 reveal 会隐藏，因为路径属于远端 Host。

用户自有 MCP server 遵循同一规则。Settings 会通过 owner-only RACP 操作，把
MCP 列表、创建/编辑、删除、启用/作用域、导入和测试路由到选中的远程项目。
`pi-host` 在该 Host 上启动 stdio 进程（或访问其 HTTP endpoint）、发现工具，并在
远端进程内解析模型调用；Desktop 本地 MCP 进程绝不会静默替代。能力行会标注
`Remote: <connection-key>` 执行位置。

Connections 还负责反向中继选择。Electron Main 只目录化未请求文件系统权限的
活跃本地插件工具，以及用户本地 MCP 配置贡献的工具；选中名称按
`RemoteConnection` 持久化，保存与连接时会按当前目录重新校验，并在 RACP 初始化后
连同 schema、source 与声明 risk 一起广告。远端 Host 先走正常权限流程，再请求
Desktop 执行；Electron Main 只执行当前选中且不依赖 workspace 的工具，并拒绝
过期、未选中、需要文件系统或任意 IPC 的请求。中继描述与请求绝不携带私钥、
device token、provider 凭据或 Host secret。

本地专用注册表会如实标注而不是伪装成远端。远程项目激活时，Subagents 设置页把
Desktop 本地全局注册表标为 `Local` 与 `Unavailable remotely`。Plugins 页把每个
Desktop 插件标为 `Local`；未显式中继的 agent 工具、插件 Skills、插件 MCP 和
trusted extensions 额外标注 `Unavailable remotely`。Panel、view、command、theme、
service 等 Desktop shell 能力保持本地标注，不声称远端可用。

| 现有 API | 远端路由 |
|---|---|
| session list/create/get/fork/configure/rename/delete/compact | 对应 RACP remote-host 操作 |
| prompt、regenerate、stop、abort、status、queue | `turn/start`（含 Host 内截断）、`turn/stop`、`turn/interrupt`、revision 操作、snapshot 与队列操作 |
| 工具权限与 AskTool 决议 | `approval/respond`、`input/respond` |
| Plan/Goal pending 与 resolve | 远端审批请求和响应 |
| Files list/read/index 与 Review diff | `workspace/list`、`workspace/read`、`workspace/diff` |
| project get/list/set/clear | 本地远端项目记录与活动 Host |

工作面板仅在远程项目激活时提供 Terminal 工具。它打开远端 pty，通过 RACP
流式传输 base64 PTY 输出，传播测量到的尺寸变化，并在公告连接关闭时把 UI 标为
断开。关闭标签页会关闭远端终端；重连不会尝试重新附加已消失的 pty。

Remote provider 凭据由 Settings 明确显示目标机器后，经 SSH bootstrap 通道写入远端 Host 的秘密存储，也支持删除；凭据不经过 RACP。

打包应用注册 `pi-desktop` scheme。稳定入口为
```text
pi-desktop://connections/ssh/add?name=GPU&alias=gpu-server
pi-desktop://projects/remote/open?connection=gpu-server&path=/home/dev/project
```
`pi-desktop://connections/ssh/add` 与 `pi-desktop://projects/remote/open`。深链会在本地 Host 与 Remote manager 就绪前排队；添加连接和打开项目都必须原生确认，入站 URL 不能静默信任 Host key、添加连接或打开远端路径。解析器拒绝未知路由、通配连接、相对路径、dot-segment逃逸、非法端口和含空格的 SSH alias。
