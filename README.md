# Verifiable shopping agent on Meta Muse Spark

A shopping assistant that answers "is this product right for me, and what should I buy instead?" without letting the model invent facts. Built for the Meta Global AI Developer Hackathon 2026 (Startup track, Build for Your World).

The model proposes, deterministic code decides:

| Step | Who | What |
| --- | --- | --- |
| Understand the request | Muse Spark (`muse-spark-1.3`, `reasoning_effort: low`) | Maps "dry, sensitive skin, no fragrance at all, maybe no essential oils" to strict conditions: hard avoid, prefer avoid, suitability tags, product type, sort |
| Pick tools | Muse Spark tool calling (strict JSON Schema arguments, parallel calls) | `check_product`, `find_products`, `get_product` over a read-only catalog port |
| Judge products | Deterministic evaluator | `excluded` only when an avoided group is printed in the ingredient list, with the ingredient position; `eligible` only when the list was checked; otherwise `unknown` |
| Write the answer | Muse Spark strict `response_format` (JSON Schema) | Short sentences, each citing evidence refs such as `ing:<product>#40` or `flag:<product>:fragrance` |
| Verify the answer | Deterministic validator | Drops products the model never looked up, re-checks every verdict under the final conditions, deletes sentences whose refs were not loaded this turn or that claim safety, cures or guarantees |
| Read a store label | Muse Spark image input (`reasoning_effort: minimal`) | Returns only visible text; a deterministic matcher finds catalog candidates and the shopper confirms |

## What the Meta Model API does here

- One request carries both `tools` and a strict `response_format`. When the model calls tools, the agent runs them and records every fact in a per-turn evidence ledger; when it stops calling tools, the same request shape returns the final JSON answer.
- `tool_choice` only accepts `auto` today, so the final round simply omits `tools` to force the JSON answer.
- Reasoning tokens count against `max_tokens`; with the default effort a 300-token budget can return no content at all. Each call sets `reasoning_effort` explicitly.

## Layout

```text
src/meta/      Meta Model API client (Chat Completions, strict tools and json_schema, image input, typed errors, timeouts)
src/agent/     catalog-neutral agent: orchestrator, tools, evaluator, evidence ledger, answer validator, claim guard, label reader
src/agent/fixtures.ts   a small synthetic catalog (invented brands) implementing CatalogPort
src/demo.ts    run one turn or one label read against the synthetic catalog with a real Meta key
```

A real catalog implements `CatalogPort` (`getProduct`, `searchProducts`, `listProducts`, `vocabulary`). The production integration that runs on a live K-beauty catalog is not part of this repository.

## Run

```bash
npm install
npm test                      # unit tests, no network
META_MODEL_API_KEY=... npx tsx src/demo.ts "Dry, sensitive skin and no fragrance. Is this OK? Show alternatives." aurora-ceramide-barrier-cream
META_MODEL_API_KEY=... npx tsx src/demo.ts --label ./photo.jpg
```

## Hackathon scope

Everything in this repository was written during the hackathon (October 27 to November 4, 2026). The live site it powers already had a product catalog, ingredient lists and a product score before the event; those are not included.

## License

MIT. See [LICENSE](./LICENSE).
