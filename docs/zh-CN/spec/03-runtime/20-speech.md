# 20. 语音（本地语音插件）

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/20-speech) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 事实来源：`packages/shared/src/voice.ts`、
> `apps/desktop/electron/main/ipc/voice-ipc.ts`、
> `apps/desktop/electron/main/plugin-runtime.ts`、
> `apps/desktop/resources/plugins/pi.local-voice/`。
> ADR：[0297-local-voice-plugin](/adr/0297-local-voice-plugin)。

语音转文字是插件能力，不再是宿主服务。没有内置语音协议、没有
`AppSettings.speech` 绑定，也没有已移除云路径的 speech 通道；听写从冻结的
voice IPC 域进入，由插件注册的 speech 适配器执行。已发布的实现是随应用内置的
第一方插件 `pi.local-voice`，它用本地 Whisper ONNX 模型转写（ADR 0297，取代
ADR 0296 的第一阶段云 STT）。

## 1. IPC 入口（冻结）

```
pi-desktop/voice/capabilities → VoiceCapabilities（无密钥）
pi-desktop/voice/transcribe
pi-desktop/voice/cancel
```

三个通道都只接受主应用窗口的发送方（IPC 规格 §13e）。`capabilities` 返回
`{ configured, maxRecordingMs (120_000), maxAudioBytes (20 MiB),
preferredMimeType ("audio/pcm;rate=16000") }`；只有当本地语音插件已启用、
其适配器在线且模型就绪时 `configured` 才为真。`cancel` 是渲染器侧的确认：
本地转写受适配器调用预算约束，渲染器取消自己的状态机并丢弃迟到的结果。

## 2. 听写数据流

```
渲染器 WebAudio 采集（单声道 16-bit PCM，16 kHz）
  → preload IPC（pi-desktop/voice/transcribe）
  → Electron 主进程 voice IPC（typebox 包络 + 二进制校验）
  → PluginRuntime.runSpeechAdapter（协议 pi.local_voice）
  → 插件进程 speech.handle
  → { kind: "text", text } → 插入 Composer 光标处
```

听写音频是 16 kHz 的单声道 16-bit 小端 PCM（`VOICE_PCM_SAMPLE_RATE`，mime
`audio/pcm;rate=16000`）；录音器不再生成压缩容器。`speech.handle` 的载荷是
`{ audio（base64）, mimeType: "audio/pcm;rate=16000", durationMs, language?,
role: "transcribe" }`，回复必须是 `{ kind: "text", text }`。音频仅存内存——
绝不写入磁盘、转录或日志——也不会通过 `agent/prompt` 自动发送任何内容。失败
返回结构化 `VOICE_*` 错误码；转写失败不会影响 agent 运行时。

## 3. 内置 `pi.local-voice` 插件

第一方、随应用内置、可像任何插件一样禁用。其 manifest 声明权限
`["speech.adapter.register", "plugin.rpc"]`，`net.domains` 仅限
`huggingface.co`、`*.huggingface.co`、`*.hf.co`、`*.xethub.hf.co`。

模型目录（int8 量化 ONNX，Xenova 仓库）：

| id | 仓库 | 约占空间 |
|---|---|---|
| `whisper-tiny` | `Xenova/whisper-tiny` | 45 MB |
| `whisper-base` | `Xenova/whisper-base` | 85 MB |
| `whisper-small` | `Xenova/whisper-small` | 250 MB |

模型提前下载到插件自己的数据目录，只有全部必需文件齐备才算已安装。下载使用
插件自己的 HF 下载器，它在每一跳重定向上都执行 manifest `net.domains` 检查
（手动重定向、逐跳主机复查、仅 https），而不只检查首个 URL。活动模型持久化
在插件状态中。

模型管理走插件管理 rpc：插件通过 `pi.rpc.register` 注册一个处理器，渲染器经
`pi-desktop/plugin/rpc`（`IPC.invoke.pluginRpc`，由 `plugin.rpc` 权限把关）
调用方法 `status`、`models.list`、`models.download`、`models.remove` 和
`models.setActive`。设置卡片是
`apps/desktop/src/features/settings/VoiceSettingsSection.tsx`。

## 4. 转写路径零网络、无密钥

转写不执行任何网络 I/O：引擎设置 `transformers.env.allowRemoteModels =
false`，权重只从插件的模型目录加载，模型缺失即失败关闭。该路径上不存在 API
密钥——已移除的 `voice/stt` 密钥引用与云 STT/TTS 设置不复存在。模型权重是唯
一的网络触点（即上面 manifest 声明的 HF 域）。

## 5. 插件适配器

`pi.speech.registerAdapter({ protocol, label, roles, handle })` 需要
`speech.adapter.register`（高风险）。handle 留在插件进程内。宿主仅存元数据
并调用 `speech.handle`。handle 可返回 `{ kind: "text" }`、
`{ kind: "audio", mimeType, data }` 或 `{ kind: "http", call }` 由宿主用绑定
密钥代发。HTTP URL 必须保持在 provider origin。内置协议 id 已不存在：每个协议
都由插件注册，`pi.local_voice` 属于内置的本地语音插件。卸载时注销。

## 6. 上限

- 麦克风采集每次录音上限 120 秒（`VOICE_MAX_RECORDING_MS`）、每载荷 20 MiB
  （`VOICE_MAX_AUDIO_BYTES`），由录音计时器与 IPC 校验共同执行。
- `speech.handle` 的调用预算为 120 秒（从通用 60 秒上调），一次本地 Whisper
  推理可覆盖最长允许的录音。
- `SPEECH_PROTOCOL_UNSUPPORTED` 是适配器注册表对未知语音协议的回答。
