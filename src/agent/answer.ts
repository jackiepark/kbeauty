import type { JsonSchema, JsonSchemaFormat } from '../meta/types.js'
import { containsUnsupportedClaim } from './claims.js'
import { compareRanked, evaluateProduct, rulesFrom } from './evaluator.js'
import type { EvidenceLedger } from './ledger.js'
import { clampText, uniqueStrings } from './text.js'
import { conditionProperties, sanitizeConditions } from './tools.js'
import type { CatalogVocabulary, Conditions, ProductFacts, ProductNote, Sentence, Verdict } from './types.js'

export const MAX_RECOMMENDATIONS = 3
const MAX_SUMMARY_SENTENCES = 3
const MAX_SENTENCE_LENGTH = 320
const MAX_QUESTION_LENGTH = 240
const MAX_SUGGESTIONS = 3
const MAX_SUGGESTION_LENGTH = 80

const sentenceSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'refs'],
  properties: {
    text: { type: 'string' },
    refs: { type: 'array', items: { type: 'string' }, description: 'Refs copied exactly from tool results.' },
  },
}

export function answerFormat(vocabulary: CatalogVocabulary): JsonSchemaFormat {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'shopping_answer',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'conditions',
          'focusProductId',
          'recommendedProductIds',
          'summary',
          'productNotes',
          'clarifyingQuestion',
          'suggestions',
        ],
        properties: {
          conditions: {
            type: 'object',
            additionalProperties: false,
            required: ['fitTags', 'hardAvoid', 'preferAvoid', 'productType', 'sort'],
            properties: conditionProperties(vocabulary),
          },
          focusProductId: { type: ['string', 'null'] },
          recommendedProductIds: { type: 'array', items: { type: 'string' } },
          summary: { type: 'array', items: sentenceSchema },
          productNotes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['productId', 'text', 'refs'],
              properties: {
                productId: { type: 'string' },
                text: { type: 'string' },
                refs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          clarifyingQuestion: { type: ['string', 'null'] },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }
}

export interface FinalAnswer {
  status: 'answered' | 'clarify'
  conditions: Conditions
  focus: { product: ProductFacts; verdict: Verdict } | null
  recommendations: Array<{ product: ProductFacts; verdict: Verdict }>
  summary: Sentence[]
  productNotes: ProductNote[]
  clarifyingQuestion: string | null
  suggestions: string[]
  dropped: { sentences: number; products: number }
}

export interface FinalizeContext {
  ledger: EvidenceLedger
  vocabulary: CatalogVocabulary
  currentProductId: string | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Turns the model's JSON into an answer the app can show. Product verdicts are recomputed from catalog data under the
 * final conditions; sentences survive only with refs that exist in the ledger and without unsupported claims.
 */
export function finalizeAnswer(raw: unknown, context: FinalizeContext): FinalAnswer {
  const { ledger, vocabulary } = context
  const answer = asRecord(raw)
  const conditions = sanitizeConditions(answer.conditions, vocabulary)
  const rules = rulesFrom(conditions)
  const names = ledger.productNames()
  let droppedSentences = 0
  let droppedProducts = 0

  const focusId = [answer.focusProductId, context.currentProductId].find(
    (id): id is string => typeof id === 'string' && ledger.hasProduct(id),
  )
  const focusProduct = focusId ? ledger.product(focusId) : undefined
  const focus = focusProduct ? { product: focusProduct, verdict: evaluateProduct(focusProduct, rules) } : null
  if (focus) ledger.addVerdict(focus.verdict)

  const recommendations: FinalAnswer['recommendations'] = []
  for (const id of uniqueStrings(
    asArray(answer.recommendedProductIds).filter((item): item is string => typeof item === 'string'),
  )) {
    const product = ledger.product(id)
    if (!product || id === focus?.product.id) {
      droppedProducts += 1
      continue
    }
    if (conditions.productType && product.productType !== conditions.productType) {
      droppedProducts += 1
      continue
    }
    const verdict = evaluateProduct(product, rules)
    if (verdict.eligibility !== 'eligible' || recommendations.length >= MAX_RECOMMENDATIONS) {
      droppedProducts += 1
      continue
    }
    ledger.addVerdict(verdict)
    recommendations.push({ product, verdict })
  }
  // The order shown is the deterministic ranking under the final conditions, not the model's.
  const wanted = new Set(conditions.fitTags)
  const rankView = (item: { product: ProductFacts; verdict: Verdict }) => ({
    product: item.product,
    fitMatches: item.product.fitTags.filter((tag) => wanted.has(tag)),
    preferAvoidHits: item.verdict.reasons.flatMap((reason) =>
      reason.kind === 'prefer-avoid' && reason.code ? [reason.code] : [],
    ),
  })
  recommendations.sort((x, y) => compareRanked(rankView(x), rankView(y), conditions.sort))

  const keepSentence = (value: unknown): Sentence | null => {
    const item = asRecord(value)
    const text = clampText(item.text, MAX_SENTENCE_LENGTH)
    const refs = uniqueStrings(asArray(item.refs).filter((ref): ref is string => typeof ref === 'string')).filter(
      (ref) => ledger.hasRef(ref),
    )
    if (!text || !refs.length || containsUnsupportedClaim(text, names)) {
      droppedSentences += 1
      return null
    }
    return { text, refs }
  }

  const summary = asArray(answer.summary)
    .map(keepSentence)
    .filter((item): item is Sentence => item !== null)
    .slice(0, MAX_SUMMARY_SENTENCES)

  const shown = new Set([focus?.product.id, ...recommendations.map((item) => item.product.id)].filter(Boolean))
  const notedProducts = new Set<string>()
  const productNotes: ProductNote[] = []
  for (const value of asArray(answer.productNotes)) {
    const id = asRecord(value).productId
    if (typeof id !== 'string' || !shown.has(id) || notedProducts.has(id)) {
      droppedSentences += 1
      continue
    }
    const sentence = keepSentence(value)
    if (!sentence) continue
    notedProducts.add(id)
    productNotes.push({ productId: id, ...sentence })
  }

  const question = clampText(answer.clarifyingQuestion, MAX_QUESTION_LENGTH)
  const clarifyingQuestion = question && !containsUnsupportedClaim(question, names) ? question : null
  const suggestions = uniqueStrings(
    asArray(answer.suggestions).filter((item): item is string => typeof item === 'string'),
  )
    .map((item) => item.slice(0, MAX_SUGGESTION_LENGTH))
    .filter((item) => !/https?:\/\//i.test(item) && !containsUnsupportedClaim(item, names))
    .slice(0, MAX_SUGGESTIONS)

  const status = clarifyingQuestion && !recommendations.length && !summary.length ? 'clarify' : 'answered'
  return {
    status,
    conditions,
    focus,
    recommendations,
    summary,
    productNotes,
    clarifyingQuestion,
    suggestions,
    dropped: { sentences: droppedSentences, products: droppedProducts },
  }
}
