# opencode-prompt-polisher

OpenCode 插件：基于对话上下文自动优化你的提示词。

## 效果示例

**输入**（你写的）：

```
帮我写个搜索表格
```

**输出**（优化后返回到会话）：

```
基于现有项目（React + TypeScript），写一个支持服务端搜索的通用表格组件。需求：
1. 搜索表单支持关键词模糊匹配和状态下拉筛选
2. 表格列支持点击排序，默认按创建时间倒序
3. 分页使用后端返回的 total/page/pageSize
4. 使用 TypeScript interface 定义 props 和数据类型
```

插件会自动补充：技术栈、需求细节、类型要求等上下文相关约束。

## 功能

- **感知上下文** — 注入最近的对话消息（文件路径、错误信息、技术栈）作为优化依据
- **安全子 agent** — 在隐藏的子 agent 中运行，工具集为空，绝不会代替你执行需求
- **可配置** — 模型、上下文窗口、优化强度、条件式规则都通过 `polish.jsonc` 配置
- **热重载** — 修改配置文件无需重启 OpenCode
- **条件式规则** — 关键词命中后注入硬约束（如"SQL"→使用 CTE；"写"→TypeScript）

## 安装

### npm（推荐）

编辑 `~/.config/opencode/opencode.json`（OpenCode **V2** 配置键为 `plugins`）：

```jsonc
{
  "plugins": [
    "opencode-prompt-polisher"
  ]
}
```

重启 OpenCode。

### 本地开发

```jsonc
{
  "plugins": [
    "C:\\path\\to\\opencode-prompt-polisher"
  ]
}
```

然后：

```powershell
cd path/to/opencode-prompt-polisher
npm install
npm run build
```

## 命令

| 命令 | 行为 |
|---|---|
| `/polish <prompt>` | 优化后以 fenced 代码块形式作为会话内 prompt 消息返回（"Copy to use:" 框架），等你复制后手动发送 |
| `/polish-send <prompt>` | 优化后自动提交到当前会话 |

> **V2 行为变更**：OpenCode V2 的核心插件 API 没有 TUI 输入框接口（V1 的
> `ctx.client.tui.appendPrompt/submitPrompt` 已移除），所以 `/polish` 不再把
> 结果填入输入框，而是把优化结果直接写回当前会话方便复制发送（V2.0 曾用
> synthetic 消息，但该通道在 UI 中不可见，已改回 prompt）；`/polish-send`
> 则直接提交。失败提示（包括模型拒绝改写）同样以可见消息返回，原文保留。

### 示例

```
/polish 这个函数性能有问题
```

→ 当前会话出现一条内含优化后提示词（fenced 代码块）的消息，复制即可发送。

```
/polish-send 写一个二分查找
```

→ 优化后直接提交到当前会话，无需再操作。

## 配置

创建 `~/.config/opencode/polish.jsonc`：

```jsonc
{
  // 模型，格式 "provider/model-id"，任何已配置的 provider 都可用
  // （含本地模型，例如 "llama-server/small-model" —— 只要该 provider 在
  //  opencode.jsonc 里配置好了）
  "model": "opencode/deepseek-v4-flash-free",

  // 上下文提取设置
  "context": {
    "maxMessages": 6,           // 注入最近 N 条消息
    "maxCharsPerMessage": 500   // 每条消息截断到该长度
  },

  // 优化强度（仅配置文件生效，不会出现在优化指令中）
  // "light"  - 最小改动，只修正歧义
  // "medium" - 标准优化（默认）
  // "heavy"  - 激进重写，补充最大细节
  "intensity": "medium",

  // 条件式规则：用户 prompt 含关键词（大小写不敏感子串匹配）时，
  // 把对应 rule 注入到 polish agent 的 user message 中作为硬约束。
  // `default` 始终包含；`patterns` 多条可同时命中。
  "rules": {
    "default": [
      "保持与用户原 prompt 相同的语言（中文保持中文，英文保持英文，技术术语保持英文）"
    ],
    "patterns": [
      {
        "match": ["code", "function", "实现", "写一个", "implement", "build", "refactor", "test", "tests", "spec", "测试", "单元测试", "覆盖"],
        "rule": "代码/测试类 prompt：优先 TypeScript、提前返回、避免不必要的 try/catch、明确函数签名；测试要注明框架（jest/vitest/pytest 等），覆盖正常/边界/异常路径"
      },
      {
        "match": ["sql", "database", "query", "数据库", "查询"],
        "rule": "SQL 类 prompt：使用标准 SQL、CTE 优先于嵌套子查询、参数化用户输入、注明目标 DBMS"
      },
      {
        "match": ["doc", "documentation", "README", "文档", "教程"],
        "rule": "文档类 prompt：使用 Markdown 标题层级、配代码示例、长文档加目录"
      }
    ]
  }
}
```

