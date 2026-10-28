/**
 * Wording a shopping answer must never contain: safety, tolerance, medical or guarantee claims. The check runs after
 * product names are removed, so a product called "Safe Me Relief" is not flagged by its own name. It is a backstop
 * for the prompt, not a full language model of claims, and covers the site's 14 languages.
 */
const UNSUPPORTED_CLAIM_PATTERNS: readonly RegExp[] = [
  // English
  /\b(safe|safer|safest|safely|hypoallergenic|non[- ]?irritating|irritation[- ]free|won'?t irritate|will not irritate|no irritation|allerg(?:y|en)[- ]free|non[- ]?toxic|toxic|cures?|cured|heals?|healing|treats? (?:acne|eczema|rosacea|dermatitis|psoriasis)|guarantee[sd]?|clinically proven|dermatologist[- ](?:approved|recommended)|no side effects|side[- ]effect[- ]free|medical[- ]grade)\b/i,
  // Korean
  /(안전|무해|저자극 보장|자극(이)? ?없|부작용(이)? ?없|치료|완치|낫게|보장)/,
  // Japanese
  /(安全|無害|刺激がない|刺激なし|副作用がない|副作用なし|治療|治る|完治|保証)/,
  // Chinese (simplified and traditional)
  /(安全|无害|無害|无刺激|無刺激|没有副作用|沒有副作用|治疗|治療|治愈|治癒|保证|保證)/,
  // Spanish / Portuguese
  /\b(segur[oa]s?|inofensiv[oa]s?|sin irritaci[oó]n|sem irrita[cç][aã]o|cura|curar|garantiza(?:do)?|garantido)\b/i,
  // French
  /\b(sûrs?|sans danger|sans irritation|guérit|guérir|garanti[es]?)\b/i,
  // German
  /\b(sicher|unbedenklich|reizfrei|heilt|garantiert)\b/i,
  // Indonesian
  /\b(aman|tanpa iritasi|menyembuhkan|dijamin)\b/i,
  // Vietnamese
  /(an toàn|không kích ứng|chữa khỏi|đảm bảo)/i,
  // Thai
  /(ปลอดภัย|ไม่ระคายเคือง|รักษาให้หาย|รับประกัน)/,
  // Russian
  /(безопасн|не раздража|вылеч|гарантир)/i,
  // Mongolian
  /(аюулгүй|эдгээ|баталгаат)/i,
  // Arabic
  /(آمن|علاج|يعالج|مضمون)/,
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function containsUnsupportedClaim(text: string, allowedNames: readonly string[] = []): boolean {
  let stripped = text
  for (const name of allowedNames) {
    if (name.trim().length >= 3) stripped = stripped.replace(new RegExp(escapeRegExp(name.trim()), 'gi'), ' ')
  }
  return UNSUPPORTED_CLAIM_PATTERNS.some((pattern) => pattern.test(stripped))
}
