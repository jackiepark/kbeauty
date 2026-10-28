import { MetaModelError } from '../meta/client.js'
import {
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ChatUsage,
  EMPTY_USAGE,
  addUsage,
} from '../meta/types.js'
import { MAX_RECOMMENDATIONS, answerFormat, finalizeAnswer, type FinalAnswer } from './answer.js'
import type { CatalogPort } from './catalog-port.js'
import { EvidenceLedger } from './ledger.js'
import { AGENT_PROMPT_VERSION, agentContextPrompt, agentSystemPrompt } from './prompts.js'
import { buildToolDefinitions, executeTool } from './tools.js'
import { type Conditions, EMPTY_CONDITIONS, type PreviousTurn } from './types.js'

export interface AgentTurnInput {
  message: string
  locale: string
  currentProductId: string | null
  previous: PreviousTurn | null
}

export interface AgentLimits {
  /** Model calls per turn, including the final answer. */
  maxModelCalls: number
  /** Tool executions per turn; extra calls get a "budget used" result. */
  maxToolCalls: number
  modelTimeoutMs: number
  maxTokens: number
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = Object.freeze({
  maxModelCalls: 4,
  maxToolCalls: 6,
  modelTimeoutMs: 20_000,
  maxTokens: 3_000,
})

export type AgentFailure =
  | 'model-auth'
  | 'model-rate-limited'
  | 'model-timeout'
  | 'model-error'
  | 'invalid-answer'
  | 'catalog-error'

export interface AgentTrace {
  promptVersion: string
  model: string
  modelCalls: number
  toolCalls: Array<{ name: string; ok: boolean; ms: number }>
  usage: ChatUsage
  latencyMs: number
  droppedSentences: number
  droppedProducts: number
  failure: AgentFailure | null
}

export type AgentTurnResult =
  | ({ status: FinalAnswer['status']; delta: Delta | null; trace: AgentTrace } & Omit<
      FinalAnswer,
      'status' | 'dropped'
    >)
  | {
      status: 'failed'
      conditions: Conditions
      delta: null
      trace: AgentTrace
    }

export interface Delta {
  added: string[]
  removed: string[]
  kept: string[]
}

export interface AgentDependencies {
  model: ChatModel
  catalog: CatalogPort
  limits?: Partial<AgentLimits>
  now?: () => number
}

function failureFor(error: unknown): AgentFailure {
  if (error instanceof MetaModelError) {
    if (error.kind === 'auth') return 'model-auth'
    if (error.kind === 'rate-limited') return 'model-rate-limited'
    if (error.kind === 'timeout') return 'model-timeout'
    return 'model-error'
  }
  return 'catalog-error'
}

async function chatOnceWithRetry(
  model: ChatModel,
  request: ChatRequest,
): Promise<{ response: ChatResponse; calls: number }> {
  try {
    return { response: await model.chat(request), calls: 1 }
  } catch (error) {
    if (!(error instanceof MetaModelError) || !error.transient) throw error
    return { response: await model.chat(request), calls: 2 }
  }
}

function parseAnswer(content: string | null): unknown {
  if (!content) return null
  try {
    return JSON.parse(content)
  } catch {
    // Some responses wrap the JSON in prose; take the outermost object.
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    try {
      return JSON.parse(content.slice(start, end + 1))
    } catch {
      return null
    }
  }
}

export function computeDelta(previous: readonly string[] | undefined, next: readonly string[]): Delta | null {
  if (!previous) return null
  const before = new Set(previous)
  const after = new Set(next)
  return {
    added: next.filter((id) => !before.has(id)),
    removed: previous.filter((id) => !after.has(id)),
    kept: next.filter((id) => before.has(id)),
  }
}

/**
 * One shopper turn: the model plans with tools (each tool result lands in the evidence ledger), then answers in strict
 * JSON, which `finalizeAnswer` re-checks against the ledger and the deterministic evaluator.
 */
export async function runAgentTurn(deps: AgentDependencies, input: AgentTurnInput): Promise<AgentTurnResult> {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const startedAt = now()
  const vocabulary = deps.catalog.vocabulary()
  const ledger = new EvidenceLedger()
  const trace: AgentTrace = {
    promptVersion: AGENT_PROMPT_VERSION,
    model: deps.model.model,
    modelCalls: 0,
    toolCalls: [],
    usage: EMPTY_USAGE,
    latencyMs: 0,
    droppedSentences: 0,
    droppedProducts: 0,
    failure: null,
  }
  const failed = (failure: AgentFailure): AgentTurnResult => {
    trace.failure = failure
    trace.latencyMs = now() - startedAt
    return { status: 'failed', conditions: input.previous?.conditions ?? EMPTY_CONDITIONS, delta: null, trace }
  }

  try {
    const current = input.currentProductId ? await deps.catalog.getProduct(input.currentProductId) : null
    if (current) ledger.addProduct(current)

    const tools = buildToolDefinitions(vocabulary)
    const format = answerFormat(vocabulary)
    const messages: ChatMessage[] = [
      { role: 'system', content: agentSystemPrompt(vocabulary) },
      { role: 'system', content: agentContextPrompt({ locale: input.locale, current, previous: input.previous }) },
      { role: 'user', content: input.message },
    ]

    let raw: unknown = null
    let toolCount = 0
    let forceAnswer = false
    for (let round = 0; round < limits.maxModelCalls; round += 1) {
      const finalRound = forceAnswer || round === limits.maxModelCalls - 1 || toolCount >= limits.maxToolCalls
      const { response, calls } = await chatOnceWithRetry(deps.model, {
        messages,
        tools: finalRound ? undefined : tools,
        parallelToolCalls: true,
        responseFormat: format,
        reasoningEffort: 'low',
        maxTokens: limits.maxTokens,
        timeoutMs: limits.modelTimeoutMs,
      })
      trace.modelCalls += calls
      trace.usage = addUsage(trace.usage, response.usage)

      if (response.toolCalls.length && !finalRound) {
        messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })
        const outcomes = await Promise.all(
          response.toolCalls.map(async (call) => {
            if (toolCount >= limits.maxToolCalls) {
              return {
                call,
                ok: false,
                ms: 0,
                result: { error: 'Tool budget used up. Answer now with the data you have.' },
              }
            }
            toolCount += 1
            const started = now()
            const outcome = await executeTool(call.function.name, call.function.arguments, {
              catalog: deps.catalog,
              ledger,
              vocabulary,
            })
            return { call, ok: outcome.ok, ms: now() - started, result: outcome.result }
          }),
        )
        for (const outcome of outcomes) {
          trace.toolCalls.push({ name: outcome.call.function.name, ok: outcome.ok, ms: outcome.ms })
          messages.push({ role: 'tool', tool_call_id: outcome.call.id, content: JSON.stringify(outcome.result) })
        }
        continue
      }

      raw = parseAnswer(response.content)
      if (raw !== null) break
      if (finalRound) break
      // Prose instead of JSON: ask once more for the answer only.
      messages.push({ role: 'assistant', content: response.content })
      messages.push({ role: 'user', content: 'Reply now with the JSON answer only.' })
      forceAnswer = true
    }

    if (raw === null) return failed('invalid-answer')
    const answer = finalizeAnswer(raw, { ledger, vocabulary, currentProductId: current?.id ?? null })
    trace.droppedSentences = answer.dropped.sentences
    trace.droppedProducts = answer.dropped.products
    trace.latencyMs = now() - startedAt
    const { dropped: _dropped, ...rest } = answer
    return {
      ...rest,
      delta: computeDelta(
        input.previous?.recommendedProductIds,
        answer.recommendations.slice(0, MAX_RECOMMENDATIONS).map((item) => item.product.id),
      ),
      trace,
    }
  } catch (error) {
    return failed(failureFor(error))
  }
}
