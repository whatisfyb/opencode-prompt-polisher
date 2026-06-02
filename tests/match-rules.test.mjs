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
  stripJsoncComments,
} from "../dist/index.js"

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

console.log(`\n${pass}/${pass + fail} tests passed`)
process.exit(fail === 0 ? 0 : 1)
