import { describe, expect, it } from 'vitest'
import { MetaModelError } from '../meta/client.js'
import type { ChatModel, ChatRequest, ChatResponse } from '../meta/types.js'
import { createFixtureCatalog } from './fixtures.js'
import { runAgentTurn } from './orchestrator.js'

const usage = { inputTokens: 100, outputTokens: 20, reasoningTokens: 10, cachedInputTokens: 0 }

type Step = ChatResponse | Error | ((request: ChatRequest) => ChatResponse)

function scriptedModel(steps: Step[]): ChatModel & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    model: 'scripted',
    requests,
    async chat(request) {
      requests.push(structuredClone(request))
      const step = steps.shift()
      if (!step) throw new Error('script exhausted')
      if (step instanceof Error) throw step
      return typeof step === 'function' ? step(request) : step
    },
  }
}

const toolCall = (id: string, name: string, args: Record<string, unknown>): ChatResponse['toolCalls'][number] => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
})

const answer = (body: Record<string, unknown>): ChatResponse => ({
  content: JSON.stringify(body),
  toolCalls: [],
  finishReason: 'stop',
  usage,
})

const finalBody = {
  conditions: {
    fitTags: ['dry'],
    hardAvoid: ['fragrance'],
    preferAvoid: [],
    productType: 'moisturizer',
    sort: 'score',
  },
  focusProductId: 'aurora-ceramide-barrier-cream',
  recommendedProductIds: ['mellow-oat-calming-cream', 'dewpoint-hyaluronic-cream'],
  summaryRefs: ['ing:aurora-ceramide-barrier-cream#8'],
  ingredientQueries: [],
  productNotes: [
    {
      productId: 'mellow-oat-calming-cream',
      refs: ['check:mellow-oat-calming-cream', 'fit:mellow-oat-calming-cream'],
    },
  ],
  clarifyingQuestion: null,
  suggestions: ['Show better value'],
}

