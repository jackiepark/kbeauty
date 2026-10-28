import type { JsonSchema, JsonSchemaFormat } from '../meta/types.js'
import { containsUnsupportedClaim } from './claims.js'
import { compareRanked, evaluateProduct, locateEvidence, rulesFrom } from './evaluator.js'
import type { EvidenceLedger } from './ledger.js'
import { refProductId } from './refs.js'
import { clampText, uniqueStrings } from './text.js'
import { conditionProperties, sanitizeConditions } from './tools.js'
import type { CatalogVocabulary, Conditions, Fact, ProductFacts, ProductNote, Verdict } from './types.js'

export const MAX_RECOMMENDATIONS = 3
const MAX_SUMMARY_FACTS = 4
const MAX_NOTE_FACTS = 3
const MAX_INGREDIENT_QUERIES = 3
const MAX_INGREDIENT_NAME_LENGTH = 80
const MAX_QUESTION_LENGTH = 240
const MAX_SUGGESTIONS = 3
const MAX_SUGGESTION_LENGTH = 80

const refList = (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description })

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
          'summaryRefs',
          'ingredientQueries',
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
          summaryRefs: refList('Refs of the facts that answer the shopper, most important first, copied exactly.'),
          ingredientQueries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['productId', 'ingredient'],
              properties: {
                productId: { type: 'string' },
                ingredient: { type: 'string', description: 'INCI name of an ingredient the shopper asked about.' },
              },
            },
          },
          productNotes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['productId', 'refs'],
              properties: {
                productId: { type: 'string' },
                refs: refList('Refs of the facts that show why this product fits, copied exactly.'),
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
  /** Facts that answer the shopper, built by code from the refs the model picked. */
  summary: Fact[]
  productNotes: ProductNote[]
  clarifyingQuestion: string | null
  suggestions: string[]
  dropped: { refs: number; products: number }
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

const isStringList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string')
const isNullableString = (value: unknown) => value === null || typeof value === 'string'
const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isListOf = (value: unknown, check: (item: Record<string, unknown>) => boolean) =>
  Array.isArray(value) && value.every((item) => isObject(item) && check(item))

/**
 * True when the model's JSON has every field of {@link answerFormat} with the right type. `finalizeAnswer` reads a
 * missing field as empty, so a malformed reply must stop here: empty `conditions` would silently drop the shopper's
 * filters and turn an excluded product eligible.
 */
export function isShoppingAnswer(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.conditions)) return false
  const { conditions } = value
  return (
    isStringList(conditions.fitTags) &&
    isStringList(conditions.hardAvoid) &&
    isStringList(conditions.preferAvoid) &&
    isNullableString(conditions.productType) &&
    typeof conditions.sort === 'string' &&
    isNullableString(value.focusProductId) &&
    isStringList(value.recommendedProductIds) &&
    isStringList(value.summaryRefs) &&
    isListOf(
      value.ingredientQueries,
      (item) => typeof item.productId === 'string' && typeof item.ingredient === 'string',
    ) &&
    isListOf(value.productNotes, (item) => typeof item.productId === 'string' && isStringList(item.refs)) &&
    isNullableString(value.clarifyingQuestion) &&
    isStringList(value.suggestions)
  )
}

type Shown = { product: ProductFacts; verdict: Verdict }

function listedFacts({ product, verdict }: Shown): Fact[] {
  return verdict.reasons.flatMap((reason): Fact[] =>
    reason.code && reason.kind !== 'not-evaluable'
      ? [{ kind: 'listed', productId: product.id, code: reason.code, evidence: reason.evidence }]
      : [],
  )
}

/** The facts one ref stands for, rebuilt from catalog data under the final conditions; nothing for any other ref. */
function factsFromRef(ref: string, shown: Shown, conditions: Conditions): Fact[] {
  const { product, verdict } = shown
  const id = product.id
  if (ref.startsWith(`flag:${id}:`)) {
    const code = ref.slice(`flag:${id}:`.length)
    if (!product.flags.items.some((flag) => flag.code === code)) return []
    const reason = evaluateProduct(product, { hardAvoid: [code], preferAvoid: [] }).reasons.find(
      (item) => item.code === code,
    )
    return [{ kind: 'listed', productId: id, code, evidence: reason?.evidence ?? [] }]
  }
  if (ref.startsWith(`ing:${id}#`)) {
    const position = Number(ref.slice(`ing:${id}#`.length))
    const item =
      product.ingredients.status === 'listed'
        ? product.ingredients.items.find((ingredient) => ingredient.position === position)
        : undefined
    return item ? [{ kind: 'ingredient', productId: id, name: item.name, position }] : []
  }
  if (ref === `check:${id}`) {
    if (verdict.eligibility === 'unknown') return [{ kind: 'unchecked', productId: id }]
    // Every avoided group the final check found not listed; the listed ones become their own facts.
    const listed = new Set(verdict.reasons.map((reason) => reason.code))
    const checked = uniqueStrings([...conditions.hardAvoid, ...conditions.preferAvoid]).filter(
      (code) => !listed.has(code),
    )
    return [...listedFacts(shown), ...(checked.length ? [{ kind: 'passes', productId: id, checked } as Fact] : [])]
  }
  if (ref === `score:${id}`) {
    return product.score.status === 'scored' && product.score.value !== null
      ? [{ kind: 'score', productId: id, value: product.score.value, productType: product.productType }]
      : [{ kind: 'unscored', productId: id }]
  }
  if (ref === `fit:${id}`)
    return product.fitTags.length ? [{ kind: 'fit', productId: id, tags: [...product.fitTags] }] : []
  if (ref === `key:${id}`) {
    return product.keyIngredients.length ? [{ kind: 'key', productId: id, names: [...product.keyIngredients] }] : []
  }
  return []
}

