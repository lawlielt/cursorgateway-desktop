# 工具映射设计文档

## 为什么 Cursor 不能做一个纯粹的代理？

### 理想情况

我们希望 Cursor 代理只做一件事：**透传**。客户端（如 Claude Code）定义自己的工具，代理原样传给 Cursor API，模型用客户端的工具名和参数格式返回 tool_call，代理原样传回客户端。

### 现实限制

Cursor API 的 `supportedTools` 字段是 `repeated ClientSideToolV2`（枚举类型），**只接受预定义的整数 ID**，不接受任意工具定义：

```protobuf
repeated ClientSideToolV2 supportedTools = 29;
```

这意味着：

1. **不能注入自定义工具定义**到 `supportedTools` — 它只认 Cursor 自己的枚举值
2. **`supportedTools` 为空时**，Cursor 服务端将模型降级为 Ask 模式（无工具模式），即使 `isAgentic=true`
3. **模型只会调用 Cursor 的原生工具**（`read_file`、`delete_file` 等），不会调用客户端定义的工具名（`Read`、`Delete` 等）

### 结论

**必须与 Cursor 的工具系统交互**。代理的职责不是透传，而是**翻译**：将 Cursor 的原生工具调用映射到客户端期望的工具格式。

---

## Cursor 原生工具集（ClientSideToolV2）

| 枚举值 | 工具名 | 功能 |
|--------|--------|------|
| 5 / 40 | `read_file` / `read_file_v2` | 读取文件内容 |
| 6 / 39 | `list_dir` / `list_dir_v2` | 列出目录内容 |
| 7 | `edit_file` | 编辑文件（old/new 文本替换） |
| 38 | `edit_file_v2`（显示名 `write`） | 写入完整文件内容 |
| 11 | `delete_file` | 删除文件 |
| 3 / 41 | `ripgrep_search` / `ripgrep_raw_search` | 正则搜索文件内容 |
| 15 | `run_terminal_command_v2` | 执行终端命令 |
| 8 | `file_search` | 按文件名搜索 |
| 42 | `glob_file_search` | Glob 模式文件搜索 |
| 18 | `web_search` | 网页搜索 |
| 23 | `search_symbols` | 符号搜索（函数、类定义） |
| 31 | `go_to_definition` | 跳转到定义 |
| 16 | `fetch_rules` | 获取 .cursorrules 等规则 |
| 34 / 35 | `todo_read` / `todo_write` | 任务管理 |
| 32 / 48 | `task` / `task_v2` | 子任务/子代理 |
| 19 / 49 | `mcp` / `call_mcp_tool` | MCP 协议支持 |
| 25 | `knowledge_base` | 知识库检索 |
| 26 | `fetch_pull_request` | 获取 PR 信息 |
| 27 | `deep_search` | 深度搜索 |
| 28 | `create_diagram` | 生成图表 |
| 29 / 30 | `fix_lints` / `read_lints` | Lint 诊断和修复 |
| 12 | `reapply` | 重新应用修改 |
| 43 | `create_plan` | 创建计划 |
| 44 / 45 | `list_mcp_resources` / `read_mcp_resource` | MCP 资源访问 |
| 46 / 47 | `read_project` / `update_project` | 项目元数据管理 |
| 50 | `apply_agent_diff` | 应用 diff 补丁 |
| 51 | `ask_question` | 向用户提问 |
| 52 | `switch_mode` | 切换 Ask/Agent 模式 |
| 53 | `generate_image` | 图片生成 |
| 54 | `computer_use` | 电脑操作 |
| 55 | `write_shell_stdin` | 向交互终端写入 |

---

## Claude Code 工具集

| 工具名 | 功能 |
|--------|------|
| `Shell`（Bash） | 执行 Shell 命令 |
| `Read` | 读取文件内容 |
| `Write` | 写入/创建文件 |
| `StrReplace`（Edit） | 字符串替换编辑文件 |
| `Delete` | 删除文件 |
| `Glob` | Glob 模式文件搜索 |
| `Grep` | 正则搜索文件内容 |
| `WebFetch` | 获取网页内容 |
| `WebSearch` | 网页搜索 |
| `Task` | 启动子代理 |
| `TodoWrite` | 任务管理 |
| `EditNotebook` | Jupyter Notebook 编辑 |
| `ListMcpResources` | 列出 MCP 资源 |
| `FetchMcpResource` | 获取 MCP 资源 |
| `EnterPlanMode` / `ExitPlanMode` | 规划模式切换 |
| `EnterWorktree` | Git worktree 管理 |
| `Skill` | 调用预定义技能 |
| `AskUserQuestion` | 向用户提问 |

---

## 工具对比：异同分析

### 直接对应（功能基本一致，参数不同）

