# 2026-07-26 模型设置中心与 TTS Provider 来源登记

## 任务边界

- 目标：实现 `CFG-01 模型设置中心`，随后让 `PC-05 真实 TTS 与听音` 使用同一配置。
- 硬约束：尽量复用多个参考项目代码，少造轮子；复用任务不做严格独立 Review，只保留来源登记、最小可运行测试、Coordinator 边界核对和真实 UI/API/音频/恢复验收。
- 独立性：Narralume 不运行时依赖 MuseDock、DramaClaw、Toonflow、LumenX 或 LocalMiniDrama。
- 敏感信息：API Key、账号或本机敏感配置不得写入代码、提交、Ledger、设计产物或输出；API 读取不得回显完整 key。

## 冻结搜索顺序

| 顺序 | 参考项目 | 本机状态 | 决策 |
| --- | --- | --- | --- |
| 1 | DramaClaw | `D:\code3\DramaClaw` 不存在 | `reference-only`：本机不可读，本轮不采用 |
| 2 | Toonflow | `D:\code3\Toonflow` 不存在 | `reference-only`：本机不可读，本轮不采用 |
| 3 | LumenX | `D:\code3\LumenX` 不存在 | `reference-only`：本机不可读，本轮不采用 |
| 4 | LocalMiniDrama | `D:\code3\LocalMiniDrama` 不存在 | `reference-only`：本机不可读，本轮不采用 |
| 5 | MuseDock | `D:\code3\MuseDock` 存在，commit `3cf8d392436983e9fa93f9cdf7aa3186780cd5dd` | `port`：移植模型设置交互、配置 normalize/masking/runtime resolve、MiniMax/MiMo TTS 请求合同 |

## MuseDock 可移植来源

### 前端模型设置

| MuseDock 源文件 | 采用方式 | Narralume 目标 |
| --- | --- | --- |
| `frontend-react/src/pages/SettingsPage.jsx` | `port` | 设置中心作为全局页；来源返回；分区状态；dirty 时 `beforeunload` 提醒；中文 loading/success/error 状态 |
| `frontend-react/src/components/settings/ModelSettings.jsx` | `port` | 顶部最终保存；加载/保存禁用；dirty 提示；全局默认模型与供应商列表组合 |
| `frontend-react/src/components/settings/ProviderList.jsx` | `port` | 供应商列表、编辑草稿、空 key 占位、保存到页面后再顶部最终保存、删除确认 |
| `frontend-react/src/components/settings\ModelConfigForm.jsx` | `reference-only` | 只复用字段组织思想；Narralume 首版不引入 MuseDock 的 Dialog/图标/组件依赖 |
| `frontend-react/src/components/settings\GlobalModelSelector.jsx` | `port` | 文本、图片、TTS 三类全局默认模型 selector |
| `frontend-react/src/hooks/useSettings.js` | `port` | server data normalize、public payload 转换、dirty/load/save 状态、active model 解析 |

Narralume 落地原则：

- 不新增 React Router；复用现有顶层 view/query/history 状态。
- 书库顶栏和系列工作台顶栏提供“模型设置”入口；设置页使用来源无关返回。
- 不把模型设置塞入七个 Episode 制作阶段。
- 不为设计/设置页新增图标库或表单库。

### 后端模型配置

| MuseDock 源文件 | 采用方式 | Narralume 目标 |
| --- | --- | --- |
| `server/routes/config.js` | `port` | 新增 Narralume Fastify plugin：读取/保存模型配置 |
| `server/services/ai/aiModelConfig.js` | `port` | normalize、apiKey masking、空 key 保留旧 key、active runtime resolve |
| `server/services/appSettings.js` | `reference-only` | 只参考文件配置读写位置，不复制 MuseDock app settings 业务 |

Narralume 必须补足：

- 写入使用临时文件 + rename，避免配置文件被截断。
- 默认配置包含 `edge-tts`，且 active TTS 默认指向 Edge TTS。
- `GET` 只返回 `hasApiKey`、`apiKeyMasked`、空 `apiKey`，不回显完整 key。
- Runtime consumer 必须读取该配置；只做持久化 UI 不算完成。

## MuseDock TTS 合同

| MuseDock 源文件 | 采用方式 | Narralume 目标 |
| --- | --- | --- |
| `server/services/ai/aiTtsModel.js` | `port` | MiniMax/MiMo 请求、超时、retry、queue、响应解码和错误清洗 |
| `server/services/tts/sceneTts.js` | `reference-only` | 只参考调用边界，不复制 MuseDock 场景业务 |
| `server/services/tts/ttsTimeline.js` | `reference-only` | 只参考时间轴思想，Narralume 继续使用现有 `tts_timeline` store |

