# 20. Remote SSH 桌面客户端

- 状态：已接受待实现
- 决策：D408 / ADR 0234
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
- Device token 只保存在本机 host-core secret store；私钥、密码、provider key 和 token 不进入 Renderer、普通 SQLite、URL 或日志。
- 未知 Host key 必须显示指纹并经用户确认；绝不注入 `StrictHostKeyChecking=no`。
- 每个连接提供状态、来源、最近连接时间、Host 版本、连接/断开、测试、显式升级/重启到当前 Desktop 版本、刷新、编辑、移除、远程项目选择和诊断复制。

Desktop 通过 SSH 检测 Linux 架构，获取同版本 GitHub Release checksum，上传 bootstrap 脚本，在远端用户目录 SHA-256 验证并安装 `pi-host`，以 `setsid` 显式启动 daemon，再通过 RACP 初始化交换一次性 pairing token。之后建立只绑定 loopback 的本地端口转发。

协议或存储版本不兼容时终止本次连接并提示升级，不能运行 Agent。显式升级会关闭本地传输，用强制重启重新执行带 checksum 的 bootstrap，并沿同一配对路径重连；绝不安装未校验包或绕过版本协商。

重连使用 `0s, 1s, 2s, 4s, 8s, 15s, 30s, 30s…`；认证、Host key、token、checksum 或协议不兼容错误不盲目重试。RACP 订阅保留 `{ epoch, sequence }` cursor，重连后按 cursor 或 snapshot 恢复，不重复执行已完成的工具调用或已准入 prompt。

Renderer 继续调用 `lib/api.ts`，没有 SSH、child process、key 或 token API。Electron Main 按 `hostId` 和 `ssh://` 项目 URI 路由 session、turn、queue、审批、AskTool、Files 和 Review diff 操作。远端事件转换回共享 `AgentEventEnvelope` 后进入现有 transcript reducer。

远程项目 prompt 从远端 Host 自己的 `~/.agents` 与 `<workspace>/.agents` 注册表解析启用的全局/项目 Skills。模型目录只含 id、名称和描述；`Skill` 调用由远端 Host 通过 `skills.read` 应答，因此技能文档与执行都留在该 Host。Plan 模式与本地 runtime 一样拒绝 Skill 工具。

用户自有 MCP server 遵循同一规则。Settings 会通过 owner-only RACP 操作，把
MCP 列表、创建/编辑、删除、启用/作用域、导入和测试路由到选中的远程项目。
`pi-host` 在该 Host 上启动 stdio 进程（或访问其 HTTP endpoint）、发现工具，并在
远端进程内解析模型调用；Desktop 本地 MCP 进程绝不会静默替代。能力行会标注
`Remote: <connection-key>` 执行位置。

| 现有 API | 远端路由 |
|---|---|
| session list/create/get/fork/configure/rename/delete/compact | 对应 RACP remote-host 操作 |
| prompt、stop、abort、status、queue | `turn/start`、`turn/stop`、`turn/interrupt`、snapshot 与队列操作 |
| 工具权限与 AskTool 决议 | `approval/respond`、`input/respond` |
| Plan/Goal pending 与 resolve | 远端审批请求和响应 |
| Files list/read/index 与 Review diff | `workspace/list`、`workspace/read`、`workspace/diff` |
| project get/list/set/clear | 本地远端项目记录与活动 Host |

Remote provider 凭据由 Settings 明确显示目标机器后，经 SSH bootstrap 通道写入远端 Host 的秘密存储，也支持删除；凭据不经过 RACP。

打包应用注册 `pi-desktop` scheme。稳定入口为
```text
pi-desktop://connections/ssh/add?name=GPU&alias=gpu-server
pi-desktop://projects/remote/open?connection=gpu-server&path=/home/dev/project
```
`pi-desktop://connections/ssh/add` 与 `pi-desktop://projects/remote/open`。深链会在本地 Host 与 Remote manager 就绪前排队；添加连接和打开项目都必须原生确认，入站 URL 不能静默信任 Host key、添加连接或打开远端路径。解析器拒绝未知路由、通配连接、相对路径、dot-segment逃逸、非法端口和含空格的 SSH alias。
