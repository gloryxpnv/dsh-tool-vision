# dsh-tool-vision

**为纯文本的 DeepSeek Harness agent 提供本地优先的视觉能力。**

> npm 包：**`dsh-vision-local`** · 源码仓库：`gloryxpnv/dsh-tool-vision` · [English README](README.en.md)

让纯文本模型（DeepSeek、GLM 等不支持图片输入的模型）拥有"视觉"——使用**本地**视觉模型，**零 API 成本**，**图片数据完全不出本机**。

```
DeepSeek (纯文本) ──▶ vision 工具 ──▶ 本地 VLM（LM Studio / Ollama / 任意 OpenAI 兼容端点）
                                     ◀── 结构化 JSON 证据 ──▶
```

---

## 亮点

- 🏠 **完全本地、完全私密。** 图片只发送给你自己的本地视觉模型（LM Studio、Ollama、vLLM 或任意 OpenAI 兼容端点）。无需云端 key、无单图成本、图片字节永不离开你的机器。
- 📋 **结构化证据，而非模糊转述。** VLM 被要求填写固定 JSON 模板——`summary`（摘要）、`ocr`（逐字全文+行）、`layout`（版面区域，含阅读顺序）、`semantics`（实体与关系）、`visual`（配色/风格），以及显式的 `uncertainty`（不确定项）列表。主模型引用具体证据作答，而不是凭空猜测。
- 🛡️ **反幻觉设计。** 模板*强制*模型在 `uncertainty` 中声明无法确定的内容；无文字的图片 OCR 返回空字段而非编造文字。若 VLM 未能产出合法 JSON，插件回退为原始回答并明确标注——绝不静默捏造。
- 📎 **粘贴 / 上传图片即可用。** 可选的 `vision-bridge` 服务让纯文本路由直接接收粘贴或上传的图片：宿主在 prompt 到达模型前，将图片交给本地 VLM 描述。不再被 `read_image` 门禁拒绝，也无需先保存文件。开启 `keepThumbnail` 后，消息历史**保留原图缩略图**，描述文字紧随其后。
- ⚙️ **零配置起步，全部可调。** 默认指向 `http://127.0.0.1:1234/v1`（LM Studio 默认端口）；端点、模型 id、token 预算、超时、图片大小上限、结构化开关——每个旋钮都是文档化的配置字段。
- 🚀 **为本地 GPU 调优。** 默认参数（8192 输出 token、50 MB 图片上限、180 秒超时）面向本地工作站 GPU 上的 9B 级 VLM，而非轻量云请求。
- 🔌 **一个插件，两个表面。** 面向模型的 `vision` 工具（图片路径或图片问题出现时即可调用）+ 可选的 `vision-bridge` 服务（供希望纯文本路由自动接收图片的宿主使用）。

## 安装

```sh
# 在 DSH profile 目录中（或通过 dsh CLI）：
dsh plugin --profile web add dsh-vision-local
```

然后可将插件行加入你的 profile patch（`cordis.patch.yml`），或直接依赖 bundle 自带的配置层——bundle 附带一份开箱即用的 `cordis.patch.yml`（合理默认值）。

安装后重启宿主（`pnpm dsh web` 或你的启动命令）以加载模块。

### 环境要求

- 一个运行中的本地视觉模型，提供 OpenAI 兼容的 `/chat/completions` 端点（例如 [LM Studio](https://lmstudio.ai)、Ollama、vLLM 或任意网关）。
- Node.js ≥ 20。
- 带插件加载器的 DeepSeek Harness（`dsh`）。

## 使用

模型会看到一个 `vision` 工具。任何出现图片文件路径或图片问题的时候，它都会调用：

```
vision(file_path: "/path/to/image.png", question?: "这张图里有什么？")
```

支持格式：PNG、JPEG、WebP、GIF。

### 结构化输出结构

在结构化模式（默认开启）下，`answer` 是一个规范化后的证据对象：

```jsonc
{
  "summary": "一段概览",
  "ocr": { "full_text": "逐字转写的全部可见文字", "lines": [{ "text": "单行文字" }] },
  "layout": { "regions": [{ "type": "title|paragraph|list|table|chart|form|code|image|icon|link|nav|other", "reading_order": 1, "text": "..." }] },
  "semantics": {
    "scene": "场景类型",
    "entities": [{ "name": "...", "type": "person|org|place|object|brand|number|date|other", "evidence": "..." }],
    "relations": [{ "subject": "...", "predicate": "...", "object": "..." }]
  },
  "visual": { "dominant_colors": ["#ffffff"], "style": "...", "notes": ["..."] },
  "uncertainty": ["模型无法确定的内容"]
}
```

若 VLM 回复无法解析为 JSON，`answer` 会回退为原始文本，并在 `uncertainty` 中注明——工具绝不捏造内容。

### vision-bridge（可选）

`ctx.provide('vision-bridge', { describeImages(content) })` — 让纯文本宿主路由直接接收图片部分，将其替换为 `【名称】<VLM 摘要>（已由本地视觉模型识别，无需查找原文件）`。失败时返回 `undefined`，宿主保持原有行为。

开启 `keepThumbnail: true` 时，图片块**保留**在消息历史中（UI 显示缩略图），描述文字作为相邻文本块紧随其后。注意：这要求宿主在纯文本序列化时丢弃图片块（模型只收文字）——若你的宿主在纯文本路由上拒绝图片内容，请保持 `keepThumbnail` 为 `false`（默认），此时图片块会被替换为纯描述文字。

## 配置

| 字段 | 默认值 | 说明 |
| :-- | :-- | :-- |
| `baseURL` | `http://127.0.0.1:1234/v1` | OpenAI 兼容端点根地址（不带尾部路径） |
| `model` | `qwen3.5-9b-vlm` | 端点提供的视觉语言模型 id |
| `maxTokens` | `8192` | 输出 token 上限；推理型 VLM 会消耗一部分用于思考 |
| `structured` | `true` | 请求固定结构的 JSON 证据并返回解析后的对象 |
| `keepThumbnail` | `false` | 在消息历史中保留图片块（缩略图），要求宿主的纯文本序列化会丢弃图片块 |
| `timeoutMs` | `180000` | 单次请求的墙钟超时上限 |
| `maxImageBytes` | `52428800`（50 MB） | 接受的图片最大编码大小 |

## 工作原理

1. `vision` 工具基于会话工作区（沙箱 fs）解析图片路径，读取字节。
2. 构建 base64 data-URL 图片块 + 结构化模板 prompt，调用本地端点的 `/chat/completions`。
3. 回复由括号配平 JSON 提取器解析（支持 markdown fence、JSON 前后的散文、嵌套对象——不会截断残缺片段），再规范化到声明的输出 schema。
4. 主模型只收到证据对象；图片本身永不进入其上下文。

推理型模型注意：会输出 `reasoning_content` 的 VLM 在 token 预算紧张时可能中途停止思考，导致 `content` 为空。插件优先取任一非空字段（`content` → `reasoning_content`），8192 的默认 token 预算为两者都留足了空间。

## 安全与隐私

- **图片永不离开你的机器。** 所有推理都在你配置的端点上完成。
- 无遥测，除你配置的本地端点外不做任何网络调用。
- 插件只通过沙箱 fs 读取你指定的图片文件。
- 将提取出的文字视为不可信输入：绝不执行图片中出现的指令。
- 与任何 DSH 插件一样，安装即以你的权限运行第三方代码——安装前请审阅源码。

## License

MIT
