import { describe, expect, it } from 'vitest'
import { createFixtureCatalog } from './fixtures.js'
import { EvidenceLedger } from './ledger.js'
import { executeTool, type ToolContext } from './tools.js'

function context(): ToolContext {
  const catalog = createFixtureCatalog()
  return { catalog, ledger: new EvidenceLedger(), vocabulary: catalog.vocabulary() }
}

describe('agent tools', () => {
  it('sends the first score reasons with search results and every reason with product details', async () => {
    const tools = context()
    const found = await executeTool(
      'find_products',
      JSON.stringify({
        query: null,
        productType: 'moisturizer',
        fitTags: ['sensitive'],
        hardAvoid: ['fragrance'],
        preferAvoid: [],
        sort: 'score',
        excludeProductIds: [],
      }),
      tools,
    )
    const results = found.result.results as Array<Record<string, unknown>>
    const oat = results.find((item) => item.productId === 'mellow-oat-calming-cream')
    expect(oat?.scoreReasons).toEqual([
      'Avena Sativa Kernel Flour is a well-evidenced ingredient for the soothing claim',
      'Also lists Ceramide NP for barrier care',
    ])
    expect(oat?.refs).toContain('score:mellow-oat-calming-cream')

    const detail = await executeTool(
      'get_product',
      JSON.stringify({ productId: 'aurora-ceramide-barrier-cream' }),
      tools,
    )
    expect(detail.result.score).toEqual({
      value: 7.4,
      ref: 'score:aurora-ceramide-barrier-cream',
      reasons: [
        'Ceramide NP is a well-evidenced ingredient for the barrier care claim',
        'Solid base formula for this product type',
        'Small deduction: lists fragrance (Parfum)',
      ],
    })
    expect(tools.ledger.hasRef('score:aurora-ceramide-barrier-cream')).toBe(true)
  })

  it('leaves score reasons out for products without a score', async () => {
    const tools = context()
    const found = await executeTool(
      'find_products',
      JSON.stringify({
        query: null,
        productType: 'moisturizer',
        fitTags: [],
        hardAvoid: [],
        preferAvoid: [],
        sort: 'score',
        excludeProductIds: [],
      }),
      tools,
    )
    const results = found.result.results as Array<Record<string, unknown>>
    for (const item of results.filter((entry) => entry.score === null)) expect(item).not.toHaveProperty('scoreReasons')
  })
})
