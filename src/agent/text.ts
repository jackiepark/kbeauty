/** Case-, accent- and spacing-insensitive form used for every name comparison in the agent. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'of', 'a', 'an', 'in', 'ml', 'g', 'ea', 'set', 'pack', 'new'])

/** Distinct search words of at least two characters, without filler words and unit suffixes. */
export function searchTokens(value: string): string[] {
  const tokens = normalizeName(value)
    .split(' ')
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token) && !/^\d+(ml|g|ea)$/.test(token))
  return [...new Set(tokens)]
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))]
}

export function clampText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}
