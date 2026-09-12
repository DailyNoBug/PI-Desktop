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

Desktop 通过 SSH 检测 Linux 架构，获取同版本 GitHub Release checksum，上传 bootstrap 脚本，在远端用户目录 SHA-256 验证并安装 `pi-host`，以 `setsid` 显式启动 daemon，再通过 RACP 初始化交换一次性 pairing token。之后建立只绑定 loopback 的本地端口转发。

重连使用 `0s, 1s, 2s, 4s, 8s, 15s, 30s, 30s…`；认证、Host key、token、checksum 或协议不兼容错误不盲目重试。RACP 订阅保留 `{ epoch, sequence }` cursor，重连后按 cursor 或 snapshot 恢复，不重复执行已完成的工具调用或已准入 prompt。

Renderer 继续调用 `lib/api.ts`，没有 SSH、child process、key 或 token API。Electron Main 按 `hostId` 和 `ssh://` 项目 URI 路由 session、turn、queue、审批、AskTool、Files 和 Review diff 操作。远端事件转换回共享 `AgentEventEnvelope` 后进入现有 transcript reducer。

| 现有 API | 远端路由 |
|---|---|
| session list/create/get/fork/configure/rename/delete/compact | 对应 RACP remote-host 操作 |
| prompt、stop、abort、status、queue | `turn/start`、`turn/stop`、`turn/interrupt`、snapshot 与队列操作 |
| 工具权限与 AskTool 决议 | `approval/respond`、`input/respond` |
| Plan/Goal pending 与 resolve | 远端审批请求和响应 |
| Files list/read/index 与 Review diff | `workspace/list`、`workspace/read`、`workspace/diff` |
| project get/list/set/clear | 本地远端项目记录与活动 Host |

Remote provider 凭据由 Settings 明确显示目标机器后，经 SSH bootstrap 通道写入远端 Host 的秘密存储，也支持删除；凭据不经过 RACP。
