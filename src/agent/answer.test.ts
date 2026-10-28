import { describe, expect, it } from 'vitest'
import { finalizeAnswer, isShoppingAnswer } from './answer.js'
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
  summaryRefs: ['flag:aurora-ceramide-barrier-cream:fragrance'],
  ingredientQueries: [],
  productNotes: [{ productId: 'mellow-oat-calming-cream', refs: ['fit:mellow-oat-calming-cream'] }],
  clarifyingQuestion: null,
  suggestions: ['Show cheaper options'],
}

describe('finalizeAnswer', () => {
  it('recomputes verdicts and builds every fact from a picked ref', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    const answer = finalizeAnswer(baseAnswer, { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null })
    expect(answer.status).toBe('answered')
    expect(answer.focus?.verdict.eligibility).toBe('excluded')
    expect(answer.recommendations.map((item) => item.product.id)).toEqual(['mellow-oat-calming-cream'])
    expect(answer.summary).toEqual([
      {
        kind: 'listed',
        productId: 'aurora-ceramide-barrier-cream',
        code: 'fragrance',
        evidence: [{ name: 'Parfum', position: 8 }],
      },
    ])
    expect(answer.productNotes).toEqual([
      {
        productId: 'mellow-oat-calming-cream',
        facts: [{ kind: 'fit', productId: 'mellow-oat-calming-cream', tags: ['dry', 'sensitive', 'soothing'] }],
      },
    ])
    expect(answer.dropped).toEqual({ refs: 0, products: 0 })
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

  it('cannot state what the catalog does not, whatever the model writes', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    // An earlier check with no avoidance left a pass ref the model may pick again under stricter final conditions.
    ledger.addVerdict(evaluateProduct(FIXTURE_PRODUCTS[0], { hardAvoid: [], preferAvoid: [] }))
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        // Text the model adds is never shown; only the refs it picks are, rebuilt from the data.
        summary: [{ text: 'It is fragrance-free, scores 10 and has 5% niacinamide.', refs: [] }],
        summaryRefs: [
          'score:aurora-ceramide-barrier-cream',
          'check:aurora-ceramide-barrier-cream',
          'ing:aurora-ceramide-barrier-cream#99',
          'fit:invented-product',
        ],
        ingredientQueries: [
          { productId: 'aurora-ceramide-barrier-cream', ingredient: 'Niacinamide' },
          { productId: 'aurora-ceramide-barrier-cream', ingredient: 'ceramide np' },
        ],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(answer.summary).toEqual([
      { kind: 'absent', productId: 'aurora-ceramide-barrier-cream', name: 'Niacinamide' },
      { kind: 'ingredient', productId: 'aurora-ceramide-barrier-cream', name: 'Ceramide NP', position: 5 },
      { kind: 'score', productId: 'aurora-ceramide-barrier-cream', value: 7.4, productType: 'moisturizer' },
      // A check ref of a product that lists an avoided group shows what it lists, never a pass.
      {
        kind: 'listed',
        productId: 'aurora-ceramide-barrier-cream',
        code: 'fragrance',
        evidence: [{ name: 'Parfum', position: 8 }],
      },
    ])
    expect(answer.summary.some((fact) => fact.kind === 'passes')).toBe(false)
    expect(answer.dropped.refs).toBe(2)
  })

  it('says a product has no score yet, shows evidence once, and keeps pass facts off cards', () => {
    const ledger = ledgerWith('kindred-barrier-balm', 'aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    const unscored = finalizeAnswer(
      {
        ...baseAnswer,
        focusProductId: 'kindred-barrier-balm',
        recommendedProductIds: [],
        summaryRefs: ['score:kindred-barrier-balm'],
        productNotes: [],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(unscored.summary).toEqual([{ kind: 'unscored', productId: 'kindred-barrier-balm' }])

    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        summaryRefs: ['flag:aurora-ceramide-barrier-cream:fragrance', 'ing:aurora-ceramide-barrier-cream#8'],
        productNotes: [
          {
            productId: 'mellow-oat-calming-cream',
            refs: ['check:mellow-oat-calming-cream', 'key:mellow-oat-calming-cream'],
          },
        ],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(answer.summary.map((fact) => fact.kind)).toEqual(['listed'])
    expect(answer.productNotes).toEqual([
      {
        productId: 'mellow-oat-calming-cream',
        facts: [{ kind: 'key', productId: 'mellow-oat-calming-cream', names: ['Oat', 'Ceramides'] }],
      },
    ])
  })

  it('lists what passed and what is listed under the final conditions for a check ref', () => {
    const ledger = ledgerWith('aurora-ceramide-barrier-cream', 'mellow-oat-calming-cream')
    const answer = finalizeAnswer(
      {
        ...baseAnswer,
        conditions: { ...baseAnswer.conditions, hardAvoid: ['fragrance'], preferAvoid: ['essential-oils'] },
        summaryRefs: ['check:mellow-oat-calming-cream'],
        productNotes: [{ productId: 'aurora-ceramide-barrier-cream', refs: ['fit:aurora-ceramide-barrier-cream'] }],
      },
      { ledger, vocabulary: FIXTURE_VOCABULARY, currentProductId: null },
    )
    expect(answer.summary).toEqual([
      { kind: 'passes', productId: 'mellow-oat-calming-cream', checked: ['fragrance', 'essential-oils'] },
    ])
    // Notes belong to recommended products only.
    expect(answer.productNotes).toEqual([])
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
        summaryRefs: [],
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

describe('isShoppingAnswer', () => {
  const valid = {
    conditions: { fitTags: ['dry'], hardAvoid: ['fragrance'], preferAvoid: [], productType: null, sort: 'score' },
    focusProductId: null,
    recommendedProductIds: [],
    summaryRefs: ['flag:a:fragrance'],
    ingredientQueries: [{ productId: 'a', ingredient: 'Niacinamide' }],
    productNotes: [{ productId: 'a', refs: ['check:a'] }],
    clarifyingQuestion: null,
    suggestions: [],
  }

  it('accepts every answer field with its type and rejects anything less', () => {
    expect(isShoppingAnswer(valid)).toBe(true)
    expect(isShoppingAnswer({})).toBe(false)
    expect(isShoppingAnswer({ ...valid, conditions: {} })).toBe(false)
    expect(isShoppingAnswer({ ...valid, conditions: { ...valid.conditions, hardAvoid: 'fragrance' } })).toBe(false)
    const { summaryRefs: _summaryRefs, ...withoutSummary } = valid
    expect(isShoppingAnswer(withoutSummary)).toBe(false)
    expect(isShoppingAnswer({ ...valid, productNotes: [{ refs: [] }] })).toBe(false)
    expect(isShoppingAnswer({ ...valid, ingredientQueries: [{ productId: 'a' }] })).toBe(false)
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