/** An ingredient the shopper asked about, looked up by name in the printed list; never answered by the model. */
function ingredientFacts(query: unknown, shown: Map<string, Shown>): Fact[] {
  const item = isObject(query) ? query : {}
  const productId = typeof item.productId === 'string' ? item.productId : ''
  const name = clampText(item.ingredient, MAX_INGREDIENT_NAME_LENGTH)
  const product = shown.get(productId)?.product
  if (!product || !name) return []
  if (product.ingredients.status !== 'listed') return [{ kind: 'unchecked', productId }]
  const positions = locateEvidence(name, product.ingredients.items)
  if (!positions.length) return [{ kind: 'absent', productId, name }]
  return positions.flatMap((position): Fact[] => {
    const listed = product.ingredients.items.find((ingredient) => ingredient.position === position)
    return listed ? [{ kind: 'ingredient', productId, name: listed.name, position }] : []
  })
}

/**
 * Turns the model's JSON into an answer the app can show. Product verdicts are recomputed from catalog data under the
 * final conditions, and every fact is built by code from a ref the model picked: the model never words a fact, so the
 * answer cannot state what the catalog does not. Only the clarifying question and suggestions are the model's words.
 */
export function finalizeAnswer(raw: unknown, context: FinalizeContext): FinalAnswer {
  const { ledger, vocabulary } = context
  const answer = asRecord(raw)
  const conditions = sanitizeConditions(answer.conditions, vocabulary)
  const rules = rulesFrom(conditions)
  const names = ledger.productNames()
  let droppedRefs = 0
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

  const shown = new Map<string, Shown>()
  if (focus) shown.set(focus.product.id, focus)
  for (const item of recommendations) shown.set(item.product.id, item)
  const collect = (facts: Fact[], seen: Set<string>, fact: Fact) => {
    const key = JSON.stringify(fact)
    if (seen.has(key)) return
    seen.add(key)
    facts.push(fact)
  }
  /** Facts for picked refs of shown products; `only` keeps a note to its own product. */
  const factsFor = (refs: unknown, only: string | null, seen: Set<string>): Fact[] => {
    const facts: Fact[] = []
    for (const ref of uniqueStrings(asArray(refs).filter((item): item is string => typeof item === 'string'))) {
      const productId = refProductId(ref)
      const item = productId && (!only || productId === only) ? shown.get(productId) : undefined
      const built = item && ledger.hasRef(ref) ? factsFromRef(ref, item, conditions) : []
      if (!built.length) droppedRefs += 1
      for (const fact of built) collect(facts, seen, fact)
    }
    return facts
  }

  // An ingredient the shopper asked about answers first; then the facts the model picked, most important first.
  const summarySeen = new Set<string>()
  const summary: Fact[] = []
  for (const query of asArray(answer.ingredientQueries).slice(0, MAX_INGREDIENT_QUERIES)) {
    const facts = ingredientFacts(query, shown)
    if (!facts.length) droppedRefs += 1
    for (const fact of facts) collect(summary, summarySeen, fact)
  }
  summary.push(...factsFor(answer.summaryRefs, null, summarySeen))
  // An ingredient already shown as the evidence of a listed group would say the same thing twice.
  const listedAt = new Set(
    summary.flatMap((fact) =>
      fact.kind === 'listed' ? fact.evidence.map((item) => `${fact.productId}#${item.position}`) : [],
    ),
  )
  const answerFacts = summary.filter(
    (fact) => fact.kind !== 'ingredient' || !listedAt.has(`${fact.productId}#${fact.position}`),
  )
  answerFacts.splice(MAX_SUMMARY_FACTS)

  const recommended = new Set(recommendations.map((item) => item.product.id))
  const productNotes: ProductNote[] = []
  for (const value of asArray(answer.productNotes)) {
    const id = asRecord(value).productId
    if (typeof id !== 'string' || !recommended.has(id) || productNotes.some((note) => note.productId === id)) {
      droppedRefs += 1
      continue
    }
    // Every recommendation passed the avoidance check, so a pass fact adds nothing on its card.
    const facts = factsFor(asRecord(value).refs, id, new Set())
      .filter((fact) => fact.kind !== 'passes')
      .slice(0, MAX_NOTE_FACTS)
    if (facts.length) productNotes.push({ productId: id, facts })
  }

  const question = clampText(answer.clarifyingQuestion, MAX_QUESTION_LENGTH)
  const clarifyingQuestion = question && !containsUnsupportedClaim(question, names) ? question : null
  const suggestions = uniqueStrings(
    asArray(answer.suggestions).filter((item): item is string => typeof item === 'string'),
  )
    .map((item) => item.slice(0, MAX_SUGGESTION_LENGTH))
    .filter((item) => !/https?:\/\//i.test(item) && !containsUnsupportedClaim(item, names))
    .slice(0, MAX_SUGGESTIONS)

  const status = clarifyingQuestion && !recommendations.length && !answerFacts.length ? 'clarify' : 'answered'
  return {
    status,
    conditions,
    focus,
    recommendations,
    summary: answerFacts,
    productNotes,
    clarifyingQuestion,
    suggestions,
    dropped: { refs: droppedRefs, products: droppedProducts },
  }
}
