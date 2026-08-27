import { config, modelFor, type AppConfig } from '../config.js'

/**
 * Minimal Anthropic Messages client.
 *
 * Written against fetch rather than the SDK so the streaming path, the prompt-cache headers and
 * the truncation detection are all visible in one file. The key comes from Worker secrets and
 * never leaves the Worker.
 */

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

/*
 * Output ceilings.
 *
 * THESE HAVE TO ALLOW FOR THINKING. On Claude 5 adaptive thinking is on by default and its tokens
 * are billed and counted against max_tokens like any others. A ceiling sized for a model that did
 * not think is a ceiling the visible answer no longer fits inside: the first live plan call came
 * back as JSON cut off mid-string at position 2975, because thinking had eaten most of 8,000.
 *
 * Truncation does not announce itself as truncation either. It arrives as a parse error about
 * an unterminated string, which reads like a model that cannot produce valid JSON.
 */

/** Output ceiling for the single-shot build call. A finished site runs 80-150KB. */
export const MAX_TOKENS_BUILD = 64_000
/** Output ceiling for one section in the sectioned fallback. */
export const MAX_TOKENS_SECTION = 24_000
/** The content plan is compact JSON, but the thinking that precedes it is not. */
export const MAX_TOKENS_PLAN = 32_000

export interface SystemBlock {
  type: 'text'
  text: string
  /** Marks the end of a cacheable prefix. The house rules block is large and identical every
   *  build, which is exactly what prompt caching is for. */
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' }
}

export interface Msg {
  role: 'user' | 'assistant'
  content: string
}

export interface CallOptions {
  system: SystemBlock[]
  messages: Msg[]
  maxTokens: number
  /**
   * How hard the model should work on this call.
   *
   * This replaced temperature. Claude 5 models removed the sampling parameters entirely and
   * REJECT them: sending temperature returns 400 "temperature is deprecated for this model",
   * which is how every generation on the first live deployment failed. Effort is the knob now,
   * and it controls thinking depth and overall token spend rather than randomness.
   *
   * Omitted means "high", which is the right default for anything that writes a whole document.
   * Set it low for cheap checks where a fast answer is worth more than a considered one.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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

function requireKey(cfg: AppConfig): string {
  const key = cfg.anthropicApiKey
  if (!key) {
    throw new AnthropicError(
      'ANTHROPIC_API_KEY is not set. Add it to .env.local for local development, or to the Vercel project environment variables for production. Set DEV_OFFLINE_GENERATION=1 to run the whole pipeline against the offline fixture without a key.',
      500,
      '',
    )
  }
  return key
}

export function requestBodyForTests(cfg: AppConfig, opts: CallOptions, stream: boolean): string {
  return body(cfg, opts, stream)
}

function body(cfg: AppConfig, opts: CallOptions, stream: boolean): string {
  return JSON.stringify({
    model: modelFor(cfg),
    max_tokens: opts.maxTokens,
    // No temperature, top_p or top_k. They are removed on Claude 5 and return a 400.
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    system: opts.system,
    messages: opts.messages,
    ...(opts.stopSequences ? { stop_sequences: opts.stopSequences } : {}),
    ...(stream ? { stream: true } : {}),
  })
}

async function post(opts: CallOptions, stream: boolean): Promise<Response> {
  const cfg = config()
  const key = requireKey(cfg)
  const maxAttempts = 3
  let lastErr: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(cfg.anthropicBaseUrl ?? DEFAULT_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
          /*
           * ONE HOUR CACHE LIFETIME, AND THE MEASUREMENT THAT FORCED IT.
           *
           * The default ephemeral cache lives five minutes. The build call streams for around
           * 470 seconds, which is longer than that, so the house rules written into the cache at
           * the START of a build had already expired by the time the repair pass ran at the end
           * of it. Two real production builds and two local ones all reported
           * cache_read_input_tokens: 0 while dutifully paying the 25% cache WRITE surcharge every
           * single time. The cache was pure cost.
           *
           * Verified against the API on 2026-08-27 before being relied on: a write reports
           * ephemeral_1h_input_tokens and the next call reports cache_read_input_tokens.
           */
          'anthropic-beta': 'extended-cache-ttl-2025-04-11',
        },
        body: body(cfg, opts, stream),
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
export async function callMessage(opts: CallOptions): Promise<CallResult> {
  const res = await post(opts, false)
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>
    stop_reason?: string
    usage?: CallResult['usage']
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  const usage = json.usage ?? {}
  record(usage)
  return { text, stopReason: json.stop_reason ?? null, usage }
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; stopReason: string | null; usage: CallResult['usage'] }

/**
 * Streaming call. Yields text deltas as they arrive so the customer watches the site assemble.
 * That moment is the product (brief s5), so this path is not allowed to buffer.
 */
export async function* streamMessage(opts: CallOptions): AsyncGenerator<StreamChunk> {
  const res = await post(opts, true)
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

  record(usage)
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

// -----------------------------------------------------------------------------------------------
// What a build costs
// -----------------------------------------------------------------------------------------------

/**
 * Token meter.
 *
 * Every call already gets a usage block back from the API and every one of them was being thrown
 * away, so the only honest answer to "what does a build cost me" was a guess. It is a real number
 * and it should be recorded like one, per job, next to the build it paid for.
 *
 * Process-local and reset per generation. A serverless function handles one generation at a time,
 * which is what makes that safe; if that ever stops being true this has to move into the request.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  calls: number
}

const EMPTY: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  calls: 0,
}

let meter: TokenUsage = { ...EMPTY }

export function resetUsageMeter(): void {
  meter = { ...EMPTY }
}

export function usageSoFar(): TokenUsage {
  return { ...meter }
}

function record(usage: CallResult['usage']): void {
  meter.calls += 1
  meter.inputTokens += usage.input_tokens ?? 0
  meter.outputTokens += usage.output_tokens ?? 0
  meter.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
  meter.cacheReadTokens += usage.cache_read_input_tokens ?? 0
}

/**
 * Published per-million-token rates, in US dollars.
 *
 * These are prices on someone else's website, so they go stale. They are here to turn a token
 * count into a number worth looking at, not to be an invoice: the authority is the Anthropic
 * console, and a figure derived from this is an estimate and is labelled as one everywhere it is
 * shown.
 *
 * Cache writes cost about 1.25x input and cache reads about 0.1x, which is why the house rules
 * carry a cache_control breakpoint: they are the same on every build and they are the expensive
 * half of the prompt.
 */
const RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

const FALLBACK_RATE = { input: 3, output: 15 }

export function estimateCostUsd(usage: TokenUsage, model: string): number {
  const rate = RATES[model] ?? FALLBACK_RATE
  const dollars =
    (usage.inputTokens * rate.input +
      usage.cacheWriteTokens * rate.input * 1.25 +
      usage.cacheReadTokens * rate.input * 0.1 +
      usage.outputTokens * rate.output) /
    1_000_000
  return Math.round(dollars * 10_000) / 10_000
}

/** Everything worth writing into the event log when a build finishes. */
export function usageReport(): TokenUsage & { model: string; estimatedCostUsd: number } {
  const model = modelFor(config())
  const usage = usageSoFar()
  return { ...usage, model, estimatedCostUsd: estimateCostUsd(usage, model) }
}
