import { describe, expect, it } from 'vitest'
import { evaluateProduct, locateEvidence, rankCandidates } from './evaluator.js'
import { FIXTURE_PRODUCTS } from './fixtures.js'
import type { Conditions } from './types.js'

const byId = (id: string) => {
  const product = FIXTURE_PRODUCTS.find((item) => item.id === id)
  if (!product) throw new Error(`missing fixture ${id}`)
  return product
}

const conditions = (patch: Partial<Conditions> = {}): Conditions => ({
  fitTags: [],
  hardAvoid: [],
  preferAvoid: [],
  productType: null,
  sort: 'score',
  ...patch,
})

describe('evaluateProduct', () => {
  it('excludes a product whose printed list has a hard-avoid group and cites the position', () => {
    const verdict = evaluateProduct(byId('aurora-ceramide-barrier-cream'), {
      hardAvoid: ['fragrance'],
      preferAvoid: [],
    })
    expect(verdict.eligibility).toBe('excluded')
    expect(verdict.reasons).toEqual([
      { kind: 'hard-avoid', code: 'fragrance', evidence: [{ name: 'Parfum', position: 8 }] },
    ])
    expect(verdict.refs).toEqual([
      'flag:aurora-ceramide-barrier-cream:fragrance',
      'ing:aurora-ceramide-barrier-cream#8',
    ])
  })

  it('keeps a product eligible when only prefer-avoid groups are listed', () => {
    const verdict = evaluateProduct(byId('aurora-ceramide-barrier-cream'), { hardAvoid: [], preferAvoid: ['linalool'] })
    expect(verdict.eligibility).toBe('eligible')
    expect(verdict.reasons[0]).toMatchObject({ kind: 'prefer-avoid', code: 'linalool', evidence: [{ position: 10 }] })
    expect(verdict.refs).toContain('check:aurora-ceramide-barrier-cream')
  })

  it('treats a code in both lists as hard-avoid', () => {
    const verdict = evaluateProduct(byId('aurora-ceramide-barrier-cream'), {
      hardAvoid: ['limonene'],
      preferAvoid: ['limonene'],
    })
    expect(verdict.eligibility).toBe('excluded')
    expect(verdict.reasons).toHaveLength(1)
  })

  it('never calls a product without an ingredient list eligible', () => {
    const verdict = evaluateProduct(byId('kindred-barrier-balm'), { hardAvoid: ['fragrance'], preferAvoid: [] })
    expect(verdict.eligibility).toBe('unknown')
    expect(verdict.reasons[0].kind).toBe('not-evaluable')
    expect(verdict.refs).not.toContain('check:kindred-barrier-balm')
  })

  it('marks an evaluated product with no avoided group as eligible', () => {
    const verdict = evaluateProduct(byId('mellow-oat-calming-cream'), {
      hardAvoid: ['fragrance', 'essential-oils'],
      preferAvoid: [],
    })
    expect(verdict).toMatchObject({ eligibility: 'eligible', reasons: [] })
  })
})

describe('locateEvidence', () => {
  it('prefers exact names and falls back to whole-word containment', () => {
    const items = [
      { position: 1, name: 'Water' },
      { position: 2, name: 'Lavandula Angustifolia (Lavender) Oil' },
      { position: 3, name: 'Parfum' },
    ]
    expect(locateEvidence('parfum', items)).toEqual([3])
    expect(locateEvidence('Lavandula Angustifolia', items)).toEqual([2])
    expect(locateEvidence('Lav', items)).toEqual([])
  })
})

describe('rankCandidates', () => {
  it('drops excluded and unknown products and ranks by fit, then score', () => {
    const moisturizers = FIXTURE_PRODUCTS.filter((item) => item.productType === 'moisturizer')
    const { ranked, excluded, unknown } = rankCandidates(
      moisturizers,
      conditions({ hardAvoid: ['fragrance'], fitTags: ['dry'], productType: 'moisturizer' }),
      { limit: 3 },
    )
    expect(ranked.map((item) => item.product.id)).toEqual(['mellow-oat-calming-cream', 'dewpoint-hyaluronic-cream'])
    expect(excluded).toBe(1)
    expect(unknown).toBe(1)
  })

  it('puts prefer-avoid hits last and can sort by value band', () => {
    const moisturizers = FIXTURE_PRODUCTS.filter((item) => item.productType === 'moisturizer')
    const byValue = rankCandidates(moisturizers, conditions({ sort: 'value' }), { limit: 3 })
    expect(byValue.ranked.map((item) => item.product.id)).toEqual([
      'dewpoint-hyaluronic-cream',
      'mellow-oat-calming-cream',
      'aurora-ceramide-barrier-cream',
    ])
    const preferNoOils = rankCandidates(moisturizers, conditions({ preferAvoid: ['essential-oils'], sort: 'value' }), {
      limit: 3,
    })
    expect(preferNoOils.ranked.at(-1)?.product.id).toBe('dewpoint-hyaluronic-cream')
  })

  it('skips excluded ids and duplicates', () => {
    const products = [
      byId('mellow-oat-calming-cream'),
      byId('mellow-oat-calming-cream'),
      byId('dewpoint-hyaluronic-cream'),
    ]
    const { ranked } = rankCandidates(products, conditions(), { excludeIds: ['dewpoint-hyaluronic-cream'], limit: 5 })
    expect(ranked.map((item) => item.product.id)).toEqual(['mellow-oat-calming-cream'])
  })
})
