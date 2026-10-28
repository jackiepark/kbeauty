import { describe, expect, it } from 'vitest'
import type { ChatModel } from '../meta/types.js'
import { createFixtureCatalog } from './fixtures.js'
import { type LabelRead, matchLabel, readLabel, scoreCandidate } from './label.js'

const read = (patch: Partial<LabelRead>): LabelRead => ({
  kind: 'product-packaging',
  brand: null,
  productName: null,
  latinNames: [],
  visibleText: [],
  confidence: 'medium',
  ...patch,
})

describe('matchLabel', () => {
  it('matches cut-off package words to the right product and ranks it first', async () => {
    const match = await matchLabel(
      createFixtureCatalog(),
      read({ brand: 'AURORA LAB', visibleText: ['CERAMIDE BARR', 'IER CREAM', '80 ML'] }),
    )
    expect(match.status).toBe('matched')
    expect(match.candidates[0].product.id).toBe('aurora-ceramide-barrier-cream')
    expect(match.candidates[0].matchedOn).toEqual(expect.arrayContaining(['aurora', 'lab', 'ceramide', 'barrier']))
  })

  it('uses Latin names the reader was sure of for Korean-only packaging', async () => {
    const match = await matchLabel(
      createFixtureCatalog(),
      read({ brand: '멜로우', latinNames: ['Mellow', 'Oat Calming Cream'], visibleText: ['오트 카밍 크림'] }),
    )
    expect(match.candidates[0]?.product.id).toBe('mellow-oat-calming-cream')
  })

  it('keeps the product words of a Latin name that carries the whole product name', async () => {
    const match = await matchLabel(
      createFixtureCatalog(),
      read({ latinNames: ['Mellow Oat Calming Cream'], visibleText: ['멜로우', '오트 카밍 크림'] }),
    )
    expect(match.status).toBe('matched')
    expect(match.candidates[0]?.product.id).toBe('mellow-oat-calming-cream')
  })

  it('refuses skin photos and reports unreadable or unknown packages', async () => {
    const catalog = createFixtureCatalog()
    expect(await matchLabel(catalog, read({ kind: 'person-or-skin' }))).toEqual({
      status: 'not-a-product',
      candidates: [],
    })
    expect(await matchLabel(catalog, read({ kind: 'unreadable' }))).toEqual({ status: 'unreadable', candidates: [] })
    expect(await matchLabel(catalog, null)).toEqual({ status: 'unreadable', candidates: [] })
    expect((await matchLabel(catalog, read({ brand: 'Unknown Brand', visibleText: ['Snail Mucin'] }))).status).toBe(
      'no-match',
    )
  })

  it('does not offer other products of the same brand for a product the catalog lacks', async () => {
    const catalog = createFixtureCatalog()
    // Shares the brand and "cream" with the barrier cream, but not the printed name.
    const missing = await matchLabel(catalog, read({ brand: 'Aurora Lab', productName: 'Vitamin Glow Cream' }))
    expect(missing).toEqual({ status: 'no-match', candidates: [] })
    // A sibling of the same line with a different product type is a different product too.
    const sibling = await matchLabel(catalog, read({ brand: 'Dewpoint', productName: 'Hyaluronic Water Toner' }))
    expect(sibling.status).toBe('no-match')
    // The printed name, even without the brand, still finds the product.
    const named = await matchLabel(catalog, read({ productName: 'Ceramide Barrier Cream' }))
    expect(named.candidates[0]?.product.id).toBe('aurora-ceramide-barrier-cream')
  })

  it('scores brand matches above word-only matches', () => {
    const catalog = createFixtureCatalog()
    return catalog.searchProducts({ query: 'cream', productType: null, limit: 10 }).then((products) => {
      const label = read({ brand: 'Dewpoint', visibleText: ['Water Cream'] })
      const scores = products.map((product) => [product.id, scoreCandidate(product, label).score] as const)
      const best = [...scores].sort((a, b) => b[1] - a[1])[0]
      expect(best[0]).toBe('dewpoint-hyaluronic-cream')
    })
  })
})

describe('readLabel', () => {
  it('sends one image with the strict label format at minimal effort and parses the result', async () => {
    let request: Parameters<ChatModel['chat']>[0] | null = null
    const model: ChatModel = {
      model: 'scripted',
      async chat(input) {
        request = input
        return {
          content: JSON.stringify({
            kind: 'product-packaging',
            brand: 'Aurora Lab',
            productName: null,
            latinNames: [],
            visibleText: ['CERAMIDE'],
            confidence: 'high',
          }),
          toolCalls: [],
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 },
        }
      },
    }
    const result = await readLabel(model, 'data:image/jpeg;base64,AAAA')
    expect(result.read).toMatchObject({ brand: 'Aurora Lab', productName: null, visibleText: ['CERAMIDE'] })
    expect(request).toMatchObject({
      reasoningEffort: 'minimal',
      responseFormat: { json_schema: { name: 'label_read' } },
    })
    const content = (request as unknown as { messages: Array<{ content: Array<{ type: string }> }> }).messages[0]
      .content
    expect(content.map((part) => part.type)).toEqual(['text', 'image_url'])
  })
})