| Cursor 工具 | Claude Code 工具 | 关键参数差异 |
|-------------|-----------------|-------------|
| `read_file` / `read_file_v2` | `Read` | `relative_workspace_path`（相对路径）→ `path`（绝对路径） |
| `edit_file_v2`（`write`） | `Write` | `relative_workspace_path` + `contents_after_edit` → `path` + `contents` |
| `edit_file` | `StrReplace` | `old_string` / `new_string` 基本一致 |
| `delete_file` | `Delete` | `relative_workspace_path` → `path` |
| `run_terminal_command_v2` | `Shell` | `command` + `cwd` → `command` + `working_directory` |
| `ripgrep_search` / `ripgrep_raw_search` | `Grep` | `search_term` → `pattern` |
| `list_dir` / `list_dir_v2` | `Glob` | 语义差异：Cursor 返回目录树，Glob 返回匹配文件列表 |
| `glob_file_search` | `Glob` | `pattern` → `glob_pattern` |
| `web_search` | `WebFetch` | 都是 Web 访问 |
| `todo_write` / `todo_read` | `TodoWrite` | 任务管理 |
| `task` / `task_v2` | `Task` | 子代理 |

> **核心差异**：路径格式（相对 vs 绝对）、参数命名（`contents_after_edit` vs `contents`）

### Cursor 独有（Claude Code 没有对应）

| 工具 | 说明 | 影响 |
|------|------|------|
| `search_symbols` | 符号搜索 | IDE 专属，代理场景不需要 |
| `go_to_definition` | 跳转定义 | IDE 专属 |
| `fetch_rules` | 获取规则 | Cursor 专属 |
| `knowledge_base` | 知识库 | Cursor 专属 |
| `fetch_pull_request` | PR 信息 | Cursor 专属 |
| `deep_search` | 深度搜索 | Cursor 专属 |
| `create_diagram` | 图表生成 | Cursor 专属 |
| `fix_lints` / `read_lints` | Lint 操作 | IDE 专属 |
| `reapply` | 重新应用 | Cursor 专属 |
| `apply_agent_diff` | 差异补丁 | Cursor 专属 |
| `switch_mode` | 模式切换 | Cursor 专属 |
| `generate_image` | 图片生成 | Cursor 专属 |
| `computer_use` | 电脑操作 | Cursor 专属 |
| `write_shell_stdin` | 交互终端输入 | 可映射到 Shell |

> 这些工具不传入 `supportedTools`，模型就不会调用它们，不影响代理功能。

### Claude Code 独有（Cursor 没有对应）

| 工具 | 说明 | 处理方式 |
|------|------|----------|
| `EditNotebook` | Jupyter 编辑 | 需要 prompt 注入 |
| `WebFetch` | 网页获取（fetch URL） | 需要 prompt 注入（Cursor 的 `web_search` 语义不完全一致） |
| `EnterPlanMode` / `ExitPlanMode` | 规划模式 | Claude Code 内部流程控制，不需要模型调用 |
| `EnterWorktree` | Worktree 管理 | Claude Code 内部流程控制 |
| `Skill` | 技能调用 | Claude Code 内部流程控制 |

---

## 混合映射方案

### 架构总览

```
Claude Code 发送请求（带 21 个工具定义）
         │
         ▼
    代理服务器
         │
    ┌────┴─────────────┐
    │                  │
 有 Cursor 对应        无 Cursor 对应
 (6 个核心工具)        (少数独有工具)
    │                  │
    ▼                  ▼
 走 Cursor 原生         走 Prompt 注入
 supportedTools        系统提示词中注入工具定义
 结构化 tool_call_v2    模型以文本格式输出
 (可靠、参数完整)       (备选、覆盖面兜底)
    │                  │
    ▼                  ▼
 映射参数              解析文本
 Cursor 名 → CC 名     <mcp_tool_use> 标签
 相对路径 → 绝对路径    直接提取工具名和参数
    │                  │
    └────────┬─────────┘
             │
        合并去重
             │
             ▼
  以 Anthropic tool_use 格式
  返回给 Claude Code
```

### 两条通道

#### 通道 1：结构化工具调用（主通道）

适用于有 Cursor 原生对应的工具。

**流程**：
1. `supportedTools` 传入 `DEFAULT_AGENT_TOOLS`（Cursor 预定义枚举）
2. 模型返回结构化 `tool_call_v2`（protobuf 格式，参数完整）
3. 代理拦截并映射：
   - 工具名：`read_file` → `Read`，`delete_file` → `Delete`，`run_terminal_command` → `Shell` 等
   - 参数名：`relative_workspace_path` → `path`，`contents_after_edit` → `contents` 等
   - 路径格式：相对路径 + `workingDirectory` → 绝对路径
4. 以 Anthropic `tool_use` 格式返回给 Claude Code

**核心映射表**：

| Cursor 调用 | → Claude Code 工具 | 参数转换 |
|-------------|-------------------|----------|
| `read_file(relative_workspace_path)` | `Read(path)` | 拼接为绝对路径 |
| `write(relative_workspace_path, contents_after_edit)` | `Write(path, contents)` | 拼接路径 + 重命名参数 |
| `edit_file(path, old_string, new_string)` | `StrReplace(path, old_string, new_string)` | 拼接路径 |
| `delete_file(relative_workspace_path)` | `Delete(path)` | 拼接路径 |
| `run_terminal_command(command, cwd)` | `Shell(command, working_directory)` | 重命名参数 |
| `ripgrep_search(search_term, path)` | `Grep(pattern, path)` | 重命名参数 |
| `list_dir(directory_path)` | `Glob(glob_pattern, target_directory)` | 填充默认 pattern `*` |
| `glob_file_search(pattern)` | `Glob(glob_pattern)` | 重命名参数 |

