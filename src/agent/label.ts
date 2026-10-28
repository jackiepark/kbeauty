import type { ChatModel, ChatUsage, JsonSchemaFormat } from '../meta/types.js'
import type { CatalogPort } from './catalog-port.js'
import { LABEL_PROMPT_VERSION, labelReaderPrompt } from './prompts.js'
import { clampText, normalizeName, searchTokens, uniqueStrings } from './text.js'
import type { ProductFacts } from './types.js'

export const LABEL_KINDS = ['product-packaging', 'person-or-skin', 'unreadable', 'other'] as const
export type LabelKind = (typeof LABEL_KINDS)[number]

export interface LabelRead {
  kind: LabelKind
  brand: string | null
  productName: string | null
  latinNames: string[]
  visibleText: string[]
  confidence: 'high' | 'medium' | 'low'
}

export type LabelMatchStatus = 'matched' | 'no-match' | 'not-a-product' | 'unreadable'

export interface LabelCandidate {
  product: ProductFacts
  /** Share of the candidate's name words seen on the label, plus a brand bonus. */
  score: number
  matchedOn: string[]
}

export interface LabelMatch {
  status: LabelMatchStatus
  candidates: LabelCandidate[]
}

const LABEL_FORMAT: JsonSchemaFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'label_read',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'brand', 'productName', 'latinNames', 'visibleText', 'confidence'],
      properties: {
        kind: { type: 'string', enum: [...LABEL_KINDS] },
        brand: { type: ['string', 'null'] },
        productName: { type: ['string', 'null'] },
        latinNames: { type: 'array', items: { type: 'string' } },
        visibleText: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
  },
}

const MAX_VISIBLE_LINES = 12
const MIN_MATCH_SCORE = 0.4
const BRAND_BONUS = 0.25
const BRAND_SEARCH_LIMIT = 48
const NAME_SEARCH_LIMIT = 12

function parseRead(content: string | null): LabelRead | null {
  if (!content) return null
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    const kind = LABEL_KINDS.includes(value.kind as LabelKind) ? (value.kind as LabelKind) : 'other'
    const strings = (input: unknown, max: number) =>
      uniqueStrings(Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [])
        .map((item) => item.slice(0, 120))
        .slice(0, max)
    return {
      kind,
      brand: clampText(value.brand, 80) || null,
      productName: clampText(value.productName, 160) || null,
      latinNames: strings(value.latinNames, 4),
      visibleText: strings(value.visibleText, MAX_VISIBLE_LINES),
      confidence: value.confidence === 'high' || value.confidence === 'low' ? value.confidence : 'medium',
    }
  } catch {
    return null
  }
}

/** Reads printed text from a package photo. The photo is sent once and never stored. */
export async function readLabel(
  model: ChatModel,
  imageUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<{ read: LabelRead | null; usage: ChatUsage; promptVersion: string }> {
  const response = await model.chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: labelReaderPrompt() },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    responseFormat: LABEL_FORMAT,
    reasoningEffort: 'minimal',
    maxTokens: 2_000,
    timeoutMs: options.timeoutMs ?? 20_000,
  })
  return { read: parseRead(response.content), usage: response.usage, promptVersion: LABEL_PROMPT_VERSION }
}

/** Label words matched against a candidate's words; a label word may be a cut-off prefix ("panthe" for "panthenol"). */
function matchedWords(candidateWords: readonly string[], labelWords: ReadonlySet<string>): string[] {
  return candidateWords.filter((word) => {
    if (labelWords.has(word)) return true
    for (const labelWord of labelWords) {
      if (labelWord.length >= 4 && word.startsWith(labelWord)) return true
    }
    return false
  })
}

function brandMatches(product: ProductFacts, brands: readonly string[]): boolean {
  const productBrand = normalizeName(product.brand)
  return brands.some((brand) => {
    const value = normalizeName(brand)
    return value.length >= 2 && (productBrand === value || productBrand.includes(value) || value.includes(productBrand))
  })
}

export function scoreCandidate(product: ProductFacts, read: LabelRead): LabelCandidate {
  const labelWords = new Set(
    searchTokens([read.brand, read.productName, ...read.latinNames, ...read.visibleText].filter(Boolean).join(' ')),
  )
  const candidateWords = searchTokens(`${product.brand} ${product.name}`)
  const matchedOn = matchedWords(candidateWords, labelWords)
  const brands = [read.brand, ...read.latinNames].filter((value): value is string => Boolean(value))
  const share = candidateWords.length ? matchedOn.length / candidateWords.length : 0
  const score = Math.round((share + (brandMatches(product, brands) ? BRAND_BONUS : 0)) * 1000) / 1000
  return { product, score, matchedOn }
}

/** The catalog is searched in Latin script, so Hangul words only help through `latinNames`. */
function latinWords(value: string | null | undefined): string[] {
  return searchTokens(value ?? '').filter((word) => /^[a-z0-9]+$/.test(word))
}

function searchQueries(read: LabelRead): Array<{ query: string; limit: number }> {
  const printedBrand = latinWords(read.brand)
  const brandWords = (printedBrand.length ? printedBrand : latinWords(read.latinNames[0])).slice(0, 3)
  const nameWords = latinWords([read.productName, ...read.latinNames].filter(Boolean).join(' ')).filter(
    (word) => !brandWords.includes(word),
  )
  const visibleWords = latinWords(read.visibleText.join(' '))
    .filter((word) => !brandWords.includes(word) && !/^\d+$/.test(word))
    .sort((a, b) => b.length - a.length)
  const queries: Array<{ query: string; limit: number }> = []
  if (brandWords.length) {
    const brand = brandWords.join(' ')
    queries.push({ query: brand, limit: BRAND_SEARCH_LIMIT })
    if (nameWords.length)
      queries.push({ query: `${brand} ${nameWords.slice(0, 3).join(' ')}`, limit: NAME_SEARCH_LIMIT })
    for (const word of visibleWords.slice(0, 2)) queries.push({ query: `${brand} ${word}`, limit: NAME_SEARCH_LIMIT })
  } else {
    for (const word of [...nameWords, ...visibleWords].slice(0, 3))
      queries.push({ query: word, limit: NAME_SEARCH_LIMIT })
  }
  const seen = new Set<string>()
  return queries.filter((item) => {
    if (seen.has(item.query)) return false
    seen.add(item.query)
    return true
  })
}

/** Deterministic catalog lookup for a label read. The shopper confirms the match; nothing is assumed. */
export async function matchLabel(catalog: CatalogPort, read: LabelRead | null, limit = 3): Promise<LabelMatch> {
  if (!read || read.kind === 'unreadable' || read.kind === 'other') return { status: 'unreadable', candidates: [] }
  if (read.kind === 'person-or-skin') return { status: 'not-a-product', candidates: [] }
  const queries = searchQueries(read)
  if (!queries.length) return { status: 'unreadable', candidates: [] }

  const results = await Promise.all(
    queries.map((item) => catalog.searchProducts({ query: item.query, productType: null, limit: item.limit })),
  )
  const unique = new Map<string, ProductFacts>()
  for (const product of results.flat()) if (!unique.has(product.id)) unique.set(product.id, product)

  const candidates = [...unique.values()]
    .map((product) => scoreCandidate(product, read))
    .filter((candidate) => candidate.score >= MIN_MATCH_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { status: candidates.length ? 'matched' : 'no-match', candidates }
}
