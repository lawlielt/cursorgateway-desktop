# CursorGateway 架构文档

## 项目概述

CursorGateway 是一个 **Cursor API 协议网关**，将 Cursor 编辑器的 AI 能力（Claude、GPT-4 等）通过标准的 OpenAI / Anthropic 兼容 API 暴露出来，支持完整的 **Agent 模式**（工具调用）和**多客户端适配**。

```text
客户端 (Claude Code / opencode / openclaw / SDK)
    │
    ▼
CursorGateway（协议转换 + 工具路由 + 多客户端适配）
    │
    ▼
Cursor API (api2.cursor.sh)
    │
    ▼
AI 模型 (Claude / GPT-4 / ...)
```

---

## 核心架构

### 两种工作模式

#### 普通模式（Simple Mode）

简单的聊天问答，无工具调用。

```text
客户端 → OpenAI 格式请求 → 代理 → Protobuf 编码 → Cursor API
                                                        │
客户端 ← OpenAI 格式响应 ← 代理 ← Protobuf 解码 ← ─────┘
```

#### Agent 模式（Agent Mode）

AI 可以主动调用工具（执行命令、读写文件、搜索等），需要双向通信。

```text
客户端 → 请求（含 tools）→ 代理 → RunSSE + MCP 注册 → Cursor API
                                                            │
                           ┌── ExecServerMessage (工具调用) ←┘
                           │
                           ├─ 原生 exec? → execRequestToToolUse → 客户端执行
                           ├─ MCP 调用?  → restoreMcpToolName   → 客户端执行
                           │                                        │
                           │         tool_result ←──────────────────┘
                           │              │
                           ├─ sendToolResult → BidiAppend → Cursor API
                           │                                    │
                           ├── continueStream ←─────────────────┘
                           │
                           └─ 循环直到无更多工具调用 → 返回最终结果
```

---

## 项目目录结构

```text
src/
├── app.js                         服务器入口
├── config/
│   └── config.js                  配置（端口、代理、超时等）
├── middleware/
│   └── auth.js                    认证中间件（客户端检测 + Token 验证）
├── routes/
│   ├── index.js                   路由总管
│   ├── v1.js                      OpenAI Chat Completions API
│   ├── messages.js                Anthropic Messages API（Agent 核心）
│   ├── completions.js             OpenAI Legacy Completions API
│   ├── responses.js               OpenAI Responses API
│   └── cursor.js                  登录接口
├── adapters/
│   ├── detector.js                客户端类型检测
│   ├── base.js                    适配器基类
│   ├── claude-code.js             Claude Code 适配器
│   ├── opencode.js                opencode 适配器
│   └── openclaw.js                openclaw 适配器
├── utils/
│   ├── agentClient.js             Agent 协议客户端（RunSSE / BidiAppend）
│   ├── sessionManager.js          Session 管理（生命周期 / 并发锁 / 工具映射）
│   ├── bidiToolFlowAdapter.js     工具流适配（exec + KV 统一分发）
│   ├── kvToolAdapter.js           KV 工具适配（参数标准化 / 名字路由）
│   ├── toolsAdapter.js            工具分流（原生覆盖 vs MCP）
│   ├── tokenManager.js            Token 管理
│   ├── protoEncoder.js            Protobuf 编解码
│   ├── modelMapper.js             模型名称映射
│   └── utils.js                   工具函数
└── docs/                          文档
```

---

## 核心组件

### 1. 请求入口层

| 路由 | 文件 | 协议 | 说明 |
|------|------|------|------|
| `POST /v1/chat/completions` | `routes/v1.js` | OpenAI Chat | 通用聊天接口 |
| `POST /v1/messages` | `routes/messages.js` | Anthropic | Agent 模式核心，支持 tool_use/tool_result |
| `POST /v1/completions` | `routes/completions.js` | OpenAI Legacy | 兼容旧版 API |
| `POST /v1/responses` | `routes/responses.js` | OpenAI Responses | 新版 API |
| `GET /v1/models` | `routes/v1.js` | OpenAI | 模型列表 |

### 2. 多客户端适配层

`src/adapters/` 下的适配器负责将不同客户端的工具名和参数格式映射到内部标准（Canonical）格式。

