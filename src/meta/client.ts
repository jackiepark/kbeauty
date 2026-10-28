import type { ChatModel, ChatRequest, ChatResponse, ChatUsage, ToolCall } from './types.js'

export const META_MODEL_API_BASE_URL = 'https://api.meta.ai/v1'
/** Standard tier. The `-contributor` variants let Meta train on inputs, so shopper text never goes there. */
export const META_DEFAULT_MODEL = 'muse-spark-1.3'
const DEFAULT_TIMEOUT_MS = 20_000

export type MetaModelErrorKind =
  | 'auth'
  | 'rate-limited'
  | 'invalid-request'
  | 'upstream'
  | 'timeout'
  | 'network'
  | 'empty-response'

/** Raw provider bodies are never copied into the message, so it is safe to log. */
export class MetaModelError extends Error {
  readonly kind: MetaModelErrorKind
  readonly status: number | null
  readonly retryAfterSeconds: number | null

  constructor(
    kind: MetaModelErrorKind,
    message: string,
    status: number | null = null,
    retryAfterSeconds: number | null = null,
  ) {
    super(message)
    this.name = 'MetaModelError'
    this.kind = kind
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }

  /** Worth one immediate retry: the request itself was fine. */
  get transient(): boolean {
    return this.kind === 'upstream' || this.kind === 'network'
  }
}

export interface MetaChatModelOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

type ApiChoice = {
  finish_reason?: string | null
  message?: { content?: string | null; tool_calls?: unknown }
}

type ApiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
}

function toUsage(raw: ApiUsage | undefined): ChatUsage {
  return {
    inputTokens: Number(raw?.prompt_tokens ?? 0),
    outputTokens: Number(raw?.completion_tokens ?? 0),
    reasoningTokens: Number(raw?.completion_tokens_details?.reasoning_tokens ?? 0),
    cachedInputTokens: Number(raw?.prompt_tokens_details?.cached_tokens ?? 0),
  }
}

function toToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (typeof call?.id !== 'string' || typeof call.function?.name !== 'string') return []
    const args = typeof call.function.arguments === 'string' ? call.function.arguments : '{}'
    return [{ id: call.id, type: 'function' as const, function: { name: call.function.name, arguments: args } }]
  })
}

function retryAfter(response: Response): number | null {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : null
}

function errorForStatus(response: Response): MetaModelError {
  const { status } = response
  if (status === 401 || status === 403)
    return new MetaModelError('auth', `Meta Model API rejected the key (${status})`, status)
  if (status === 429)
    return new MetaModelError('rate-limited', 'Meta Model API rate limit', status, retryAfter(response))
  if (status >= 500) return new MetaModelError('upstream', `Meta Model API failed (${status})`, status)
  return new MetaModelError('invalid-request', `Meta Model API rejected the request (${status})`, status)
}

export function toChatCompletionBody(model: string, request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages,
    reasoning_effort: request.reasoningEffort,
    max_tokens: request.maxTokens,
  }
  if (request.tools?.length) {
    body.tools = request.tools
    body.tool_choice = 'auto'
    body.parallel_tool_calls = request.parallelToolCalls ?? true
  }
  if (request.responseFormat) body.response_format = request.responseFormat
  return body
}

/** Meta Model API client over Chat Completions. One attempt per call; callers decide on retries. */
export function createMetaChatModel(options: MetaChatModelOptions): ChatModel {
  const model = options.model ?? META_DEFAULT_MODEL
  const baseUrl = (options.baseUrl ?? META_MODEL_API_BASE_URL).replace(/\/+$/, '')
  const fetchImpl = options.fetch ?? fetch
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!options.apiKey) throw new MetaModelError('auth', 'Meta Model API key is missing')

  return {
    model,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const controller = new AbortController()
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(toChatCompletionBody(model, request)),
          signal: controller.signal,
        })
      } catch (error) {
        clearTimeout(timer)
        if (controller.signal.aborted)
          throw new MetaModelError('timeout', `Meta Model API timed out after ${timeoutMs}ms`)
        throw new MetaModelError('network', error instanceof Error ? error.message : 'Meta Model API network error')
      }

      try {
        if (!response.ok) throw errorForStatus(response)
        const payload = (await response.json()) as { choices?: ApiChoice[]; usage?: ApiUsage }
        const choice = payload.choices?.[0]
        const content = typeof choice?.message?.content === 'string' ? choice.message.content : null
        const toolCalls = toToolCalls(choice?.message?.tool_calls)
        const finishReason = choice?.finish_reason ?? null
        if (!toolCalls.length && !content?.trim()) {
          // Seen when reasoning spends the whole token budget (finish_reason "length").
          throw new MetaModelError(
            'empty-response',
            `Meta Model API returned no content (${finishReason ?? 'unknown'})`,
          )
        }
        return { content, toolCalls, finishReason, usage: toUsage(payload.usage) }
      } catch (error) {
        if (error instanceof MetaModelError) throw error
        if (controller.signal.aborted)
          throw new MetaModelError('timeout', `Meta Model API timed out after ${timeoutMs}ms`)
        throw new MetaModelError('upstream', 'Meta Model API returned an unreadable response')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
