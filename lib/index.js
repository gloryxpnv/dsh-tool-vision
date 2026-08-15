/**
 * dsh-tool-vision — bridge tool that routes image understanding to a local
 * LM Studio VLM while the main agent model stays text-only (e.g. DeepSeek).
 *
 * Two surfaces:
 *  - the model-facing `vision` tool: reads an image file and returns the VLM's
 *    textual answer (no image block ever enters the main model's context);
 *  - the optional `vision-bridge` service: lets the host admit uploaded-image
 *    messages on a text-only route by replacing image parts with VLM
 *    descriptions before the prompt reaches the model.
 *
 * @module dsh-tool-vision
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-vision'

/** The services this plugin needs: the tool registry and the sandboxed fs. */
export const inject = ['tools', 'fs']

/** Plugin configuration; every field has a local-first default. */
export const Config = z.object({
  /** LM Studio OpenAI-compatible endpoint root, without a trailing path. */
  baseURL: z.string().default('http://127.0.0.1:4407/v1'),
  /** The vision-language model id LM Studio serves. */
  model: z.string().default('qwen3.5-9b-vlm'),
  /** Output token cap for the VLM answer; reasoning models consume part of it. */
  maxTokens: z.number().step(1).min(1).default(8192),
  /**
   * Structured mode: the VLM is asked to return fixed-shape JSON evidence
   * (summary / ocr / layout / semantics / visual / uncertainty) which is
   * parsed and returned as an object instead of free text. Falls back to a
   * free-text answer wrapped in the same shape when parsing fails.
   */
  structured: z.boolean().default(true),
  /** Maximum wall time for one LM Studio request. */
  timeoutMs: z.natural().default(180000),
  /** Maximum encoded bytes accepted for one image. */
  maxImageBytes: z.natural().default(50 * 1024 * 1024),
})

/** Extensions `vision` accepts; the VLM request carries the declared media type. */
const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * The canonical outcome declared by the `vision` output schema.
 * Structured mode: `answer` is a fixed-shape evidence object
 * (summary / ocr / layout / semantics / visual / uncertainty), so the main
 * model can quote specifics instead of trusting a free-form retelling.
 * Free-text mode keeps the legacy `answer` string.
 */
const EVIDENCE_SHAPE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    ocr: {
      type: 'object',
      additionalProperties: false,
      properties: {
        full_text: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
          },
        },
      },
    },
    layout: {
      type: 'object',
      additionalProperties: false,
      properties: {
        regions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string' },
              reading_order: { type: 'number' },
              text: { type: 'string' },
            },
          },
        },
      },
    },
    semantics: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scene: { type: 'string' },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              evidence: { type: 'string' },
            },
          },
        },
        relations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              subject: { type: 'string' },
              predicate: { type: 'string' },
              object: { type: 'string' },
            },
          },
        },
      },
    },
    visual: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dominant_colors: { type: 'array', items: { type: 'string' } },
        style: { type: 'string' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
    uncertainty: { type: 'array', items: { type: 'string' } },
  },
}

const valueShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string' },
    model: { type: 'string' },
    answer: {
      oneOf: [
        { type: 'string' },
        EVIDENCE_SHAPE,
      ],
    },
  },
}

/**
 * The fixed JSON template the VLM is asked to fill in structured mode.
 * Full transcription, reading-order layout regions, entity/relation lists,
 * and an explicit uncertainty list so the model states what it could not
 * determine instead of guessing. No pixel coordinates or confidence scores:
 * vision models tend to fabricate those, so the schema deliberately omits
 * them and relies on verbatim text plus explicit uncertainty instead.
 */
