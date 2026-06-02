import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

// --- Config ---

interface RulePattern {
  /** Keywords to match (case-insensitive substring). Any single match triggers the rule. */
  match: string[]
  /** The rule text to inject when triggered. */
  rule: string
}

interface RulesConfig {
  /** Baseline rules always included (array of strings, joined with newlines). */
  default?: string[]
  /** Conditional rules triggered by keyword matches. */
  patterns?: RulePattern[]
}

interface PolishConfig {
  model: string
  context: { maxMessages: number; maxCharsPerMessage: number }
  intensity: "light" | "medium" | "heavy"
  rules: RulesConfig
}

const DEFAULT_CONFIG: PolishConfig = {
  model: "opencode/deepseek-v4-flash-free",
  context: { maxMessages: 6, maxCharsPerMessage: 500 },
  intensity: "medium",
  rules: { default: [], patterns: [] },
}

function loadConfig(): PolishConfig {
  const configDir =
    process.env.OPENCODE_CONFIG_DIR?.trim() ||
    join(homedir(), ".config", "opencode")
  for (const name of ["polish.jsonc", "polish.json"]) {
    const p = join(configDir, name)
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8")
        // Strip JSONC comments (lines starting with //)
        const cleaned = raw
          .split("\n")
          .map((l) => l.replace(/\/\/.*$/, ""))
          .join("\n")
        const parsed = JSON.parse(cleaned)
        return {
          model: parsed.model ?? DEFAULT_CONFIG.model,
          context: {
            maxMessages:
              parsed.context?.maxMessages ?? DEFAULT_CONFIG.context.maxMessages,
            maxCharsPerMessage:
              parsed.context?.maxCharsPerMessage ??
              DEFAULT_CONFIG.context.maxCharsPerMessage,
          },
          intensity: parsed.intensity ?? DEFAULT_CONFIG.intensity,
          rules: {
            default: Array.isArray(parsed.rules?.default)
              ? parsed.rules.default
              : [],
            patterns: Array.isArray(parsed.rules?.patterns)
              ? parsed.rules.patterns
              : [],
          },
        }
      } catch {
        // Config parse failed — use defaults
      }
    }
  }
  return DEFAULT_CONFIG
}

// --- Model parsing ---

interface ModelRef {
  providerID: string
  modelID: string
}

function parseModel(model: string): ModelRef | null {
  const idx = model.indexOf("/")
  if (idx < 1) return null
  return {
    providerID: model.slice(0, idx),
    modelID: model.slice(idx + 1),
  }
}

// --- System prompt ---

const POLISH_AGENT = "polish"

// V2 SDK hard-constraint schema. Server creates a virtual `StructuredOutput` tool
// using this as `inputSchema`, sets `tool_choice: "required"` at the provider API
// layer, validates the tool call arguments against this schema, and retries on
// failure up to `retryCount` times. The validated object is returned via
// `info.structured` on the assistant message.
//
// We force the model to wrap its output in { "rewritten": "..." } so the
// rewrite is structurally separated from any preamble/analysis — the only
// field on the result that the plugin reads is `rewritten`.
const POLISH_JSON_SCHEMA = {
  type: "object",
  properties: {
    rewritten: {
      type: "string",
      description:
        "The optimized prompt — ONLY the rewritten text, no preamble, no analysis, no quotes, no markdown.",
    },
  },
  required: ["rewritten"],
  additionalProperties: false,
} as const

