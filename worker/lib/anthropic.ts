import type { Env } from '../env'
import { modelFor } from '../env'

/**
 * Minimal Anthropic Messages client.
 *
 * Written against fetch rather than the SDK so the streaming path, the prompt-cache headers and
 * the truncation detection are all visible in one file. The key comes from Worker secrets and
 * never leaves the Worker.
 */

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/** Output ceiling for the single-shot build call. A finished site runs 80-150KB. */
export const MAX_TOKENS_BUILD = 32_000
/** Output ceiling for one section in the sectioned fallback. */
export const MAX_TOKENS_SECTION = 12_000
/** The content plan is JSON and compact. */
export const MAX_TOKENS_PLAN = 8_000

export interface SystemBlock {
  type: 'text'
  text: string
  /** Marks the end of a cacheable prefix. The house rules block is large and identical every
   *  build, which is exactly what prompt caching is for. */
  cache_control?: { type: 'ephemeral' }
}

export interface Msg {
  role: 'user' | 'assistant'
  content: string
}

export interface CallOptions {
  system: SystemBlock[]
  messages: Msg[]
  maxTokens: number
  temperature?: number
  stopSequences?: string[]
}

export interface CallResult {
  text: string
  stopReason: string | null
  usage: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'AnthropicError'
  }
}

function requireKey(env: Env): string {
  const key = env.ANTHROPIC_API_KEY?.trim()
  if (!key) {
    throw new AnthropicError(
      'ANTHROPIC_API_KEY is not set. Add it to .dev.vars for local dev, or `wrangler secret put ANTHROPIC_API_KEY` for production. Set DEV_OFFLINE_GENERATION=1 to run the pipeline without it.',
      500,
      '',
    )
  }
  return key
}

function body(env: Env, opts: CallOptions, stream: boolean): string {
  return JSON.stringify({
    model: modelFor(env),
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0.4,
    system: opts.system,
    messages: opts.messages,
    ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
    ...(stream ? { stream: true } : {}),
  })
}

async function post(env: Env, opts: CallOptions, stream: boolean): Promise<Response> {
  const key = requireKey(env)
  const maxAttempts = 3
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body: body(env, opts, stream),
      })

      if (res.ok) return res

      const text = await res.text()
      // 429 and 5xx are worth another go. 4xx otherwise is our bug and retrying just burns time.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new AnthropicError(`Anthropic ${res.status}`, res.status, text)
        if (attempt < maxAttempts) {
          await sleep(600 * attempt * attempt)
          continue
        }
      }
      throw new AnthropicError(
        `Anthropic API returned ${res.status}: ${text.slice(0, 400)}`,
        res.status,
        text,
      )
    } catch (err) {
      lastErr = err
      if (err instanceof AnthropicError && err.status < 500 && err.status !== 429) throw err
      if (attempt === maxAttempts) break
      await sleep(600 * attempt * attempt)
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new AnthropicError('Anthropic request failed', 500, String(lastErr))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Non-streaming call. Used for the content plan and for repair passes. */
export async function callMessage(env: Env, opts: CallOptions): Promise<CallResult> {
  const res = await post(env, opts, false)
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
    stop_reason?: string
    usage?: CallResult['usage']
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  return { text, stopReason: json.stop_reason ?? null, usage: json.usage ?? {} }
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; stopReason: string | null; usage: CallResult['usage'] }

/**
 * Streaming call. Yields text deltas as they arrive so the customer watches the site assemble.
 * That moment is the product (brief s5), so this path is not allowed to buffer.
 */
export async function* streamMessage(env: Env, opts: CallOptions): AsyncGenerator<StreamChunk> {
  const res = await post(env, opts, true)
  if (!res.body) throw new AnthropicError('Anthropic returned no body', 502, '')

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let stopReason: string | null = null
  let usage: CallResult['usage'] = {}

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value

      // SSE frames are separated by a blank line.
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)

        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const raw = dataLine.slice(5).trim()
        if (!raw || raw === '[DONE]') continue

        let evt: {
          type?: string
          delta?: { type?: string; text?: string; stop_reason?: string }
          usage?: CallResult['usage']
          message?: { usage?: CallResult['usage'] }
          error?: { message?: string; type?: string }
        }
        try {
          evt = JSON.parse(raw)
        } catch {
          continue
        }

        if (evt.type === 'error') {
          throw new AnthropicError(
            `Anthropic stream error: ${evt.error?.message ?? 'unknown'}`,
            502,
            raw,
          )
        }
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          yield { type: 'text', text: evt.delta.text ?? '' }
        }
        if (evt.type === 'message_delta') {
          stopReason = evt.delta?.stop_reason ?? stopReason
          if (evt.usage) usage = { ...usage, ...evt.usage }
        }
        if (evt.type === 'message_start' && evt.message?.usage) {
          usage = { ...usage, ...evt.message.usage }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  yield { type: 'done', stopReason, usage }
}

/**
 * Truncation detection. Brief s5: check stop_reason and whether </html> is present.
 * `max_tokens` on the stop reason means the model ran out of room mid-document.
 */
export function isTruncated(html: string, stopReason: string | null): boolean {
  if (stopReason === 'max_tokens') return true
  return !/<\/html>\s*$/i.test(html.trim())
}

/** Models like to wrap output in a code fence even when told not to. Strip it, quietly. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:html|json)?\s*\n([\s\S]*?)\n?```$/i)
  if (fenced?.[1]) return fenced[1].trim()
  // Opening fence with no close, which happens when output is truncated.
  const openOnly = trimmed.match(/^```(?:html|json)?\s*\n([\s\S]*)$/i)
  if (openOnly?.[1]) return openOnly[1].trim()
  return trimmed
}

/** Pull the first balanced JSON object out of a response. */
export function extractJson(text: string): string {
  const cleaned = stripCodeFence(text)
  const start = cleaned.indexOf('{')
  if (start === -1) return cleaned

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return cleaned.slice(start, i + 1)
    }
  }
  return cleaned.slice(start)
}