describe('runAgentTurn', () => {
  it('runs tools, then validates the strict JSON answer against the ledger', async () => {
    const model = scriptedModel([
      {
        content: 'Checking.',
        toolCalls: [
          toolCall('c1', 'check_product', {
            productId: 'aurora-ceramide-barrier-cream',
            hardAvoid: ['fragrance'],
            preferAvoid: [],
          }),
          toolCall('c2', 'find_products', {
            query: null,
            productType: 'moisturizer',
            fitTags: ['dry'],
            hardAvoid: ['fragrance'],
            preferAvoid: [],
            sort: 'score',
            excludeProductIds: ['aurora-ceramide-barrier-cream'],
          }),
        ],
        finishReason: 'tool_calls',
        usage,
      },
      answer(finalBody),
    ])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      {
        message: 'Dry skin, no fragrance at all. Is this ok?',
        locale: 'en',
        currentProductId: 'aurora-ceramide-barrier-cream',
        previous: null,
      },
    )
    expect(result.status).toBe('answered')
    if (result.status === 'failed') throw new Error('unexpected failure')
    expect(result.focus?.verdict.eligibility).toBe('excluded')
    expect(result.recommendations.map((item) => item.product.id)).toEqual([
      'mellow-oat-calming-cream',
      'dewpoint-hyaluronic-cream',
    ])
    expect(result.trace).toMatchObject({ modelCalls: 2, failure: null, droppedRefs: 0 })
    expect(result.summary).toEqual([
      { kind: 'ingredient', productId: 'aurora-ceramide-barrier-cream', name: 'Parfum', position: 8 },
    ])
    expect(result.trace.toolCalls.map((call) => [call.name, call.ok])).toEqual([
      ['check_product', true],
      ['find_products', true],
    ])
    expect(result.trace.usage.inputTokens).toBe(200)
    // Round one offers tools and the answer format together; the tool results go back in order.
    expect(model.requests[0].tools?.map((tool) => tool.function.name)).toEqual([
      'find_products',
      'get_product',
      'check_product',
    ])
    expect(model.requests[0].responseFormat?.json_schema.name).toBe('shopping_answer')
    const toolMessages = model.requests[1].messages.filter((message) => message.role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(JSON.parse((toolMessages[0] as { content: string }).content)).toMatchObject({ eligibility: 'excluded' })
  })

  it('puts the viewed product in the context and computes a delta against earlier picks', async () => {
    const model = scriptedModel([answer({ ...finalBody, recommendedProductIds: [] })])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      {
        message: 'Is it fragrance free?',
        locale: 'ja',
        currentProductId: 'aurora-ceramide-barrier-cream',
        previous: { conditions: finalBody.conditions as never, recommendedProductIds: ['mellow-oat-calming-cream'] },
      },
    )
    const context = model.requests[0].messages[1] as { content: string }
    expect(context.content).toContain('Page language: ja.')
    expect(context.content).toContain('"productId":"aurora-ceramide-barrier-cream"')
    expect(result.delta).toEqual({ added: [], removed: ['mellow-oat-calming-cream'], kept: [] })
  })

  it('gives the model the request and question behind a pending clarification', async () => {
    const model = scriptedModel([answer({ ...finalBody, recommendedProductIds: [] })])
    await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      {
        message: 'the first one',
        locale: 'en',
        currentProductId: 'aurora-ceramide-barrier-cream',
        previous: {
          conditions: finalBody.conditions as never,
          recommendedProductIds: [],
          pending: {
            request: 'I must avoid alcohol completely',
            question: 'Do you mean drying alcohol or fatty alcohols?',
          },
        },
      },
    )
    const context = model.requests[0].messages[1] as { content: string }
    expect(context.content).toContain('"I must avoid alcohol completely"')
    expect(context.content).toContain('"Do you mean drying alcohol or fatty alcohols?"')
    expect(context.content).toContain('keep hard or prefer avoid as the first message worded it')
  })

  it('stops offering tools after the tool budget and still answers', async () => {
    const lookups = Array.from({ length: 7 }, (_, index) =>
      toolCall(`g${index}`, 'get_product', { productId: 'mellow-oat-calming-cream' }),
    )
    const model = scriptedModel([
      { content: null, toolCalls: lookups, finishReason: 'tool_calls', usage },
      (request) => {
        expect(request.tools).toBeUndefined()
        return answer({ ...finalBody, recommendedProductIds: ['mellow-oat-calming-cream'] })
      },
    ])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      { message: 'Tell me about the oat cream', locale: 'en', currentProductId: null, previous: null },
    )
    expect(result.status).toBe('answered')
    expect(result.trace.toolCalls.filter((call) => call.ok)).toHaveLength(6)
    expect(result.trace.toolCalls.filter((call) => !call.ok)).toHaveLength(1)
  })

  it('asks once more for JSON when the model replies in prose', async () => {
    const model = scriptedModel([
      { content: 'Sure! It has fragrance.', toolCalls: [], finishReason: 'stop', usage },
      answer(finalBody),
    ])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      { message: 'ok?', locale: 'en', currentProductId: 'aurora-ceramide-barrier-cream', previous: null },
    )
    expect(result.status).toBe('answered')
    expect(model.requests[1].tools).toBeUndefined()
    expect(model.requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'Reply now with the JSON answer only.' })
  })

  it('retries a failed call once: server errors and slow replies, while the turn has time', async () => {
    const input = { message: 'ok?', locale: 'en', currentProductId: 'aurora-ceramide-barrier-cream', previous: null }
    const retried = await runAgentTurn(
      {
        model: scriptedModel([new MetaModelError('upstream', 'boom', 502), answer(finalBody)]),
        catalog: createFixtureCatalog(),
      },
      input,
    )
    expect(retried.status).toBe('answered')
    expect(retried.trace.modelCalls).toBe(2)

    // A reply slower than the call timeout is tried once more within the turn's time.
    const slowOnce = await runAgentTurn(
      {
        model: scriptedModel([new MetaModelError('timeout', 'slow'), answer(finalBody)]),
        catalog: createFixtureCatalog(),
      },
      input,
    )
    expect(slowOnce.status).toBe('answered')
    expect(slowOnce.trace.modelCalls).toBe(2)

    // Only once per call: two slow replies end the turn, and both calls are counted.
    const slowTwice = await runAgentTurn(
      {
        model: scriptedModel([new MetaModelError('timeout', 'slow'), new MetaModelError('timeout', 'slow')]),
        catalog: createFixtureCatalog(),
      },
      input,
    )
    expect(slowTwice).toMatchObject({ status: 'failed', trace: { failure: 'model-timeout', modelCalls: 2 } })

    // No retry when less than `minRetryMs` of the turn is left.
    let clock = 0
    const late = await runAgentTurn(
      {
        model: scriptedModel([
          () => {
            clock += 41_000
            throw new MetaModelError('timeout', 'slow')
          },
          answer(finalBody),
        ]),
        catalog: createFixtureCatalog(),
        now: () => clock,
      },
      input,
    )
    expect(late).toMatchObject({ status: 'failed', trace: { failure: 'model-timeout', modelCalls: 1 } })
  })

  it('counts retries against the model-call budget and keeps tools off the last call', async () => {
    const model = scriptedModel([
      new MetaModelError('upstream', 'boom', 502),
      {
        content: null,
        toolCalls: [toolCall('g1', 'get_product', { productId: 'mellow-oat-calming-cream' })],
        finishReason: 'tool_calls',
        usage,
      },
      new MetaModelError('network', 'reset'),
      (request) => {
        expect(request.tools).toBeUndefined()
        return answer({ ...finalBody, recommendedProductIds: ['mellow-oat-calming-cream'] })
      },
    ])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog() },
      { message: 'Tell me about the oat cream', locale: 'en', currentProductId: null, previous: null },
    )
    expect(result.status).toBe('answered')
    expect(model.requests).toHaveLength(4)
    expect(result.trace.modelCalls).toBe(4)
  })

  it('stops the turn at its wall-time limit and gives each call only the time left', async () => {
    let clock = 0
    const lookup = (id: string): ChatResponse => ({
      content: null,
      toolCalls: [toolCall(id, 'get_product', { productId: 'mellow-oat-calming-cream' })],
      finishReason: 'tool_calls',
      usage,
    })
    const model = scriptedModel([
      (request) => {
        expect(request.timeoutMs).toBe(20_000)
        clock += 30_000
        return lookup('g1')
      },
      (request) => {
        expect(request.timeoutMs).toBe(15_000)
        clock += 20_000
        return lookup('g2')
      },
    ])
    const result = await runAgentTurn(
      { model, catalog: createFixtureCatalog(), now: () => clock, limits: { turnTimeoutMs: 45_000 } },
      { message: 'Tell me about the oat cream', locale: 'en', currentProductId: null, previous: null },
    )
    expect(result).toMatchObject({ status: 'failed', trace: { failure: 'model-timeout', modelCalls: 2 } })
    expect(model.requests).toHaveLength(2)
  })

  it('keeps the earlier filters when the answer JSON is missing fields', async () => {
    const previous = { conditions: finalBody.conditions as never, recommendedProductIds: [] }
    const input = { message: 'ok?', locale: 'en', currentProductId: 'aurora-ceramide-barrier-cream', previous }
    // An empty object once, then a proper answer: the turn asks again and answers under the real filters.
    const recovered = await runAgentTurn(
      { model: scriptedModel([answer({}), answer(finalBody)]), catalog: createFixtureCatalog() },
      input,
    )
    expect(recovered.status).toBe('answered')
    if (recovered.status === 'failed') throw new Error('unexpected failure')
    expect(recovered.focus?.verdict.eligibility).toBe('excluded')

    const model = scriptedModel([answer({}), answer({ ...finalBody, conditions: {} })])
    const failed = await runAgentTurn({ model, catalog: createFixtureCatalog() }, input)
    expect(failed).toMatchObject({
      status: 'failed',
      conditions: finalBody.conditions,
      trace: { failure: 'invalid-answer', modelCalls: 2 },
    })
    expect(model.requests[1].messages.at(-1)).toEqual({ role: 'user', content: 'Reply now with the JSON answer only.' })
  })
})

describe('find_products fallback', () => {
  it('browses the product type when descriptive query words match no product', async () => {
    const { executeTool } = await import('./tools.js')
    const { EvidenceLedger } = await import('./ledger.js')
    const { FIXTURE_VOCABULARY } = await import('./fixtures.js')
    const outcome = await executeTool(
      'find_products',
      JSON.stringify({
        query: 'fragrance free cream for dry skin',
        productType: 'moisturizer',
        fitTags: ['dry'],
        hardAvoid: ['fragrance'],
        preferAvoid: [],
        sort: 'score',
        excludeProductIds: [],
      }),
      { catalog: createFixtureCatalog(), ledger: new EvidenceLedger(), vocabulary: FIXTURE_VOCABULARY },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.result.queryMatched).toBe(false)
    expect((outcome.result.results as Array<{ productId: string }>).map((item) => item.productId)).toEqual([
      'mellow-oat-calming-cream',
      'dewpoint-hyaluronic-cream',
    ])
  })
})
