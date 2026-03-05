# CursorGateway 开发指南

本文件是 AI 助手的**入口文档**，提供项目开发原则和详细文档索引。具体技术细节请查阅 `docs/` 目录下的对应文档。

---

## 文档索引

| 文档 | 路径 | 内容 |
|------|------|------|
| **架构文档** | [docs/architecture.md](docs/architecture.md) | 项目整体架构、目录结构、核心组件、通信协议、超时策略 |
| **工具调用机制** | [docs/tool-calling.md](docs/tool-calling.md) | 原生 Exec 工具 vs MCP 扩展工具的完整运行机制、参数映射、Session 生命周期 |
| **Proto Schema** | [docs/cursor-agent-proto-schema.md](docs/cursor-agent-proto-schema.md) | Cursor Agent 协议的 Protobuf 消息定义（逆向得到） |
| **工具映射设计** | [docs/tool-mapping-design.md](docs/tool-mapping-design.md) | Cursor 原生工具 ↔ 客户端工具的映射策略与设计决策 |
| **踩坑记录** | [docs/pitfalls.md](docs/pitfalls.md) | 开发过程中遇到的所有问题、根因分析、修复方案、教训 |

---

## 架构认知

### agent.v1 不是纯模型 API

`agent.v1.AgentService/RunSSE` 是一个**带工具路由的 Agent 协议**，不是简单的 chat completion API。

- 模型输出经过 Cursor 服务端解析，识别出工具调用后通过 `exec_server_message` 发给客户端
- 客户端执行工具后通过 `BidiAppend` 返回结果
- Cursor 服务端做的是**路由**，不是执行

### Cursor 支持 MCP 扩展工具

Cursor 的 agent 协议完全支持自定义工具（通过 MCP 机制）。MCP 工具注册在 `RequestContext.mcp_tools`（field 7）+ `AgentRunRequest.mcp_tools`（field 4），工具调用通过 `exec_server_message` field 11（McpArgs）路由回客户端。

### 原生工具分流核心原则

**不和 Cursor 内置工具对抗**。将客户端工具分两类：

- **原生覆盖**（Read, Write, Bash, Grep 等）：不注册 MCP，让模型自然使用原生工具，通过 `execRequestToToolUse` 映射
- **MCP 扩展**（WebFetch, TodoWrite, Task 等）：注册 MCP + prompt 注入

---

## 开发原则

### 1. 修复验证规范（最高优先级）

**任何代码修改都必须完成以下全部步骤：**

1. **补充或更新对应的测试用例**：覆盖所有场景（正常路径、错误路径、边界情况）
2. **运行全部测试并通过**：`for f in test/unit/*.test.js; do node "$f"; done` 全部 PASS
3. **测试必须验证真实效果**：Read → 真的返回内容；Write → 文件真的存在且正确；去重 → 旧数据真的被过滤
4. **不允许只写代码不写测试**
5. **测试通过后必须重启服务**：

```bash
lsof -ti:3010 | xargs kill -9 2>/dev/null; sleep 1 && node src/app.js
```

> Node.js 不会热更新，`require()` 缓存的是启动时的代码。测试文件每次运行重新加载所以能通过，但运行中的服务用的还是旧代码。

### 2. 复现验证

1. 构造 `node -e` 脚本模拟实际请求
2. 脚本必须输出明确的 PASS/FAIL，不能靠"应该没问题了"
3. 覆盖边界情况

### 3. 知识库维护

每次修复新 bug 后，必须更新 [docs/pitfalls.md](docs/pitfalls.md)：

- **问题描述**：什么场景下出了什么错
- **根因分析**：为什么会出这个问题
- **修复方案**：改了哪些文件、关键代码片段
- **教训**：以后如何避免同类问题

### 4. 编码规范

- **修改 proto 编码后必须验证**：用简单工具（如只有一个参数的 Read）测试编码是否正确
- **添加日志时标注来源**：`[AgentClient]`、`[SessionManager]`、`[Messages API]` 区分层级
- **Git 提交使用中文**：格式 `<type>(<scope>): <中文描述>`
- **不要假设字段含义**：所有 proto 字段必须通过逆向或公开 proto 验证
- **先检查是否有现成机制**：Cursor 的 MCP 支持、KV blob、exec_server_message，不要急于自造方案
- **每次代码修改必须用 curl 实际测试**：不能只跑单元测试就认为没问题
- **逆向 proto schema 时必须从 Cursor.app 官方源码**：搜索 `workbench.desktop.main.js` 中的 `agent.v1.` typeName 定义

### 5. 禁止的行为

- **修改代码后不写测试就停下来**
- **不跑全部测试就提交代码**
- **测试通过后不重启服务就说"修好了"**
- **只跑单元测试不做端到端验证**（如果涉及 API 调用链路）
- **验证脚本输出含糊结果**

---

## 测试清单

| 文件 | 断言数 | 覆盖范围 |
|------|-------|---------|
| `test/unit/native-tool-filter.test.js` | 52 | 原生工具分流过滤、参数映射 |
| `test/unit/all-tools-coverage.test.js` | 111 | 全部 14 个客户端工具覆盖 |
| `test/unit/schema-validation.test.js` | 39 | 参数名与客户端 schema 一致性 |
| `test/unit/workspace-path.test.js` | 26 | 工作目录提取、传播、protobuf 编码 |
| `test/unit/cross-turn-dedup.test.js` | 62 | 跨轮次签名去重、KV 重放过滤 |
| `test/unit/session-continuation.test.js` | 71 | 并发锁、多轮生命周期、超时重试 |
| `test/unit/tool-flow-automation.test.js` | 13 | mapAgentChunkToToolUse 分发逻辑 |
| `test/unit/kv-tool-adapter.test.js` | — | KV 工具适配器参数映射 |
| `test/unit/text-tool-fallback.test.js` | — | 文本解析回退工具调用 |
| `test/unit/exec-param-normalize.test.js` | 22 | exec 路径参数标准化、Edit→StrReplace 映射 |
| `test/unit/allskipped-final-timeout.test.js` | 27 | allToolCallsSkipped 超时、空 FINAL 检测 |
| `test/unit/mcp-registration.test.js` | 13 | McpTools wrapper 构建、双重注册完整性 |
| `test/unit/mcp-name-sanitize.test.js` | 33 | MCP 工具名冲突处理 |
| `test/integration/e2e-tool-roundtrip.test.js` | 245 | 端到端工具链路（含 HTTP 验证） |
| `test/integration/tool-outcome.test.js` | 63 | 工具执行真实文件效果验证 |
| `test/integration/mcp-fix.test.js` | — | MCP 工具调用集成 |
