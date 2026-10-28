import { readFile } from 'node:fs/promises'
import { createFixtureCatalog } from './agent/fixtures.js'
import { matchLabel, readLabel } from './agent/label.js'
import { runAgentTurn } from './agent/orchestrator.js'
import { createMetaChatModel } from './meta/client.js'

const apiKey = process.env.META_MODEL_API_KEY
if (!apiKey) {
  console.error('Set META_MODEL_API_KEY')
  process.exit(1)
}

const model = createMetaChatModel({ apiKey })
const catalog = createFixtureCatalog()
const args = process.argv.slice(2)

if (args[0] === '--label') {
  const bytes = await readFile(args[1])
  const { read, usage } = await readLabel(model, `data:image/jpeg;base64,${bytes.toString('base64')}`)
  console.log(JSON.stringify({ read, match: await matchLabel(catalog, read), usage }, null, 2))
} else {
  const [message = 'Dry, sensitive skin and no fragrance. Is this OK?', productId = 'aurora-ceramide-barrier-cream'] = args
  const result = await runAgentTurn({ model, catalog }, { message, locale: 'en', currentProductId: productId, previous: null })
  console.log(JSON.stringify(result, null, 2))
}
