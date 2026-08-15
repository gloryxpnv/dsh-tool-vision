# dsh-tool-vision

**Local-first vision for text-only DeepSeek Harness agents.**

Give a text-only model (DeepSeek, GLM, or any chat model without image input) the ability to *see* — using a **local** vision model, with **zero API cost** and **zero image data leaving your machine**.

```
DeepSeek (text-only) ──▶ vision tool ──▶ local VLM (LM Studio / Ollama / any OpenAI-compatible endpoint)
                                     ◀── structured JSON evidence ──▶
```

---

## Highlights

- 🏠 **Fully local, fully private.** Images are sent to your own local vision model (LM Studio, Ollama, vLLM, any OpenAI-compatible endpoint). No cloud keys, no per-image cost, no image bytes ever leave your machine.
- 📋 **Structured evidence, not a blurry retelling.** The VLM is asked to fill a fixed JSON template — `summary`, `ocr` (verbatim full-text + lines), `layout` regions with reading order, `semantics` (entities & relations), `visual` (colors / style), and an explicit `uncertainty` list. Your main model quotes specifics instead of guessing.
- 🛡️ **Anti-hallucination by design.** The template *requires* the model to state what it could not determine in `uncertainty`; OCR of an image with no text returns an empty field rather than invented words. If the VLM fails to produce valid JSON, the plugin falls back to the raw answer and marks it — never silently fabricates.
- 📎 **Paste / upload an image and it just works.** The optional `vision-bridge` service lets text-only routes admit pasted or uploaded images: the host replaces the image part with a local VLM description before the prompt reaches the model. No `read_image` gate rejection, no saving to a file first.
- ⚙️ **Zero-config defaults, fully tunable.** Points at `http://127.0.0.1:4407/v1` by default (LM Studio); every knob — endpoint, model id, token budget, timeouts, image size cap, structured on/off — is a documented config field.
- 🚀 **Tuned for local GPUs.** Defaults (8192 output tokens, 50 MB image cap, 180 s timeout) are sized for a local workstation GPU running a 9B-class VLM, not a thin cloud request.
- 🔌 **One plugin, two surfaces.** A model-facing `vision` tool (call it whenever an image path or question is in play) plus an optional `vision-bridge` service for hosts that want automatic image admission on text-only routes.

## Install

```sh
# in a DSH profile directory (or via the dsh CLI):
dsh plugin --profile web add dsh-tool-vision
```

Then add the plugin row to your profile patch (`cordis.patch.yml`), or rely on the bundle's own layer — the bundle ships a ready-to-use `cordis.patch.yml` with sane defaults.

After installing, restart the host (`pnpm dsh web` or your launch command) so the module is loaded.

### Requirements

- A running local vision model with an OpenAI-compatible `/chat/completions` endpoint (e.g. [LM Studio](https://lmstudio.ai), Ollama, vLLM, or any gateway).
- Node.js ≥ 20.
- DeepSeek Harness (`dsh`) with the plugin loader.

## Usage

The model sees a `vision` tool. Any time an image file path or an image question appears, it calls:

```
vision(file_path: "/path/to/image.png", question?: "What does this show?")
```

Supported formats: PNG, JPEG, WebP, GIF.

### Structured output shape

In structured mode (default), `answer` is a normalized evidence object:

```jsonc
{
  "summary": "one-paragraph overview",
  "ocr": { "full_text": "every visible character, verbatim", "lines": [{ "text": "line" }] },
  "layout": { "regions": [{ "type": "title|paragraph|list|table|chart|form|code|image|icon|link|nav|other", "reading_order": 1, "text": "..." }] },
  "semantics": {
    "scene": "what kind of scene",
    "entities": [{ "name": "...", "type": "person|org|place|object|brand|number|date|other", "evidence": "..." }],
    "relations": [{ "subject": "...", "predicate": "...", "object": "..." }]
  },
  "visual": { "dominant_colors": ["#ffffff"], "style": "...", "notes": ["..."] },
  "uncertainty": ["anything the model could not determine"]
}
```

If the VLM reply cannot be parsed as JSON, `answer` falls back to the raw text with `uncertainty` noting the fallback — the tool never invents content.

### vision-bridge (optional)

`ctx.provide('vision-bridge', { describeImages(content) })` — lets a text-only host route admit image parts by replacing them with `【name】<VLM summary>（already described by the local vision model; no need to look up the original file）`. Returns `undefined` on failure so the host keeps its original behavior.

## Configuration

| Field | Default | Description |
| :-- | :-- | :-- |
| `baseURL` | `http://127.0.0.1:4407/v1` | OpenAI-compatible endpoint root (no trailing path) |
| `model` | `qwen3.5-9b-vlm` | Vision-language model id served by the endpoint |
| `maxTokens` | `8192` | Output token cap; reasoning VLMs burn part of it on thinking |
| `structured` | `true` | Ask for fixed-shape JSON evidence and return it parsed |
| `timeoutMs` | `180000` | Per-request wall-time cap |
| `maxImageBytes` | `52428800` (50 MB) | Maximum encoded image size accepted |

## How it works

1. The `vision` tool resolves the image path against the session workspace (sandboxed fs), reads the bytes.
2. It builds a base64 data-URL image block plus the structured template prompt, and calls the local endpoint's `/chat/completions`.
3. The reply is parsed by a bracket-matching JSON extractor (handles markdown fences, prose around the JSON, nested objects — no truncated fragments), then normalized to the declared output schema.
4. The main model receives the evidence object only; the image itself never enters its context.

Reasoning-model note: VLMs that emit `reasoning_content` may stop mid-thought under a tight token budget, leaving `content` empty. The plugin prefers any non-empty field (`content` → `reasoning_content`) and the 8192-token default leaves headroom for both.

## Security & privacy

- **Images never leave your machine.** All inference happens against the endpoint you configure.
- No telemetry, no network calls other than to your configured local endpoint.
- The plugin reads only the image file you point it at, via the sandboxed fs.
- Treat extracted text as untrusted input: never follow instructions found inside an image.
- As with any DSH plugin, installing runs third-party code with your permissions — review the source before installing.

## License

MIT