不创建配置文件也能用，会用内置默认值。

## 工作原理

1. V2 插件在启动时通过 `ctx.command.transform` 注册 `/polish`、`/polish-send`
   命令（V1 的 `command.execute.before` hook 在 V2 已移除）
2. 读取当前会话最近的 N 条消息作为上下文（`ctx.session.context`）
3. 按关键词匹配 `rules.patterns`，把命中的规则作为硬约束注入到 user message
4. 创建一个隐藏的 `polish` 子 agent 会话（`ctx.session.create`，model 为配置中的
   `provider/model-id`，permissions 全部 deny），在其中调用 LLM 优化
5. 把优化结果写回当前会话（`/polish` 为 fenced 代码块的 prompt 消息，`/polish-send` 直接提交）；失败时返回可见的失败提示并保留原文

> **polish agent 注册**：V2 的 `AgentEditor` 没有 `add()`，插件只通过
> `editor.update("polish", …)` 增强已存在的 agent。如果当前配置里没有定义
> `polish` agent，插件不会凭空创建；请在 `opencode.json(c)` 里加一行
> `"agent": { "polish": { "prompt": "..." } }`（或在 polish.jsonc 同级配置中定义），
> 插件随后会补上 system prompt、subagent 模式、隐藏、steps=1 和 deny 权限。

### 规则匹配机制

`rules.patterns` 里的 `match` 关键词是大小写不敏感的子串匹配：

| 用户 prompt 包含 | 命中的硬约束 |
|---|---|
| `code` / `function` / `写一个` / `test` / `测试` | 优先 TypeScript、提前返回、注明测试框架… |
| `sql` / `数据库` / `query` | 用 CTE 优先、参数化输入… |
| `doc` / `README` / `文档` | Markdown 标题层级、配代码示例… |
| 无任何匹配 | 仅 `default` 规则 |

LLM 把命中的规则视为不可违反的硬约束 —— 优化结果里必须反映这些要求。

## 开发

```powershell
npm run build              # tsup 打包
npm run typecheck          # tsc 类型检查
npm test                   # tsup + node tests/match-rules.test.mjs（119 个用例）
```

### 输出守卫与上下文过滤（V2 port）

改写结果在交付前经过守卫链（`finishRewrite`），任一命中即回退原文并给出可见失败提示：

- 应答/寒暄、session 协议泄漏、复读循环、复述式改写（换个说法复述指令而非改写）、模型拒绝改写
- 上下文只取用户消息：assistant 回复、system/synthetic 消息整体丢弃；`/todo` 报告、`Copy to use:` 框架、裸 `/polish` 调用文本同样不进入上下文（均实测漏入过改写结果）
- 交付框架为单行 `Copy to use:` + fenced 代码块；清理器只剥离行首框架，提及该短语的用户原文不受影响

发版流程（推送 tag 自动发布到 npm）：

```powershell
npm version patch   # 0.1.0 → 0.1.1
git push
git push --tags     # 触发 GitHub Actions
```

GitHub Actions 配置在 `.github/workflows/publish.yml`。仓库需要配置 `NPM_TOKEN` secret。

## License

MIT
