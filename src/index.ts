import { readFileSync, existsSync, appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

/** Module-level mutex: prevents concurrent /polish invocations from racing
 * on session prompt operations (which would result in duplicate sends or
 * context being read mid-flight). */
let isPolishing = false

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
        // Strip JSONC comments (line + block) while preserving `//` and `/*`
        // when they appear inside string literals — a regex-based strip
        // would silently truncate rule strings like "Prefer TS // strict".
        const cleaned = stripJsoncComments(raw)
        const parsed = JSON.parse(cleaned)
        return {
          model: parsed.model ?? DEFAULT_CONFIG.model,
          context: {
            maxMessages:
              parsed.context?.maxMessages ??
              DEFAULT_CONFIG.context.maxMessages,
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

/**
 * Remove `//` line and `/* *\/` block comments from a JSONC string while
 * preserving these tokens when they appear inside string literals. Also
 * honors backslash-escaped quotes inside strings.
 *
 * Exported for unit testing — see tests/match-rules.test.mjs.
 */
export function stripJsoncComments(input: string): string {
  let out = ""
  let i = 0
  let inString = false
  let escape = false
  const n = input.length
  while (i < n) {
    const c = input[i]!
    const next = input[i + 1]
    if (inString) {
      out += c
      if (escape) {
        escape = false
      } else if (c === "\\") {
        escape = true
      } else if (c === '"') {
        inString = false
      }
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && next === "/") {
      // line comment — skip to (but keep) the newline
      while (i < n && input[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      // block comment — skip past closing */
      i += 2
      while (i < n - 1 && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// --- Model parsing ---

interface ModelRef {
  providerID: string
  modelID: string
}

/** Parse "provider/model-id" into a V2 model ref. Any provider id is valid —
 * e.g. "opencode/deepseek-v4-flash-free" or a local "llama-server/small-model". */
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

/** Assistant messages that are session-protocol dumps must never reach the
 *  rewrite model: it copies their FORMAT instead of transforming the prompt.
 *  Observed 2026-10-02 — asked to rewrite "who is taylor swift?", the polish
 *  agent answered the question and wrapped the answer in "Findings: /tmp/… +
 *  TASK COMPLETE", imitating the surrounding session's assistant messages. The
 *  looksLikeLeak guard then correctly rejected the result, but the run was lost.
 *  The cure is upstream of the guard: never feed the model a format to copy. */
function looksLikeSessionDump(text: string): boolean {
  if (/\/tmp\/opencode\//i.test(text)) return true
  if (/^findings:/im.test(text)) return true
  if (/TASK COMPLETE/i.test(text)) return true
  if (/"todos"\s*:/.test(text)) return true
  if (/^#{1,3}\s+\S/m.test(text)) return true
  // Plugin outputs echoed back as user turns (observed 2026-10-03: a pasted
  // `/todo` report and pasted `/polish` deliveries sat in context while
  // polishing "give cookie", and the rewrite came back carrying an unrelated
  // todo). A rewrite never needs another command's output as context.
  // Line-anchored like the frame strip: a turn that merely MENTIONS the
  // phrase mid-line is conversation, not chrome.
  if (/^todo\s+\[\d+\/\d+\]/im.test(text)) return true
  if (/^copy to use\b/im.test(text)) return true
  return false
}

export function extractContext(
  messages: any[],
  maxMessages: number,
  maxChars: number,
): string {
  // Scan a wider window than we keep. In a noisy session most recent messages
  // are assistant dumps, so slicing to maxMessages first starves the context of
  // the user's own asks — which are the only thing a prompt rewriter needs.
  const recent = messages.slice(-(maxMessages * 4))
  const kept: string[] = []
  for (const msg of recent) {
    // V2 messages discriminate on `type` ("user" | "assistant" | "system" | ...),
    // not `role`. Legacy V1 shapes ({info:{role}}) still fall through below.
    const kind = msg.type ?? msg.role ?? msg.info?.role ?? "unknown"
    if (kind === "system") continue
    // Command echoes and plugin notices are harness protocol, not conversation.
    if (kind === "synthetic") continue
    // Assistant messages are dropped ENTIRELY, not pattern-filtered.
    //
    // A rewriter needs the user's asks; assistant turns are never input to a
    // rewrite. Worse, they are the leak vector: this session's assistant turns
    // ("58/58 tests pass, committed a9a3da3", "The log is decisive, and it says
    // my fix is still wrong:") sailed past `looksLikeSessionDump` because none
    // of its patterns match ordinary prose, and the polish agent then copied the
    // shape — emitting "Findings: /tmp/..." and a "Proposed rewrite — for your
    // review only" wrapper instead of the prompt. A denylist loses to prose it
    // has not seen; dropping the whole class cannot lose.
    if (kind !== "user") continue
    const text = extractText(msg)
    if (!text) continue
    // Raw `/polish` invocations are not rewrite input. Observed 2026-10-03:
    // polishing "sing proud to be an american" returned "sing proud be an
    // american" — a PREVIOUS polish attempt, echoed verbatim from history
    // instead of rewritten. The command text steers nothing; it only offers
    // itself up for copying.
    if (/^\/(polish|polish-send)\b/i.test(text.trim())) continue
    if (looksLikeSessionDump(text)) continue
    const truncated =
      text.length > maxChars ? text.slice(0, maxChars) + "..." : text
    kept.push(`[User]: ${truncated}`)
  }
  // Keep the MOST RECENT maxMessages, not the first ones found in the scan
  // window. The window is 4x wider than the budget on purpose: interleaved
  // non-user turns get skipped, so the turns that survive must be the latest
  // ones, otherwise a session that opened with "explain X" silently steers a
  // rewrite of "fix that bug" from twenty messages ago.
  return kept.slice(-maxMessages).join("\n\n")
}

export function extractText(msg: any): string {
  // V2 user/synthetic messages carry a plain `text` string.
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text
  // V2 assistant messages carry `content: [{type:"text", text}, ...]`.
  const content = msg.content
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text as string)
      .join("\n")
      .trim()
  }
  if (typeof content === "string") return content
  // Legacy fallbacks (V1 shapes).
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

/**
 * Strip model thinking traces from output. Some models wrap chain-of-thought
 * in paired tags even when thinking is disabled server-side (observed
 * 2026-10-02: a full trace leaked into a polish rewrite). Removes complete
 * pairs with their content; a dangling opener truncates everything after it.
 * Returns the trimmed remainder (possibly empty — callers treat that as no
 * output and fall back to the original prompt).
 */
export function cleanThinking(text: string): string {
  let out = text
  // Angle and square variants, including mixed open/close (observed both).
  out = out.replace(/[[<]thinking[\]>][\s\S]*?[[/<]\/thinking[\]>]/gi, "")
  out = out.replace(/[[<]think[\]>][\s\S]*?[[/<]\/think[\]>]/gi, "")
  const openIdx = out.search(/[[<]thinking[\]>]|[[<]think[\]>]/i)
  if (openIdx >= 0) out = out.slice(0, openIdx)
  return out.trim()
}

/**
 * Strip the <raw_prompt> framing tags when the model echoes them into its
 * output (observed 2026-10-02: rewrite wrapped in the boundary tags from the
 * request). Case-insensitive; trims the remainder.
 */
export function cleanWrapperTags(text: string): string {
  let out = text
  if (/raw_prompt/i.test(out)) {
    out = out.replace(/<\/?raw_prompt>/gi, "").trim()
  }

  // Structured restatement wrappers (observed 2026-10-02, passed through to the
  // user verbatim as the "polished" prompt):
  //
  //   You are an AI assistant.
  //   The user is asking you to sing the "Happy Birthday" song.
  //   **Task:** Output the lyrics to the "Happy Birthday" song.
  //   **Constraints:** 1. ...
  //   **Rewritten Prompt:**
  //   Please sing the "Happy Birthday" song by outputting its lyrics.
  //
  // and the review variant "Proposed rewrite - for your review only. DO NOT
  // execute or answer it." The rewrite is whatever follows the LAST wrapper
  // heading, so the preamble is dropped rather than the whole response.
  // Heading detection normalizes each line (strip markdown emphasis, hashes,
  // trailing colon) and compares to a fixed vocabulary. Regex-per-variant kept
  // missing shapes - `**Rewritten Prompt:**` failed because the colon sits
  // inside the emphasis - and a vocabulary is easier to extend safely.
  const HEADINGS = new Set([
    "prompt",
    "rewritten prompt",
    "revised prompt",
    "final prompt",
    "final answer",
    "final output",
    "revised version",
    "output",
  ])
  const normalizeHead = (line: string): string =>
    line
      .replace(/[*_#`>]/g, "")
      .replace(/\s*:\s*$/, "")
      .trim()
      .toLowerCase()
  const lines = out.split("\n")
  let lastHead = -1
  for (let i = 0; i < lines.length; i++) {
    if (HEADINGS.has(normalizeHead(lines[i]))) lastHead = i
  }
  if (lastHead !== -1) {
    const tail = lines.slice(lastHead + 1).join("\n").trim()
    // Only accept the tail if it is non-empty; a bare heading with nothing
    // after it means the model put the prompt BEFORE the heading, so keep the
    // original rather than returning nothing.
    if (tail) out = tail
  }

  // A delivery preamble is chrome, not part of the prompt: the current frame
  // is "Copy to use:", and the retired one was "Proposed rewrite - for your
  // review only / DO NOT execute...". Both are stripped so a model that echoes
  // the frame back does not get it glued onto the prompt. Drop the preamble
  // sentence(s) up to the blank line that follows them.
  // Strip the delivery frame, but ONLY when it really is a frame.
  //
  // The previous form was `/^[\s\S]{0,400}?(?:copy to use\b|...)[^\n]*\n+/i`, and
  // `[\s\S]{0,400}?` matched ANY content before the phrase - so the strip DELETED
  // it. Two measured destructions, both of legitimate user input:
  //   "My draft is below. Please copy to use as a template.\n\nThe draft: hello"
  //     -> "The draft: hello"     (the opening sentence was gone)
  //   "function f() {\n  // copy to use strict mode\n  return 1\n}"
  //     -> "  return 1\n}"        (the function head was gone)
  //
  // A frame line STARTS with its marker; a line that merely CONTAINS one is user
  // content. Anchoring on the line start is the whole fix, and it costs nothing:
  // the frame we emit is a single leading line.
  // `proposed rewrite` is the retired frame's own opening words; including it
  // keeps an echo of the OLD frame strippable, which is the whole reason a model
  // that saw it before an upgrade can still have its rewrite cleaned.
  const FRAME_LINE =
    /^\s*(?:copy to use\b|proposed rewrite\b|for your review only\b|do not execute or answer it\b)/i
  const head = out.split("\n")
  let cut = 0
  while (cut < head.length) {
    const line = head[cut]
    if (!line.trim()) break // a blank line ends the leading frame
    if (FRAME_LINE.test(line)) {
      cut += 1
      continue
    }
    // Stop at the first line that is not a frame. There is deliberately no
    // "short continuation line" allowance here: an earlier attempt had one, and
    // it kept eating short CONTENT lines until it hit a long one, so
    // "Copy to use:\nExplain the bug." came back empty. Both the frame we ship
    // and the retired one are a single line, so the allowance bought nothing and
    // cost a prompt.
    break
  }
  if (cut > 0) out = head.slice(cut).join("\n")
  return out.trim()
}
/**
 * Remove markdown code fences, keeping the inner content. Models often wrap
 * an otherwise good rewrite in ``` fences despite instructions (observed
 * 2026-10-02: a one-line rewrite rejected as "an answer" only because of
 * fences). Stripping recovers it; the inner text still passes through the
 * answer/leak guards downstream. Empty remainder means no usable output.
 */
export function cleanFences(text: string): string {
  if (!text.includes("`")) return text
  return text
    .replace(/```[\w+-]*[ \t]*\r?\n?/g, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .trim()
}

export function extractLatestAssistantText(messages: any[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // V2 uses `type: "assistant"`; keep the legacy `role` fallback.
    const kind = m.type ?? m.role ?? m.info?.role
    if (kind === "assistant") {
      const t = cleanWrapperTags(cleanFences(cleanThinking(extractText(m))))
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
/**
 * Reject output that has collapsed into a repetition loop.
 *
 * Observed 2026-10-02: the rewrite model returned 2111 words of which only 227
 * were unique (ratio 0.108), with a single 20-word span repeated 10 times, all
 * of it wrapped in a self-invented "Proposed rewrite - for your review only"
 * preamble. None of that is a prompt rewrite, but it sailed past looksLikeAnswer
 * and looksLikeLeak: the loop was long enough to look like an essay and the
 * preamble was not session protocol.
 *
 * Two independent signals, either sufficient:
 *  - unique-word ratio below the floor. Real prompts, even wordy ones, sit well
 *    above it; a loop collapses it. Measured floor is 0.35, which is far above
 *    the observed 0.108 and far below any sane rewrite.
 *  - the same 20-word span occurring three or more times.
 *
 * Length alone is NOT a signal: a legitimately detailed prompt can be long, and
 * rejecting on length would throw away good rewrites.
 */
export function looksDegenerate(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length < 40) return false // too short to judge; short prompts are fine
  const uniqueRatio = new Set(words.map((w) => w.toLowerCase())).size / words.length
  if (uniqueRatio < 0.35) return true
  const spans = new Map<string, number>()
  const SPAN = 20
  for (let i = 0; i <= words.length - SPAN; i++) {
    const key = words.slice(i, i + SPAN).join(" ").toLowerCase()
    const n = (spans.get(key) ?? 0) + 1
    if (n >= 3) return true
    spans.set(key, n)
  }
  return false
}

export function looksLikeAnswer(text: string): boolean {
  const t = text.trim()
  if (!t) return true

  // Conversational / answer-mode openings. The (’s| is) after "here" is
  // MANDATORY: bare "Here are ..." is legitimate rewrite language (a false
  // positive rejected a good rewrite 2026-10-02).
  const answerPrefixRe =
    /^(here('s| is)\b|below\b|sure\b|of course\b|absolutely\b|certainly\b|i('ll| will| can)\b|let me\b|好的[，,。 ]?|当然[可以，,。 ]?|下面是|以下是|让我|我来|可以的|没问[题到]|当然可[以到])/i
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

/**
 * Detect session-protocol leakage: the polish model echoing harness artifacts
 * (findings-file lines, task markers, tool JSON) instead of rewriting the
 * prompt. Observed 2026-10-02: context saturated with `/tmp/opencode/*`
 * chatter led small-model to emit "Findings: /tmp/opencode/....md" as the
 * "rewrite". Returns true when the output looks like protocol, not a prompt.
 */
export function looksLikeLeak(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (/\/tmp\/opencode\//i.test(t)) return true
  if (/^findings:/im.test(t)) return true
  if (/TASK COMPLETE/i.test(t)) return true
  if (/"todos"\s*:/.test(t)) return true
  if (/^```/m.test(t)) return true
  return false
}

/**
 * Detect a model refusal to rewrite: noisy input ("sing tinkle START",
 * observed 2026-10-03) makes the model punt with "Do not perform any action
 * or provide a response." instead of a rewrite, and no other guard catches
 * it — so the refusal shipped as the polished prompt.
 *
 * Deliberately opening-anchored: a legitimate rewrite may CONTAIN
 * constraints ("do not reveal the key"), but a rewrite that OPENS as a
 * refusal to act is not a rewrite at all.
 */
export function looksLikeRefusal(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return /^(do not perform any action|do nothing|take no action|no action\b|i cannot comply|i can'?t comply|i am unable|i'?m unable|unable to comply|unable to process|cannot process this)\b/i.test(t)
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
    `Rewrite the prompt inside <raw_prompt> tags. Output ONLY the rewritten version — nothing else. Do not output file paths, task lists, checklists, status reports, or tool calls — only the rewritten prompt text.`,
  )

  return sections.join("\n\n---\n\n")
}

// --- LLM call via the V2 plugin context ---

type PolishResult = { text: string; success: boolean; error?: string }

/**
 * V2 port: the plugin context IS the server client, so no separate client
 * construction is needed. The flow is a single child session ("polish
 * compartment"):
 *
 *   1. session.create  — hidden child session with the polish agent + config
 *                        model and a tool-less permission deny-list
 *   2. session.prompt  — the user message (raw prompt + context + rules)
 *   3. session.wait    — block until the agent finishes
 *   4. session.context — read messages; the latest assistant text IS the
 *                        rewritten prompt (the V1 hard-JSON schema field
 *                        was a V1-SDK-era API and is not part of the V2
 *                        prompt input, so extraction is from plain text)
 *
 * The hidden polish agent enforces the no-tools behavior (V2 agents have no
 * `tools: {}` key — capability denial happens via `permissions` deny rules
 * and `steps: 1`, which also bounds the agent loop to a single model call).
 */
/** Append one line to the plugin's diagnostic log. Never throws. */
function logPolish(msg: string): void {
  try {
    appendFileSync(join("/tmp", "opencode", "polish_cleanup.log"), msg + "\n")
  } catch {
    // diagnostics must never break the plugin
  }
}

/** Run the guards over a raw rewrite and shape the result.
 *
 *  Shared by both call paths (stateless generate and the legacy compartment) so
 *  the acceptance criteria cannot drift between them.
 */
export function finishRewrite(original: string, raw: string | null): PolishResult {
  const cleaned = raw ? cleanWrapperTags(cleanFences(cleanThinking(raw))) : ""
  const result = cleaned.trim() ? cleaned : null
  if (!result) {
    return { text: original, success: false, error: "No output from model" }
  }
  if (looksLikeAnswer(result)) {
    return { text: original, success: false, error: "Model produced an answer instead of a rewrite. Try again or rephrase the prompt." }
  }
  if (looksLikeLeak(result)) {
    return { text: original, success: false, error: "Model echoed session protocol instead of rewriting. Try again (a less noisy session helps) or rephrase the prompt." }
  }
  if (looksLikeRefusal(result)) {
    return { text: original, success: false, error: "Model refused to rewrite instead of rewriting. Try rephrasing the prompt." }
  }
  if (looksDegenerate(result)) {
    return { text: original, success: false, error: "Model output was degenerate (repetition loop) instead of a rewrite. Try rephrasing the prompt." }
  }
  if (looksLikeRestatement(original, result)) {
    return { text: original, success: false, error: "Model restated the instruction instead of rewriting it. Try rephrasing the prompt." }
  }
  return { text: result, success: true }
}

/** Compose the prompt for the stateless path.
 *
 *  ctx.generate.text accepts only {prompt, model} - there is no system-prompt
 *  field - so the system instructions must be carried inline. Omitting them was
 *  a regression: the compartment path ran the hidden `polish` agent, whose
 *  system prompt is POLISH_SYSTEM_PROMPT (assigned at agent registration), so
 *  the model had "You are a text transformation function, not an AI assistant"
 *  before this point and does NOT have it now. Without them the model degraded
 *  to restating the instruction instead of rewriting it -
 *  'Rewrite the following instruction clearly and completely: "Sing the song
 *  Twinkle Twinkle Little Star."' - which is not a rewrite at all.
 */
/** Reject a rewrite that merely restates the instruction instead of doing it.
 *
 *  Observed 2026-10-03 on input `Sing the song Twinkle Twinkle Little Star.`:
 *  the model returned
 *      Rewrite the following instruction clearly and completely: "Sing the song
 *      Twinkle Twinkle Little Star."
 *  which is an instruction to rewrite, not a rewrite. looksLikeAnswer does not
 *  match it (it is not an answer) and looksLikeDegenerate does not (it is
 *  short), so it was delivered as a successful polish.
 *
 *  Deliberately narrow, because "rewrite X" is a legitimate thing for a user to
 *  ask for: BOTH conditions must hold - the output opens with a meta-imperative
 *  about transforming the input, AND it quotes the original prompt verbatim.
 *  A real rewrite that happens to share a phrase with the original fails neither.
 */
export function looksLikeRestatement(original: string, text: string): boolean {
  const t = text.trim()
  if (!/^(please\s+)?(rewrite|rephrase|paraphrase|reword|translate|summari[sz]e|expand|shorten)\b/i.test(t)) {
    return false
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.!?,;:"'`]/g, "").trim()
  const quoted = t.match(/["“']([^"”']{12,})["”']/)
  const candidate = norm(quoted ? quoted[1] : t)
  const o = norm(original)
  return o.length >= 12 && (candidate === o || candidate.includes(o))
}

export function buildGeneratePrompt(userMsg: string): string {
  return `${POLISH_SYSTEM_PROMPT}\n\n---\n\n${userMsg}`
}

/**
 * Stateless rewrite via ctx.generate.text.
 *
 * This is the path that fixes what the user actually saw. The compartment
 * approach creates a real child session, so the rewrite model streams its
 * output into a session that renders in the UI - a page of degenerate rambling
 * appeared in front of the user before any guard could run, even with the
 * degeneracy guard live. Nothing about the guards can help: they decide what is
 * DELIVERED, not what is rendered while the model is still writing.
 *
 * ctx.generate.text is a plain POST to /api/experimental/generate with
 * {prompt, model} (read out of the opencode binary's route table), so no
 * session exists, nothing renders, and there is nothing to clean up.
 */
async function polishViaGenerate(
  ctx: any,
  modelRef: { providerID: string; modelID: string },
  userMsg: string,
  original: string,
): Promise<PolishResult | null> {
  const gen = ctx?.generate?.text
  if (typeof gen !== "function") return null
  try {
    const resp: any = await gen({
      prompt: buildGeneratePrompt(userMsg),
      model: { providerID: modelRef.providerID, id: modelRef.modelID },
    })
    if (resp?.error) {
      logPolish(`GEN-ERR ${JSON.stringify(resp.error).slice(0, 200)}`)
      return null
    }
    // The RPC layer unwraps to the handler's return value, which the binary
    // shows as {text}. Tolerate the other plausible shapes rather than assume.
    const raw =
      typeof resp === "string"
        ? resp
        : resp?.text ?? resp?.data?.text ?? resp?.content ?? null
    if (typeof raw !== "string" || !raw.trim()) {
      logPolish(`GEN-SHAPE keys=${Object.keys(resp ?? {}).join(",") || typeof resp}`)
      return null
    }
    logPolish(`GEN-OK ${raw.length} chars: ${raw.slice(0, 160).replace(/\s+/g, " ")}`)
    return finishRewrite(original, raw)
  } catch (err) {
    logPolish(`GEN-THREW ${(err as Error)?.message ?? err}`)
    return null
  }
}

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

  // Tracked so the scratch session can be deleted on EVERY exit path — success,
  // model error, validation bail-out, or thrown exception. Cleanup runs from the
  // `finally` below and nowhere else.
  let compartmentId: string | undefined

  try {
    // Stateless path first. If it works there is no scratch session at all:
    // nothing renders, nothing streams, nothing needs deleting.
    const generated = await polishViaGenerate(ctx, modelRef, userMsg, original)
    if (generated) return generated

    // 1. Create the polish compartment (child session, hidden agent, config model)
    const createResp: any = await ctx.session.create({
      parentID: parentSessionId,
      title: "polish-compartment",
      agent: POLISH_AGENT,
      model: {
        providerID: modelRef.providerID,
        id: modelRef.modelID,
      },
      permissions: POLISH_PERMISSIONS,
      ...(sessionDirectory ? { location: { directory: sessionDirectory } } : {}),
    })
    const childId: string | undefined = createResp?.id
    if (!childId || typeof childId !== "string") {
      return { text: original, success: false, error: "Failed to create child session" }
    }
    compartmentId = childId

    // 2. Send the prompt (soft constraint via system prompt — the V2 prompt
    //    input has no format/structured field, so the model answers in text)
    const promptResp: any = await ctx.session.prompt({
      sessionID: childId,
      text: userMsg,
      delivery: "queue",
    })
    if (promptResp?.error) {
      return { text: original, success: false, error: `Model error: ${promptResp.error.message || promptResp.error.name || "unknown"}` }
    }

    // 3. Wait for the agent to finish, then read the session context
    await ctx.session.wait({ sessionID: childId })
    const messages = normalizeResponse(await ctx.session.context({ sessionID: childId }))

    // 4. Surface any model error recorded on the assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const m: any = messages[i]
      if (m?.type === "assistant" && m.error) {
        const apiError = m.error
        return { text: original, success: false, error: `Model error: ${apiError.message || apiError.name || "unknown"}` }
      }
    }

    // Same guards as the stateless path — shared so they cannot drift.
    return finishRewrite(original, extractLatestAssistantText(messages))
  } catch (err: any) {
    const msg = err?.message || String(err)
    return { text: original, success: false, error: `SDK error: ${msg}` }
  } finally {
    // The scratch compartment must not survive the call, whichever way this
    // function returns. See removeCompartment for why this goes through the SDK
    // client rather than ctx.session.
    if (compartmentId) {
      await removeCompartment(ctx, compartmentId)
    }
  }
}

/**
 * Delete the scratch child session.
 *
 * 2026-10-02: this cleanup never ran. `ctx.session` is the plugin-context
 * session client, and its surface is list/create/get/switchAgent/switchModel/
 * prompt/compact/wait/context/history/events/interrupt/message/messages — there
 * is NO remove and NO delete on it, so the old
 * `typeof ctx.session.remove === "function"` guard was always false and the
 * `catch` swallowed the fact. Proof: 9 orphaned "polish-compartment" sessions in
 * the v2 database, every one with parent_id NULL. Deletion lives on the SDK
 * client's Session2: `client.session.delete({sessionID})` ->
 * DELETE /session/{sessionID}, which is the same call
 * `opencode session delete <id>` makes.
 *
 * Tried in order so a future runtime change degrades to a loud warning instead
 * of another silent leak.
 */
/** One-shot dump of the real plugin context shape.
 *
 *  Three previous attempts to clean up the scratch compartment were written
 *  against ASSUMED shapes (`ctx.session.remove`, `ctx.client.session.delete`,
 *  `ctx.session.delete`) and all three came back undefined at runtime — the
 *  only reason that was knowable is the NOAPI line in polish_cleanup.log.
 *  Inferring the API from a package's types is not evidence; this is. Written
 *  once per server process, deleted and rewritten on each start.
 */
let ctxShapeDumped = false
function dumpCtxShape(ctx: any): void {
  if (ctxShapeDumped) return
  ctxShapeDumped = true
  const keys = (o: any): string[] => {
    try {
      return o ? Object.keys(o).sort() : []
    } catch {
      return ["<unreadable>"]
    }
  }
  const shape: Record<string, unknown> = {
    ctxKeys: keys(ctx),
    ctxTypes: Object.fromEntries(
      keys(ctx).map((k) => [k, typeof (ctx as any)[k]]),
    ),
    sessionKeys: keys(ctx?.session),
    clientPresent: ctx?.client !== undefined && ctx?.client !== null,
    // Depth 2 on the namespaces that could carry a delete or an HTTP escape
    // hatch. Depth 1 already proved the answer is not at the top level.
    depth2: Object.fromEntries(
      keys(ctx)
        .filter((k) => typeof (ctx as any)[k] === "object" && (ctx as any)[k] !== null)
        .map((k) => [k, keys((ctx as any)[k])]),
    ),
    sessionDepth2: Object.fromEntries(
      keys(ctx?.session)
        .filter((k) => typeof (ctx as any).session?.[k] === "object" && (ctx as any).session?.[k] !== null)
        .map((k) => [k, keys((ctx as any).session[k])]),
    ),
    // Function bodies, trimmed: an RPC escape hatch would call the server's
    // session-delete route without the plugin needing a client.
    fnSources: Object.fromEntries(
      (["rpc"] as string[])
        .filter((k) => typeof (ctx as any)[k] === "function")
        .concat(["session.generate", "session.get", "session.move", "storage.set", "storage.get", "app.fetch"])
        .map((path) => {
          const fn = path
            .split(".")
            .reduce<any>((o, p) => (o == null ? o : o[p]), ctx)
          return [path, typeof fn === "function" ? String(fn).slice(0, 240) : `<<${typeof fn}>>`]
        }),
    ),
    // Any namespace that mentions delete/remove/destroy/archive is a candidate.
    deleteLikeEverywhere: Object.fromEntries(
      keys(ctx)
        .map((k) => [
          k,
          keys((ctx as any)[k]).filter((m) =>
            /^(delete|remove|destroy|archive|purge|dispose|drop)$/i.test(m),
          ),
        ])
        .filter(([, v]) => (v as string[]).length > 0),
    ),
  }
  try {
    writeFileSync(join("/tmp", "opencode", "polish_ctx_shape.json"), JSON.stringify(shape, null, 2))
  } catch {
    // diagnostics must never break the plugin
  }
}

async function removeCompartment(ctx: any, sessionID: string): Promise<void> {
  // The compartment was created with `location: { directory }`, so the delete
  // must be scoped the same way — an unscoped DELETE can fail to resolve the
  // session and throw, which is how this stayed broken for two runs.
  const directory = ctx?.location?.directory
  const log = (msg: string) => {
    try {
      appendFileSync(join("/tmp", "opencode", "polish_cleanup.log"), msg + "\n")
    } catch {
      // diagnostics must never break the plugin
    }
  }

  const attempts: Array<[string, () => unknown]> = [
    ["client.session.delete", () => ctx?.client?.session?.delete?.({ sessionID, directory })],
    ["client.session.remove", () => ctx?.client?.session?.remove?.({ sessionID, directory })],
    ["session.delete", () => ctx?.session?.delete?.({ sessionID, directory })],
  ]
  for (const [name, attempt] of attempts) {
    try {
      const call = attempt()
      if (call === undefined) continue // shape absent on this runtime
      const res: any = await call
      const err = res && typeof res === "object" ? (res.error ?? res.data?.error) : undefined
      if (err) {
        log(`FAIL ${sessionID} via ${name}: ${JSON.stringify(err).slice(0, 300)}`)
        continue
      }
      log(`OK ${sessionID} via ${name} directory=${directory ?? "none"}`)
      return
    } catch (err) {
      log(`THREW ${sessionID} via ${name}: ${(err as Error)?.message ?? err}`)
      continue
    }
  }

  // The V2 plugin context exposes NO session-delete surface: a runtime dump of
  // ctx (see dumpCtxShape) shows clientPresent=false and ctx.session carrying
  // only command/context/create/generate/get/hook/interrupt/move/prompt/
  // switchAgent/switchModel/synthetic/update/wait. That is why three separate
  // attempts to call it through the SDK all logged NOAPI.
  //
  // But the server route exists and works from outside the process:
  //   GET    /api/session/{id} -> 200 with the session JSON
  //   DELETE /api/session/{id} -> 204, and the row is gone from session_v2
  // Both verified by hand against the live server before this code was written,
  // including the directory-scoped create (location.directory) that a previous
  // comment wrongly blamed for the failure — an unscoped DELETE returned 204
  // for a compartment created with a location, so the scoping theory was wrong.
  // So the plugin issues the request itself.
  const auth = serverAuthHeader()
  for (const base of serverBaseUrls(ctx)) {
    try {
      const url = `${base}/api/session/${encodeURIComponent(sessionID)}`
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          ...(auth ? { Authorization: auth } : {}),
          ...(directory ? { "x-opencode-directory": encodeURIComponent(directory) } : {}),
        },
      })
      if (res.status === 204 || res.status === 200 || res.status === 404) {
        // 404 means already gone, which is the desired end state.
        log(`OK ${sessionID} via HTTP DELETE ${url} -> ${res.status}`)
        return
      }
      log(`FAIL ${sessionID} via HTTP DELETE ${url}: status ${res.status}`)
    } catch (err) {
      log(`THREW ${sessionID} via HTTP DELETE ${base}: ${(err as Error)?.message ?? err}`)
    }
  }
  log(`NOAPI ${sessionID} — no reachable server route deleted the compartment`)
}

/** HTTP Basic credentials for the local server, read from our own environment.
 *
 *  The plugin runs INSIDE the `opencode serve` process, so the server's own
 *  password is already in process.env — no config file, no secret to copy. The
 *  username is fixed at "opencode" and the password is OPENCODE_SERVER_PASSWORD
 *  (OPENCODE_PASSWORD is also present in this environment; the former is the
 *  one opencode serve sets for itself). Verified against the live server: the
 *  correct pair returns 200, an empty username, a wrong username, and a wrong
 *  password each return 401 — so the header is genuinely enforced, not ignored.
 */
export function serverAuthHeader(env: Record<string, string | undefined> = process.env): string | undefined {
  const pw = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD
  if (!pw) return undefined
  return `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}`
}

/** Candidate base URLs for the local OpenCode server, best guess first.
 *
 *  The port is not fixed: OpenChamber spawns `opencode serve --hostname ... --port
 *  <n>` and the number changes on every restart (40283, then 35043, observed in
 *  one session). Nothing exports it, so it is read out of this process's own
 *  command line via /proc/self/cmdline — which is the serve invocation, since
 *  the plugin is loaded by that same process.
 */
export function serverBaseUrls(ctx: any, cmdline?: string): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== "string" || !v) return
    const url = v.startsWith("http") ? v : `http://127.0.0.1:${v.replace(/^:/, "")}`
    if (!out.includes(url)) out.push(url.replace(/\/$/, ""))
  }
  push(process.env.OPENCODE_SERVER_URL)
  try {
    // `cmdline` is injectable so the parsing is testable without spawning a
    // process whose argv looks like a server invocation.
    const raw = cmdline ?? readFileSync("/proc/self/cmdline", "utf8")
    const argv = raw.split("\0")
    const portFlag = argv.indexOf("--port")
    if (portFlag !== -1 && argv[portFlag + 1]) {
      const hostFlag = argv.indexOf("--hostname")
      const host = hostFlag !== -1 && argv[hostFlag + 1] ? argv[hostFlag + 1] : "127.0.0.1"
      push(`http://${host}:${argv[portFlag + 1]}`)
    }
  } catch {
    // /proc unavailable (non-Linux): fall through to the env var only
  }
  return out
}

// --- Plugin (V2) ---

const POLISH_PERMISSIONS = [
  // Permission deny-list. OpenCode requires explicit per-capability entries —
  // there is no wildcard, so any new permission type added in a future
  // OpenCode version will default to "allow" for this subagent until added
  // below. Known as of OpenCode 2.x: edit, bash, webfetch, doom_loop,
  // external_directory. When upgrading, audit the permission list and extend.
  { action: "edit", resource: "*", effect: "deny" as const },
  { action: "bash", resource: "*", effect: "deny" as const },
  { action: "webfetch", resource: "*", effect: "deny" as const },
  { action: "doom_loop", resource: "*", effect: "deny" as const },
  { action: "external_directory", resource: "*", effect: "deny" as const },
]

const plugin = {
  id: "prompt-polisher",
  async setup(ctx: any) {
    dumpCtxShape(ctx)
    const denyAll = POLISH_PERMISSIONS

    // ── Polish agent: hidden subagent, no tools, single step ──
    // V2 registers agents through a transform editor (there is no `config`
    // hook anymore). The editor can only update/remove agents that exist, so
    // we ensure the `polish` agent is present by also documenting the
    // config-file registration below (see README). When the agent is not
    // present in the config, the command still works: the child session is
    // created with the model directly and a text-only prompt.
    // Agent customization is best-effort: it must NEVER block command
    // registration below. If the agent transform throws in a given runtime
    // (e.g. missing agent, read-only editor), commands still register and the
    // child session falls back to model-direct prompting.
    const registerPolishAgent = async () => {
      try {
        await ctx.agent.transform((editor: any) => {
          const existing = editor.get(POLISH_AGENT)
          if (existing) {
            editor.update(POLISH_AGENT, (agent: any) => {
              agent.name = "Polish"
              agent.system = POLISH_SYSTEM_PROMPT
              agent.mode = "subagent"
              agent.hidden = true
              agent.steps = 1
              agent.description =
                "Hidden helper: rewrites user prompts into stronger versions. No tools, one step."
              agent.permissions = denyAll
            })
          }
        })
      } catch (err) {
        console.error(`[prompt-polisher] agent transform skipped: ${(err as Error)?.message ?? err}`)
      }
    }
    // Command registration runs FIRST so agent customization can never
    // block it (see bisect 2026-10-02: commands were absent while the agent
    // transform ran before them).
    await ctx.command.transform((editor: any) => {
      const runPolish = async (
        sessionID: string,
        original: string,
        autoSend: boolean,
        delivery: "steer" | "queue",
        promptInput: any,
      ) => {
        if (isPolishing) {
          // V2 has no TUI toast API in the core plugin context — surface the
          // busy state as a synthetic message in the session instead.
          try {
            await ctx.session.synthetic({
              sessionID,
              text: `Polish busy: ${autoSend ? "/polish-send" : "/polish"} is already running, please wait.`,
              delivery: "queue",
            })
          } catch {
            // no-op
          }
          return
        }
        isPolishing = true
        // Delivery is a SINGLE prompt: the rewrite, and nothing else.
        //
        // History (2026-10-02, user-confirmed repro): the progress notice
        // ("Polishing your prompt, one moment… (no action needed)") was posted
        // as a second prompt. Two prompts plus a mid-turn interrupt meant the
        // model woke holding both at once, and the pairing read as "permission
        // granted" sitting next to an imperative sentence — so Muse Spark 1.3
        // executed the rewrite instead of showing it. Evidence: session
        // ses_f04cbd312ffe3G9t45jxyCKvxw, delivery text arriving as USER
        // messages at seq 3822/3912/3972; seq 4036 "the rewrite reads as an
        // instruction, so coder obeys it"; seq 3999 "it did not polish the
        // prompt. it processed it". The mid-turn abort additionally produced
        // idle:failed turns and an expired-reasoning-item provider error
        // (seq 1444). With only the polished prompt posted, this path behaved.
        //
        // The pre-polish interrupt is gone for the same reason: it existed to
        // cancel a "turn on the raw slash text" that no session ever showed
        // arriving as a user message, and it could abort an unrelated in-flight
        // turn the user had running.
        try {
          // Reload config on every invocation for hot-reload
          const config = loadConfig()

          // Fetch conversation context from the parent session
          let context = ""
          try {
            const msgs = normalizeResponse(
              await ctx.session.context({ sessionID }),
            )
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

          const result = await polishViaSDK(
            ctx,
            sessionID,
            ctx.location?.directory,
            original,
            context,
            config,
          )

          const finalText = result.success ? result.text : original

          if (autoSend) {
            // /polish-send: submit the polished prompt in the current session
            await ctx.session.prompt({
              sessionID,
              text: finalText,
              delivery,
            })
          } else if (result.success) {
            // /polish: review-first. Delivered as a session PROMPT carrying
            // the invocation's own prompt fields and delivery mode: prompts
            // are visible in the UI and `synthetic` is not (2026-10-03 —
            // review-via-synthetic shipped, user reports no visible text,
            // same reason an earlier build moved off synthetic). The rewrite
            // ships fenced so it reads as quotable content. Residual risk,
            // stated plainly: an instruction-shaped rewrite of a fragment
            // ("Please give me a cookie.") can still be obeyed as a task —
            // the channel that would stop it is the one the user cannot see.
            // The frame stays one line: the old long review-only preface was
            // noise. No interrupt anywhere on this path (whole-session
            // abort + error flash on every use — both rejected).
            await ctx.session.prompt({
              ...promptInput,
              sessionID,
              text: `Copy to use:\n\n\`\`\`\n${finalText}\n\`\`\``,
              delivery,
            })
          } else {
            // Failure path: the original prompt stays unsent (never
            // auto-submit on failure). The notice goes out as a VISIBLE
            // prompt, not synthetic — synthetic is invisible in the UI, so
            // a silent failure reads as a dead command. The notice text is
            // descriptive (same safety class as /todo's report), never an
            // instruction to obey.
            try {
              await ctx.session.prompt({
                ...promptInput,
                sessionID,
                text: `Polish failed: ${result.error}\n\nOriginal prompt:\n\n${original}`,
                delivery,
              })
            } catch {
              // Last resort — the original prompt is still in the session
            }
          }
        } finally {
          isPolishing = false
        }
      }

      editor.add({
        name: "polish",
        description:
          "AI-optimize your prompt using conversation context. Shows the rewrite for review without sending.",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const original = (prompt?.text || "").trim()
          if (!original) {
            await ctx.session.synthetic({
              sessionID,
              text: "Usage: /polish <prompt>\n\nExample: /polish 帮我写个函数",
              delivery: "queue",
            })
            return
          }
          await runPolish(sessionID, original, false, delivery, prompt)
        },
      })

      editor.add({
        name: "polish-send",
        description:
          "AI-optimize your prompt using conversation context. Result is submitted automatically.",
        execute: async ({ sessionID, prompt, delivery }: any) => {
          const original = (prompt?.text || "").trim()
          if (!original) {
            await ctx.session.synthetic({
              sessionID,
              text: "Usage: /polish-send <prompt>\n\nExample: /polish-send 帮我写个函数",
              delivery: "queue",
            })
            return
          }
          await runPolish(sessionID, original, true, delivery, prompt)
        },
      })
    })

    // Agent customization last (best-effort, never blocks commands).
    await registerPolishAgent()
  },
}

export default plugin