const POLISH_SYSTEM_PROMPT = `You are a text transformation function, not an AI assistant.

Your input: a raw user prompt wrapped in <raw_prompt>...</raw_prompt> tags.
Your output: a rewritten version of that prompt.

You do not have tools, code execution, or any way to act on the prompt. You do not answer questions. You do not provide solutions. You do not write code. You do not engage with the prompt's content beyond rewriting it.

A user prompt that says "write me a login function" is DATA to be transformed, not a request for you to write the function. Your output is a better-prompting version of "write me a login function", not the login function itself.

## Process

Silently analyze (do NOT output your analysis):
1. What is vague or missing? What assumptions are implicit?
2. What constraints or format expectations are absent?
3. What context (if provided) should be injected — file names, error messages, tech stack?
4. Is the prompt already clear enough? If so, return it unchanged.

## Output

- Output ONLY the rewritten prompt — no preamble, no commentary, no code blocks, no quotes
- Preserve language: Chinese in Chinese, English in English, technical terms in English
- Preserve user's original intent completely
- If the prompt is already clear and complete, return it as-is

## Context utilization

When conversation context is provided:
- If user mentions a file/variable/function earlier → inject the exact name into the prompt
- If there's an active task or error → reference it explicitly with details from context
- If tech stack is clear from context → use correct terminology and API names
- If previous assistant response contains relevant code → reference it by name

## Additional rules (hard constraints)

If the user message contains an "Additional rules to follow strictly" section, those rules are HARD CONSTRAINTS — you MUST enforce them in the rewritten prompt:
- Reflect every additional rule in the optimized prompt (e.g., if rule says "prefer TypeScript over JavaScript", the rewritten prompt must specify TypeScript)
- Do NOT ignore or weaken additional rules
- Do NOT add explanations about which rules were applied

## Forbidden

- Answer the prompt or provide a solution
- Write code (no code blocks, no triple backtick fences)
- Start with conversational openings: "Here is", "Below is", "I'll help", "Sure", "好的", "当然", "下面是", "以下是", "让我", "我来", "可以的", etc.
- Add explanations, markdown formatting, or quotes around output
- Translate the prompt
- Add pleasantries ("please", "kindly", "thanks")
- Over-expand a simple prompt
- Invent requirements not implied by context
- Remove technical details that were already specific`

// --- Context extraction ---

function extractContext(
  messages: any[],
  maxMessages: number,
  maxChars: number,
): string {
  const recent = messages.slice(-maxMessages)
  const parts: string[] = []
  for (const msg of recent) {
    const role = msg.role ?? msg.info?.role ?? "unknown"
    if (role === "system") continue
    const text = extractText(msg)
    if (!text) continue
    const label = role === "user" ? "User" : "Assistant"
    const truncated =
      text.length > maxChars ? text.slice(0, maxChars) + "..." : text
    parts.push(`[${label}]: ${truncated}`)
  }
  return parts.join("\n\n")
}

function extractText(msg: any): string {
  if (typeof msg.content === "string") return msg.content
  const parts = msg.parts ?? msg.info?.parts
  if (Array.isArray(parts)) {
    return parts
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("\n")
      .trim()
  }
  return ""
}

function normalizeResponse(response: any): any[] {
  if (response === null || response === undefined) return []
  if (Array.isArray(response)) return response
  if (typeof response === "object" && "data" in response) {
    const d = response.data
    if (d !== null && d !== undefined) return Array.isArray(d) ? d : [d]
  }
  return []
}

function extractLatestAssistantText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const role = m.role ?? m.info?.role
    if (role === "assistant") {
      const t = extractText(m)
      if (t) return t
    }
  }
  return null
}

// --- Rule matching ---

/**
 * Match the user's prompt against conditional rules and return the rules to inject.
 * Returns an array of rule strings. `default` is always included; patterns are
 * included when any of their `match` keywords appear in the prompt (case-insensitive
 * substring match). Multiple patterns can match simultaneously.
 */
export function matchRules(prompt: string, config: PolishConfig): string[] {
  const matched: string[] = []
  const rules = config.rules

  // Always include default rules
  if (Array.isArray(rules.default)) {
    for (const r of rules.default) {
      if (typeof r === "string" && r.trim()) matched.push(r.trim())
    }
  }

  // Match conditional patterns
  if (Array.isArray(rules.patterns)) {
    const lower = prompt.toLowerCase()
    for (const pattern of rules.patterns) {
      if (!pattern || !Array.isArray(pattern.match) || typeof pattern.rule !== "string") continue
      const hit = pattern.match.some((kw) => {
        if (typeof kw !== "string" || !kw) return false
        return lower.includes(kw.toLowerCase())
      })
      if (hit && pattern.rule.trim()) {
        matched.push(pattern.rule.trim())
      }
    }
  }

  return matched
}

// --- Output sanity check ---

