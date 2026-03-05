# Cursor 工具调用机制详解

本文档详细说明 CursorGateway 中工具调用的完整运行机制，包括原生工具（Native Exec）和扩展工具（MCP）两条路径。

---

## 概述

Cursor 的 Agent 模式支持两种工具调用通道：

| 通道 | 触发方式 | 适用工具 | 通信协议 |
|------|---------|---------|---------|
| **原生 Exec** | `ExecServerMessage` field 2-8, 10, 14 | 文件读写、Shell、搜索等内置工具 | Protobuf 双向流（BidiAppend） |
| **MCP 扩展** | `ExecServerMessage` field 11（McpArgs） | 任意自定义工具（web_fetch、todo_write 等） | Protobuf 双向流 + MCP 注册 |

此外还有一个辅助通道：

| 通道 | 触发方式 | 说明 |
|------|---------|------|
| **KV Blob** | `kv_server_message` field 4 | 模型最终响应中的工具调用，可能与 Exec 通道重复 |

---

## 一、原生 Exec 工具调用

### 1.1 流程

```text
Cursor API                         CursorGateway                        客户端 (Claude Code 等)
    │                                    │                                    │
    │ ── ExecServerMessage ──────────>   │                                    │
    │    (field 2: ShellArgs)            │                                    │
    │                                    │ parseExecServerMessage()           │
    │                                    │ execRequestToToolUse()             │
    │                                    │ adaptKvToolUseToIde()              │
    │                                    │                                    │
    │                                    │ ── tool_use (Bash) ──────────────> │
    │                                    │                                    │
    │                                    │ <── tool_result ─────────────────  │
    │                                    │                                    │
    │                                    │ sendToolResult()                   │
    │                                    │ buildShellResultMessage()          │
    │                                    │                                    │
    │ <── BidiAppend (结果) ────────────  │                                    │
    │                                    │                                    │
```

### 1.2 ExecServerMessage 字段映射

Cursor 通过 `ExecServerMessage` 发送原生工具调用。每种工具对应一个 protobuf field：

| Field | Wire Type | 工具类型 | 参数结构 |
|-------|-----------|---------|---------|
| 1 | uint32 | — | `id`（请求序号） |
| 2 | message | Shell | `ShellArgs { 1: command, 2: cwd }` |
| 3 | message | Write | `WriteArgs { 1: path, 2: fileText, 3: toolCallId }` |
| 4 | message | Delete | `DeleteArgs { 1: path }` |
| 5 | message | Grep | `GrepArgs { 1: pattern, 2: path, 3: glob }` |
| 7 | message | Read | `ReadArgs { 1: path }` |
| 8 | message | LS | `LsArgs { 1: path }` |
| 10 | message | RequestContext | 请求工作区上下文（必须本地处理） |
| 11 | message | MCP | `McpArgs`（见 MCP 章节） |
| 14 | message | Shell v2 | `ShellArgs`（流式 shell，同 field 2 格式） |
| 15 | string | — | `exec_id`（执行标识） |
| 20 | message | Fetch | `FetchArgs`（网络请求） |
| 28 | message | Subagent | `SubagentArgs`（子代理） |

> **注意**：field 4 是 `DeleteArgs`，不是 `ReadArgs`。这是早期逆向时的常见错误。

### 1.3 参数映射

`execRequestToToolUse()` 将 Cursor 原生参数转为中间格式：

| Cursor 工具 | 中间格式参数 |
|------------|------------|
| Shell (field 2/14) | `{ command, working_directory }` |
| Write (field 3) | `{ file_path, content }` |
| Delete (field 4) | `{ file_path }` |
| Grep (field 5) | `{ pattern, path, glob }` |
| Read (field 7) | `{ file_path }` |
| LS (field 8) | `{ path }` |

然后 `adaptKvToolUseToIde()` → `normalizeInputForTool()` 根据客户端工具 schema 动态标准化参数名：

```text
Cursor exec: { file_path: "/a.txt", content: "hello" }
     ↓ normalizeInputForTool (根据 Claude Code schema)
Claude Code: { path: "/a.txt", contents: "hello" }
     ↓ normalizeInputForTool (根据 opencode schema)
opencode:    { file_path: "/a.txt", content: "hello" }
```

### 1.4 结果返回

工具执行完成后，`agentClient.sendToolResult()` 根据工具类型构建对应的 Protobuf 结果消息：

| 工具类型 | 构建函数 | 结果结构 |
|---------|---------|---------|
| Shell | `buildShellResultMessage` | `{ output, exitCode, cwd }` |
| Read | `buildReadResultMessage` | `{ content, path }` |
| Write | `buildWriteResultMessage` | `{ success: { path, linesWritten } }` 或 `{ error: { path, error } }` |
| Delete | `buildDeleteResultMessage` | `{ path }` |
| Grep | `buildGrepResultMessage` | `{ results }` |
| LS | `buildLsResultMessage` | `{ entries }` |
| RequestContext | `buildRequestContextResultMessage` | `{ workspacePath, os, shell }` |

结果通过 `bidiAppend()` 发送回 Cursor API。

### 1.5 Edit → StrReplace 智能路由

