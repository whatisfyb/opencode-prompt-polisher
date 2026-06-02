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

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail === 0 ? 0 : 1)
