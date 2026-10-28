/**
 * Evidence refs: short ids for facts the agent has actually loaded this turn. A sentence may only cite refs that
 * exist in the turn's ledger, which is how invented facts are caught.
 */
export const productRef = (productId: string) => `product:${productId}`
export const ingredientRef = (productId: string, position: number) => `ing:${productId}#${position}`
export const flagRef = (productId: string, code: string) => `flag:${productId}:${code}`
export const scoreRef = (productId: string) => `score:${productId}`
export const fitRef = (productId: string) => `fit:${productId}`
export const keyIngredientsRef = (productId: string) => `key:${productId}`
/** "Checked against the shopper's avoidance rules and nothing avoided is listed." */
export const checkedRef = (productId: string) => `check:${productId}`

/** The product a ref points at, or null for a malformed ref. */
export function refProductId(ref: string): string | null {
  const match = /^(?:product|ing|flag|score|fit|key|check):([^#:]+)/.exec(ref)
  return match ? match[1] : null
}
