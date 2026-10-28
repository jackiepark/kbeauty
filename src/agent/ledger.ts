import { flagRef, fitRef, ingredientRef, keyIngredientsRef, productRef, scoreRef } from './refs.js'
import type { ProductFacts, Verdict } from './types.js'

/**
 * Everything the agent has loaded during one turn. Answers may only mention products and cite refs recorded here.
 * A product loaded with its full ingredient list replaces an earlier list-row copy.
 */
export class EvidenceLedger {
  private readonly products = new Map<string, ProductFacts>()
  private readonly refs = new Set<string>()
  private readonly verdicts = new Map<string, Verdict>()

  addProduct(product: ProductFacts): void {
    const existing = this.products.get(product.id)
    if (!existing || existing.ingredients.status !== 'listed') this.products.set(product.id, product)
    this.refs.add(productRef(product.id))
    if (product.score.status === 'scored' && product.score.value !== null) this.refs.add(scoreRef(product.id))
    if (product.fitTags.length) this.refs.add(fitRef(product.id))
    if (product.keyIngredients.length) this.refs.add(keyIngredientsRef(product.id))
    for (const flag of product.flags.items) this.refs.add(flagRef(product.id, flag.code))
    if (product.ingredients.status === 'listed') {
      for (const item of product.ingredients.items) this.refs.add(ingredientRef(product.id, item.position))
    }
  }

  addVerdict(verdict: Verdict): void {
    this.verdicts.set(verdict.productId, verdict)
    for (const ref of verdict.refs) this.refs.add(ref)
  }

  product(id: string): ProductFacts | undefined {
    return this.products.get(id)
  }

  hasProduct(id: string): boolean {
    return this.products.has(id)
  }

  hasRef(ref: string): boolean {
    return this.refs.has(ref)
  }

  productNames(): string[] {
    return [...this.products.values()].flatMap((product) => [product.name, product.brand])
  }

  get size(): number {
    return this.products.size
  }
}
