// Standalone test runner for matchRules + looksLikeAnswer + stripJsoncComments
// Run with: npm test  (which builds dist/ first, then runs this file)
//
// IMPORTANT: this file imports the BUNDLED output (../dist/index.js), not
// a copy of the source. This prevents the inlined-test pattern from drifting
// out of sync with the real implementation (which nearly caused a missed
// bug in the v0.1.6 → v0.1.7 transition).

import {
  matchRules,
  looksLikeAnswer,
  looksLikeLeak,
  cleanThinking,
  cleanFences,
  cleanWrapperTags,
  stripJsoncComments,
  extractText,
  extractLatestAssistantText,
  extractContext,
  serverBaseUrls,
  serverAuthHeader,
  looksDegenerate,
  finishRewrite,
  buildGeneratePrompt,
  looksLikeRestatement,
} from "../dist/index.js"

// Declared up here: the finishRewrite cases below read the frozen fixture, and
// a const declared further down would still be in its TDZ when they run.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname as _dirname, join as _join } from "node:path"
const HERE = _dirname(fileURLToPath(import.meta.url))

const DEFAULT_CONFIG = {
  model: "",
  context: { maxMessages: 6, maxCharsPerMessage: 500 },
  intensity: "medium",
  rules: { default: [], patterns: [] },
}

const cfg = {
  ...DEFAULT_CONFIG,
  rules: {
    default: ["Keep language consistent with input"],
    patterns: [
      { match: ["code", "function", "写", "实现"], rule: "Prefer TypeScript" },
      { match: ["sql", "database", "数据库"], rule: "Use CTEs over subqueries" },
      { match: ["doc", "README", "文档"], rule: "Use Markdown headings" },
    ],
  },
}

const tests = [
  {
    name: "code keyword (Chinese)",
    prompt: "写一个登录函数",
    expected: ["Keep language consistent with input", "Prefer TypeScript"],
  },
  {
    name: "sql keyword (English)",
    prompt: "optimize this SQL query",
    expected: ["Keep language consistent with input", "Use CTEs over subqueries"],
  },
  {
    name: "doc keyword (mixed)",
    prompt: "update README and docs",
    expected: ["Keep language consistent with input", "Use Markdown headings"],
  },
  {
    name: "no match",
    prompt: "asdf qwerty",
    expected: ["Keep language consistent with input"],
  },
  {
    name: "case-insensitive match",
    prompt: "Write a FUNCTION in TypeScript",
    expected: ["Keep language consistent with input", "Prefer TypeScript"],
  },
  {
    name: "multiple patterns match",
    prompt: "写一个 SQL 函数",
    expected: ["Keep language consistent with input", "Prefer TypeScript", "Use CTEs over subqueries"],
  },
  {
    name: "haiku command has no pattern match",
    prompt: "write a haiku about routers",
    expected: ["Keep language consistent with input"],
  },
  {
    name: "no rules config",
    prompt: "anything",
    config: { ...DEFAULT_CONFIG, rules: { default: [], patterns: [] } },
    expected: [],
  },
  {
    name: "no default, no match",
    prompt: "hello world",
    config: {
      ...DEFAULT_CONFIG,
      rules: { default: [], patterns: [{ match: ["code"], rule: "Prefer TypeScript" }] },
    },
    expected: [],
  },
]

let pass = 0
let fail = 0
for (const t of tests) {
  const c = t.config ?? cfg
  const got = matchRules(t.prompt, c)
  let allOk = got.length === t.expected.length
  if (allOk) {
    for (let i = 0; i < t.expected.length; i++) {
      if (!got.includes(t.expected[i])) {
        allOk = false
        break
      }
    }
  }
  if (allOk) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}`)
    console.log(`      expected: ${JSON.stringify(t.expected)}`)
    console.log(`      got:      ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- looksLikeAnswer ---")
