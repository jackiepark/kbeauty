/**
 * Verifiable shopping agent core.
 *
 * The model proposes (understands the request, reads a label, picks tools, picks which facts to show); deterministic
 * code decides (which products exist, whether an avoided ingredient group is listed, which score a product has) and
 * builds every fact the shopper sees, so no answer can state what the catalog does not. This
 * folder must stay catalog- and app-neutral: everything specific arrives through `CatalogPort`.
 */

export const ELIGIBILITIES = ['eligible', 'excluded', 'unknown'] as const
export type Eligibility = (typeof ELIGIBILITIES)[number]

export const SORT_ORDERS = ['score', 'value'] as const
export type SortOrder = (typeof SORT_ORDERS)[number]

/** Coarse relative value bands, best first. */
export const VALUE_BANDS = ['very-high', 'high', 'similar', 'premium', 'unknown'] as const
export type ValueBand = (typeof VALUE_BANDS)[number]

export interface VocabularyEntry {
  code: string
  /** Short English label the model reads; apps localise codes themselves. */
  label: string
}

export interface CatalogVocabulary {
  /** Ingredient groups a shopper can avoid, e.g. `fragrance`. */
  avoidance: readonly VocabularyEntry[]
  /** Source-listed suitability tags, e.g. `dry` or `soothing`. */
  fit: readonly VocabularyEntry[]
  productTypes: readonly VocabularyEntry[]
}

export interface ProductIngredient {
  /** 1-based position in the printed ingredient list. */
  position: number
  name: string
}

export interface ProductFlag {
  /** An avoidance code. */
  code: string
  /** Ingredient names, as printed, that triggered the flag. */
  evidence: string[]
}

export interface ProductFacts {
  id: string
  brand: string
  name: string
  productType: string
  /**
   * `listed`: the full printed list is loaded. `not-loaded`: list rows that carry flags but not the list.
   * `missing`: the catalog has no ingredient list for the product.
   */
  ingredients: { status: 'listed' | 'missing' | 'not-loaded'; items: ProductIngredient[] }
  /** `evaluated`: every flag rule ran over the printed list, so an absent flag means "not listed". */
  flags: { status: 'evaluated' | 'unknown'; items: ProductFlag[] }
  /** `reasons`: plain-language reasons behind a score, strongest first, written by the catalog adapter. */
  score: { status: 'scored' | 'unscored'; value: number | null; reasons?: string[] }
  valueBand: ValueBand | null
  keyIngredients: string[]
  fitTags: string[]
}

export interface Conditions {
  fitTags: string[]
  hardAvoid: string[]
  preferAvoid: string[]
  productType: string | null
  sort: SortOrder
}

export const EMPTY_CONDITIONS: Conditions = Object.freeze({
  fitTags: [],
  hardAvoid: [],
  preferAvoid: [],
  productType: null,
  sort: 'score',
}) as Conditions

/** A clarifying question the assistant asked last turn, with the shopper message that led to it. */
export interface PendingClarification {
  request: string
  question: string
}

/** What the client carries from the previous turn of the same conversation. */
export interface PreviousTurn {
  conditions: Conditions
  recommendedProductIds: string[]
  pending?: PendingClarification | null
}

export interface EvidenceItem {
  name: string
  /** Null when the evidence name could not be placed in a loaded ingredient list. */
  position: number | null
}

export interface VerdictReason {
  kind: 'hard-avoid' | 'prefer-avoid' | 'not-evaluable'
  code: string | null
  evidence: EvidenceItem[]
}

export interface Verdict {
  productId: string
  eligibility: Eligibility
  reasons: VerdictReason[]
  /** Evidence refs a sentence about this verdict may cite. */
  refs: string[]
}

/**
 * A fact the app shows. The model only picks the ref a fact comes from (or names an ingredient to look up); code
 * builds the fact from catalog data under the final conditions, and the app words it. A fact can never contradict
 * the data it came from.
 */
export type Fact =
  /** The product lists an avoidance group; evidence names with their places in the printed list. */
  | { kind: 'listed'; productId: string; code: string; evidence: EvidenceItem[] }
  /** None of these avoided groups is listed in the product's printed list. */
  | { kind: 'passes'; productId: string; checked: string[] }
  /** No ingredient list to check. */
  | { kind: 'unchecked'; productId: string }
  | { kind: 'ingredient'; productId: string; name: string; position: number }
  /** An ingredient the shopper asked about is not in the product's printed list. */
  | { kind: 'absent'; productId: string; name: string }
  | { kind: 'score'; productId: string; value: number; productType: string }
  /** The product has not been scored yet. */
  | { kind: 'unscored'; productId: string }
  | { kind: 'fit'; productId: string; tags: string[] }
  | { kind: 'key'; productId: string; names: string[] }

export interface ProductNote {
  productId: string
  facts: Fact[]
}