MiniMax 合同：

- 默认 base URL：`https://api.minimaxi.com/v1`。
- 请求路径：`/t2a_v2`。
- Header：`Authorization: Bearer <apiKey>`。
- Body：`model`、`text`、`stream: false`、`output_format: "hex"`、`voice_setting`、`audio_setting`、`subtitle_enable: false`。
- 音频：从 hex 解码为 `Buffer`。

MiMo 合同：

- 默认 base URL：`https://api.xiaomimimo.com/v1`。
- 请求路径：`/chat/completions`。
- Header：`api-key: <apiKey>`。
- Body：`messages`、`modalities: ["text", "audio"]`、`audio: { format, voice }`。
- 音频：从 base64 解码为 `Buffer`。

共同边界：

- 429/502/503/504 retry；502/503/504 指数退避，429 线性退避。
- 请求 timeout。
- 按 provider/base/model 维度 queue。
- 错误不得泄露 API Key、完整 signed URL 或原始大 payload。
- 不复制 MuseDock env/appSettings fallback 路径；Narralume runtime config 只来自自身 resolver。

## node-edge-tts 官方资料

当前通过 `npm view node-edge-tts version description repository license types dist-tags dependencies --json` 核验：

- latest/version：`1.2.10`。
- repository：`https://github.com/SchneeHertz/node-edge-tts`。
- license：MIT。
- types：`dist/edge-tts.d.ts`。
- dependencies：`ws`、`https-proxy-agent`、`yargs`。

README 合同：

```ts
import { EdgeTTS } from "node-edge-tts";

const tts = new EdgeTTS({
  voice: "zh-CN-YunjianNeural",
  lang: "zh-CN",
  outputFormat: "audio-24khz-48kbitrate-mono-mp3",
  saveSubtitles: true,
  rate: "default",
  pitch: "default",
  volume: "default",
  timeout: 10000,
});

await tts.ttsPromise(text, audioPath);
```

字幕合同：

- `saveSubtitles: true` 时生成同名 JSON 字幕文件。
- JSON 项包含 `part`、`start`、`end`。
- `start/end` 单位为毫秒。

微软 Learn 当前 `Language and voice support for the Speech service` 页面确认：

- Locale：`zh-CN`。
- Language：Chinese (Mandarin, Simplified)。
- Voice：`zh-CN-YunjianNeural`。
- Gender：Male。
- 可见 styles 包含 `documentary-narration`、`narration-relaxed` 等；首版 Edge TTS 接入不新增 style UI，避免 Edge 服务与 Azure SSML 能力差异造成不可控失败。

Narralume Edge TTS 首版边界：

- 默认 provider：`edge-tts`。
- 默认 language：中文 / `zh-CN`。
- 默认 gender：男性 / `male`。
- UI voice label：`Chinese - China - Yunjian`。
- 实际 voice ID：`zh-CN-YunjianNeural`。
- 输出先写临时 `.mp3`，成功后按现有 TTS 管线需要转换/提交为当前 timeline 合同可消费的音频。
- subtitle JSON 严格校验 array、`part` string、finite nonnegative `start/end`、`end >= start`、单调、数量上限。
- 逐词边界映射到现有 timeline/cue/SRT/ASS；不新建第二套字幕 store 或 TTS store。
- 包内 timeout/reject/partial file 风险由 Narralume adapter 外层清理：临时路径、异常规范化、失败/取消删除音频和 `.json`、成功后 ffprobe。
- System.Speech 保留本地 fallback，但不再作为默认 TTS。

## OpenDesign 决策

- 设计提交：`6ab1592 docs(design): 冻结模型设置中心页面方案`。
- 页面位置：全局设置页。
- 入口：书库顶栏与系列工作台顶栏。
- 不属于七个 Episode 制作阶段。
- 交互：全局默认模型、供应商列表、供应商编辑、页面草稿、顶部最终保存、未保存提醒。
- 视觉：Narralume 暖中性工业编辑风；铜橙唯一主强调；连续工作台，不做卡片墙。
- 密钥：不回显完整 key；Edge TTS 不需要 API Key。
- 异步状态：中文 loading/success/failure/interrupted；保存时禁用重复提交。

## Review 与验证边界

- 本轮以复用和移植为主，不恢复严格独立 Review。
- 必做：
  - 来源登记。
  - 最小可运行测试。
  - Coordinator 边界/安全自审。
  - 真实 UI/API/音频/恢复验收。
- 只有确认无可复用代码且必须新造高风险核心时，才重新评估独立 Review。