#### 通道 2：Prompt 注入工具调用（辅助通道）

适用于 Claude Code 独有、没有 Cursor 对应的工具。

**流程**：
1. 将 Claude Code 独有工具的定义注入到系统提示词中
2. 使用 MCP 格式指导模型输出文本格式的工具调用
3. 从模型的文本响应中解析 `<mcp_tool_use>` 标签
4. 直接以 Anthropic `tool_use` 格式返回（工具名和参数已经是 Claude Code 格式）

**适用工具**：`EditNotebook`、`WebFetch` 等少数工具。

### 合并与去重

1. 优先使用通道 1 的结构化工具调用（更可靠）
2. 补充通道 2 解析到的文本工具调用
3. 按 `tool_call_id` 或工具名+参数去重
4. 统一以 Anthropic `tool_use` 格式返回

### ERROR_USER_ABORTED_REQUEST 处理

使用 `aiserver.v1`（单向流）时，Cursor 服务端在模型发出工具调用后会等待客户端执行结果，但单向流无法回传结果，最终触发 `ERROR_USER_ABORTED_REQUEST`。

**这是预期行为，不影响功能**：
- 工具调用在错误发生前已经完整接收
- 代理将工具调用返回给 Claude Code
- Claude Code 执行工具后，在下一次请求中将结果放入 `messages`（包含 `tool_result`）
- 代理将完整对话历史发给 Cursor，新的请求是无状态的

---

## 路径转换规则

Claude Code 在系统提示中包含 `Working directory: /absolute/path`，代理提取后用于转换：

```
Cursor 返回: relative_workspace_path = "src/index.js"
Working directory = "/Users/user/project"
→ Claude Code: path = "/Users/user/project/src/index.js"
```

已有绝对路径（以 `/` 开头）不做转换。

---

## 实现要点

1. **`messages.js`**：从 `streamDecoder.feedData(chunk)` 中同时获取 `text` 和 `toolCalls`
2. **`toolsAdapter.js`**：`mapCursorToolToIde()` 负责工具名和参数的映射；`filterNonNativeTools()` 过滤原生覆盖的工具
3. **`utils.js`**：`DEFAULT_AGENT_TOOLS` 定义传给 Cursor 的工具枚举列表
4. **Prompt 注入**：只注入无 Cursor 对应的 Claude Code 独有工具，避免与原生工具冲突
5. **去重**：结构化工具调用优先，文本解析的同名工具调用被过滤

---

## 原生工具分流策略（重要）

### 问题

StrReplace、TodoWrite 等工具注册为 MCP 后，Cursor 模型在文件操作场景会忽略 MCP 工具，
优先使用原生工具（read/write/shell），导致模型在 "想调用 StrReplace 但调不了" 的循环中死锁。

### 解决方案：不和原生工具对抗

将 Claude Code 工具分为两类：

| 类别 | 工具 | 处理方式 |
|------|------|----------|
| **原生覆盖** | Read, Write, StrReplace, Bash, Shell, Grep, Glob, LS, Delete | **不注册 MCP**，不注入 prompt。模型自然使用原生工具，代理通过 `execRequestToToolUse` 映射回 Claude Code 格式 |
| **无原生对应** | TodoWrite, Task, WebFetch, EditNotebook, ListMcpResources 等 | **注册 MCP** + prompt 注入，通过文本解析捕获 |

### StrReplace 的处理

StrReplace 没有直接对应的 Cursor 原生工具，但模型会用 read + write 完成同样的操作：
1. 模型调用原生 `read` → 代理返回 `Read` tool_use → Claude Code 执行
2. 模型调用原生 `write`（带修改后的全文）→ 代理返回 `Write` tool_use → Claude Code 执行

效果等同于 StrReplace，只是分成两步。

### 参数映射（execRequestToToolUse）

| Cursor 原生 | Claude Code 工具 | 参数映射 |
|-------------|-----------------|----------|
| read | Read | `path` (不是 file_path) |
| write | Write | `path` + `contents` (不是 file_path + content) |
| shell | Bash | `command` + `working_directory` |
| grep | Grep | `pattern` + `path` |
| ls | Glob | `glob_pattern: '*'` + `target_directory` |
| delete (field 4) | Delete | `path` |

### 相关文件

- `toolsAdapter.js`：`NATIVE_COVERED_TOOLS_LOWER`、`filterNonNativeTools()`
- `sessionManager.js`：`execRequestToToolUse()` 参数映射
- `agentClient.js`：`parseExecServerMessage()` field 4 = delete
- `test/unit/native-tool-filter.test.js`：54 项测试用例
