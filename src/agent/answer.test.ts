import { describe, expect, it } from 'vitest'
import { finalizeAnswer } from './answer.js'
import { containsUnsupportedClaim } from './claims.js'
import { evaluateProduct } from './evaluator.js'
import { FIXTURE_PRODUCTS, FIXTURE_VOCABULARY } from './fixtures.js'
import { EvidenceLedger } from './ledger.js'

function ledgerWith(...ids: string[]) {
  const ledger = new EvidenceLedger()
  for (const id of ids) {
    const product = FIXTURE_PRODUCTS.find((item) => item.id === id)
    if (!product) throw new Error(id)
    ledger.addProduct(product)
  }
  return ledger
}

const baseAnswer = {
  conditions: {
    fitTags: ['dry'],
    hardAvoid: ['fragrance'],
    preferAvoid: [],
    productType: 'moisturizer',
    sort: 'score',
  },
  focusProductId: 'aurora-ceramide-barrier-cream',
  recommendedProductIds: ['mellow-oat-calming-cream'],
  summary: [{ text: 'This cream lists Parfum at position 8.', refs: ['ing:aurora-ceramide-barrier-cream#8'] }],
  productNotes: [
    {
      productId: 'mellow-oat-calming-cream',
      text: 'No listed fragrance and it is tagged for dry skin.',
      refs: ['fit:mellow-oat-calming-cream'],
    },
  ],
  clarifyingQuestion: null,
  suggestions: ['Show cheaper options'],
}

describe('finalizeAnswer', () => {
  it('recomputes verdicts and keeps cited sentences', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    const answer = finalizeAnswer(baseAnswer, { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null })
    expect(answer.status).toBe('answered')
    expect(answer.focus?.verdict.eligibility).toBe('excluded')
    expect(answer.recommendations.map((item) => item.product.id)).toEqual(['mellow-oat-calming-cream'])
    expect(answer.summary).toHaveLength(1)
    expect(answer.productNotes).toHaveLength(1)
    expect(answer.dropped).toEqual({ sentences: 0, products: 0 })
  })

  it('drops recommendations that fail the final conditions or were never loaded', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream', 'dewpoint-hyaluronic-cream')
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        conditions: { ...baseAnswer.conditions, hardAvoid: ['fragrance', 'essential-oils'] },
        recommendedProductIds: ['dewpoint-hyaluronic-cream', 'invented-product', 'mellow-oat-calming-cream'],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(answer.recommendations.map((item) => item.product.id)).toEqual(['mellow-oat-calming-cream'])
    expect(answer.dropped.products).toBe(2)
  })

  it('removes sentences with unknown refs, no refs, or unsupported claims', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        summary: [
          { text: 'It contains 5% niacinamide.', refs: ['ing:aurora-ceramide-barrier-cream#99'] },
          { text: 'Great for everyone.', refs: [] },
          { text: 'The oat cream is safe for sensitive skin.', refs: ['fit:mellow-oat-calming-cream'] },
          { text: 'The Aurora cream lists Parfum.', refs: ['flag:aurora-ceramide-barrier-cream:fragrance'] },
        ],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(answer.summary.map((item) => item.text)).toEqual(['The Aurora cream lists Parfum.'])
    expect(answer.dropped.sentences).toBe(3)
  })

  it('cleans conditions against the vocabulary', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream')
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        conditions: {
          fitTags: ['dry', 'glass-skin'],
          hardAvoid: ['parabens', 'fragrance'],
          preferAvoid: ['fragrance', 'limonene'],
          productType: 'toner',
          sort: 'cheap',
        },
        recommendedProductIds: [],
        productNotes: [],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: 'aurora-ceramide-barrier-cream' },
    )
    expect(answer.conditions).toEqual({
      fitTags: ['dry'],
      hardAvoid: ['fragrance'],
      preferAvoid: ['limonene'],
      productType: null,
      sort: 'score',
    })
  })

  it('falls back to the viewed product and reports a clarify turn', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream')
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        focusProductId: 'invented',
        recommendedProductIds: [],
        summary: [],
        productNotes: [],
        clarifyingQuestion: 'Which preservatives do you avoid?',
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: 'aurora-ceramide-barrier-cream' },
    )
    expect(answer.status).toBe('clarify')
    expect(answer.focus?.product.id).toBe('aurora-ceramide-barrier-cream')
  })

  it('does not let a later check override the excluded verdict of the final conditions', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream')
    ledger.addVerdict(evaluateProduct(FIXTURE_PRODUCTS[0], { hardAvoid: [], preferAvoid: [] }))
    const answer = finalizeAnswer(baseAnswer, { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null })
    expect(answer.focus?.verdict.eligibility).toBe('excluded')
  })
})

describe('containsUnsupportedClaim', () => {
  it('flags safety and medical wording across languages but not product names', () => {
    expect(containsUnsupportedClaim('This is safe for sensitive skin')).toBe(true)
    expect(containsUnsupportedClaim('민감한 피부에도 안전해요')).toBe(true)
    expect(containsUnsupportedClaim('敏感肌でも安全です')).toBe(true)
    expect(containsUnsupportedClaim('Treats acne fast')).toBe(true)
    expect(containsUnsupportedClaim('Safe Me Relief Milk lists no fragrance', ['Safe Me Relief Milk'])).toBe(false)
    expect(containsUnsupportedClaim('No listed fragrance; Parfum is not in the ingredient list.')).toBe(false)
    expect(containsUnsupportedClaim('A hair treatment with panthenol.')).toBe(false)
  })
})
