import { checkedRef, flagRef, ingredientRef } from './refs.js'
import { normalizeName } from './text.js'
import {
  type Conditions,
  type EvidenceItem,
  type ProductFacts,
  type ProductIngredient,
  type Verdict,
  type VerdictReason,
  VALUE_BANDS,
} from './types.js'

export interface AvoidanceRules {
  hardAvoid: readonly string[]
  preferAvoid: readonly string[]
}

const MAX_POSITIONS_PER_EVIDENCE = 3

/** Places a flag's evidence names in the printed list: exact name first, then whole-word containment. */
export function locateEvidence(evidence: string, items: readonly ProductIngredient[]): number[] {
  const needle = normalizeName(evidence)
  if (!needle) return []
  const exact = items.filter((item) => normalizeName(item.name) === needle)
  const matches = exact.length ? exact : items.filter((item) => ` ${normalizeName(item.name)} `.includes(` ${needle} `))
  return matches.slice(0, MAX_POSITIONS_PER_EVIDENCE).map((item) => item.position)
}

function evidenceItems(product: ProductFacts, names: readonly string[]): EvidenceItem[] {
  const items = product.ingredients.status === 'listed' ? product.ingredients.items : []
  return names.flatMap((name): EvidenceItem[] => {
    const positions = locateEvidence(name, items)
    return positions.length ? positions.map((position) => ({ name, position })) : [{ name, position: null }]
  })
}

/** True when an absent flag can be read as "not in the printed list". */
export function isEvaluable(product: ProductFacts): boolean {
  return product.flags.status === 'evaluated' && product.ingredients.status !== 'missing'
}

/**
 * Deterministic avoidance check. `excluded` needs a listed hard-avoid flag; `eligible` needs an evaluated list with no
 * hard-avoid flag; anything else is `unknown`. A model can never turn an `unknown` into `eligible`.
 */
export function evaluateProduct(product: ProductFacts, rules: AvoidanceRules): Verdict {
  const reasons: VerdictReason[] = []
  const refs: string[] = []
  const hard = new Set(rules.hardAvoid)
  const prefer = new Set(rules.preferAvoid.filter((code) => !hard.has(code)))

  for (const flag of product.flags.items) {
    const kind = hard.has(flag.code) ? 'hard-avoid' : prefer.has(flag.code) ? 'prefer-avoid' : null
    if (!kind) continue
    const evidence = evidenceItems(product, flag.evidence)
    reasons.push({ kind, code: flag.code, evidence })
    refs.push(flagRef(product.id, flag.code))
    for (const item of evidence) if (item.position !== null) refs.push(ingredientRef(product.id, item.position))
  }

  if (reasons.some((reason) => reason.kind === 'hard-avoid')) {
    return { productId: product.id, eligibility: 'excluded', reasons, refs: [...new Set(refs)] }
  }
  if (!isEvaluable(product)) {
    reasons.unshift({ kind: 'not-evaluable', code: null, evidence: [] })
    return { productId: product.id, eligibility: 'unknown', reasons, refs: [...new Set(refs)] }
  }
  refs.push(checkedRef(product.id))
  return { productId: product.id, eligibility: 'eligible', reasons, refs: [...new Set(refs)] }
}

/**
 * Recommendation order: fewer prefer-avoid hits first. With `sort: 'value'` the value band leads, then requested fit
 * tags and score; otherwise requested fit tags lead, then score.
 */
export function compareRanked(
  a: Pick<RankedProduct, 'product' | 'fitMatches' | 'preferAvoidHits'>,
  b: Pick<RankedProduct, 'product' | 'fitMatches' | 'preferAvoidHits'>,
  sort: Conditions['sort'],
): number {
  const prefer = a.preferAvoidHits.length - b.preferAvoidHits.length
  if (prefer) return prefer
  const fit = b.fitMatches.length - a.fitMatches.length
  const score = scoreValue(b.product) - scoreValue(a.product)
  if (sort === 'value') return valueRank(a.product) - valueRank(b.product) || fit || score
  return fit || score
}

export function rulesFrom(conditions: Pick<Conditions, 'hardAvoid' | 'preferAvoid'>): AvoidanceRules {
  return { hardAvoid: conditions.hardAvoid, preferAvoid: conditions.preferAvoid }
}

export interface RankedProduct {
  product: ProductFacts
  verdict: Verdict
  fitMatches: string[]
  preferAvoidHits: string[]
}

function valueRank(product: ProductFacts): number {
  const index = VALUE_BANDS.indexOf(product.valueBand ?? 'unknown')
  return index === -1 ? VALUE_BANDS.length : index
}

function scoreValue(product: ProductFacts): number {
  return product.score.status === 'scored' && product.score.value !== null ? product.score.value : -1
}

/**
 * Orders candidates for recommendation: only `eligible` products, fewer prefer-avoid hits first, more requested fit
 * tags first, then score (or value band when the shopper asked for value), then the catalog's own order.
 */
export function rankCandidates(
  products: readonly ProductFacts[],
  conditions: Conditions,
  options: { excludeIds?: readonly string[]; limit: number },
): { ranked: RankedProduct[]; considered: number; excluded: number; unknown: number } {
  const skip = new Set(options.excludeIds ?? [])
  const seen = new Set<string>()
  const wanted = new Set(conditions.fitTags)
  const rules = rulesFrom(conditions)
  let excluded = 0
  let unknown = 0
  const eligible: Array<RankedProduct & { order: number }> = []

  products.forEach((product, order) => {
    if (skip.has(product.id) || seen.has(product.id)) return
    seen.add(product.id)
    if (conditions.productType && product.productType !== conditions.productType) return
    const verdict = evaluateProduct(product, rules)
    if (verdict.eligibility === 'excluded') {
      excluded += 1
      return
    }
    if (verdict.eligibility === 'unknown') {
      unknown += 1
      return
    }
    eligible.push({
      product,
      verdict,
      order,
      fitMatches: product.fitTags.filter((tag) => wanted.has(tag)),
      preferAvoidHits: verdict.reasons.flatMap((reason) =>
        reason.kind === 'prefer-avoid' && reason.code ? [reason.code] : [],
      ),
    })
  })

  eligible.sort((a, b) => compareRanked(a, b, conditions.sort) || a.order - b.order)

  return {
    ranked: eligible.slice(0, options.limit).map(({ order: _order, ...rest }) => rest),
    considered: seen.size,
    excluded,
    unknown,
  }
}
