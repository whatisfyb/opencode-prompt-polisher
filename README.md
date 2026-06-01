# opencode-prompt-polisher

An [OpenCode](https://opencode.ai) plugin that AI-optimizes your prompts using conversation context.

```
/polish 帮我写个带搜索的 table 组件
```
↓
```
在现有 Ant Design Pro 项目中，基于 ProTable 封装一个支持服务端搜索、分页、多列排序的通用表格组件。需求：
1. 搜索表单支持关键词模糊匹配和状态下拉筛选
2. 表格列支持点击排序，默认按创建时间倒序
3. 分页使用后端返回的 total/page/pageSize
4. 类型定义用 TypeScript interface
```

## Features

- **Context-aware** — injects recent conversation context (file names, error messages, tech stack) into the optimization
- **Undo support** — `/polish-undo` restores the original prompt
- **Auto-send** — `/polish -d` fills and auto-submits the optimized prompt
- **Safe subagent** — runs as a restricted hidden agent with no tool access, guaranteed never to execute your request instead of optimizing it
- **Configurable** — model, context window, and intensity via `polish.jsonc`

## Installation

### Via GitHub (recommended)

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "whatisfyb/opencode-prompt-polisher"
    // other plugins...
  ]
}
```

### Local development

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "C:\\Users\\<you>\\Desktop\\opencode-prompt-polisher"
    // other plugins...
  ]
}
```

Then build:

```powershell
cd path/to/opencode-prompt-polisher
npm install
npm run build
```

Restart OpenCode. Type `/polish` to verify it's registered.

## Usage

| Command | Description |
|---|---|
| `/polish <prompt>` | Optimize the prompt and put the result in the input box (waiting for you to edit or send) |
| `/polish-send <prompt>` | Optimize and auto-send immediately |

### Examples

```
You:  /polish 这个函数的性能有问题，帮我优化一下

# ⏳ (toast: loading)
# Input box now contains the optimized version
# Toast: "Polish Ready — Optimized prompt loaded. Press Enter to send, or edit first."
You:  (edit if needed) → Enter
```

```
You:  /polish-d 写一个二分查找

# ⏳ (toast: loading)
# Result is auto-sent without further action
```

## Configuration

Create `~/.config/opencode/polish.jsonc`:

```jsonc
{
  // Required: model in "provider/model-id" format
  // Uses OpenCode's provider routing (no apiKey needed separately)
  "model": "opencode/deepseek-v4-flash-free",

  // Optional: context extraction settings
  "context": {
    "maxMessages": 6,        // recent messages to inject as context
    "maxCharsPerMessage": 500  // truncate each message to this length
  },

  // Optional: optimization intensity
  // "light"   — minimal changes, fix only clarity issues
  // "medium"  — standard optimization (default)
  // "heavy"   — aggressive rewriting with maximum detail
  "intensity": "medium"
}
```

If no config file is found, defaults are used (model: `opencode/deepseek-v4-flash-free`, medium intensity).

## How it works

1. **Interception** — the plugin hooks `command.execute.before` and intercepts `/polish` commands
2. **Context gathering** — reads recent messages from the current session (max 6 messages, 500 chars each)
3. **Optimization** — sends a system prompt + context + original prompt to the LLM through a dedicated hidden subagent with zero tool access
4. **Result delivery** — the optimized prompt replaces the input box content (with undo support via `/polish-undo`)

The hidden `polish` agent is registered with `tools: {}` and all permissions set to `"deny"`, ensuring it can only generate text — never execute code or use tools.

## Architecture

```
User types /polish <prompt>
         │
         ▼
command.execute.before hook
         │
         ├─► throw __POLISH_HANDLED__  (block default execution)
         │
         └─► Async flow:
              ├─ clearPrompt()
              ├─ fetch session context
              ├─ create child session (hidden polish agent)
              ├─ session.prompt({ agent: "polish", ... })
              ├─ read assistant response
              ├─ save original to undo stack
              └─ appendPrompt(result)
```

## Development

```powershell
npm run build     # build with tsup
npm run typecheck # type check with tsc
```

## License

MIT