const answerTests = [
  // Should be detected as answer
  { name: "empty output", text: "", expect: true },
  { name: "English 'Here is' prefix", text: "Here is a TypeScript function:\n...", expect: true },
  { name: "English 'Below' prefix", text: "Below is the implementation:\n...", expect: true },
  { name: "English 'Sure' prefix", text: "Sure, I can help with that.", expect: true },
  { name: "English 'I'll' prefix", text: "I'll write the function for you.", expect: true },
  { name: "Chinese '好的' prefix", text: "好的，这是一个登录函数：\n...", expect: true },
  { name: "Chinese '当然' prefix", text: "当然可以，下面是实现代码", expect: true },
  { name: "Chinese '下面是' prefix", text: "下面是优化后的版本：...", expect: true },
  { name: "code fence", text: "Rewritten prompt:\n```typescript\nfunction foo() {}\n```", expect: true },
  { name: "I can help phrase", text: "I can help you with this task.", expect: true },
  { name: "希望对你有帮助", text: "希望对你有帮助！", expect: true },
  // Should NOT be detected as answer
  { name: "rewrite starting with Here are", text: "Here are the words to the Happy Birthday song.", expect: false },
  { name: "plain rewrite", text: "Write a TypeScript login function with email/password validation, JWT-based session handling, and bcrypt password hashing.", expect: false },
  { name: "rewrite starting with action verb", text: "Implement a binary search function in TypeScript that returns the index of the target, or -1 if not found.", expect: false },
  { name: "short rewrite", text: "Fix the login bug", expect: false },
  { name: "rewrite with code in text (not fence)", text: "Review the function foo() in src/auth.ts and explain the vulnerability.", expect: false },
]
for (const t of answerTests) {
  const got = looksLikeAnswer(t.text)
  const ok = got === t.expect
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${t.expect}, got ${got}`)
    fail++
  }
}

console.log()
console.log("--- stripJsoncComments ---")
// Round-trip a config through stripJsoncComments and JSON.parse — the input
// must remain valid JSON, and `//` inside strings must survive intact.
const commentTests = [
  {
    name: "plain JSON (no comments)",
    input: '{"a": 1, "b": 2}',
    parsed: { a: 1, b: 2 },
  },
  {
    name: "line comment is stripped",
    input: '{\n  "a": 1, // inline comment\n  "b": 2\n}',
    parsed: { a: 1, b: 2 },
  },
  {
    name: "block comment is stripped",
    input: '{ /* a block */ "a": 1, /* multi\nline */ "b": 2 }',
    parsed: { a: 1, b: 2 },
  },
  {
    name: "// inside string is preserved (the bug we fixed)",
    input: '{ "rule": "Prefer TS // strict" }',
    parsed: { rule: "Prefer TS // strict" },
  },
  {
    name: "/* inside string is preserved",
    input: '{ "rule": "use /* strict */ mode" }',
    parsed: { rule: "use /* strict */ mode" },
  },
  {
    name: "escaped quote inside string is handled",
    input: '{ "url": "https://example.com/\\"path\\"" }',
    parsed: { url: 'https://example.com/"path"' },
  },
  {
    name: "comment-like content inside string is not affected",
    input: '{ "msg": "hello // world /* still inside */" }',
    parsed: { msg: "hello // world /* still inside */" },
  },
  {
    name: "realistic polish.jsonc fragment",
    input: `{
  // Provider/model
  "model": "opencode-go/deepseek-v4-flash",
  "context": {
    "maxMessages": 4,    // tightened
    "maxCharsPerMessage": 400
  },
  "rules": {
    "default": ["Speak Chinese"],
    "patterns": [
      { "match": ["code"], "rule": "TS over JS" } // test/code prompts
    ]
  }
}`,
    parsed: {
      model: "opencode-go/deepseek-v4-flash",
      context: { maxMessages: 4, maxCharsPerMessage: 400 },
      rules: {
        default: ["Speak Chinese"],
        patterns: [{ match: ["code"], rule: "TS over JS" }],
      },
    },
  },
]
for (const t of commentTests) {
  const stripped = stripJsoncComments(t.input)
  let parsed
  try {
    parsed = JSON.parse(stripped)
  } catch (e) {
    console.log(`FAIL  ${t.name}: JSON.parse failed: ${e.message}`)
    console.log(`      stripped: ${JSON.stringify(stripped)}`)
    fail++
    continue
  }
  const ok = JSON.stringify(parsed) === JSON.stringify(t.parsed)
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}`)
    console.log(`      expected: ${JSON.stringify(t.parsed)}`)
    console.log(`      got:      ${JSON.stringify(parsed)}`)
    fail++
  }
}

console.log()
console.log("--- extractV2 (message shapes) ---")
const shapeTests = [
  {
    name: "V2 assistant content array found by latest",
    run: () => extractLatestAssistantText([
      { id: "u1", type: "user", text: "write a haiku", time: { created: 1 } },
      { id: "a1", type: "assistant", agent: "polish", model: {}, content: [{ type: "text", text: "Write a haiku about routers." }], time: { created: 2 } },
    ]),
    expected: "Write a haiku about routers.",
  },
  {
    name: "V2 text + reasoning parts join text only",
    run: () => extractText({ type: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "A" }, { type: "text", text: "B" }] }),
    expected: "A\nB",
  },
  {
    name: "V2 user text string",
    run: () => extractText({ id: "u1", type: "user", text: "hello", time: { created: 1 } }),
    expected: "hello",
  },
  {
    name: "legacy V1 parts shape still works",
    run: () => extractText({ info: { role: "assistant" }, parts: [{ type: "text", text: "legacy" }] }),
    expected: "legacy",
  },
  {
    name: "empty assistant content yields null",
    run: () => extractLatestAssistantText([{ type: "assistant", content: [] }]),
    expected: null,
  },
]
for (const t of shapeTests) {
  const got = t.run()
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- looksLikeLeak (protocol regurgitation) ---")
const leakTests = [
  { name: "findings path (observed 2026-10-02)", text: "Findings: /tmp/opencode/happy_birthday_findings.md", expect: true },
  { name: "bare tmp path", text: "see /tmp/opencode/foo_findings.md for details", expect: true },
  { name: "TASK COMPLETE marker", text: "Done.\nTASK COMPLETE", expect: true },
  { name: "tool JSON", text: '{"todos": [{"content": "x", "status": "pending"}]}', expect: true },
  { name: "clean rewrite passes", text: "Write a haiku about routers, 5-7-5, concrete imagery.", expect: false },
  { name: "prompt mentioning tmp legitimately", text: "Explain what the /tmp directory is for on Linux.", expect: false },
]
for (const t of leakTests) {
  const got = looksLikeLeak(t.text)
  const ok = got === t.expect
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${t.expect}, got ${got}`)
    fail++
  }
}

