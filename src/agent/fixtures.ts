import type { CatalogPort } from './catalog-port.js'
import { searchTokens } from './text.js'
import type { CatalogVocabulary, ProductFacts, ProductFlag } from './types.js'

/**
 * A small synthetic catalog for tests and the public demo. Brands and products are invented; ingredient lists use
 * ordinary INCI names. Flags are derived by the same kind of rule a real catalog would run at ingest.
 */
export const FIXTURE_VOCABULARY: CatalogVocabulary = {
  avoidance: [
    { code: 'fragrance', label: 'fragrance or parfum listed' },
    { code: 'essential-oils', label: 'essential oils listed' },
    { code: 'denatured-alcohol', label: 'denatured alcohol listed' },
    { code: 'exfoliating-acids', label: 'AHA/BHA/PHA acids listed' },
    { code: 'retinoids', label: 'retinol or retinal listed' },
    { code: 'linalool', label: 'linalool (fragrance allergen) listed' },
    { code: 'limonene', label: 'limonene (fragrance allergen) listed' },
  ],
  fit: [
    { code: 'dry', label: 'dry skin' },
    { code: 'oily', label: 'oily skin' },
    { code: 'sensitive', label: 'sensitive skin' },
    { code: 'hydration', label: 'hydration' },
    { code: 'soothing', label: 'soothing' },
  ],
  productTypes: [
    { code: 'serum', label: 'serum' },
    { code: 'moisturizer', label: 'moisturizer' },
    { code: 'cleanser', label: 'cleanser' },
  ],
}

const FLAG_RULES: Array<{ code: string; pattern: RegExp }> = [
  { code: 'fragrance', pattern: /\b(parfum|fragrance)\b/i },
  { code: 'essential-oils', pattern: /\b(lavandula angustifolia|citrus|mentha)\b.*\boil\b/i },
  { code: 'denatured-alcohol', pattern: /alcohol denat/i },
  { code: 'exfoliating-acids', pattern: /\b(glycolic|salicylic|mandelic) acid\b|gluconolactone/i },
  { code: 'retinoids', pattern: /\bretin(ol|al)\b/i },
  { code: 'linalool', pattern: /^linalool$/i },
  { code: 'limonene', pattern: /^limonene$/i },
]

function flagsFor(inci: string[]): ProductFlag[] {
  const flags = new Map<string, string[]>()
  for (const name of inci) {
    for (const rule of FLAG_RULES) {
      if (rule.pattern.test(name)) flags.set(rule.code, [...(flags.get(rule.code) ?? []), name])
    }
  }
  return [...flags].map(([code, evidence]) => ({ code, evidence }))
}

type FixtureInput = Omit<ProductFacts, 'ingredients' | 'flags'> & { inci: string[] | null }

function product(input: FixtureInput): ProductFacts {
  const { inci, ...rest } = input
  return {
    ...rest,
    ingredients: inci
      ? { status: 'listed', items: inci.map((name, index) => ({ position: index + 1, name })) }
      : { status: 'missing', items: [] },
    flags: inci ? { status: 'evaluated', items: flagsFor(inci) } : { status: 'unknown', items: [] },
  }
}

