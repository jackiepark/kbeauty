import type { JsonSchema, ToolDefinition } from '../meta/types.js'
import type { CatalogPort } from './catalog-port.js'
import { evaluateProduct, rankCandidates } from './evaluator.js'
import type { EvidenceLedger } from './ledger.js'
import { fitRef, keyIngredientsRef, productRef, scoreRef } from './refs.js'
import { clampText, uniqueStrings } from './text.js'
import { type CatalogVocabulary, type Conditions, type ProductFacts, SORT_ORDERS, type Verdict } from './types.js'

export const TOOL_NAMES = ['find_products', 'get_product', 'check_product'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const MAX_FOUND = 5
const LIST_LIMIT = 48
/** Score reasons sent with each search result; the full list comes with get_product. */
const MAX_FOUND_SCORE_REASONS = 2
const SEARCH_LIMIT = 12
const MAX_INGREDIENTS_SHOWN = 80
const MAX_PRODUCT_ID_LENGTH = 160

export interface ToolContext {
  catalog: CatalogPort
  ledger: EvidenceLedger
  vocabulary: CatalogVocabulary
}

export interface ToolOutcome {
  ok: boolean
  result: Record<string, unknown>
}

function enumArray(values: readonly string[], description: string): JsonSchema {
  return values.length
    ? { type: 'array', description, items: { type: 'string', enum: [...values] } }
    : { type: 'array', description, items: { type: 'string' } }
}

function nullableEnum(values: readonly string[], description: string): JsonSchema {
  return values.length
    ? { type: ['string', 'null'], description, enum: [...values, null] }
    : { type: ['string', 'null'], description }
}

export function conditionProperties(vocabulary: CatalogVocabulary): Record<string, JsonSchema> {
  const avoidance = vocabulary.avoidance.map((entry) => entry.code)
  return {
    fitTags: enumArray(
      vocabulary.fit.map((entry) => entry.code),
      'Skin types or concerns the shopper asked for. Used to rank, never to exclude.',
    ),
    hardAvoid: enumArray(avoidance, 'Ingredient groups that must not be listed.'),
    preferAvoid: enumArray(avoidance, 'Ingredient groups the shopper would rather not have.'),
    productType: nullableEnum(
      vocabulary.productTypes.map((entry) => entry.code),
      'Product type to look in. Null when the shopper did not narrow it.',
    ),
    sort: {
      type: 'string',
      enum: [...SORT_ORDERS],
      description: '"value" only when the shopper asks for better value.',
    },
  }
}

export function buildToolDefinitions(vocabulary: CatalogVocabulary): ToolDefinition[] {
  const conditions = conditionProperties(vocabulary)
  const avoidance = vocabulary.avoidance.map((entry) => entry.code)
  return [
    {
      type: 'function',
      function: {
        name: 'find_products',
        description:
          'Find catalog products and rank the ones that pass the avoidance check. With a query, matches products whose brand, name or key ingredients contain every query word; if nothing matches and a productType is given, it browses that type instead. Without a query, browses one productType. Returns at most 5 eligible products, best first.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'productType', 'fitTags', 'hardAvoid', 'preferAvoid', 'sort', 'excludeProductIds'],
          properties: {
            query: {
              type: ['string', 'null'],
              description:
                'Only brand, product or ingredient names (e.g. "cosrx snail", "niacinamide"). Put skin needs and avoidances in fitTags and hardAvoid, not here. Null to browse a productType.',
            },
            productType: conditions.productType,
            fitTags: conditions.fitTags,
            hardAvoid: conditions.hardAvoid,
            preferAvoid: conditions.preferAvoid,
            sort: conditions.sort,
            excludeProductIds: {
              type: 'array',
              description: 'Products to leave out, such as the one being viewed.',
              items: { type: 'string' },
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_product',
        description:
          'Full catalog facts for one product: score, suitability tags, key ingredients, avoidance flags with the ingredient positions that triggered them, and the printed ingredient list as "position name" entries.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['productId'],
          properties: { productId: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'check_product',
        description:
          'Deterministic avoidance check of one product against the shopper rules. Returns eligibility (eligible, excluded or unknown), the reasons with ingredient positions, and the refs to cite.',
        strict: true,
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['productId', 'hardAvoid', 'preferAvoid'],
          properties: {
            productId: { type: 'string' },
            hardAvoid: enumArray(avoidance, 'Ingredient groups that must not be listed.'),
            preferAvoid: enumArray(avoidance, 'Ingredient groups the shopper would rather not have.'),
          },
        },
      },
    },
  ]
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function codes(value: unknown, allowed: readonly { code: string }[]): string[] {
  if (!Array.isArray(value)) return []
  const known = new Set(allowed.map((entry) => entry.code))
  return uniqueStrings(value.filter((item): item is string => typeof item === 'string')).filter((code) =>
    known.has(code),
  )
}

/** Clean condition codes against the vocabulary; a code in both lists counts as hard-avoid. */
export function sanitizeConditions(raw: unknown, vocabulary: CatalogVocabulary): Conditions {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const hardAvoid = codes(value.hardAvoid, vocabulary.avoidance)
  const productType =
    typeof value.productType === 'string' && vocabulary.productTypes.some((entry) => entry.code === value.productType)
      ? value.productType
      : null
  return {
    fitTags: codes(value.fitTags, vocabulary.fit),
    hardAvoid,
    preferAvoid: codes(value.preferAvoid, vocabulary.avoidance).filter((code) => !hardAvoid.includes(code)),
    productType,
    sort: value.sort === 'value' ? 'value' : 'score',
  }
}

function productId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= MAX_PRODUCT_ID_LENGTH ? value.trim() : null
}

/** The compact view of a product the model reads. Every fact carries the ref it may cite. */
export function describeProduct(product: ProductFacts): Record<string, unknown> {
  const listed = product.ingredients.status === 'listed'
  return {
    productId: product.id,
    ref: productRef(product.id),
    brand: product.brand,
    name: product.name,
    productType: product.productType,
    score:
      product.score.status === 'scored'
        ? {
            value: product.score.value,
            ref: scoreRef(product.id),
            ...(product.score.reasons?.length ? { reasons: product.score.reasons } : {}),
          }
        : null,
    valueBand: product.valueBand,
    fitTags: product.fitTags.length ? { tags: product.fitTags, ref: fitRef(product.id) } : null,
    keyIngredients: product.keyIngredients.length
      ? { names: product.keyIngredients, ref: keyIngredientsRef(product.id) }
      : null,
    flags: product.flags.items.map((flag) => ({
      code: flag.code,
      ref: `flag:${product.id}:${flag.code}`,
      evidence: flag.evidence,
    })),
    flagCheck: product.flags.status,
    ingredientList: product.ingredients.status,
    ingredients: listed
      ? product.ingredients.items.slice(0, MAX_INGREDIENTS_SHOWN).map((item) => `${item.position} ${item.name}`)
      : [],
    ingredientRefFormat: listed ? `ing:${product.id}#<position>` : null,
  }
}

export function describeVerdict(verdict: Verdict): Record<string, unknown> {
  return {
    productId: verdict.productId,
    eligibility: verdict.eligibility,
    reasons: verdict.reasons.map((reason) => ({
      kind: reason.kind,
      code: reason.code,
      evidence: reason.evidence.map((item) =>
        item.position === null ? item.name : `${item.name} (#${item.position})`,
      ),
    })),
    refs: verdict.refs,
  }
}

async function loadProduct(context: ToolContext, id: string): Promise<ProductFacts | null> {
  const known = context.ledger.product(id)
  if (known?.ingredients.status === 'listed') return known
  const product = await context.catalog.getProduct(id)
  if (product) context.ledger.addProduct(product)
  return product ?? known ?? null
}

async function findProducts(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const conditions = sanitizeConditions(args, context.vocabulary)
  const query = clampText(args.query, 120)
  const exclude = Array.isArray(args.excludeProductIds)
    ? args.excludeProductIds.filter((item): item is string => typeof item === 'string')
    : []
  if (!query && !conditions.productType) {
    return { ok: false, result: { error: 'Give a query or a productType.' } }
  }
  let products = query
    ? await context.catalog.searchProducts({ query, productType: conditions.productType, limit: SEARCH_LIMIT })
    : []
  // Descriptive words ("fragrance free", "for dry skin") match no product name; browse the type instead.
  const queryMatched = Boolean(query) && products.length > 0
  if (!queryMatched && conditions.productType) {
    products = await context.catalog.listProducts({ productType: conditions.productType, limit: LIST_LIMIT })
  }
  const { ranked, considered, excluded, unknown } = rankCandidates(products, conditions, {
    excludeIds: exclude,
    limit: MAX_FOUND,
  })
  for (const item of ranked) {
    context.ledger.addProduct(item.product)
    context.ledger.addVerdict(item.verdict)
  }
  return {
    ok: true,
    result: {
      appliedConditions: conditions,
      ...(query ? { queryMatched } : {}),
      considered,
      excludedByAvoidance: excluded,
      withoutIngredientList: unknown,
      results: ranked.map((item) => ({
        productId: item.product.id,
        brand: item.product.brand,
        name: item.product.name,
        productType: item.product.productType,
        eligibility: item.verdict.eligibility,
        score: item.product.score.status === 'scored' ? item.product.score.value : null,
        ...(item.product.score.status === 'scored' && item.product.score.reasons?.length
          ? { scoreReasons: item.product.score.reasons.slice(0, MAX_FOUND_SCORE_REASONS) }
          : {}),
        valueBand: item.product.valueBand,
        fitTags: item.product.fitTags,
        fitMatches: item.fitMatches,
        keyIngredients: item.product.keyIngredients.slice(0, 3),
        preferAvoidListed: item.preferAvoidHits,
        refs: [
          productRef(item.product.id),
          ...item.verdict.refs,
          ...(item.product.score.status === 'scored' ? [scoreRef(item.product.id)] : []),
          ...(item.product.fitTags.length ? [fitRef(item.product.id)] : []),
          ...(item.product.keyIngredients.length ? [keyIngredientsRef(item.product.id)] : []),
        ],
      })),
      ...(considered === 0 ? { note: 'No catalog product matched. Do not suggest products from memory.' } : {}),
    },
  }
}

async function getProduct(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const id = productId(args.productId)
  if (!id) return { ok: false, result: { error: 'productId is required.' } }
  const product = await loadProduct(context, id)
  if (!product) return { ok: false, result: { error: `No catalog product has id ${id}.` } }
  return { ok: true, result: describeProduct(product) }
}

async function checkProduct(args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const id = productId(args.productId)
  if (!id) return { ok: false, result: { error: 'productId is required.' } }
  const product = await loadProduct(context, id)
  if (!product) return { ok: false, result: { error: `No catalog product has id ${id}.` } }
  const hardAvoid = codes(args.hardAvoid, context.vocabulary.avoidance)
  const preferAvoid = codes(args.preferAvoid, context.vocabulary.avoidance)
  const verdict = evaluateProduct(product, { hardAvoid, preferAvoid })
  context.ledger.addVerdict(verdict)
  return { ok: true, result: describeVerdict(verdict) }
}

export async function executeTool(name: string, rawArgs: string, context: ToolContext): Promise<ToolOutcome> {
  const args = parseArgs(rawArgs)
  if (!args) return { ok: false, result: { error: 'Arguments must be a JSON object.' } }
  try {
    if (name === 'find_products') return await findProducts(args, context)
    if (name === 'get_product') return await getProduct(args, context)
    if (name === 'check_product') return await checkProduct(args, context)
    return { ok: false, result: { error: `Unknown tool ${name}.` } }
  } catch {
    // Catalog failures stay generic; the model must not see internal error text.
    return {
      ok: false,
      result: { error: 'The catalog could not answer. Do not guess; tell the shopper to try again.' },
    }
  }
}
