# CursorGateway 踩坑记录

本文档记录项目开发过程中遇到的关键问题和解决方案，避免重复踩坑。

---

## 目录

- [1. Protobuf 编码陷阱](#1-protobuf-编码陷阱)
- [2. 工具调用去重](#2-工具调用去重)
- [3. KV Blob 机制](#3-kv-blob-机制)
- [4. Session 管理](#4-session-管理)
- [5. 编码与解码](#5-编码与解码)
- [6. 超时与心跳](#6-超时与心跳)
- [7. 原生工具分流策略](#7-原生工具分流策略)
- [8. Protobuf 编码防御性处理](#8-protobuf-编码防御性处理)
- [9. KV 工具调用与原生 exec 重复问题](#9-kv-工具调用与原生-exec-重复问题)
- [10. Session 并发竞争](#10-session-并发竞争)
- [11. 工作目录传递错误](#11-工作目录传递错误)
- [12. exec 路径参数未标准化](#12-exec-路径参数未标准化)
- [13. Edit 工具映射为 Write](#13-edit-工具映射为-write)
- [14. BidiAppend 重试与自动重连](#14-bidiappend-重试与自动重连)
- [15. MCP 工具名与 Cursor 保留名冲突](#15-mcp-工具名与-cursor-保留名冲突)

---

## 1. Protobuf 编码陷阱

### 1.1 ListValue 多元素编码（已修复）

**问题**：`encodeProtobufValue` 处理数组时，把所有元素拼在一个 field 1 里：

```javascript
// 错误写法 — 所有元素被包在单个 field 1，protobuf 解析器只保留最后一个
const listData = encodeMessageField(1, concatBytes(...values));
```

**影响**：`required: ["path", "old_string", "new_string"]` 只看到 `["new_string"]`，导致 MCP 工具的 `input_schema` 残缺。

**修复**：每个元素必须是独立的 field 1（repeated field 编码规则）：

```javascript
const encodedValues = value.map(v => encodeMessageField(1, encodeProtobufValue(v)));
const listData = concatBytes(...encodedValues);
```

### 1.2 Null 值编码缺少 value 字节（已修复）

**问题**：null 值只写了 tag（0x08）没写 varint 0，会污染后续字段解析。

```javascript
// 错误：只返回 tag，缺少 value
return encodeVarint((1 << 3) | 0);

// 正确：tag + value
const tag = encodeTag(1, 0);
const data = encodeVarint(0);
return Buffer.concat([tag, data]);
```

### 1.3 Connect/gRPC-Web 帧格式

SSE 流中的每个帧格式为 `[flags:1字节][length:4字节 BE][data]`：

- `flags & 0x80` = trailer（包含 grpc-status / grpc-message）
- 否则为数据帧，data 即 protobuf 消息

解析时必须处理**跨帧的不完整消息**，用 buffer 持续拼接。

---

## 2. 工具调用去重

### 2.1 Anthropic tool ID 不能用于去重（已修复）

**问题**：`execRequestToToolUse()` 每次调用都 `uuidv4()` 生成新 ID，即使是同一个 Cursor exec_server_message 被重放，也会得到不同的 Anthropic ID。

**修复**：用 Cursor 层面的标识符（`exec.id` + `exec.execId`）做去重：

```javascript
function getCursorExecKey(chunk) {
  if (chunk.type === 'tool_call' && chunk.execRequest) {
    const er = chunk.execRequest;
    const parts = [];
    if (er.id !== undefined && er.id !== null) parts.push(`id:${er.id}`);
    if (er.execId) parts.push(`execId:${er.execId}`);
    return parts.join('|') || null;
  }
  if (chunk.type === 'tool_call_kv' && chunk.toolUse) {
    return chunk.toolUse.id ? `kv:${chunk.toolUse.id}` : null;
  }
  return null;
}
```

### 2.2 continuation stream 会重放整个会话

Cursor 的 `continueStream()` 在收到 tool_result 后，可能从头重放整个响应。必须：

- **文本去重**：记录 `sentText`，只发送超出已发送长度的新增部分
- **工具去重**：记录 `sentCursorExecKeys`，在调用 `mapAgentChunkToToolUse` **之前**检查

### 2.3 跨请求的历史工具重放

Claude Code 每次请求带完整对话历史，包含之前的 `tool_use` / `tool_result`。如果序列化格式不当，Cursor 的模型会重新执行历史中的工具。

**修复**：将历史工具调用标记为已完成：

```javascript
// 错误：模型误认为需要执行
textParts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input)})]`);

// 正确：明确标记为已完成
textParts.push(`[Already executed tool "${block.name}" with args: ${argsSummary}]`);
textParts.push(`[Tool execution result]: ${resultContent}`);
```

---

## 3. KV Blob 机制

### 3.1 什么是 KV

Cursor 的 agent 协议中，`kv_server_message`（field 4）用于大数据传输（类似 blob store）。模型的最终响应（包含文本和工具调用）可能通过 KV blob 而非 `interaction_update` 传递。

### 3.2 KV FINAL 响应

当 KV blob 中的 JSON 包含 `role: "assistant"` 且有 `id` 字段时，表示这是**最终响应**。其中 `content` 可能包含文本和工具调用（`tool-call` / `tool-use` 类型的 block）。

### 3.3 KV 工具调用与 exec 工具调用的去重

同一个工具调用可能同时出现在 `exec_server_message` 和 KV FINAL 中。需要用签名（工具名 + 参数 hash）去重，避免发送重复的 `tool_use` 给客户端。

---

## 4. Session 管理

### 4.1 Session 生命周期

```text
新请求（无 tool_result）→ 创建 session + AgentClient → chatStream()
         ↓
  工具调用 → 返回 tool_use → 保持 session
         ↓
续请求（有 tool_result）→ 查找 session → sendToolResult → continueStream()
         ↓
  无更多工具调用 → cleanupSession()
```

### 4.2 Session 查找

Claude Code 不一定会带 `x-cursor-session-id` header。退而求其次，通过 `tool_use_id` 在所有 session 的 `toolCallMapping` 中查找匹配的 session。

### 4.3 text_fallback 工具

`text_fallback` 类工具没有对应的 `exec_server_message`，发送 BidiAppend 结果会被忽略。处理方式：关闭当前 session，用完整对话历史发起新请求（fresh request）。

**注意**：KV-mapped 工具（如通过 KV 路径的 Edit → StrReplace）**不应自动触发 fresh request**。之前 `sendToolResult` 中 `kvMapped` flag 也触发 `needsFreshRequest = true`，导致正确映射的 KV 工具永远无法完成。修复后只有 `text_fallback` 触发 fresh request。

---

## 5. 编码与解码

### 5.1 UTF-8 多字节字符损坏

**问题**：`Buffer.from(textField, 'binary')` 会把 UTF-8 字符串当 Latin-1 处理，破坏中文等多字节字符。

**场景**：`CursorStreamDecoder._processMessage` 解析 protobuf text 字段时，先按 binary 转 Buffer 再转 UTF-8，导致工具参数中的中文变成乱码。

**修复**：优先使用结构化 `toolCallV2` 数据，仅在无结构化数据时回退解析 text 字段。

### 5.2 工作目录上下文

Cursor 的模型在处理长 system prompt 时，可能忽略其中的工作目录信息，导致生成 `find / -name "file"` 这类从根目录搜索的命令。

**修复**：在 system prompt 最前面添加显眼的 `[Workspace]` 块：

```text
[Workspace]
Working directory: /Users/xxx/project
All file operations should use paths relative to or within this directory.
```

---

## 6. 超时与心跳

### 6.1 chatStream 超时

- 空闲超时：3 分钟无数据
- 通过 `AbortController` 和读取超时双重控制

### 6.2 continueStream 超时

- 首事件超时（`CURSOR_CONTINUE_FIRST_EVENT_TIMEOUT_MS`）：等待第一个有效事件，默认 120 秒
- 空闲超时（`CURSOR_CONTINUE_IDLE_TIMEOUT_MS`）：两次有效事件间隔，默认 60 秒
- 绝对超时：无有意义事件（只有心跳）时的兜底，等于首事件超时

### 6.3 心跳不算有意义活动

Cursor 的 `interaction_update` 中 `field 13 = heartbeat` 只是保活信号。必须区分心跳和真正的文本/工具调用事件，否则心跳会不断重置超时，导致无限等待。

---

## 7. 原生工具分流策略

### 7.1 问题

StrReplace、TodoWrite 等 Claude Code 工具注册为 MCP 后，Cursor 模型在文件操作场景会忽略 MCP 工具，坚持用原生工具（read/write/shell），导致模型在"想调 StrReplace 但调不了"的循环中死锁。

### 7.2 解决方案：不和原生工具对抗

将 Claude Code 工具分为两类，分别处理：

| 类别 | 工具 | 处理方式 |
|------|------|----------|
| **原生覆盖** | Read, Write, StrReplace, Bash, Shell, Grep, Glob, LS, Delete | **不注册 MCP**，模型自然使用原生工具，代理通过 `execRequestToToolUse` 映射回客户端格式 |
| **无原生对应** | TodoWrite, Task, WebFetch, EditNotebook, ListMcpResources 等 | **注册 MCP** + prompt 注入 |

### 7.3 StrReplace 的处理

StrReplace 没有直接对应的 Cursor 原生工具，但模型会自然用 read + write 两步完成同样的操作：

1. 模型调用原生 `read` → 代理返回 `Read` tool_use → 客户端执行
2. 模型调用原生 `write`（带修改后的全文）→ 代理返回 `Write` tool_use → 客户端执行

### 7.4 参数映射（动态标准化）

**关键教训：参数名不能硬编码，必须根据客户端实际发送的 tool schema 动态适配！**

```text
exec_server_message → execRequestToToolUse (原始名) → adaptKvToolUseToIde (标准化) → 客户端
```

### 7.5 Edit → StrReplace 映射

Cursor 模型发出的文件编辑操作使用 `Edit` 工具名（带 `old_string` + `new_string`），这是 StrReplace 语义。`adaptKvToolUseToIde` 通过输入感知路由处理：

- `Edit` + `old_string`/`new_string` → **StrReplace**（部分修改）
- `Edit` + `content`（无 old_string）→ **Write**（全文件写入）

### 7.6 相关代码

- `toolsAdapter.js`：`NATIVE_COVERED_TOOLS_LOWER`、`filterNonNativeTools()`
- `sessionManager.js`：`execRequestToToolUse()` 原始参数映射
- `kvToolAdapter.js`：`adaptKvToolUseToIde()`、`normalizeInputForTool()` 动态标准化
- `bidiToolFlowAdapter.js`：`mapAgentChunkToToolUse()` exec 路径也走标准化

---

## 8. Protobuf 编码防御性处理

### 8.1 问题

`encodeStringField(fieldNumber, undefined)` 会导致 `Buffer.from(undefined)` 抛出 TypeError。这类错误很难通过单元测试发现，因为单元测试通常 mock 了底层编码函数。

### 8.2 根因：错误路径的 result 结构不一致

通用错误处理器创建 `{ error: "字符串" }`，但 `buildWriteResultMessage` 假设 `result.error` 是对象，访问 `result.error.path` 和 `result.error.error` 得到 undefined。

### 8.3 修复：双层防御

**第一层 — 编码函数兜底**：所有 `encode*Field` 函数处理 undefined/null：

```javascript
function encodeStringField(fieldNumber, value) {
  const data = Buffer.from(String(value ?? ''), 'utf-8');  // undefined → ''
}
```

**第二层 — result builder 处理两种 error 格式**：

```javascript
} else if (result.error) {
  const errorPath = typeof result.error === 'object' ? (result.error.path || '') : '';
  const errorMsg = typeof result.error === 'object'
    ? (result.error.error || 'Write failed')
    : (typeof result.error === 'string' ? result.error : 'Write failed');
}
```

### 8.4 Write 成功结果回填路径

Write 工具结果通常是纯文本（如 "Wrote 1 lines to file.txt"），JSON.parse 会失败。修复后使用原始请求的 path 做回填。

### 8.5 教训

- **单元测试 mock 太深会隐藏 bug**：原有测试 mock 了 `agentClient.sendToolResult`，导致 Protobuf 编码路径从未被执行
- **端到端测试必须覆盖编码层**：用真实的 `AgentClient`（mock `bidiAppend` 替代网络 I/O）确保完整编码路径被测试
- **所有 builder 必须处理两种 error 格式**：`{ error: "string" }` 和 `{ error: { path, error } }`

---

## 9. KV 工具调用与原生 exec 重复问题

### 9.1 问题

Cursor 模型的同一个工具调用可能同时出现在两个通道：

1. **原生 exec**（`exec_server_message` field 3 = write）— 正确处理并返回结果
2. **KV FINAL 响应**（`kv_server_message` 中的 `tool-call` 块）— 重复！

由于原生覆盖工具没有注册为 MCP，Cursor 服务端对 KV 中的这些工具调用返回 `<tool_use_error>InputValidationError`。

### 9.2 现象

```text
Bash(echo "fdafdaowerqr" > 2.txt)     ← Cursor 用 shell 创建了文件
文件 2.txt 已成功创建
Error writing file                      ← KV 重复的 Write 工具失败
Write(2.txt) → Error writing file
Read 2 files → Read 2 files → ...（无限循环）
```

### 9.3 continueStream 重放 KV FINAL 导致工具调用提前终止

**根因**：`continueStream` 的 `locallyExecutedToolIds` / `locallyExecutedToolSignatures` 每次调用都重新初始化为空。当 Cursor 在 continuation 中重放第一轮的 KV FINAL，`continueStream` 无法识别它是旧数据。

**修复**：`AgentClient` 实例的 `_handledExecIds` / `_handledExecSignatures` 在 `chatStream` 结束时写入，`continueStream` 开始时继承：

```javascript
// chatStream 结束时
for (const id of locallyExecutedToolIds) this._handledExecIds.add(id);
for (const sig of locallyExecutedToolSignatures) this._handledExecSignatures.add(sig);

// continueStream 开始时
const locallyExecutedToolIds = new Set(this._handledExecIds);
const locallyExecutedToolSignatures = new Set(this._handledExecSignatures);
```

### 9.4 教训

- **同一操作可能出现在多个通道**：exec 和 KV 是独立通道
- **去重状态必须跨轮次持久化**：每个 generator 函数独立的局部变量不够
- **硬编码的工具名过滤太脆弱**：`isNativeCoveredTool` 无法区分"旧的重放"和"新的调用"

---

## 10. Session 并发竞争

### 10.1 问题

Claude Code 在代理响应较慢时（>几秒），会**重发相同的 tool_result 请求**。两个并发请求竞争同一个 `AgentClient.sseReader`，导致数据丢失和超时。

### 10.2 日志特征

```text
[Messages API] Continuing session: xxx tool_results: 1
[AgentClient] BidiAppend seqno=44, data=175bytes
...
[Messages API] Continuing session: xxx tool_results: 1    ← 重复请求！
[AgentClient] BidiAppend seqno=44, data=175bytes          ← 同一 seqno！
...
[AgentClient] Read timeout after 60000ms (idle), ending continueStream
```

### 10.3 修复：Session 并发锁

```javascript
// messages.js — continuation 处理入口
if (!session.acquireContinuationLock()) {
  await Promise.race([
    session.waitForContinuation(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('lock timeout')), 90000)),
  ]);
  session = null;  // 回退到 fresh request
}

// 所有退出路径都必须释放锁
session.releaseContinuationLock();
```

### 10.4 教训

- **Claude Code 会重试**：代理响应慢时（>3-5s），客户端会重发请求
- **共享 reader 是致命的**：`ReadableStream.getReader()` 一次只能一个活跃 reader
- **seqno 冲突**：并发 BidiAppend 用相同 seqno，Cursor 可能忽略重复

---

## 11. 工作目录传递错误

### 11.1 问题

用户在 `cursor-proxy` 目录运行 Claude Code，Cursor 模型却尝试操作代理服务的目录。

### 11.2 根因（两层问题）

**第一层**：`extractWorkingDirectory` 不识别 Claude Code 的 system prompt 格式。Claude Code 发送 `Workspace Path:` 但代理只匹配 `Working directory:`。

**第二层**：`buildRequestContextResultMessage` 硬编码 `process.cwd()` 而不接收 `workspacePath` 参数。

### 11.3 修复

```javascript
// 支持多种格式
const patterns = [
  /Workspace Path:\s*([^\n]+)/i,     // Claude Code CLI
  /Working directory:\s*([^\n]+)/i,  // Cursor IDE
  /Workspace Root:\s*([^\n]+)/i,
  /CWD:\s*([^\n]+)/i,
];

// buildRequestContextResultMessage 接收 workspacePath 参数
function buildRequestContextResultMessage(id, execId, workspacePath) {
  const resolvedPath = workspacePath || process.cwd();
}
```

### 11.4 教训

- **`process.cwd()` 是代理进程的目录，不是用户的**
- **必须用真实数据测试**：测试用 `Working directory:` 格式，线上是 `Workspace Path:` 格式

---

## 12. exec 路径参数未标准化

### 12.1 问题

Claude Code 通过代理执行 Write 时始终报 "Error editing file"，模型不断重试。

### 12.2 根因

**第一层**：exec 路径绕过了参数标准化。`bidiToolFlowAdapter.js` 中 KV 路径走 `adaptKvToolUseToIde()`，但 exec 路径直接用原始输出。

**第二层**：`normalizeInputForTool` 缺少 `content → contents` 映射。Claude Code 的 Write 工具 schema 用 `contents`（复数），但映射只处理了 `content → fileText`。

**第三层**：`setIfAllowed('content', value)` 因 `content` 不在 schema 的 allowed 列表而被**静默丢弃**。

### 12.3 修复

exec 路径也走 `adaptKvToolUseToIde` 标准化，`normalizeInputForTool` 新增 `contents` 分支。

### 12.4 教训

- **两条路径必须走同一套标准化**
- **`setIfAllowed` 静默丢弃是隐蔽的 bug**
- **测试必须验证值，不能只验证 key**

---

## 13. Edit 工具映射为 Write

### 13.1 问题

模型反复输出分析但每次编辑都失败："Error editing file"。

### 13.2 根因

Cursor 模型发出 `Edit` 工具调用（带 `old_string` + `new_string`），是 StrReplace 语义。但代理把它当成 Write：

```text
Edit + { old_string, new_string }
  → TOOL_NAME_CANDIDATES 把 edit 归入 write 组
  → normalizeInputForTool 走 write 分支
  → old_string/new_string 被丢弃
```

### 13.3 修复

**输入感知路由**：

```javascript
if ((name === 'edit' || name === 'edit_file') &&
    ('old_string' in input || 'new_string' in input)) {
  // → 映射为 StrReplace 而非 Write
}
```

### 13.4 教训

- **工具名不能只看名字，要看语义**：`Edit` 可以是 StrReplace 也可以是 Write
- **Cursor 和客户端的工具名不同**：Cursor 用 `Edit`，客户端用 `StrReplace`

---

## 14. BidiAppend 重试与自动重连

### 14.1 BidiAppend 自动重试

- 网络错误、超时、5xx 服务端错误自动重试 3 次
- 指数退避：1s → 2s → 4s（最大 5s）
- 4xx 客户端错误不浪费重试
- 单次超时 15s

### 14.2 continueStream 自动降级

延迟写 SSE headers 到第一个有意义事件到达后。如果 `continueStream` 在发送任何内容之前失败，透明降级为 fresh request。

### 14.3 教训

- **网络不可靠要重试**：Cursor API 偶尔超时或连接重置
- **尽量延迟不可逆操作**：SSE headers 一旦发出不能撤回

---

## 15. MCP 工具名与 Cursor 保留名冲突

### 15.1 问题

启用 protobuf MCP 注册后，每次请求都报 `grpc-status: 8 (Provider Error)`。

### 15.2 根因

Cursor 服务端有保留工具名（`TodoWrite`、`WebFetch`、`Task`、`EditNotebook`、`FetchMcpResource`、`Delete`），以相同名字注册 MCP 会冲突。

### 15.3 修复

注册时加 `mcp_` 前缀，回调时去掉前缀还原。

```javascript
const CURSOR_RESERVED_TOOL_NAMES = new Set([
  'TodoWrite', 'WebFetch', 'Task', 'EditNotebook', 'FetchMcpResource', 'Delete',
]);

function sanitizeMcpToolName(name) {
  if (CURSOR_RESERVED_TOOL_NAMES.has(name)) return `mcp_${name}`;
  return name;
}
```

### 15.4 教训

- **Cursor 有保留工具名列表**
- **PascalCase 工具名更容易冲突**：第三方 MCP 应用 snake_case 或加前缀

---

## 16. Claude Code CLI 适配器缺失导致工具调用失败和 Session 断裂

### 16.1 问题描述

Claude Code CLI（独立命令行版本）连接代理服务后：
1. 工具调用报 "invalid arguments" 错误
2. 模型访问了错误的目录（代理服务器的工作目录而非用户的工作目录）

### 16.2 根因分析

**三层问题叠加：**

**问题 A：适配器缺失** — Claude Code CLI 使用全小写工具名（`bash`, `read`, `write`, `edit`, `grep`, `glob`），与现有的 `claude-code` 适配器（PascalCase: `Bash`, `Read`, `Write`, `StrReplace`）和 `opencode` 适配器（`read_file`, `write_file`, `str_replace`）都不匹配。

**问题 B：检测器优先级错误** — `detectClient()` 以 API key 优先匹配，如果用户配置了错误的 key（如 `opencode`），会短路工具名启发式检测，导致错误的 adapter 被选中。

**问题 C：KV-only 工具调用导致 Session 断裂** — Cursor 模型同时调用多个工具时，部分工具只出现在 KV FINAL response 中（没有对应的 `exec_server_message`）。当客户端返回这些 KV-mapped 工具的结果时，系统无法通过 BidiAppend 发送回 Cursor，只能 `signalling fresh request` 销毁 session 重新开始。新 session 中模型重新推理，可能做出不同决策。

### 16.3 修复

**A. 新增 `claude-code-cli` 适配器** — `src/adapters/claude-code-cli.js`

```javascript
toolNameMap: {
  file_read: 'read', file_write: 'write', file_edit: 'edit',
  shell_exec: 'bash', content_search: 'grep', file_search: 'glob',
  dir_list: 'ls', file_delete: 'delete',
  web_fetch: 'webfetch', web_search: 'websearch',
  todo_write: 'todowrite', todo_read: 'todoread',
}
```

**B. 检测器改为"工具名优先"** — `src/adapters/detector.js`

工具名启发式现在优先于 API key 匹配。关键区分逻辑：
- PascalCase 原始名（`StrReplace`, `Bash`）→ `claude-code`
- 全小写 + bash + read + grep 组合 → `claude-code-cli`
- `read_file` / `write_file` → `opencode`
- `exec` → `openclaw`

**C. 问题 C 暂未修复** — KV-only 工具调用导致 session 断裂是更深层的架构问题，需要在 agentClient 层面支持对 KV-mapped 工具结果的 BidiAppend 传输。

### 16.4 教训

- **不同版本的同一客户端可能有完全不同的工具命名风格** — Claude Code Cursor 集成版用 PascalCase，CLI 版用全小写
- **检测策略应以"做了什么"（工具名）优先于"说了什么"（API key）** — 用户可能配置错误的 key
- **Cursor 的 exec_server_message 并非覆盖所有工具调用** — 部分只出现在 KV FINAL 中，需要有降级策略

---

## 17. exec path fallback 使用 process.cwd() 导致工具操作错误目录

### 17.1 问题描述

Claude Code CLI 在 `~/Downloads/cursor逆向agent客户端` 目录下运行，但模型的 `Grep` 工具调用却搜索了代理服务器的目录 `/Users/taxue/Documents/AI/Cursor-To-OpenAI`。

### 17.2 根因分析

**触发链路：**

1. Cursor 模型同时调用 `Glob` + `Read`，其中 `Glob` 只出现在 KV FINAL（无 exec_server_message）
2. `Glob` 的 KV-mapped 结果触发 `needsFreshRequest: true`，session 被销毁
3. fresh request 中模型重新推理，发出 `grep` exec，但 `execRequest.path` 为 `undefined`
4. `execRequestToToolUse` 中 `path: execRequest.path || process.cwd()` fallback 到了代理进程的工作目录

**直接原因：** `sessionManager.js` 的 `execRequestToToolUse` 和 `sendToolResult` 中，当 Cursor 的 exec request 没有提供 `path` 时，fallback 使用 `process.cwd()` —— 这是代理服务器自身的工作目录，不是用户的。

### 17.3 修复

将所有 `process.cwd()` fallback 替换为 `session.agentClient?.workspacePath`：

```javascript
// execRequestToToolUse 函数开头
const sessionCwd = session.agentClient?.workspacePath || process.cwd();

// grep/ls 的 path fallback
canonInput = { pattern: execRequest.pattern, path: execRequest.path || sessionCwd };

// sendToolResult 的 cwd fallback
cwd: cursorRequest.cwd || session.agentClient?.workspacePath || process.cwd(),
```

共修改 4 处 `process.cwd()` fallback（adapter 路径 2 处 + legacy 路径 2 处）+ 1 处 `sendToolResult` 中的 cwd。

### 17.4 教训

- **`process.cwd()` 在代理服务中几乎总是错误的** — 应该用从客户端 system prompt 提取的 `workspacePath`
- **KV-mapped 工具 → fresh request → 新 exec 的 path 可能为空** — 这种路径需要正确的 fallback
- **session 对象应该是唯一的"真相来源"** — 工作目录信息应通过 `session.agentClient.workspacePath` 获取，而非全局状态
