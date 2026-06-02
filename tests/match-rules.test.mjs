// Standalone test runner for matchRules
// Run with: node tests/match-rules.test.mjs

import { readFileSync } from "node:fs"
import { join } from "node:path"

// Minimal mock for file ops (not actually used by the inlined functions)
void readFileSync
void join

// Inline a copy of matchRules + types for testing without bundler
const DEFAULT_CONFIG = {
  model: "",
  context: { maxMessages: 6, maxCharsPerMessage: 500 },
  intensity: "medium",
  rules: { default: [], patterns: [] },
}

function matchRules(prompt, config) {
  const matched = []
  const rules = config.rules
  if (Array.isArray(rules.default)) {
    for (const r of rules.default) {
      if (typeof r === "string" && r.trim()) matched.push(r.trim())
    }
  }
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

// Inline copy of looksLikeAnswer
function looksLikeAnswer(text) {
  const t = text.trim()
  if (!t) return true
  const answerPrefixRe =
    /^(here('s| is)?\b|below\b|sure\b|of course\b|absolutely\b|certainly\b|i('ll| will| can)\b|let me\b|好的[，,。 ]?|当然[可以，,。 ]?|下面是|以下是|让我|我来|可以的|没问[题到]|当然可[以到])/i
  if (answerPrefixRe.test(t)) return true
  if (/```/.test(t)) return true
  const helpfulEnRe =
    /\b(i can help|i can assist|let me know|feel free to|here to help)\b/i
  const helpfulZhRe = /希望对[你您]有帮助|希望能帮[到助]/
  if (helpfulEnRe.test(t) || helpfulZhRe.test(t)) return true
  return false
}

// Inline copy of extractRewritten
function isRewrittenField(obj) {
  return (
    typeof obj === "object" &&
    obj !== null &&
    typeof obj.rewritten === "string"
  )
}

function findBalancedJsonObject(text) {
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (c === "\\") escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === "{") {
      if (depth === 0) start = i
      depth++
    } else if (c === "}") {
      depth--
      if (depth === 0 && start !== -1) return text.slice(start, i + 1)
    }
  }
  return null
}

function extractRewritten(text) {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const obj = JSON.parse(trimmed)
    if (isRewrittenField(obj)) return obj.rewritten
  } catch {}
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) {
    try {
      const obj = JSON.parse(codeBlockMatch[1].trim())
      if (isRewrittenField(obj)) return obj.rewritten
    } catch {}
  }
  const objStr = findBalancedJsonObject(trimmed)
  if (objStr) {
    try {
      const obj = JSON.parse(objStr)
      if (isRewrittenField(obj)) return obj.rewritten
    } catch {}
  }
  return null
}

// Inline copy of stripPreamble
function stripPreamble(text) {
  const patterns = [
    /^here'?s?\s+(?:the|your)\s+(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
    /^here\s+is\s+(?:the\s+)?(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
    /^(?:optimized|rewritten|polished)\s+(?:prompt|version|response)[:：]?\s*/i,
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
console.log("--- extractRewritten ---")
const extractTests = [
  // Should extract
  { name: "direct JSON", input: '{"rewritten": "hello world"}', expect: "hello world" },
  { name: "JSON with whitespace", input: '  \n  {"rewritten": "hello"}  \n  ', expect: "hello" },
  { name: "JSON in code block", input: '```json\n{"rewritten": "hello"}\n```', expect: "hello" },
  { name: "JSON in plain code block", input: '```\n{"rewritten": "hello"}\n```', expect: "hello" },
  { name: "JSON with preamble text", input: 'Here is the result:\n{"rewritten": "hello"}\nHope this helps!', expect: "hello" },
  { name: "JSON with Chinese chars in value", input: '{"rewritten": "优化后的提示词"}', expect: "优化后的提示词" },
  { name: "JSON with escaped quotes in value", input: '{"rewritten": "He said \\"hi\\" to me"}', expect: 'He said "hi" to me' },
  // Should return null
  { name: "missing rewritten field", input: '{"result": "hello"}', expect: null },
  { name: "rewritten is number", input: '{"rewritten": 123}', expect: null },
  { name: "rewritten is null", input: '{"rewritten": null}', expect: null },
  { name: "invalid JSON", input: 'not json at all', expect: null },
  { name: "empty string", input: '', expect: null },
  { name: "JSON with braces in string value", input: '{"rewritten": "use foo() in { block }"}', expect: "use foo() in { block }" },
]
for (const t of extractTests) {
  const got = extractRewritten(t.input)
  const ok = got === t.expect
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expect)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log()
console.log("--- stripPreamble ---")
const stripTests = [
  { name: "English 'Here's the optimized prompt:'", input: "Here's the optimized prompt:\n\nFix the bug", expect: "Fix the bug" },
  { name: "English 'Here is the rewritten version:'", input: "Here is the rewritten version:\n\nFix the bug", expect: "Fix the bug" },
  { name: "English 'Optimized prompt:'", input: "Optimized prompt: Fix the bug", expect: "Fix the bug" },
  { name: "Chinese '优化后的提示词：'", input: "优化后的提示词：\n\n修复这个 bug", expect: "修复这个 bug" },
  { name: "Chinese '重写后的版本：'", input: "重写后的版本：\n\n修复这个 bug", expect: "修复这个 bug" },
  { name: "Chinese '提示词如下'", input: "提示词如下：\n\n修复这个 bug", expect: "修复这个 bug" },
  { name: "Chinese '以下是优化后的提示词：'", input: "以下是优化后的提示词：\n\n修复这个 bug", expect: "修复这个 bug" },
  { name: "no preamble", input: "Fix the bug", expect: "Fix the bug" },
  { name: "empty", input: "", expect: "" },
  { name: "whitespace only", input: "   \n  ", expect: "" },
]
for (const t of stripTests) {
  const got = stripPreamble(t.input)
  const ok = got === t.expect
  if (ok) {
    console.log(`PASS  ${t.name}`)
    pass++
  } else {
    console.log(`FAIL  ${t.name}: expected ${JSON.stringify(t.expect)}, got ${JSON.stringify(got)}`)
    fail++
  }
}

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail === 0 ? 0 : 1)
