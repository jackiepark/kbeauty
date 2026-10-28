/**
 * Request and response shapes for the Meta Model API Chat Completions endpoint
 * (OpenAI-compatible). Only the fields this codebase uses are modelled.
 */

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image_url'
  /** A public https URL or a `data:image/...;base64,` URL. */
  image_url: { url: string }
}

export type ContentPart = TextPart | ImagePart

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** JSON Schema object accepted by strict tools and `json_schema` output. */
export type JsonSchema = Record<string, unknown>

export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; strict: true; parameters: JsonSchema }
}

export interface JsonSchemaFormat {
  type: 'json_schema'
  json_schema: { name: string; strict: true; schema: JsonSchema }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  /** The API only accepts `auto` today; named and `required` choices return 400. */
  parallelToolCalls?: boolean
  responseFormat?: JsonSchemaFormat
  reasoningEffort: ReasoningEffort
  /** Reasoning tokens count against this budget, so keep it well above the visible answer size. */
  maxTokens: number
  timeoutMs?: number
}

export interface ChatUsage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
}

export interface ChatResponse {
  content: string | null
  toolCalls: ToolCall[]
  finishReason: string | null
  usage: ChatUsage
}

export interface ChatModel {
  readonly model: string
  chat(request: ChatRequest): Promise<ChatResponse>
}

export const EMPTY_USAGE: ChatUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
})

export function addUsage(total: ChatUsage, next: ChatUsage): ChatUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
    cachedInputTokens: total.cachedInputTokens + next.cachedInputTokens,
  }
}