const STRUCTURED_PROMPT = `You are a vision engine reading an image. Analyze the image carefully and return ONLY a single valid JSON object with EXACTLY this shape — no markdown fences, no commentary, no extra keys:

{
  "summary": "one-paragraph overview of the image",
  "ocr": {
    "full_text": "every visible text character, transcribed verbatim, in reading order",
    "lines": [ { "text": "one text line, verbatim" } ]
  },
  "layout": {
    "regions": [
      { "type": "title|paragraph|list|table|chart|form|code|image|icon|link|nav|other",
        "reading_order": 1,
        "text": "text inside this region, or describe the region if it has no text" }
    ]
  },
  "semantics": {
    "scene": "what kind of scene or context the image shows",
    "entities": [ { "name": "entity name", "type": "person|org|place|object|brand|number|date|other", "evidence": "where in the image this entity appears" } ],
    "relations": [ { "subject": "entity A", "predicate": "relation verb", "object": "entity B" } ]
  },
  "visual": {
    "dominant_colors": [ "color names or hex" ],
    "style": "art/design style, if any",
    "notes": [ "other visual observations" ]
  },
  "uncertainty": [ "anything you could NOT determine; empty array if fully confident" ]
}

Rules:
- Transcribe text verbatim; do not paraphrase or fix typos.
- If any text is blurry/illegible/truncated, put it in uncertainty — never invent it.
- If the image is not what the question expects, say so in uncertainty.
- Return the JSON object as the entire answer.`

/**
 * Scan for the first balanced {...} JSON object starting at `text.indexOf('{')`.
 * Walks char by char, skipping strings and escapes, so nested objects and
 * prose around the JSON are handled. Returns the parsed object, or undefined
 * when the first block does not parse.
 * @param {string} text - the remaining reply, starting anywhere.
 * @returns {object | undefined}
 */
function parseFirstJsonBlock(text) {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1))
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Extract a JSON object from a VLM reply that may wrap it in markdown fences
 * or stray prose. Tries the whole reply first, then scans for the first
 * balanced {...} block from each `{` position. Returns the parsed object, or
 * undefined when no object can be recovered.
 * @param {string} text - raw VLM reply.
 * @returns {object | undefined}
 */
function extractJsonObject(text) {
  if (typeof text !== 'string') return undefined
  const candidate = text.trim()
  try {
    const parsed = JSON.parse(candidate)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {
    // fall through to the block scan
  }
  let idx = candidate.indexOf('{')
  while (idx !== -1) {
    const parsed = parseFirstJsonBlock(candidate.slice(idx))
    if (parsed !== undefined) return parsed
    idx = candidate.indexOf('{', idx + 1)
  }
  return undefined
}

/** Coerce an unknown value into a string (empty when absent). */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/** Coerce an unknown value into a string array (empty when absent). */
function asStringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/**
 * Normalize a parsed evidence object into the exact EVIDENCE_SHAPE, filling
 * missing keys and dropping extras so the declared output schema holds.
 * @param {object | undefined} parsed - object recovered from the VLM reply.
 * @param {string} fallbackText - free-text answer used when parsing failed.
 * @returns {object} a well-formed evidence object.
 */
function normalizeEvidence(parsed, fallbackText) {
  if (parsed === undefined) {
    // Parse failure: keep the raw text in summary and say so explicitly.
    return {
      summary: fallbackText,
      ocr: { full_text: '', lines: [] },
      layout: { regions: [] },
      semantics: { scene: '', entities: [], relations: [] },
      visual: { dominant_colors: [], style: '', notes: [] },
      uncertainty: ['VLM 未返回有效 JSON，已回退为原始文本回答'],
    }
  }
  const ocrRaw = parsed.ocr ?? {}
  const layoutRaw = parsed.layout ?? {}
  const semanticsRaw = parsed.semantics ?? {}
  const visualRaw = parsed.visual ?? {}
  const regions = Array.isArray(layoutRaw.regions)
    ? layoutRaw.regions
      .filter((r) => r !== null && typeof r === 'object')
      .map((r) => ({
        type: asString(r.type),
        reading_order: typeof r.reading_order === 'number' ? r.reading_order : 0,
        text: asString(r.text),
      }))
    : []
  const entities = Array.isArray(semanticsRaw.entities)
    ? semanticsRaw.entities
      .filter((e) => e !== null && typeof e === 'object')
      .map((e) => ({
        name: asString(e.name),
        type: asString(e.type),
        evidence: asString(e.evidence),
      }))
    : []
  const relations = Array.isArray(semanticsRaw.relations)
    ? semanticsRaw.relations
      .filter((r) => r !== null && typeof r === 'object')
      .map((r) => ({
        subject: asString(r.subject),
        predicate: asString(r.predicate),
        object: asString(r.object),
      }))
    : []
  return {
    summary: asString(parsed.summary),
    ocr: {
      full_text: asString(ocrRaw.full_text),
      lines: Array.isArray(ocrRaw.lines)
        ? ocrRaw.lines
          .filter((l) => l !== null && typeof l === 'object')
          .map((l) => ({ text: asString(l.text) }))
        : [],
    },
    layout: { regions },
    semantics: {
      scene: asString(semanticsRaw.scene),
      entities,
      relations,
    },
    visual: {
      dominant_colors: asStringArray(visualRaw.dominant_colors),
      style: asString(visualRaw.style),
      notes: asStringArray(visualRaw.notes),
    },
    uncertainty: asStringArray(parsed.uncertainty),
  }
}

/**
 * Build the LM Studio request, scoped to the caller's abort signal plus a
 * hard timeout. Node 22 provides AbortSignal.any/timeout.
 * @param {string} baseURL - configured endpoint root.
 * @param {object} body - chat/completions payload.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {number} timeoutMs - per-request wall-time cap.
 */
function buildRequest(baseURL, body, signal, timeoutMs) {
  const url = baseURL.replace(/\/+$/, '') + '/chat/completions'
  const timeout = AbortSignal.timeout(timeoutMs)
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
  })
}

