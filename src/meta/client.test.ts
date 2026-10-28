import { describe, expect, it } from 'vitest'
import { MetaModelError, createMetaChatModel, toChatCompletionBody } from './client.js'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('createMetaChatModel', () => {
  it('posts an OpenAI-compatible body with tools, strict format and reasoning effort', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const model = createMetaChatModel({
      apiKey: 'test-key',
      fetch: (async (url: string, init: RequestInit) => {
        captured = { url, init }
        return jsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Checking.',
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'check_product', arguments: '{"productId":"p1"}' } },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 3 },
            prompt_tokens_details: { cached_tokens: 2 },
          },
        })
      }) as typeof fetch,
    })
    const response = await model.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: { name: 'check_product', description: 'd', strict: true, parameters: { type: 'object' } },
        },
      ],
      responseFormat: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: { type: 'object' } },
      },
      reasoningEffort: 'low',
      maxTokens: 2000,
    })
    expect(captured).not.toBeNull()
    const { url, init } = captured as unknown as { url: string; init: RequestInit }
    expect(url).toBe('https://api.meta.ai/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'muse-spark-1.3',
      tool_choice: 'auto',
      parallel_tool_calls: true,
      reasoning_effort: 'low',
      max_tokens: 2000,
      response_format: { type: 'json_schema' },
    })
    expect(response.toolCalls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'check_product', arguments: '{"productId":"p1"}' } },
    ])
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cachedInputTokens: 2 })
  })

  it('omits tool fields without tools', () => {
    const body = toChatCompletionBody('muse-spark-1.3', { messages: [], reasoningEffort: 'minimal', maxTokens: 10 })
    expect(body).not.toHaveProperty('tools')
    expect(body).not.toHaveProperty('tool_choice')
  })

  it('maps HTTP failures to typed errors without copying provider bodies', async () => {
    const call = (status: number, headers: Record<string, string> = {}) =>
      createMetaChatModel({
        apiKey: 'k',
        fetch: (async () => new Response('{"error":{"message":"secret detail"}}', { status, headers })) as typeof fetch,
      }).chat({ messages: [], reasoningEffort: 'low', maxTokens: 10 })
    await expect(call(401)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    await expect(call(429, { 'retry-after': '7' })).rejects.toMatchObject({
      kind: 'rate-limited',
      retryAfterSeconds: 7,
    })
    await expect(call(400)).rejects.toMatchObject({ kind: 'invalid-request' })
    const upstream = await call(503).catch((error: MetaModelError) => error)
    expect(upstream).toMatchObject({ kind: 'upstream', transient: true })
    expect(String((upstream as Error).message)).not.toContain('secret detail')
  })

  it('treats an all-reasoning response as empty', async () => {
    const model = createMetaChatModel({
      apiKey: 'k',
      fetch: (async () =>
        jsonResponse({ choices: [{ finish_reason: 'length', message: { content: null } }] })) as typeof fetch,
    })
    await expect(model.chat({ messages: [], reasoningEffort: 'low', maxTokens: 10 })).rejects.toMatchObject({
      kind: 'empty-response',
    })
  })

  it('times out slow calls', async () => {
    const model = createMetaChatModel({
      apiKey: 'k',
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })) as typeof fetch,
    })
    await expect(
      model.chat({ messages: [], reasoningEffort: 'low', maxTokens: 10, timeoutMs: 20 }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    })
  })

  it('refuses to start without a key', () => {
    expect(() => createMetaChatModel({ apiKey: '' })).toThrow(MetaModelError)
  })
})
