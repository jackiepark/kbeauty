/**
 * Verifiable shopping agent core.
 *
 * The model proposes (understands the request, reads a label, picks tools, words the answer); deterministic code
 * decides (which products exist, whether an avoided ingredient group is listed, which score a product has). This
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

export interface Sentence {
  text: string
  refs: string[]
}

export interface ProductNote extends Sentence {
  productId: string
}