/** The model-facing prompt: user question or a general description request. */
function buildPrompt(question, structured) {
  if (structured === true) return STRUCTURED_PROMPT
  const text = question !== undefined && question.trim().length > 0
    ? question.trim()
    : 'Describe this image in detail, including any visible text, layout, and notable elements.'
  return text
}

/**
 * One LM Studio vision call: bytes + media type + prompt → answer.
 * In structured mode the VLM is asked to fill the fixed JSON template; the
 * reply is parsed into a normalized evidence object (falling back to a
 * free-text answer wrapped in the same shape when parsing fails). In
 * free-text mode it returns the plain answer string.
 * @param {object} config - resolved plugin configuration.
 * @param {Uint8Array} data - encoded image bytes.
 * @param {string} mediaType - declared image media type.
 * @param {string} prompt - the model-facing instruction.
 * @param {AbortSignal | undefined} signal - caller cancellation.
 * @param {boolean} structured - request and parse structured JSON evidence.
 * @returns {Promise<string | object>} answer text, or evidence object.
 */
async function vlmDescribe(config, data, mediaType, prompt, signal, structured = false) {
  const base64 = Buffer.from(data).toString('base64')
  const payload = {
    model: config.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + base64 } },
      ],
    }],
    max_tokens: config.maxTokens,
    stream: false,
  }
  let response
  try {
    response = await buildRequest(config.baseURL, payload, signal, config.timeoutMs)
  } catch (error) {
    throw new Error('LM Studio request failed (' + String(error) + ')')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error('LM Studio returned HTTP ' + response.status + ': ' + body.slice(0, 300))
  }
  const json = await response.json()
  const message = json?.choices?.[0]?.message
  // Reasoning VLMs (e.g. qwen3.5-9b-vlm) emit the final answer in `content`,
  // but only after burning tokens on `reasoning_content`. With a tight token
  // budget the model can stop mid-thought, leaving `content` empty — prefer
  // any non-empty field over the empty string.
  const content = (message?.content ?? '').trim()
  const reasoning = (message?.reasoning_content ?? '').trim()
  const answer = content.length > 0 ? content : reasoning
  if (answer.length === 0) throw new Error('LM Studio returned an empty answer')
  if (!structured) return answer
  return normalizeEvidence(extractJsonObject(answer), answer)
}