export const FIXTURE_PRODUCTS: ProductFacts[] = [
  product({
    id: 'aurora-ceramide-barrier-cream',
    brand: 'Aurora Lab',
    name: 'Ceramide Barrier Cream 80ml',
    productType: 'moisturizer',
    inci: [
      'Water',
      'Glycerin',
      'Butylene Glycol',
      'Squalane',
      'Ceramide NP',
      'Panthenol',
      'Cholesterol',
      'Parfum',
      'Limonene',
      'Linalool',
    ],
    score: {
      status: 'scored',
      value: 7.4,
      reasons: [
        'Ceramide NP is a well-evidenced ingredient for the barrier care claim',
        'Solid base formula for this product type',
        'Small deduction: lists fragrance (Parfum)',
      ],
    },
    valueBand: 'similar',
    keyIngredients: ['Ceramides', 'Panthenol'],
    fitTags: ['dry', 'hydration'],
  }),
  product({
    id: 'mellow-oat-calming-cream',
    brand: 'Mellow',
    name: 'Oat Calming Cream',
    productType: 'moisturizer',
    inci: [
      'Water',
      'Glycerin',
      'Avena Sativa Kernel Flour',
      'Caprylic/Capric Triglyceride',
      'Ceramide NP',
      'Allantoin',
      'Panthenol',
    ],
    score: {
      status: 'scored',
      value: 8.1,
      reasons: [
        'Avena Sativa Kernel Flour is a well-evidenced ingredient for the soothing claim',
        'Also lists Ceramide NP for barrier care',
        'Reasonably priced versus comparable global brands',
      ],
    },
    valueBand: 'high',
    keyIngredients: ['Oat', 'Ceramides'],
    fitTags: ['dry', 'sensitive', 'soothing'],
  }),
  product({
    id: 'dewpoint-hyaluronic-cream',
    brand: 'Dewpoint',
    name: 'Hyaluronic Water Cream',
    productType: 'moisturizer',
    inci: [
      'Water',
      'Butylene Glycol',
      'Sodium Hyaluronate',
      'Betaine',
      'Glycerin',
      'Lavandula Angustifolia (Lavender) Oil',
    ],
    score: { status: 'scored', value: 6.2 },
    valueBand: 'very-high',
    keyIngredients: ['Hyaluronic Acid'],
    fitTags: ['oily', 'hydration'],
  }),
  product({
    id: 'kindred-barrier-balm',
    brand: 'Kindred',
    name: 'Barrier Balm',
    productType: 'moisturizer',
    inci: null,
    score: { status: 'unscored', value: null },
    valueBand: null,
    keyIngredients: [],
    fitTags: ['dry'],
  }),
  product({
    id: 'aurora-panthenol-serum',
    brand: 'Aurora Lab',
    name: 'Panthenol 5 Serum',
    productType: 'serum',
    inci: ['Water', 'Panthenol', 'Glycerin', 'Madecassoside', 'Sodium Hyaluronate'],
    score: { status: 'scored', value: 7.9 },
    valueBand: 'high',
    keyIngredients: ['Panthenol', 'Madecassoside'],
    fitTags: ['sensitive', 'soothing'],
  }),
  product({
    id: 'nightshift-retinal-serum',
    brand: 'Nightshift',
    name: 'Retinal 0.1 Night Serum',
    productType: 'serum',
    inci: ['Water', 'Squalane', 'Retinal', 'Tocopherol', 'Alcohol Denat.'],
    score: { status: 'scored', value: 6.8 },
    valueBand: 'premium',
    keyIngredients: ['Retinal'],
    fitTags: [],
  }),
  product({
    id: 'mellow-gentle-gel-cleanser',
    brand: 'Mellow',
    name: 'Low pH Gel Cleanser',
    productType: 'cleanser',
    inci: ['Water', 'Cocamidopropyl Betaine', 'Glycerin', 'Salicylic Acid', 'Parfum'],
    score: { status: 'scored', value: 6.5 },
    valueBand: 'similar',
    keyIngredients: ['BHA'],
    fitTags: ['oily'],
  }),
  product({
    id: 'dewpoint-oil-free-cleanser',
    brand: 'Dewpoint',
    name: 'Amino Foam Cleanser',
    productType: 'cleanser',
    inci: ['Water', 'Sodium Cocoyl Glycinate', 'Glycerin', 'Panthenol'],
    score: { status: 'unscored', value: null },
    valueBand: 'high',
    keyIngredients: ['Amino acids'],
    fitTags: ['sensitive'],
  }),
]

/** In-memory `CatalogPort` over the fixtures, with the same contracts a real catalog implements. */
export function createFixtureCatalog(products: readonly ProductFacts[] = FIXTURE_PRODUCTS): CatalogPort {
  const byId = new Map(products.map((item) => [item.id, item]))
  const listRow = (item: ProductFacts): ProductFacts => ({ ...item, ingredients: { status: 'not-loaded', items: [] } })
  return {
    vocabulary: () => FIXTURE_VOCABULARY,
    async getProduct(id) {
      return byId.get(id) ?? null
    },
    async searchProducts({ query, productType, limit }) {
      const words = searchTokens(query)
      return products
        .filter((item) => !productType || item.productType === productType)
        .filter((item) => {
          const text = searchTokens(`${item.brand} ${item.name} ${item.keyIngredients.join(' ')}`)
          return words.every((word) => text.some((token) => token.includes(word)))
        })
        .slice(0, limit)
        .map(listRow)
    },
    async listProducts({ productType, limit }) {
      return products
        .filter((item) => item.productType === productType)
        .slice(0, limit)
        .map(listRow)
    },
  }
}
