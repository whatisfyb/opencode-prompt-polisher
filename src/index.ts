import type { Plugin } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// --- Config ---

interface PolishConfig {
  model: string
  context: { maxMessages: number; maxCharsPerMessage: number }
  intensity: "light" | "medium" | "heavy"
}

const DEFAULT_CONFIG: PolishConfig = {
  model: "opencode/deepseek-v4-flash-free",
  context: { maxMessages: 6, maxCharsPerMessage: 500 },
  intensity: "medium",
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

const POLISH_SYSTEM_PROMPT = `You are a prompt optimization assistant. Your ONLY job is to rewrite the given prompt to be clearer and more effective for an AI coding agent.

## Process

First, analyze the original prompt silently (do NOT output your analysis):
1. What is vague or ambiguous? What assumptions are left implicit?
2. What constraints or format expectations are missing?
3. What context from the recent conversation (if provided) should be injected — file names, variable names, error messages, tech stack?
4. Could a simple request be over-expanded? Is the original already clear enough?

Then, output ONLY the optimized prompt based on your analysis.

## Output constraints

- You MUST NOT attempt to fulfill or answer the prompt yourself
- You MUST NOT write code, execute commands, or use any tools
- You MUST NOT provide explanations, analysis, or solutions
- You MUST output ONLY the rewritten prompt — no analysis, no commentary, no markdown, no quotes
- Do NOT wrap output in quotes, code blocks, or any formatting

## Rewrite rules

- Preserve the user's original intent completely
- Make vague requests specific, implicit requirements explicit
- Keep the same language (Chinese stays Chinese, English stays English, technical terms stay English)
- Be concise — don't over-expand a simple prompt
- If the prompt is already clear and complete, return it as-is

## Context utilization

When conversation context is provided:
- If user mentions a file/variable/function earlier → inject the exact name into the prompt
- If there's an active task or error → reference it explicitly with details from context
- If tech stack is clear from context → use correct terminology and API names
- If previous assistant response contains relevant code → reference it by name

## Forbidden

- Translate the prompt to another language
- Change the tone or add pleasantries ("please", "kindly", "thanks")
- Add explanations, markdown formatting, or quotes around output
- Over-expand simple requests (e.g. "fix typo" → don't write a paragraph)
- Invent requirements not implied by context
- Remove technical details that were already specific
- Answer the prompt or provide a solution`

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

// --- LLM call via OpenCode SDK ---

async function polishViaSDK(
  client: any,
  parentSessionId: string,
  sessionDirectory: string | undefined,
  original: string,
  context: string,
  config: PolishConfig,
): Promise<{ text: string; success: boolean }> {
  const modelRef = parseModel(config.model)
  if (!modelRef) {
    console.error(
      `[polish] invalid model format "${config.model}", expected "provider/model-id"`,
    )
    return { text: original, success: false }
  }

  const userMsg = context
    ? `Recent conversation:\n\n${context}\n\n---\n\nOptimize this prompt:\n\n${original}`
    : `Optimize this prompt:\n\n${original}`

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
      console.error("[polish] failed to create child session")
      return { text: original, success: false }
    }

    // 2. Send prompt to child session with polish agent (no tools)
    await client.session.prompt({
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

    // 3. Read child session messages to extract assistant response
    const messagesResponse = await client.session.messages({
      path: { id: childId },
      ...(sessionDirectory ? { query: { directory: sessionDirectory, limit: 50 } } : { query: { limit: 50 } }),
    })

    // Normalize: SDK may return { data: [...] } or [...]
    const messages = normalizeResponse(messagesResponse)
    const result = extractLatestAssistantText(messages)
    if (!result) {
      console.error("[polish] child session returned no assistant output")
      return { text: original, success: false }
    }

    return { text: result, success: true }
  } catch (err) {
    console.error("[polish] SDK call failed:", err)
    return { text: original, success: false }
  }
}

// --- Plugin ---

const server: Plugin = async (ctx) => {
  // Load config once at startup
  const config = loadConfig()

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
            const msgs = resp.data ?? resp
            if (Array.isArray(msgs)) {
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
                message:
                  "Could not optimize prompt, loaded original instead.",
                variant: "warning",
                duration: 3000,
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