export function apply(ctx, config) {
  // ── Optional vision-bridge service ────────────────────────────────────────
  // Lets the host admit uploaded-image prompts on a text-only route: image
  // parts (base64 payload) become text descriptions from the local VLM. On any
  // failure we return undefined so the host keeps its original refusal.
  ctx.provide('vision-bridge', {
    async describeImages(content) {
      let changed = false
      const out = []
      for (const part of content) {
        if (part === null || typeof part !== 'object' || part.type !== 'image') {
          out.push(part)
          continue
        }
        changed = true
        try {
          const data = Buffer.from(String(part.data ?? ''), 'base64')
          const answer = await vlmDescribe(config, data, String(part.mediaType), buildPrompt(undefined, config.structured), undefined, config.structured)
          const label = part.name !== undefined && String(part.name).length > 0
            ? String(part.name)
            : '上传图片'
          // Structured evidence would bury the answer in JSON; the bridge
          // message is for the main model, so surface the summary (or the raw
          // text) plus a hint that the image was already read locally — the
          // main model must not go hunting for the original file on disk.
          const shown = typeof answer === 'object' && answer !== null
            ? (answer.summary.length > 0 ? answer.summary : answer.ocr.full_text)
            : answer
          out.push({ type: 'text', text: '【' + label + '】' + shown + '（已由本地视觉模型识别，无需查找原文件）' })
        } catch (error) {
          ctx.logger.warn('[tool-vision] vision-bridge describe failed: ' + String(error))
          return undefined
        }
      }
      return changed ? out : undefined
    },
  })

  ctx.tools.register(defineTool({
    name: 'vision',
    description:
      'Describe or answer questions about an image file using the local LM Studio vision model. '
      + 'Use this when the user asks about the content of an image (a screenshot, photo, diagram, UI, chart, '
      + 'or any picture file) — e.g. to recognize text, layout, objects, or visual details. '
      + 'Returns the vision model\'s textual answer; the image itself never enters the main model\'s context. '
      + 'Accepts PNG/JPEG/WebP/GIF paths, absolute or relative to the session workspace.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the image file, resolved by the filesystem backend.',
      },
      question: {
        type: 'string',
        description: 'Optional question or instruction for the vision model (e.g. "What does this screenshot show?" or "Extract all text"). Defaults to a general description.',
      },
    },
    output: {
      schema: valueShape,
      render: (_args, value) => {
        const answer = value.answer
        let body
        if (typeof answer === 'string') {
          body = answer
        } else {
          const lines = [
            answer.summary,
            '',
            'OCR: ' + (answer.ocr.full_text || '—'),
            '布局区域: ' + answer.layout.regions.map((r) => '[' + r.type + '] ' + r.text).join(' | '),
            '实体: ' + answer.semantics.entities.map((e) => e.name + '(' + e.type + ')').join(', '),
            '关系: ' + answer.semantics.relations.map((r) => r.subject + ' ' + r.predicate + ' ' + r.object).join('; '),
            '视觉: ' + [answer.visual.style, answer.visual.dominant_colors.join(', ')].filter(Boolean).join(' | '),
            '不确定项: ' + (answer.uncertainty.length > 0 ? answer.uncertainty.join('; ') : '无'),
          ]
          body = lines.filter((l, i) => !(i > 0 && l === '')).join('\n')
        }
        return [{
          type: 'text',
          text: '[vision:' + value.model + '] ' + value.file + '\n' + body,
        }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requestedPath = args.file_path.trim()
      if (requestedPath.length === 0) throw new Error('vision: file_path must be a non-empty string')

      const ext = requestedPath.slice(requestedPath.lastIndexOf('.')).toLowerCase()
      const mediaType = IMAGE_EXTENSIONS[ext]
      if (mediaType === undefined) {
        throw new Error('vision: "' + requestedPath + '" is not a PNG/JPEG/WebP/GIF image path')
      }

      // Resolve against the calling session's workspace, like the read tools.
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(requestedPath, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal,
      })
      const info = await ctx.fs.stat(target, exec.signal)
      if (info === undefined) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new Error('vision: "' + target.displayPath + '" not found')
      }
      if (info.type !== 'file') {
        throw new Error('vision: "' + target.displayPath + '" is not a regular file')
      }

      const data = await ctx.fs.readBytes(target, exec.signal, config.maxImageBytes)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

      const answer = await vlmDescribe(config, data, mediaType, buildPrompt(args.question, config.structured), exec.signal, config.structured)

      return {
        file: target.displayPath,
        model: config.model,
        answer,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: 'Vision ' + args.file_path,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}