```text
Claude Code 工具: Read, Write, StrReplace, Bash, Grep, Glob, ...
opencode 工具:    read_file, write_file, replace_string, bash, ...
openclaw 工具:    Read, Write, Edit, Bash, ...
                    │
                    ▼
              Canonical 格式（代理内部标准）
                    │
                    ▼
              Cursor 原生 exec / MCP
```

客户端检测逻辑在 `src/adapters/detector.js`，通过 `x-api-key` 值或工具名特征自动识别。

### 3. Agent 协议层

#### agentClient.js

核心职责：
- 构建 `AgentRunRequest`（含 MCP 工具注册）
- 发送 `POST /agent.v1.AgentService/RunSSE`
- 解析 SSE 响应（InteractionUpdate / ExecServerMessage / KV）
- 通过 `POST /agent.v1.AgentService/BidiAppend` 返回工具结果
- 管理跨轮次去重状态（`_handledExecIds` / `_handledExecSignatures`）

#### sessionManager.js

核心职责：
- Session 生命周期管理（创建、查找、清理）
- `execRequestToToolUse()` — 将 Cursor exec 参数转为客户端格式
- `sendToolResult()` — 将客户端执行结果编码回 Cursor 格式
- 并发锁（`acquireContinuationLock` / `releaseContinuationLock`）

### 4. 工具分流层

#### 原生覆盖工具

不注册 MCP。模型使用 Cursor 内置工具（read/write/shell/grep 等），代理通过 `execRequestToToolUse()` 映射回客户端工具格式。

覆盖工具列表：Read, Write, StrReplace, Bash/Shell, Grep, Glob, LS, Delete

#### MCP 扩展工具

注册为 MCP + prompt 注入。通过 `ExecServerMessage` field 11（McpArgs）接收调用。

MCP 工具列表：WebFetch, WebSearch, TodoWrite, TodoRead, Task, EditNotebook, ListMcpResources, FetchMcpResource

> 详细机制见 [docs/tool-calling.md](./tool-calling.md)

### 5. 参数标准化层

`kvToolAdapter.js` 的 `normalizeInputForTool()` 根据客户端工具 schema 动态适配参数名：

```text
Cursor exec 输出: { file_path: "/a.txt", content: "hello" }
                          │
                adaptKvToolUseToIde(toolUse, clientTools)
                          │
Claude Code schema: { path: "/a.txt", contents: "hello" }
```

关键点：不硬编码参数名，根据客户端实际提供的 `input_schema` 中 `required` / `properties` 字段动态决定。

---

## 通信协议

### 与 Cursor API 的通信

- **协议**：Connect Protocol（基于 HTTP/2）
- **数据格式**：Protobuf
- **初始请求**：`POST /agent.v1.AgentService/RunSSE`（SSE 流）
- **续传/结果**：`POST /agent.v1.AgentService/BidiAppend`

SSE 帧格式：`[flags:1字节][length:4字节 BE][data:protobuf]`

> 详细 proto 定义见 [docs/cursor-agent-proto-schema.md](./cursor-agent-proto-schema.md)

### 与客户端的通信

- **协议**：HTTP/1.1 + SSE
- **数据格式**：JSON（OpenAI / Anthropic 格式）
- **流式**：Server-Sent Events

---

## 超时策略

| 超时项 | 默认值 | 说明 |
|-------|-------|------|
| chatStream 空闲 | 3 分钟 | 无数据超时 |
| continueStream 首事件 | 120 秒 | 等待第一个有效事件 |
| continueStream 空闲 | 60 秒 | 两次有效事件间隔 |
| BidiAppend 单次 | 15 秒 | 网络请求超时 |
| BidiAppend 重试 | 3 次 | 指数退避 1s → 2s → 4s |
| 并发锁等待 | 90 秒 | 等待前一个 continuation 完成 |

心跳（`InteractionUpdate.heartbeat`）不算有意义活动，不重置超时。

---

## 支持的 API 端点

| 端点 | 方法 | 协议 | 说明 |
|------|------|------|------|
| `/v1/models` | GET | OpenAI | 可用模型列表 |
| `/v1/chat/completions` | POST | OpenAI Chat | 聊天补全（流式/非流式） |
| `/v1/completions` | POST | OpenAI Legacy | 文本补全 |
| `/v1/responses` | POST | OpenAI Responses | 新版 Responses API |
| `/v1/messages` | POST | Anthropic | Anthropic Messages API（Agent 模式核心） |
| `/cursor/loginDeepControl` | GET | 内部 | 浏览器登录获取 Token |
