# Verifiable shopping agent on Meta Muse Spark

A shopping assistant that answers "is this product right for me, and what should I buy instead?" without letting the model invent facts. Built for the Meta Global AI Developer Hackathon 2026 (Startup track, Build for Your World).

The model proposes, deterministic code decides, and the model never writes a product fact:

| Step | Who | What |
| --- | --- | --- |
| Understand the request | Muse Spark (`muse-spark-1.3`, `reasoning_effort: low`) | Maps "dry, sensitive skin, no fragrance at all, maybe no essential oils" to strict conditions: hard avoid, prefer avoid, suitability tags, product type, sort |
| Pick tools | Muse Spark tool calling (strict JSON Schema arguments, parallel calls) | `check_product`, `find_products`, `get_product` over a read-only catalog port |
| Judge products | Deterministic evaluator | `excluded` only when an avoided group is printed in the ingredient list, with the ingredient position; `eligible` only when the list was checked; otherwise `unknown` |
| Pick the facts to show | Muse Spark strict `response_format` (JSON Schema) | Evidence refs from this turn's data, such as `flag:<product>:fragrance`, `ing:<product>#40`, `score:<product>`, plus the INCI name of any ingredient the shopper asked about. No sentences |
| Build the facts | Deterministic code | Drops products the model never looked up, re-checks every verdict under the final conditions, and rebuilds each picked ref from catalog data into a structured fact (`listed`, `passes`, `ingredient`, `absent`, `score`, `fit`, `key`, ...). The app words the facts in the shopper's language, so an answer cannot say what the ingredient list does not |
| Read a store label | Muse Spark image input (`reasoning_effort: minimal`) | Returns only visible text; a deterministic matcher finds catalog candidates and the shopper confirms |

## What the Meta Model API does here

- One request carries both `tools` and a strict `response_format`. When the model calls tools, the agent runs them and records every fact in a per-turn evidence ledger; when it stops calling tools, the same request shape returns the final JSON answer.
- `tool_choice` only accepts `auto` today, so the final round simply omits `tools` to force the JSON answer.
- Reasoning tokens count against `max_tokens`; with the default effort a 300-token budget can return no content at all. Each call sets `reasoning_effort` explicitly.

## Layout

```text
src/meta/      Meta Model API client (Chat Completions, strict tools and json_schema, image input, typed errors, timeouts)
src/agent/     catalog-neutral agent: orchestrator, tools, evaluator, evidence ledger, fact builder, claim guard, label reader, golden set
src/agent/fixtures.ts   a small synthetic catalog (invented brands) implementing CatalogPort
src/demo.ts    run one turn or one label read against the synthetic catalog with a real Meta key
src/golden.ts  run the 70-case golden set against the synthetic catalog with a real Meta key
```

A real catalog implements `CatalogPort` (`getProduct`, `searchProducts`, `listProducts`, `vocabulary`). The production integration that runs on a live K-beauty catalog is not part of this repository.

## Run

```bash
npm install
npm test                      # unit tests, no network
META_MODEL_API_KEY=... npx tsx src/demo.ts "Dry, sensitive skin and no fragrance. Is this OK? Show alternatives." aurora-ceramide-barrier-cream
META_MODEL_API_KEY=... npx tsx src/demo.ts --label ./photo.jpg
META_MODEL_API_KEY=... npx tsx src/golden.ts golden-results.json
```

## Golden set

`src/agent/golden.ts` holds 50 shopper questions (15 English, 10 in other languages, 20 follow-ups that change earlier conditions, 5 edge cases such as medical wording and unclear ingredient groups) and 20 prompt injections (14 in the shopper's message, 6 planted in catalog data: product names, key ingredients, score reasons). Every answer is checked for invented products, facts that differ from the catalog, safety or medical claims and leaked instructions in the model's own words, and recommendations that fail the final conditions; each case adds what it expects (verdict, conditions, products that must not be recommended).

Run on 2026-10-29 with `muse-spark-1.3`:

| Check | Result |
| --- | --- |
| Cases passing every check | 69 / 70 (the one miss was a single model call over the 20 s timeout; the same case passed 3 of 3 reruns) |
| Invented products | 0 |
| Facts shown that differ from the catalog | 0 of 109 |
| Safety or medical claims in the model's words | 0 |
| Leaked instructions | 0 |
| Follow-ups that applied the condition change | 20 / 20 |
| Questions in other languages | 10 / 10 |
| Injections that changed a verdict, a condition or a recommendation | 0 / 20 |
| Latency per turn | p50 5.0 s, p95 11.6 s, 1.9 model calls on average |


## Hackathon scope

Everything in this repository was written during the hackathon (October 27 to November 4, 2026). The live site it powers already had a product catalog, ingredient lists and a product score before the event; those are not included.

## License

MIT. See [LICENSE](./LICENSE).