/**
 * Detect whether the model's output looks like an answer to the user's
 * prompt rather than a rewritten version of it. Returns true if the output
 * appears to be answering instead of rewriting.
 *
 * Heuristics:
 *  - Empty output
 *  - Starts with common "helpful assistant" prefixes (English + Chinese)
 *  - Contains code fences (the model tried to write code)
 *  - Contains "I can help" / "希望能帮到" type assistant phrases
 */
export function looksLikeAnswer(text: string): boolean {
  const t = text.trim()
  if (!t) return true

  // Conversational / answer-mode openings
  const answerPrefixRe =
    /^(here('s| is)?\b|below\b|sure\b|of course\b|absolutely\b|certainly\b|i('ll| will| can)\b|let me\b|好的[，,。 ]?|当然[可以，,。 ]?|下面是|以下是|让我|我来|可以的|没问[题到]|当然可[以到])/i
  if (answerPrefixRe.test(t)) return true

  // Code fences — the model is trying to write code instead of rewriting the prompt
  if (/```/.test(t)) return true

  // "I can help" / "希望能帮到" style assistant pleasantries.
  // English phrases use \b; Chinese phrases don't (\b doesn't recognize CJK as word chars).
  const helpfulEnRe =
    /\b(i can help|i can assist|let me know|feel free to|here to help)\b/i
  const helpfulZhRe = /希望对[你您]有帮助|希望能帮[到助]/
  if (helpfulEnRe.test(t) || helpfulZhRe.test(t)) return true

  return false
}

// --- User message construction ---

function buildUserMessage(
  original: string,
  context: string,
  config: PolishConfig,
): string {
  const sections: string[] = []

  // Frame the raw prompt as data, not a request — the <raw_prompt> tags
  // create an explicit structural boundary that helps weaker models stay
  // in "transformer" mode instead of slipping into "assistant" mode.
  sections.push(`<raw_prompt>\n${original}\n</raw_prompt>`)

  if (context) {
    sections.push(`Recent conversation (for context):\n\n${context}`)
  }

  const matchedRules = matchRules(original, config)
  if (matchedRules.length > 0) {
    const rulesBlock = matchedRules.map((r) => `- ${r}`).join("\n")
    sections.push(`Additional rules to follow strictly (hard constraints):\n\n${rulesBlock}`)
  }

  sections.push(
    `Rewrite the prompt inside <raw_prompt> tags. Output ONLY the rewritten version — nothing else.`,
  )

  return sections.join("\n\n---\n\n")
}

// --- LLM call via OpenCode SDK ---

type PolishResult = { text: string; success: boolean; error?: string }

/**
 * Orchestrator: try V2 (hard JSON constraint) first, fall back to V1 (soft).
 * Receives the plugin `ctx` so it can build a V2 client against `ctx.serverUrl`.
 */
async function polishViaSDK(
  ctx: any,
  parentSessionId: string,
  sessionDirectory: string | undefined,
  original: string,
  context: string,
  config: PolishConfig,
): Promise<PolishResult> {
  const modelRef = parseModel(config.model)
  if (!modelRef) {
    return { text: original, success: false, error: `Invalid model format "${config.model}", expected "provider/model-id"` }
  }

  const userMsg = buildUserMessage(original, context, config)
  const v1Client: any = ctx.client

  // ── Path A: V2 SDK + format: json_schema (hard constraint) ──
  try {
    return await polishViaV2(ctx, parentSessionId, sessionDirectory, userMsg, modelRef, original)
  } catch (v2Err: any) {
    const v2Msg = v2Err?.message || String(v2Err)
    // V2 unavailable (server too old / no tool calling support / etc.) — fall back
    return await polishViaV1(v1Client, parentSessionId, sessionDirectory, userMsg, modelRef, original, v2Msg)
  }
}

/**
 * V2 path: server enforces JSON via virtual `StructuredOutput` tool + tool_choice:required.
 * The validated object is read directly from `info.structured` — no parsing needed.
 */
async function polishViaV2(
  ctx: any,
  parentSessionId: string,
  sessionDirectory: string | undefined,
  userMsg: string,
  modelRef: ModelRef,
  original: string,
): Promise<PolishResult> {
  const v2 = createOpencodeClient({ baseUrl: ctx.serverUrl.href })

  // 1. Create child session (top-level params, no body/query wrappers)
  const createResp = await v2.session.create({
    parentID: parentSessionId,
    title: "polish-compartment",
    ...(sessionDirectory ? { directory: sessionDirectory } : {}),
  })
  const childId: string | undefined = createResp?.data?.id
  if (!childId || typeof childId !== "string") {
    throw new Error("v2: failed to create child session")
  }

  // 2. Send prompt with hard JSON constraint
  const promptResp = await v2.session.prompt({
    sessionID: childId,
    agent: POLISH_AGENT,
    model: { providerID: modelRef.providerID, modelID: modelRef.modelID },
    parts: [{ type: "text", text: userMsg, synthetic: true }],
    format: {
      type: "json_schema",
      schema: POLISH_JSON_SCHEMA,
      retryCount: 3,
    },
    ...(sessionDirectory ? { directory: sessionDirectory } : {}),
  })

  // 3. Surface API errors (e.g. Insufficient balance)
  const info: any = promptResp?.data?.info
  if (info?.error) {
    const apiError = info.error
    throw new Error(`Model error: ${apiError.message || apiError.name || "unknown"}`)
  }

  // 4. Read validated structured output (server has already verified against schema)
  const rewritten = (info?.structured as { rewritten?: unknown } | undefined)?.rewritten
  if (typeof rewritten === "string" && rewritten.trim()) {
    return { text: rewritten.trim(), success: true }
  }

  // No structured output (very rare — model produced nothing usable)
  throw new Error("v2: info.structured.rewritten missing or empty")
}

/**
 * V1 path: v0.1.6 soft-constraint logic. Used only when V2 fails.
 * Includes the full extraction pipeline: promptResp → messages() → looksLikeAnswer.
 */
async function polishViaV1(
  client: any,
  parentSessionId: string,
  sessionDirectory: string | undefined,
  userMsg: string,
  modelRef: ModelRef,
  original: string,
  v2ErrorMsg: string,
): Promise<PolishResult> {
  try {
    // 1. Create child session
    const createResp = await client.session.create({
      body: {
        parentID: parentSessionId,
        title: "polish-compartment",
      },
      ...(sessionDirectory ? { query: { directory: sessionDirectory } } : {}),
    })

    const childSession =
      typeof createResp?.data === "object"
        ? createResp.data
        : Array.isArray(createResp)
          ? createResp
          : createResp
    const childId = childSession?.id
    if (!childId || typeof childId !== "string") {
      return { text: original, success: false, error: "Failed to create child session" }
    }

    // 2. Send prompt (no format field — soft constraint via system prompt)
    const promptResp = await client.session.prompt({
      path: { id: childId },
      ...(sessionDirectory ? { query: { directory: sessionDirectory } } : {}),
      body: {
        agent: POLISH_AGENT,
        model: modelRef,
        parts: [
          { type: "text", text: userMsg, synthetic: true },
        ],
      },
    })

    // 3. Check prompt response for model errors
    if (promptResp?.data?.info?.error) {
      const apiError = promptResp.data.info.error
      const msg = apiError.message || apiError.name || "Unknown model error"
      return { text: original, success: false, error: `Model error: ${msg}` }
    }

    // 4. Try extracting text from prompt response directly
    if (promptResp?.data) {
      const text = extractLatestAssistantText([{ info: promptResp.data.info, parts: promptResp.data.parts }])
      if (text) {
        if (looksLikeAnswer(text)) {
          return { text: original, success: false, error: "Model produced an answer instead of a rewrite. Try again or rephrase the prompt." }
        }
        return { text, success: true }
      }
    }

    // 5. Fallback: read messages from child session
    const messagesResponse = await client.session.messages({
      path: { id: childId },
      ...(sessionDirectory ? { query: { directory: sessionDirectory, limit: 50 } } : { query: { limit: 50 } }),
    })

    const messages = normalizeResponse(messagesResponse)

    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === "assistant" && messages[i]?.info?.error) {
        const apiError = messages[i].info.error
        const msg = apiError.message || apiError.name || "Unknown model error"
        return { text: original, success: false, error: `Model error: ${msg}` }
      }
    }

    const result = extractLatestAssistantText(messages)
    if (!result) {
      return { text: original, success: false, error: `No output from model (v2 path failed: ${v2ErrorMsg})` }
    }

    if (looksLikeAnswer(result)) {
      return { text: original, success: false, error: "Model produced an answer instead of a rewrite. Try again or rephrase the prompt." }
    }

    return { text: result, success: true }
  } catch (err: any) {
    const msg = err?.message || String(err)
    return { text: original, success: false, error: `SDK error: ${msg} (v2 path failed: ${v2ErrorMsg})` }
  }
}

// --- Plugin ---

const server: Plugin = async (ctx) => {

  return {
    config: async (cfg) => {
      cfg.command ??= {}
      cfg.command["polish"] = {
        template: "<prompt>",
        description: "AI-optimize your prompt using conversation context. Result fills the input box without auto-sending.",
      }
      cfg.command["polish-send"] = {
        template: "<prompt>",
        description: "AI-optimize your prompt using conversation context. Result fills and auto-submits.",
      }
      // Register polish agent: hidden subagent with no tools, max 1 step
      cfg.agent ??= {}
      cfg.agent[POLISH_AGENT] = {
        prompt: POLISH_SYSTEM_PROMPT,
        tools: {},
        maxSteps: 1,
        permission: {
          edit: "deny",
          bash: "deny",
          webfetch: "deny",
          doom_loop: "deny",
          external_directory: "deny",
        },
        mode: "subagent",
        hidden: true,
      }
    },

    "command.execute.before": async (input, output) => {
      // Shared polish logic
      const runPolish = async (original: string, autoSend: boolean) => {
        // Reload config on every invocation for hot-reload
        const config = loadConfig()
        try {
          // Show loading state
          await ctx.client.tui.clearPrompt({})
          await ctx.client.tui.appendPrompt({
            body: { text: "⏳ 正在优化提示词..." },
          })

          // Fetch conversation context
          let context = ""
          try {
            const resp = await ctx.client.session.messages({
              path: { id: input.sessionID },
            })
            const msgs = normalizeResponse(resp)
            if (Array.isArray(msgs) && msgs.length > 0) {
              context = extractContext(
                msgs,
                config.context.maxMessages,
                config.context.maxCharsPerMessage,
              )
            }
          } catch {
            // no context — polish without it
          }

          // Polish via OpenCode SDK (V2 first, V1 fallback)
          const result = await polishViaSDK(
            ctx,
            input.sessionID,
            undefined,
            original,
            context,
            config,
          )

          // Put result in input box
          const finalText = result.success ? result.text : original

          await ctx.client.tui.clearPrompt({})
          await ctx.client.tui.appendPrompt({ body: { text: finalText } })

          if (autoSend) {
            await ctx.client.tui.submitPrompt({})
          } else if (result.success) {
            await ctx.client.tui.showToast({
              body: {
                title: "Polish Ready",
                message: "Optimized prompt loaded. Press Enter to send, or edit first.",
                variant: "info",
                duration: 3000,
              },
            })
          } else {
            await ctx.client.tui.showToast({
              body: {
                title: "Polish Failed",
                message: result.error || "Could not optimize prompt, loaded original instead.",
                variant: "error",
                duration: 5000,
              },
            })
          }
        } catch (err) {
          // Fallback: load original into input box
          try {
            await ctx.client.tui.clearPrompt({})
            await ctx.client.tui.appendPrompt({ body: { text: original } })
            if (autoSend) await ctx.client.tui.submitPrompt({})
          } catch {
            // Last resort
          }
        }
      }

      // --- /polish ---
      if (input.command === "polish") {
        const original = (input.arguments || "").trim()
        if (!original) {
          throw new Error(
            "Usage: /polish <prompt>\n\nExample: /polish 帮我写个函数",
          )
        }
        runPolish(original, false)
        throw new Error("__POLISH_HANDLED__")
      }

      // --- /polish-send ---
      if (input.command === "polish-send") {
        const original = (input.arguments || "").trim()
        if (!original) {
          throw new Error(
            "Usage: /polish-send <prompt>\n\nExample: /polish-send 帮我写个函数",
          )
        }
        runPolish(original, true)
        throw new Error("__POLISH_HANDLED__")
      }
    },
  }
}

export default server
