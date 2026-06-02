import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

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

- Output a single raw JSON object with exactly one field. Nothing else — no preamble, no trailing text, no code blocks, no markdown:
  {"rewritten": "<the optimized prompt>"}
- The "rewritten" field contains the polished prompt — not code, not an answer, not a meta-commentary
- Preserve language: Chinese in Chinese, English in English, technical terms in English
- Preserve user's original intent completely
- If the prompt is already clear and complete, return it unchanged

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

- Output anything other than the raw JSON object
- Wrap output in code blocks, quotes, or markdown
- Add conversational openings before or after the JSON ("Here is", "下面是", "提示词如下", etc.)
- Put a conversational opening inside the "rewritten" field value
- Answer the prompt or provide a solution
- Write code
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

// --- Output extraction ---

/**
 * Extract the "rewritten" field from the model's JSON output.
 * Returns null if no valid JSON object with a string "rewritten" field is found.
 *
 * Tries three strategies in order:
 *  1. Direct JSON.parse on the trimmed text
 *  2. JSON inside a ```json``` (or ```) code block
 *  3. A balanced `{...}` object anywhere in the text
 */
export function extractRewritten(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  // 1. Direct JSON parse
  try {
    const obj = JSON.parse(trimmed)
    if (isRewrittenField(obj)) return obj.rewritten
  } catch {
    // not pure JSON, continue
  }

  // 2. JSON inside a code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      const obj = JSON.parse(codeBlockMatch[1].trim())
      if (isRewrittenField(obj)) return obj.rewritten
    } catch {
      // not valid JSON in code block, continue
    }
  }

  // 3. Find a balanced {...} object in the text
  const objStr = findBalancedJsonObject(trimmed)
  if (objStr) {
    try {
      const obj = JSON.parse(objStr)
      if (isRewrittenField(obj)) return obj.rewritten
    } catch {
      // not valid JSON, give up
    }
  }

  return null
}

function isRewrittenField(obj: unknown): obj is { rewritten: string } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof (obj as Record<string, unknown>).rewritten === "string"
  )
}

/**
 * Find the first balanced JSON object `{...}` in the text, respecting string
 * boundaries so that braces inside string values don't break the scan.
 * Returns the substring or null.
 */
function findBalancedJsonObject(text: string): string | null {
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === "{") {
      if (depth === 0) start = i
      depth++
    } else if (c === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        return text.slice(start, i + 1)
      }
    }
  }
  return null
}

/**
 * Strip common "here's the optimized prompt:" style preambles from the start
 * of the text. The model sometimes outputs these inside the JSON string value
 * even when instructed not to. Returns the cleaned text.
 */
export function stripPreamble(text: string): string {
  const patterns: RegExp[] = [
    // English
    /^here'?s?\s+(?:the|your)\s+(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
    /^here\s+is\s+(?:the\s+)?(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
    /^(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
    // Chinese
    /^优化[后过]?[的]?提示[词语][：:]?\s*/,
    /^重写[后过]?[的]?提示[词语][：:]?\s*/,
    /^优化[后过]?[的]?版本[：:]?\s*/,
    /^重写[后过]?[的]?版本[：:]?\s*/,
    /^提示词如下[：:]?\s*/,
    /^以下是?(?:优化[后过]?[的]?|重写[后过]?[的]?)?(?:提示[词语]|版本)[：:]?\s*/,
  ]
  let result = text.trim()
  for (const re of patterns) {
    result = result.replace(re, "")
  }
  return result.trim()
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

async function polishViaSDK(
  client: any,
  parentSessionId: string,
  sessionDirectory: string | undefined,
  original: string,
  context: string,
  config: PolishConfig,
): Promise<{ text: string; success: boolean; error?: string }> {
  const modelRef = parseModel(config.model)
  if (!modelRef) {
    return { text: original, success: false, error: `Invalid model format "${config.model}", expected "provider/model-id"` }
  }

  const userMsg = buildUserMessage(original, context, config)

  try {
    // 1. Create child session (same pattern as magic-context historian)
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

    // 2. Send prompt to child session with polish agent (no tools)
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
        const out = applyExtractionPipeline(text, original)
        if (out !== null) return out
      }
    }

    // 5. Fallback: read messages from child session
    const messagesResponse = await client.session.messages({
      path: { id: childId },
      ...(sessionDirectory ? { query: { directory: sessionDirectory, limit: 50 } } : { query: { limit: 50 } }),
    })

    const messages = normalizeResponse(messagesResponse)

    // Check for errors in assistant messages
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.info?.role === "assistant" && messages[i]?.info?.error) {
        const apiError = messages[i].info.error
        const msg = apiError.message || apiError.name || "Unknown model error"
        return { text: original, success: false, error: `Model error: ${msg}` }
      }
    }

    const result = extractLatestAssistantText(messages)
    if (!result) {
      return { text: original, success: false, error: "No output from model" }
    }

    const out = applyExtractionPipeline(result, original)
    if (out !== null) return out
    return { text: original, success: false, error: "Model output could not be parsed. Try again." }
  } catch (err: any) {
    const msg = err?.message || String(err)
    return { text: original, success: false, error: `SDK error: ${msg}` }
  }
}

/**
 * Apply the layered extraction pipeline to the model's raw output.
 * Returns the polish result on success, or null if extraction failed
 * (caller decides whether to retry/fail/propagate error).
 */
function applyExtractionPipeline(
  raw: string,
  original: string,
): { text: string; success: boolean; error?: string } | null {
  // Layer 1-3: JSON extraction (direct / code block / balanced scan)
  const rewritten = extractRewritten(raw)
  if (rewritten !== null) {
    const cleaned = stripPreamble(rewritten)
    if (!cleaned) return null  // empty "rewritten" field — let caller fail
    if (looksLikeAnswer(cleaned)) {
      return {
        text: original,
        success: false,
        error: "Model produced an answer instead of a rewrite. Try again or rephrase the prompt.",
      }
    }
    return { text: cleaned, success: true }
  }

  // Layer 4: JSON failed, try stripping preamble from raw text
  const stripped = stripPreamble(raw)
  if (stripped && stripped !== raw.trim() && !looksLikeAnswer(stripped)) {
    return { text: stripped, success: true }
  }

  // Layer 5: looksLikeAnswer on raw text (last chance)
  if (looksLikeAnswer(raw)) {
    return {
      text: original,
      success: false,
      error: "Model produced an answer instead of a rewrite. Try again or rephrase the prompt.",
    }
  }

  // Final fallback: use raw text as-is (model gave a rewrite but in unexpected format)
  const trimmed = raw.trim()
  if (trimmed) return { text: trimmed, success: true }

  return null
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

          // Polish via OpenCode SDK
          const result = await polishViaSDK(
            ctx.client,
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