Cursor 模型的文件编辑操作使用 `Edit` 工具名，但根据参数不同，语义可能是 StrReplace 或 Write：

```text
Edit + { old_string, new_string }  →  StrReplace（部分替换）
Edit + { content }                  →  Write（全文件写入）
```

`adaptKvToolUseToIde()` 中的输入感知路由：

```javascript
if ((name === 'edit' || name === 'edit_file') &&
    ('old_string' in input || 'new_string' in input)) {
  // → 映射为 StrReplace
}
```

---

## 二、MCP 扩展工具调用

### 2.1 什么工具走 MCP

没有直接对应 Cursor 原生 exec 的工具通过 MCP 机制注册：

| MCP 工具 | 说明 |
|----------|------|
| `web_fetch` / `WebFetch` | 获取网页内容 |
| `web_search` / `WebSearch` | 网页搜索 |
| `todo_write` / `TodoWrite` | 写入/更新待办事项 |
| `todo_read` / `TodoRead` | 读取待办事项 |
| `Task` | 子任务管理 |
| `EditNotebook` | 编辑 Jupyter Notebook |
| `ListMcpResources` | 列出 MCP 资源 |
| `FetchMcpResource` | 获取 MCP 资源 |

### 2.2 MCP 注册（双重注册）

MCP 工具需要在两个位置注册，缺一不可：

#### 位置一：AgentRunRequest.field 4 — McpTools wrapper

告诉 Cursor **路由层**："我的客户端支持这些 MCP 工具，请通过 `ExecServerMessage` field 11 转发给我"。

```text
AgentRunRequest {
  field 4 (McpTools) {
    repeated McpToolDescriptor {
      1: name          // 工具名（已 sanitize）
      2: description   // 工具描述
      3: input_schema  // JSON Schema → google.protobuf.Value
      4: provider_identifier  // "cursor-tools"
      5: tool_name     // 同 name
    }
  }
}
```

#### 位置二：RequestContext.field 7 — 模型可见工具列表

告诉 Cursor **模型层**："这些工具存在，你可以在回复中调用它们"。

```text
RequestContext {
  field 7 (repeated McpToolDefinition) {
    1: name          // 工具名（已 sanitize）
    2: description   // 工具描述
    3: input_schema  // JSON Schema → google.protobuf.Value
    4: provider_identifier  // "cursor-tools"
    5: tool_name     // 同 name
  }
  field 14 (McpInstructions) {
    1: identifier    // "cursor-tools"
    2: instructions  // 文本描述，指导模型如何使用工具
  }
}
```

**缺少 field 4**：模型知道工具但 Cursor 不路由 → 工具调用请求不会到达客户端。

**缺少 field 7**：Cursor 路由就绪但模型不知道工具 → 模型不会发起调用。

### 2.3 工具名冲突处理

Cursor 服务端有内部保留工具名，以相同名字注册 MCP 会导致 `grpc-status: 8 (Provider Error)`。

保留名列表：

```
TodoWrite, WebFetch, Task, EditNotebook, FetchMcpResource, Delete
```

解决方案 — 注册时加 `mcp_` 前缀，回调时去掉前缀：

```text
注册: TodoWrite → mcp_TodoWrite（发给 Cursor）
回调: mcp_TodoWrite → TodoWrite（还原给客户端）
```

### 2.4 MCP 调用流程

```text
Cursor API                         CursorGateway                        客户端
    │                                    │                                    │
    │ ── ExecServerMessage ──────────>   │                                    │
    │    field 11 (McpArgs) {            │                                    │
    │      name: "mcp_WebFetch"          │                                    │
    │      args: { url: "..." }          │ parseExecServerMessage()           │
    │      tool_call_id: "xxx"           │ restoreMcpToolName()               │
    │    }                               │   → name: "WebFetch"              │
    │                                    │ execRequestToToolUse()             │
    │                                    │                                    │
    │                                    │ ── tool_use (WebFetch) ──────────> │
    │                                    │                                    │
    │                                    │ <── tool_result ─────────────────  │
    │                                    │                                    │
    │                                    │ buildMcpResultMessage()            │
    │ <── BidiAppend (McpResult) ──────  │                                    │
    │                                    │                                    │
```

### 2.5 McpArgs 解析

`ExecServerMessage` field 11 包含 `McpArgs` 消息：

```text
McpArgs {
  1: string name              // MCP 工具名（可能有 mcp_ 前缀）
  2: google.protobuf.Struct args  // 工具参数（Struct 编码）
  3: string tool_call_id
  4: string provider_identifier
  5: string tool_name
}
```

**关键**：`args` 是 `google.protobuf.Struct`（field 2），不是 JSON 字符串。需要用 `decodeProtobufStruct()` 解码。

### 2.6 McpResult 编码

```text
McpResult (ExecClientMessage field 11) {
  oneof {
    1: McpSuccess success {
      repeated McpToolResultContentItem content {
        oneof {
          1: McpTextContent text {
            1: string text    // 实际文本内容
          }
          2: McpImageContent image
        }
      }
      bool is_error
    }
    2: McpError error {
      1: string error
    }
    3: McpRejected rejected
    4: McpPermissionDenied permission_denied
    5: McpToolNotFound tool_not_found
    6: McpToolError tool_error
  }
}
```

