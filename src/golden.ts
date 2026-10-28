import { writeFile } from 'node:fs/promises'
import { runGolden, summarizeGolden } from './agent/golden.js'
import { createMetaChatModel } from './meta/client.js'

// Runs the 70-case golden set against the synthetic catalog with a real Meta key:
//   META_MODEL_API_KEY=... npx tsx src/golden.ts [results.json]
const apiKey = process.env.META_MODEL_API_KEY
if (!apiKey) {
  console.error('Set META_MODEL_API_KEY')
  process.exit(1)
}

const model = createMetaChatModel({ apiKey })
const outcomes = await runGolden(model)
const summary = summarizeGolden(outcomes)
for (const item of outcomes.filter((outcome) => !outcome.ok)) console.log(`FAIL ${item.id}: ${item.failures.join('; ')}`)
console.log(JSON.stringify(summary, null, 2))
await writeFile(
  process.argv[2] ?? 'golden-results.json',
  `${JSON.stringify({ model: model.model, ranAt: new Date().toISOString(), summary, outcomes }, null, 1)}\n`,
)