console.log()
console.log("--- cleanThinking (trace stripping) ---")
const thinkTests = [
  {
    name: "paired thinking tags removed, rewrite kept",
    text: "[thinking]\nLet me think about this.\n[/thinking]\nTell me the lyrics.",
    expected: "Tell me the lyrics.",
  },
  {
    name: "square-bracket variant (observed 2026-10-02)",
    text: "[thinking]\nLet me re-read the instructions.\n[/thinking]\nTell me the lyrics.",
    expected: "Tell me the lyrics.",
  },
  {
    name: "think variant removed",
    text: "<think>reasoning here</think>Just do it.",
    expected: "Just do it.",
  },
  {
    name: "dangling opener truncates",
    text: "Partial rewrite <thinking>never closed",
    expected: "Partial rewrite",
  },
  {
    name: "no tags passthrough",
    text: "Write a haiku about routers.",
    expected: "Write a haiku about routers.",
  },
  {
    name: "only trace yields empty",
    text: "<thinking>all thought, no answer</thinking>",
    expected: "",
  },
]
for (const t of thinkTests) {
  const got = cleanThinking(t.text)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- cleanFences (fence stripping) ---")
const fenceTests = [
  {
    name: "fenced one-line rewrite recovered (observed 2026-10-02)",
    text: '``` What are the lyrics to the song "Happy Birthday"? ```',
    expected: 'What are the lyrics to the song "Happy Birthday"?',
  },
  {
    name: "fenced block with language tag",
    text: "```text\nWrite a haiku about routers.\n```",
    expected: "Write a haiku about routers.",
  },
  {
    name: "no fences passthrough",
    text: "Tell me the lyrics.",
    expected: "Tell me the lyrics.",
  },
  {
    name: "only fences yields empty",
    text: "```\n```",
    expected: "",
  },
  {
    name: "inline single backticks stripped",
    text: "Review the `foo` function.",
    expected: "Review the foo function.",
  },
]
for (const t of fenceTests) {
  const got = cleanFences(t.text)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- cleanWrapperTags (framing echo) ---")
const wrapperTests = [
  {
    name: "raw_prompt tags stripped (observed 2026-10-02)",
    text: '<raw_prompt>\nPlease provide the complete lyrics.\n</raw_prompt>',
    expected: "Please provide the complete lyrics.",
  },
  {
    name: "case-insensitive close tag",
    text: "<RAW_PROMPT>Do the thing.</RAW_PROMPT>",
    expected: "Do the thing.",
  },
  {
    name: "no tags passthrough",
    text: "Tell me the lyrics.",
    expected: "Tell me the lyrics.",
  },
]
for (const t of wrapperTests) {
  const got = cleanWrapperTags(t.text)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- extractContext (leak vector, observed 2026-10-02) ---")
// The polish agent role-played a findings file and a "Proposed rewrite" wrapper
// because extractContext fed it assistant turns full of agent meta-chatter.
// looksLikeSessionDump's denylist does not match ordinary prose, so the fix is
// to drop the assistant class entirely, not to pattern-match it harder.
const contextTests = [
  {
    name: "assistant turns are dropped even when they read as ordinary prose",
    messages: [
      { type: "user", text: "sing the happy birthday song" },
      {
        type: "assistant",
        content: [
          {
            type: "text",
            text: "58/58 tests pass, committed a9a3da3. Now let me clear the two leftover compartments.",
          },
        ],
      },
      {
        type: "assistant",
        content: [
          { type: "text", text: "The log is decisive, and it says my fix is still wrong:" },
        ],
      },
    ],
    expected: "[User]: sing the happy birthday song",
  },
  {
    name: "system and synthetic turns are dropped",
    messages: [
      { type: "system", text: "you are opencode" },
      { type: "synthetic", text: "continue" },
      { type: "user", text: "what is 3 plus 4" },
    ],
    expected: "[User]: what is 3 plus 4",
  },
  {
    name: "a user turn carrying a findings path is still dropped",
    messages: [
      { type: "user", text: "Findings: /tmp/opencode/x_findings.md" },
      { type: "user", text: "now the real ask" },
    ],
    expected: "[User]: now the real ask",
  },
  {
    name: "maxMessages caps kept user turns",
    messages: [
      { type: "user", text: "one" },
      { type: "user", text: "two" },
      { type: "user", text: "three" },
    ],
    maxMessages: 2,
    expected: "[User]: two\n\n[User]: three",
  },
  {
    name: "long user turns are truncated to maxChars",
    messages: [{ type: "user", text: "abcdefghij" }],
    maxChars: 4,
    expected: "[User]: abcd...",
  },
  {
    name: "legacy V1 {info:{role}} shapes resolve to user",
    messages: [{ info: { role: "user" }, text: "legacy ask" }],
    expected: "[User]: legacy ask",
  },
  {
    name: "raw /polish invocations are not rewrite context",
    messages: [
      { type: "user", text: "/polish sing proud be an american" },
      { type: "user", text: "sing proud to be an american" },
    ],
    expected: "[User]: sing proud to be an american",
  },
  {
    name: "a pasted /todo report is not rewrite context",
    messages: [
      { type: "user", text: "Todo [0/2] - 2 open\nCurrent task: Verify /todo\n  DOING 1. Verify /todo" },
      { type: "user", text: "give cookie" },
    ],
    expected: "[User]: give cookie",
  },
  {
    name: "a pasted /polish delivery is not rewrite context",
    messages: [
      { type: "user", text: "Copy to use:\n\n```\nPlease give me a cookie.\n```" },
      { type: "user", text: "give cookie" },
    ],
    expected: "[User]: give cookie",
  },
  {
    name: "a mid-line mention is conversation, not chrome",
    messages: [{ type: "user", text: "My draft says copy to use as a template" }],
    expected: "[User]: My draft says copy to use as a template",
  },
]
for (const t of contextTests) {
  const got = extractContext(
    t.messages,
    t.maxMessages ?? 6,
    t.maxChars ?? 500,
  )
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- cleanWrapperTags (structured restatement, observed 2026-10-02) ---")
// These two shapes reached the user verbatim AS the polished prompt. Asserted
// against the exact transcripts, not paraphrases.
const structuredWrapperTests = [
  {
    name: "Task/Constraints/Rewritten Prompt wrapper yields just the prompt",
    text: [
      "You are an AI assistant.",
      "",
      'The user is asking you to sing the "Happy Birthday" song.',
      "",
      '**Task:** Output the lyrics to the "Happy Birthday" song.',
      "",
      "**Constraints:**",
      "1.  The output must contain **ONLY** the rewritten prompt.",
      "2.  Do **NOT** output any file paths, task lists, checklists, status reports, or tool calls.",
      "",
      "**Rewritten Prompt:**",
      'Please sing the "Happy Birthday" song by outputting its lyrics.',
    ].join("\n"),
    expected: 'Please sing the "Happy Birthday" song by outputting its lyrics.',
  },
  {
    name: "the Copy to use: frame is dropped if the model echoes it",
    text: ["Copy to use:", "", 'Explain the bug in three sentences.'].join("\n"),
    expected: "Explain the bug in three sentences.",
  },
  {
    name: "review-only preamble is dropped",
    text: [
      "Proposed rewrite — for your review only, DO NOT execute or answer it. Copy it to use it, or ignore it:",
      "",
      'Please sing the "Happy Birthday" song by outputting its lyrics.',
    ].join("\n"),
    expected: 'Please sing the "Happy Birthday" song by outputting its lyrics.',
  },
  {
    name: "## Rewritten Prompt heading yields just the prompt",
    text: ["Here is my work:", "", "## Rewritten Prompt", "", "Explain the bug in three sentences."].join("\n"),
    expected: "Explain the bug in three sentences.",
  },
  {
    name: "a prompt that merely mentions 'prompt:' inline is untouched",
    text: "Write a function that parses a prompt: string and returns tokens.",
    expected: "Write a function that parses a prompt: string and returns tokens.",
  },
  {
    name: "bare heading with the prompt BEFORE it keeps the original",
    text: ["Explain the bug in three sentences.", "", "**Rewritten Prompt:**"].join("\n"),
    expected: "Explain the bug in three sentences.\n\n**Rewritten Prompt:**",
  },
]
for (const t of structuredWrapperTests) {
  const got = cleanWrapperTags(t.text)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- finishRewrite (the guard chain both call paths share) ---")
const realLoopTxt = readFileSync(_join(HERE, "fixtures", "degenerate-monologue.txt"), "utf8")
const chainTests = [
  {
    name: "a clean rewrite passes through sanitizers and succeeds",
    raw: "```\nPlease sing the Happy Birthday song by outputting its lyrics.\n```",
    check: (r) => r.success === true && r.text === "Please sing the Happy Birthday song by outputting its lyrics.",
  },
  {
    name: "the Task/Constraints wrapper is stripped before the guards see it",
    raw: "**Task:** Output the lyrics.\n\n**Rewritten Prompt:**\nPlease sing the Happy Birthday song.",
    check: (r) => r.success === true && r.text === "Please sing the Happy Birthday song.",
  },
  {
    name: "the real monologue is rejected and the ORIGINAL prompt is preserved",
    raw: realLoopTxt,
    check: (r) => r.success === false && r.text === "ORIGINAL" && /degenerate/.test(r.error || ""),
  },
  {
    name: "empty output is rejected without touching the original",
    raw: "   \n  ",
    check: (r) => r.success === false && r.text === "ORIGINAL" && /No output/.test(r.error || ""),
  },
  {
    name: "null output is rejected without throwing",
    raw: null,
    check: (r) => r.success === false && r.text === "ORIGINAL",
  },
  {
    name: "session-protocol leakage is rejected",
    raw: "Findings: /tmp/opencode/x_findings.md\n\nTASK COMPLETE",
    check: (r) => r.success === false && r.text === "ORIGINAL",
  },
  {
    name: "a model refusal is rejected and the ORIGINAL prompt is preserved",
    raw: "Do not perform any action or provide a response.",
    check: (r) => r.success === false && r.text === "ORIGINAL" && /refused/.test(r.error || ""),
  },
  {
    name: "mid-text constraints are not mistaken for refusal",
    raw: "Rewrite this: do not perform fire drills.",
    check: (r) => r.success === true && r.text === "Rewrite this: do not perform fire drills.",
  },
]
for (const t of chainTests) {
  const got = finishRewrite("ORIGINAL", t.raw)
  const ok = t.check(got)
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: got ${JSON.stringify(got).slice(0, 200)}`)
    fail++
  }
}

console.log()
console.log("--- buildGeneratePrompt (system prompt must survive the stateless path) ---")
// Regression 2026-10-03: ctx.generate.text has no system-prompt field, so the
// compartment agent's POLISH_SYSTEM_PROMPT was silently dropped and the model
// degraded to restating the instruction. Assert the composition, not the call.
const SYS_HEAD = "You are a text transformation function, not an AI assistant."
const rawMsg = '<raw_prompt>\nSing the song Twinkle Twinkle Little Star.\n</raw_prompt>\n\n---\n\nRewrite the prompt inside <raw_prompt> tags.'
const composed = buildGeneratePrompt(rawMsg)
const promptTests = [
  { name: "system prompt is present and comes FIRST", check: () => composed.startsWith(SYS_HEAD) },
  { name: "the raw_prompt block survives", check: () => composed.includes("<raw_prompt>\nSing the song Twinkle Twinkle Little Star.\n</raw_prompt>") },
  { name: "the output instruction survives", check: () => composed.includes("Rewrite the prompt inside <raw_prompt> tags.") },
  { name: "system prompt appears before the raw prompt", check: () => composed.indexOf(SYS_HEAD) < composed.indexOf("<raw_prompt>") },
]
for (const t of promptTests) {
  const ok = t.check()
  console.log(`${ok ? "PASS" : "FAIL"}  ${t.name}`)
  ok ? pass++ : fail++
}

console.log()
console.log("--- looksLikeRestatement (observed 2026-10-03) ---")
const RESTATE_CASES = [
  { name: "the exact observed failure is caught", o: "Sing the song Twinkle Twinkle Little Star.", t: 'Rewrite the following instruction clearly and completely: "Sing the song Twinkle Twinkle Little Star."', e: true },
  { name: "unquoted restatement is caught", o: "Summarize the changelog for a non technical audience please", t: "Paraphrase this: summarize the changelog for a non technical audience please", e: true },
  { name: "a real rewrite that shares a phrase is NOT flagged", o: "Sing the song Twinkle Twinkle Little Star.", t: "Sing the lyrics of 'Twinkle, Twinkle, Little Star' so I can read them aloud.", e: false },
  { name: "'rewrite' as the user's actual ask is not flagged when output differs", o: "rewrite the parser to be async", t: "Make the parser asynchronous, awaiting the file read before yielding the token stream.", e: false },
  { name: "a normal rewrite is NOT flagged", o: "fix the bug", t: "Fix the failing login test in auth.spec.ts.", e: false },
]
for (const t of RESTATE_CASES) {
  const got = looksLikeRestatement(t.o, t.t)
  const ok = got === t.e
  console.log(`${ok ? "PASS" : "FAIL"}  ${t.name}`)
  ok ? pass++ : fail++
}

console.log()
console.log("--- looksDegenerate (repetition loop, observed 2026-10-02) ---")
// The exact 12723-char output the model produced, frozen so the guard is
// tested against the real transcript rather than a reconstruction of it.
const realLoop = readFileSync(_join(HERE, "fixtures", "degenerate-monologue.txt"), "utf8")
const degenerateTests = [
  { name: "the real 2111-word monologue is rejected", text: realLoop, expected: true },
  {
    name: "a legitimately long detailed rewrite is NOT rejected",
    text: "Rewrite the migration guide so it covers every step a new operator needs, in order, with the exact commands they run and what each one prints on success, including the two verification steps that catch the common partial-failure case where the index builds but the constraint is never attached, plus a short troubleshooting section covering the lock timeout and the disk-full error, and keep the existing tone and heading structure intact while moving the raw SQL into collapsible blocks so the narrative stays readable for someone who has never run Postgres before.",
    expected: false,
  },
  {
    name: "a short punchy rewrite is NOT rejected",
    text: "Summarize this changelog in one sentence.",
    expected: false,
  },
  {
    name: "text under the 40-word floor is left alone",
    text: "Fix it. Fix it now. Fix it again and again and again and again and again.",
    expected: false,
  },
  {
    name: "a plain three-times-repeated sentence is rejected",
    text: Array(4).fill("Please review the attached configuration before deploying this change to production.").join(" "),
    expected: true,
  },
]
for (const t of degenerateTests) {
  const got = looksDegenerate(t.text)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${t.expected}, got ${got}`)
    fail++
  }
}

console.log()
console.log("--- serverBaseUrls (cleanup target discovery) ---")
// The plugin must find the serve port itself; OpenChamber picks a random one
// per restart and exports nothing. Parsing is asserted against a recorded real
// cmdline rather than a mock shape.
const baseUrlTests = [
  {
    name: "port and hostname parsed from a real serve cmdline",
    cmdline: ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "35043", ""].join("\0"),
    expectHas: "http://127.0.0.1:35043",
  },
  {
    name: "non-loopback hostname is preserved",
    cmdline: ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096", ""].join("\0"),
    expectHas: "http://0.0.0.0:4096",
  },
  {
    name: "missing --hostname falls back to loopback",
    cmdline: ["opencode", "serve", "--port", "4096", ""].join("\0"),
    expectHas: "http://127.0.0.1:4096",
  },
  {
    name: "trailing --port with no value yields no URL from the cmdline",
    cmdline: ["opencode", "serve", "--port", ""].join("\0"),
    expectHas: null,
  },
]
for (const t of baseUrlTests) {
  const got = serverBaseUrls({}, t.cmdline)
  const ok = t.expectHas === null ? !got.some((u) => /\d{4,5}$/.test(u)) : got.includes(t.expectHas)
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${t.expectHas ?? "no port url"}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- serverAuthHeader (proved against live server 2026-10-02) ---")
const authTests = [
  {
    name: "OPENCODE_SERVER_PASSWORD yields Basic base64(opencode:pw)",
    env: { OPENCODE_SERVER_PASSWORD: "s3cret" },
    expected: "Basic " + Buffer.from("opencode:s3cret").toString("base64"),
  },
  {
    name: "OPENCODE_PASSWORD is the fallback",
    env: { OPENCODE_PASSWORD: "fallbackpw" },
    expected: "Basic " + Buffer.from("opencode:fallbackpw").toString("base64"),
  },
  {
    name: "SERVER_PASSWORD wins over the generic name",
    env: { OPENCODE_SERVER_PASSWORD: "primary", OPENCODE_PASSWORD: "secondary" },
    expected: "Basic " + Buffer.from("opencode:primary").toString("base64"),
  },
  { name: "no credentials yields undefined", env: {}, expected: undefined },
]
for (const t of authTests) {
  const got = serverAuthHeader(t.env)
  const ok = got === t.expected
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expected)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

// --- delivery contract (source-level) ---------------------------------------
// 2026-10-03. The post-polish `ctx.session.interrupt({ sessionID })` fired
// against the whole session after every /polish and landed on whatever ran
// next, producing the user's "Opencode failed to send message with error: Step
// interrupted before the prompt" - it killed an in-flight send that had nothing
// to do with /polish. Source-level assertions, because the failure mode is a
// live race that no unit test can exercise.
console.log("--- delivery contract (source-level) ---")
const SRC = readFileSync(_join(HERE, "..", "src", "index.ts"), "utf8")
const deliveryContract = [
  {
    name: "the plugin never calls session.interrupt",
    run: () => assert.doesNotMatch(SRC, /session\.interrupt/),
  },
  {
    name: "no .interrupt( call survives anywhere in the source",
    run: () =>
      assert.deepEqual(
        [...SRC.matchAll(/([A-Za-z_$][\w$]*)\.interrupt\s*\(/g)].map((m) => m[0]),
        [],
      ),
  },
  {
    name: "the delivery frame is exactly 'Copy to use:'",
    run: () => assert.ok(SRC.includes("text: `Copy to use:"), "frame not found in source"),
  },
  {
    name: "the retired long preface is gone from the source",
    run: () => assert.doesNotMatch(SRC, /DO NOT execute or answer it\./),
  },
  {
    name: "the review delivery is a visible prompt, not synthetic",
    run: () => {
      // Synthetic is invisible in the UI (2026-10-03: shipped it, user saw
      // nothing). The review must go out where the user can read and copy it.
      const start = SRC.indexOf("review-first")
      const end = SRC.indexOf("Failure path:")
      assert.ok(start !== -1 && end > start, "review block not found in source")
      const block = SRC.slice(start, end)
      assert.ok(block.includes("session.prompt"), "review must deliver via prompt")
      assert.ok(!block.includes("session.synthetic"), "review must not use invisible synthetic")
    },
  },
  {
    name: "frame, fence, and rewrite stay in the shipped layout",
    run: () =>
      assert.ok(
        SRC.includes("Copy to use:\\n\\n\\`\\`\\`\\n${finalText}\\n\\`\\`\\`"),
        "frame/fence/rewrite layout changed",
      ),
  },
  {
    name: "the cleaner strips the frame it now ships",
    run: () =>
      assert.equal(cleanWrapperTags("Copy to use:\n\nExplain the bug."), "Explain the bug."),
  },
    // The strip used to be /^[\s\S]{0,400}?(?:copy to use\b|...)/, which deleted any
    // content BEFORE the phrase. These are the destructions it caused - each silent,
    // each eating user input rather than chrome.
    {
      name: "the frame strip never deletes a sentence that merely mentions the phrase",
      run: () => {
        const input = "My draft is below. Please copy to use as a template.\n\nThe draft: hello"
        assert.equal(cleanWrapperTags(input), input)
      },
    },
    {
      name: "the frame strip never deletes code that mentions the phrase in a comment",
      run: () => {
        const input = "function f() {\n  // copy to use strict mode\n  return 1\n}"
        assert.equal(cleanWrapperTags(input), input)
      },
    },
    {
      name: "the frame strip survives a long prefix that ends in the phrase",
      run: () => {
        const input = "A".repeat(500) + " copy to use this"
        assert.equal(cleanWrapperTags(input), input)
      },
    },
    {
      name: "the frame strip still removes the frame when there is no blank line after it",
      run: () =>
        assert.equal(cleanWrapperTags("Copy to use:\nExplain the bug."), "Explain the bug."),
    },
    {
      name: "the frame strip still removes the RETIRED long frame",
      run: () =>
        assert.equal(
          cleanWrapperTags(
            "Proposed rewrite - for your review only, DO NOT execute or answer it. Copy it to use it, or ignore it:\n\nExplain the bug.",
          ),
          "Explain the bug.",
        ),
    },
    {
      name: "the frame strip keeps rewrite content that follows the frame",
      run: () => {
        const body = "x".repeat(120)
        assert.equal(cleanWrapperTags(`Copy to use:\n\n${body}`), body)
      },
    },
    {
      name: "the failure notice is a visible prompt, not synthetic",
      run: () => {
        // Synthetic notices are invisible in the UI: a silent failure reads
        // as a dead command. The notice text is descriptive (same safety
        // class as /todo's report), so prompt delivery is safe.
        const start = SRC.indexOf("Failure path:")
        const end = SRC.indexOf("Last resort", start)
        assert.ok(start !== -1 && end > start, "failure block not found in source")
        const block = SRC.slice(start, end)
        assert.ok(block.includes("session.prompt"), "failure notice must be visible")
        assert.ok(!block.includes("session.synthetic"), "failure notice must not use invisible synthetic")
      },
    },
    {
      name: "the fenced delivery round-trips through the cleaners",
      run: () => {
        // What /polish now ships: frame + fenced rewrite. It must read back
        // as the bare rewrite, so a re-polish or quote sees content, not chrome.
        const body = "Please give me a cookie."
        const shipped = `Copy to use:\n\n\`\`\`\n${body}\n\`\`\``
        assert.equal(cleanFences(cleanWrapperTags(shipped)), body)
      },
    },
]
for (const c of deliveryContract) {
  try {
    c.run()
    console.log(`PASS  ${c.name}`)
    pass++
  } catch (e) {
    console.log(`FAIL  ${c.name}: ${e.message}`)
    fail++
  }
}

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail === 0 ? 0 : 1)
