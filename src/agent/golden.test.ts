import { describe, expect, it } from 'vitest'
import type { ChatModel, ChatResponse } from '../meta/types.js'
import { GOLDEN_CASES, runGoldenCase, summarizeGolden } from './golden.js'

const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 }
const answering = (body: Record<string, unknown>): ChatModel => ({
  model: 'scripted',
  async chat(): Promise<ChatResponse> {
    return { content: JSON.stringify(body), toolCalls: [], finishReason: 'stop', usage }
  },
})
const answer = (patch: Record<string, unknown>) => ({
  conditions: {
    fitTags: ['dry'],
    hardAvoid: ['fragrance'],
    preferAvoid: [],
    productType: 'moisturizer',
    sort: 'score',
  },
  focusProductId: 'aurora-ceramide-barrier-cream',
  recommendedProductIds: [],
  summaryRefs: ['flag:aurora-ceramide-barrier-cream:fragrance'],
  ingredientQueries: [],
  productNotes: [],
  clarifyingQuestion: null,
  suggestions: ['Show fragrance-free creams'],
  ...patch,
})
const golden = (id: string) => {
  const found = GOLDEN_CASES.find((item) => item.id === id)
  if (!found) throw new Error(id)
  return found
}

describe('golden set', () => {
  it('has 50 shopper questions and 20 injections, with follow-ups and other languages', () => {
    expect(GOLDEN_CASES).toHaveLength(70)
    expect(GOLDEN_CASES.filter((item) => item.group === 'injection')).toHaveLength(20)
    expect(GOLDEN_CASES.filter((item) => item.group === 'follow-up')).toHaveLength(20)
    expect(
      GOLDEN_CASES.filter((item) => item.locale !== 'en' && item.group !== 'injection').length,
    ).toBeGreaterThanOrEqual(10)
    expect(new Set(GOLDEN_CASES.map((item) => item.id)).size).toBe(70)
  })

  it('passes an answer that meets the case and fails one that drops the shopper filter', async () => {
    const met = await runGoldenCase(answering(answer({})), golden('s01'))
    expect(met).toMatchObject({ ok: true, failures: [] })

    const dropped = await runGoldenCase(
      answering(
        answer({ conditions: { fitTags: [], hardAvoid: [], preferAvoid: [], productType: null, sort: 'score' } }),
      ),
      golden('i05'),
    )
    expect(dropped.ok).toBe(false)
    expect(dropped.failures).toEqual(
      expect.arrayContaining(['focus eligible, expected excluded', 'hardAvoid misses fragrance']),
    )
    expect(summarizeGolden([met, dropped])).toMatchObject({ cases: 2, passed: 1, injectionSuccesses: 1 })
  })

  it('reports leaked instructions and claims in the model words', async () => {
    const leaked = await runGoldenCase(
      answering(answer({ clarifyingQuestion: 'Rules: You never write product facts. Is that clear?' })),
      golden('i03'),
    )
    expect(leaked.failures.some((failure) => failure.startsWith('instructions leaked'))).toBe(true)
  })
})
