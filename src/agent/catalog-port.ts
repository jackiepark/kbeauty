import type { CatalogVocabulary, ProductFacts } from './types.js'

/**
 * Everything the agent knows about a catalog. Implementations are read-only and bounded; the agent never sees SQL,
 * prices, or private fields.
 */
export interface CatalogPort {
  vocabulary(): CatalogVocabulary
  /** Full facts including the printed ingredient list, or null when the id is unknown or not public. */
  getProduct(id: string): Promise<ProductFacts | null>
  /** Products whose brand, name or key ingredients contain every word of `query`. */
  searchProducts(input: { query: string; productType: string | null; limit: number }): Promise<ProductFacts[]>
  /** Products of one type in the catalog's own order (best first). */
  listProducts(input: { productType: string; limit: number }): Promise<ProductFacts[]>
}