---

## 三、KV Blob 辅助通道

### 3.1 什么是 KV

`kv_server_message`（SSE 响应中的 field 4）是 Cursor 的大数据传输通道。模型的完整响应（含文本和工具调用）可能通过 KV blob 传递，而非 `interaction_update`。

### 3.2 KV FINAL 响应

KV blob 中的 JSON 包含 `role: "assistant"` 且有 `id` 字段时，这是**最终响应**。其 `content` 数组可能包含 `tool-call` / `tool-use` 类型的块。

### 3.3 与 Exec 通道的去重

同一个工具调用可能同时出现在 Exec 和 KV 两个通道。代理使用**签名去重**避免重复执行：

```text
签名 = toolName + JSON.stringify(sortedArgs)
```

- `_handledExecIds`：记录已处理的 exec id
- `_handledExecSignatures`：记录已处理的工具签名
- 这两个集合在 `chatStream` → `continueStream` 之间**跨轮次传递**

---

## 四、原生工具分流策略

### 4.1 核心原则：不和 Cursor 内置工具对抗

将客户端工具分为两类处理：

| 类别 | 工具 | 注册方式 | 调用路径 |
|------|------|---------|---------|
| **原生覆盖** | Read, Write, StrReplace, Bash, Grep, Glob, LS, Delete | 不注册 MCP | 通过 ExecServerMessage → execRequestToToolUse 映射 |
| **MCP 扩展** | WebFetch, WebSearch, TodoWrite, Task 等 | 注册 MCP + prompt 注入 | 通过 McpArgs 或文本解析 |

**为什么不把所有工具都注册为 MCP？** Cursor 模型在文件操作场景会优先使用原生工具（read/write/shell），忽略同名的 MCP 工具。如果把 StrReplace 注册为 MCP，模型会在"想调 StrReplace 但调不了"的循环中死锁。

### 4.2 text_fallback 机制

当 MCP 工具调用没有通过 `ExecServerMessage` field 11 到达（可能因为注册失败或模型通过文本描述工具调用），代理会解析模型输出的文本，提取工具调用：

```text
模型输出文本中包含:
  <tool_use>
    <name>WebFetch</name>
    <input>{"url": "..."}</input>
  </tool_use>

代理解析后生成 tool_use 块发给客户端
```

这是最后的兜底机制。text_fallback 工具结果无法通过 BidiAppend 发回，需要关闭当前 session 用 fresh request 重建。

---

## 五、Session 生命周期

### 5.1 完整流程

```text
新请求（无 tool_result）
    │
    ├─ createSession(agentClient)
    ├─ agentClient.chatStream()
    │      ↓
    │   ExecServerMessage / KV 工具调用
    │      ↓
    │   mapAgentChunkToToolUse() → 去重 → 参数标准化
    │      ↓
    │   yield tool_use → 客户端执行
    │
    └─ 有工具调用 → session 保持
       无工具调用 → cleanupSession()

续请求（有 tool_result）
    │
    ├─ findSessionByToolCallId() 或 getSession()
    ├─ acquireContinuationLock()  // 防并发
    ├─ sendToolResult()
    │      ↓
    │   构建 Protobuf 结果 → bidiAppend()
    │      ↓
    │   sendResumeAction()
    │
    ├─ continueStream()
    │      ↓
    │   继续读取 SSE 流（继承去重状态）
    │      ↓
    │   新的文本 / 新的工具调用
    │
    ├─ releaseContinuationLock()
    └─ 有工具调用 → session 保持
       无工具调用 → cleanupSession()
```

### 5.2 并发控制

Claude Code / opencode 等客户端在代理响应较慢时（>3-5秒）会**重发相同请求**。代理通过 `acquireContinuationLock()` / `releaseContinuationLock()` 确保同一 session 同时只有一个请求在处理 continuation。

后到的请求等待锁释放，超时后回退为 fresh request（用完整对话历史新建 session）。

---

## 六、关键代码位置

| 模块 | 文件 | 职责 |
|------|------|------|
| Agent 协议客户端 | `src/utils/agentClient.js` | 构建 AgentRunRequest、解析 ExecServerMessage、MCP 注册/结果编码 |
| 工具流适配 | `src/utils/bidiToolFlowAdapter.js` | `mapAgentChunkToToolUse()` — 统一 exec/KV 两条路径的工具调用分发 |
| KV 工具适配 | `src/utils/kvToolAdapter.js` | `adaptKvToolUseToIde()` / `normalizeInputForTool()` — 参数标准化 |
| 工具过滤 | `src/utils/toolsAdapter.js` | `filterNonNativeTools()` — 分离原生覆盖 vs MCP 工具 |
| Session 管理 | `src/utils/sessionManager.js` | Session 生命周期、`execRequestToToolUse()`、`sendToolResult()` |
| Protobuf 编解码 | `src/utils/protoEncoder.js` | 底层 encode/decode，含 `google.protobuf.Struct/Value` |
| 客户端适配器 | `src/adapters/` | 多客户端工具名/参数映射 |
