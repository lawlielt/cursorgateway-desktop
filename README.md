# CursorGateway

将 Cursor 编辑器的 AI 能力转换为标准 OpenAI / Anthropic API，让你可以在任何兼容的客户端中使用 Cursor 订阅的模型。

> 基于逆向工程 Cursor 客户端 Protobuf 协议实现，兼容 Cursor 2.3.41+。

## 它能做什么？

简单来说，这个代理服务器充当了一个"翻译官"：

```text
你的程序 / CLI 工具（OpenAI SDK、Anthropic SDK、Claude Code、opencode 等）
        ↓ 标准 API 请求
CursorGateway 代理（本地运行）
        ↓ Cursor 私有协议（Protobuf + HTTP/2）
Cursor API 服务器
        ↓
Claude / GPT / Gemini 等 AI 模型
```

你只需要一个 Cursor 账号，就能把 Cursor 订阅的所有模型暴露为标准 OpenAI API，供任意客户端使用。

## 主要特性

- **多协议兼容** — 同时支持 OpenAI Chat Completions、Completions (Legacy)、Responses API 和 Anthropic Messages API
- **Agent 模式** — 支持工具调用（Tool Calling），AI 可以执行命令、读写文件、搜索代码等
- **多客户端适配** — 自动识别 Claude Code、opencode、openclaw 等不同客户端，适配各自的工具名和参数格式
- **流式输出** — SSE 实时流式响应
- **多模型访问** — Claude、GPT、Gemini 等 Cursor 支持的所有模型
- **智能模型映射** — 自动将外部模型名（如 `claude-3.5-sonnet`）映射为 Cursor 内部名称
- **Token 持久化** — 登录一次，token 自动保存，后续无需重复认证

---

## 快速开始

### 前置要求

- **Node.js** 18+（推荐 20 LTS）
- **npm**（随 Node.js 附带）
- 一个 **Cursor 账号**（需要有效的订阅）

### 安装

```bash
git clone https://github.com/taxue2016/CursorGateway.git
cd CursorGateway
npm install
```

### 获取 Token

代理需要 Cursor 的认证 Token 才能访问 AI 模型。提供了两种方式获取：

#### 方式一：命令行登录（推荐）

```bash
npm run login
```

运行后会输出一个登录链接，在浏览器中打开并登录你的 Cursor 账号。登录成功后 Token 会自动保存到项目根目录的 `.cursor-token` 文件中。

> `.cursor-token` 已添加到 `.gitignore`，不会被提交到 Git。

#### 方式二：手动获取

如果你已经登录了 Cursor 桌面端，可以从 Cursor 的本地存储中提取 Token：

1. 打开 Cursor IDE
1. 打开开发者工具（`Help → Toggle Developer Tools`）
1. 在 Console 中执行以下代码，获取认证信息：

```javascript
const db = await new Promise((resolve, reject) => {
  const req = indexedDB.open("cursorAuth");
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const tx = db.transaction("cursorAuth", "readonly");
const store = tx.objectStore("cursorAuth");
const keys = await new Promise(resolve => {
  const req = store.getAll();
  req.onsuccess = () => resolve(req.result);
});
console.log(JSON.stringify(keys, null, 2));
```

1. 将获取到的 `accessToken` 保存到 `.cursor-token` 文件中

### 启动服务

```bash
npm start
```

服务默认监听 `http://localhost:3010`。

启动后你会看到：

```text
The server listens port: 3010
Server URL: http://localhost:3010
[Auth] Using saved token from: /path/to/.cursor-token
```

### 验证安装

```bash
# 查看可用模型列表
curl http://localhost:3010/v1/models

# 发送一条测试消息
curl http://localhost:3010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "你好"}]
  }'
```

---

## 配置

### 端口

默认端口 `3010`，可通过环境变量修改：

```bash
PORT=8080 npm start
```

### 代理（网络代理）

如果需要通过 HTTP 代理访问 Cursor API，编辑 `src/config/config.js`：

```javascript
module.exports = {
    port: process.env.PORT || 3010,
    proxy: {
        enabled: true,
        url: 'http://127.0.0.1:7890',  // 你的代理地址
    },
};
```

### Docker 部署

```bash
# 构建镜像
docker build -t cursor-gateway .

# 运行（需要先获取 token）
docker run -d \
  -p 3010:3010 \
  -v $(pwd)/.cursor-token:/app/.cursor-token \
  --name cursor-gateway \
  cursor-gateway
```

或者使用环境变量传入 Token：

```bash
docker run -d \
  -p 3010:3010 \
  -e CURSOR_TOKEN="your-token-here" \
  --name cursor-gateway \
  cursor-gateway
```

---

## 使用教程

### 1. 作为通用 OpenAI API 使用

任何支持自定义 `base_url` 的 OpenAI 客户端都可以直接使用。

#### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    api_key="not-needed",  # 填任意值，实际认证使用本地 .cursor-token
    base_url="http://localhost:3010/v1"
)

# 普通对话
response = client.chat.completions.create(
    model="claude-4.5-sonnet",
    messages=[{"role": "user", "content": "用 Python 写一个快速排序"}]
)
print(response.choices[0].message.content)

# 流式输出
stream = client.chat.completions.create(
    model="claude-4.5-sonnet",
    messages=[{"role": "user", "content": "解释一下什么是 Transformer"}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

#### Node.js（OpenAI SDK）

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'not-needed',
  baseURL: 'http://localhost:3010/v1',
});

const response = await client.chat.completions.create({
  model: 'claude-4.5-sonnet',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(response.choices[0].message.content);
```

#### curl

```bash
# 基本对话
curl http://localhost:3010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "你好"}]
  }'

# 流式输出
curl http://localhost:3010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-4.5-sonnet",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

### 2. 作为 Anthropic API 使用

#### Python（Anthropic SDK）

```python
import anthropic

client = anthropic.Anthropic(
    api_key="not-needed",
    base_url="http://localhost:3010/v1"
)

message = client.messages.create(
    model="claude-4.5-sonnet",
    max_tokens=1024,
    messages=[{"role": "user", "content": "你好，Claude"}]
)
print(message.content[0].text)
```

### 3. 搭配 Claude Code 使用

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 是 Anthropic 官方的终端 AI 编程助手。通过本代理可以让 Claude Code 使用 Cursor 的模型额度，无需 Anthropic API 付费。

#### 方式一：环境变量（推荐快速体验）

```bash
# 设置 API 地址指向本代理
export ANTHROPIC_BASE_URL=http://localhost:3010

# API Key 设置为 "claude-code"，代理通过此值识别客户端类型
export ANTHROPIC_API_KEY=claude-code

# 启动 Claude Code
claude
```

#### 方式二：配置文件（推荐持久化）

编辑 `~/.claude/settings.json`（用户级，对所有项目生效）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3010",
    "ANTHROPIC_API_KEY": "claude-code"
  }
}
```

也可以在项目级别配置。在项目根目录创建 `.claude/settings.local.json`（不会被 Git 提交）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3010",
    "ANTHROPIC_API_KEY": "claude-code"
  }
}
```

#### 方式三：通过 apiKeyHelper 动态生成

如果你需要更灵活的认证方式，可以在 `~/.claude/settings.json` 中使用 `apiKeyHelper`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3010"
  },
  "apiKeyHelper": "echo claude-code"
}
```

#### 指定模型

Claude Code 默认使用 `claude-sonnet-4-6`，代理会自动映射为 Cursor 支持的模型。你也可以手动指定：

```bash
# 启动时指定模型
claude --model claude-4.5-sonnet

# 或在运行中切换
# 输入 /model 命令选择模型
```

#### 验证连接

启动 Claude Code 后，如果看到正常的欢迎界面并能对话，说明配置成功。同时检查代理日志 `server.log` 应能看到类似输出：

```text
[Messages API] Anthropic Messages request, client: claude-code, model: claude-4.5-sonnet
```

> **说明**：`ANTHROPIC_API_KEY` 的值 `claude-code` 不是真正的认证凭证，而是告诉代理"这是 Claude Code 客户端"。代理识别后会自动适配 Claude Code 的工具命名风格（PascalCase：`Read`、`Write`、`Bash` 等），并使用本地 `.cursor-token` 进行 Cursor API 认证。请确保已执行过 `npm run login`。

### 4. 搭配 opencode 使用

[opencode](https://github.com/opencode-ai/opencode) 是一款开源终端 AI 编程工具。

在 opencode 的配置文件中设置：

```json
{
  "provider": {
    "type": "openai",
    "api_key": "opencode",
    "base_url": "http://localhost:3010/v1"
  }
}
```

> `api_key` 的值 `opencode` 用于客户端识别，实际认证使用本地 Cursor Token。

### 5. 搭配 openclaw 使用

[openclaw](https://openclawlab.com) 是一款开源 AI 编程助手。通过本代理可以让 openclaw 使用 Cursor 的模型额度。

#### 方式一：环境变量（快速体验）

```bash
export API_KEY=openclaw
export BASE_URL=http://localhost:3010/v1

# 启动 openclaw
openclaw
```

#### 方式二：配置文件（推荐）

编辑 `~/.openclaw/openclaw.json`，在 `models.providers` 中添加自定义 provider：

```json
{
  "models": {
    "default": "cursor-proxy/claude-4.5-sonnet",
    "providers": {
      "cursor-proxy": {
        "baseUrl": "http://localhost:3010/v1",
        "apiKey": "openclaw",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-4.5-sonnet",
            "name": "Claude 4.5 Sonnet",
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "claude-4.6-opus-high",
            "name": "Claude 4.6 Opus",
            "contextWindow": 200000,
            "maxTokens": 8192
          },
          {
            "id": "gpt-5.2",
            "name": "GPT 5.2",
            "contextWindow": 128000,
            "maxTokens": 16384
          }
        ]
      }
    }
  }
}
```

配置完成后重启 openclaw gateway：

```bash
openclaw gateway restart
```

#### 验证连接

```bash
# 检查配置是否正确
openclaw doctor

# 启动后在对话中检查代理日志
# server.log 中应出现：
# [Chat API] client: openclaw, model: claude-4.5-sonnet
```

> **说明**：`apiKey` 的值 `openclaw` 用于客户端识别，代理会自动适配 openclaw 的工具命名风格（短命名：`read`、`write`、`exec` 等），实际认证使用本地 `.cursor-token`。

### 6. 搭配 Crush CLI 使用

[Crush](https://github.com/charmbracelet/crush) 是一个终端 AI 助手。

在 `~/.local/share/crush/crush.json` 中配置：

```json
{
  "default_provider": "cursor-proxy",
  "default_model": "claude-4.5-sonnet",
  "providers": {
    "cursor-proxy": {
      "kind": "openai",
      "api_key": "not-needed",
      "url": "http://localhost:3010/v1"
    }
  }
}
```

### 7. 搭配其他 OpenAI 兼容客户端

任何支持自定义 `base_url` 的 OpenAI 兼容客户端都可以使用，包括但不限于：

- **Chatbox** — 桌面端 AI 聊天工具
- **Open WebUI** — Web 界面
- **LobeChat** — 开源 AI 聊天框架
- **NextChat (ChatGPT-Next-Web)** — Web 聊天界面
- **各种编程框架** — LangChain、LlamaIndex 等

通用配置思路：

- API Base URL 设为 `http://localhost:3010/v1`
- API Key 填任意值（如已通过 `npm run login` 保存 Token）
- 模型名使用 Cursor 支持的模型名称

---

## 多客户端适配

代理内置了智能客户端识别机制，能自动检测请求来源并适配不同的工具名称和参数格式。

### 客户端识别策略

| 优先级 | 识别方式 | 示例 |
|--------|---------|------|
| 1 | API Key 精确匹配 | `x-api-key: claude-code` |
| 2 | 工具名称启发式 | 检测 `StrReplace`（Claude Code）/ `read_file`（opencode）/ `exec`（openclaw） |
| 3 | 默认 | 回退到 `claude-code` 适配器 |

### 支持的客户端

| 客户端 | 推荐 API Key | 工具命名风格 | 说明 |
|--------|-------------|-------------|------|
| Claude Code | `claude-code` | PascalCase（`Read`, `Write`, `Bash`） | Anthropic 官方 CLI |
| opencode | `opencode` | snake_case（`read_file`, `write_file`, `bash`） | 开源编程工具 |
| openclaw | `openclaw` | 短命名（`read`, `write`, `exec`） | AI 编程工具 |

### 原生工具与 MCP 工具

代理将客户端工具分为两类处理：

- **原生覆盖工具**（如文件读写、Shell 执行、搜索等）：直接映射为 Cursor 内置的执行通道，无需额外注册
- **MCP 工具**（如 `web_fetch`、`web_search`、`todo_write` 等）：通过 Cursor 的 MCP 扩展机制注册，以 Protobuf 协议传递

这种设计确保了模型总是使用最可靠的工具调用路径，避免名称冲突和路由错误。

---

## 支持的模型

代理支持 Cursor 提供的所有模型，并能自动映射外部 SDK 使用的模型名称。

### Anthropic Claude 系列

| 外部名称 | Cursor 内部名称 |
|---------|---------------|
| `claude-opus-4-6` | `claude-4.6-opus-high` |
| `claude-sonnet-4-6` | `claude-4.6-sonnet-medium` |
| `claude-sonnet-4-5-20250929` | `claude-4.5-sonnet` |
| `claude-haiku-4-5-20251001` | `claude-4.5-haiku` |
| `claude-3.5-sonnet` | `claude-4.5-sonnet` |
| `claude-3.5-haiku` | `claude-4.5-haiku` |

### OpenAI GPT 系列

| 外部名称 | Cursor 内部名称 |
|---------|---------------|
| `gpt-4` / `gpt-4o` | `gpt-5.2` |
| `gpt-4o-mini` | `gpt-5-mini` |
| `o1` / `o1-preview` | `gpt-5.1-high` |

### Google Gemini 系列

| 外部名称 | Cursor 内部名称 |
|---------|---------------|
| `gemini-pro` / `gemini-2.5-pro` | `gemini-3-pro` |
| `gemini-flash` | `gemini-3-flash` |

你也可以直接使用 Cursor 内部名称（如 `claude-4.5-sonnet`），无需映射。

完整的模型列表可通过 `GET /v1/models` 接口查询。

---

## API 端点参考

| 端点 | 方法 | 协议 | 说明 |
|------|------|------|------|
| `/v1/models` | GET | OpenAI | 获取可用模型列表 |
| `/v1/chat/completions` | POST | OpenAI Chat | 聊天补全（支持流式、Agent 模式） |
| `/v1/completions` | POST | OpenAI Legacy | 文本补全 |
| `/v1/responses` | POST | OpenAI Responses | Responses API |
| `/v1/messages` | POST | Anthropic | Anthropic Messages API（支持工具调用） |
| `/cursor/loginDeepControl` | GET | 内部 | 浏览器登录获取 Token |

### 认证与客户端识别

所有 `/v1/*` 端点需要 Cursor Token 认证。请求头 `x-api-key` 或 `Authorization: Bearer` 同时承担两个职责：

1. **客户端识别** — 代理根据 key 值判断请求来自哪个客户端
2. **Cursor 认证** — 如果 key 值是有效的 Cursor Token，直接用于认证；否则回退到本地 `.cursor-token`

#### 各客户端推荐配置

| 客户端 | 请求头 | 说明 |
|--------|--------|------|
| Claude Code | `x-api-key: claude-code` | 代理识别后自动使用本地 Token 认证 |
| opencode | `x-api-key: opencode` | 同上 |
| openclaw | `x-api-key: openclaw` | 同上 |
| 通用 SDK | `Authorization: Bearer <Cursor Token>` | 直接传入有效 Token，也可填任意值配合本地 Token |

**Token 获取优先级**：请求头中的有效 Cursor Token > 本地 `.cursor-token` 文件

如果请求头中的值不是有效 Cursor Token 格式（如 `claude-code`、`opencode`、`sk-xxx` 等），代理会将其用于客户端识别，然后自动回退使用本地保存的 Cursor Token 进行认证。因此，只要执行过 `npm run login`，各客户端只需设置对应的 key 值即可，无需关心实际的 Cursor Token。

---

## 架构概览

```text
┌──────────────────────────────────────────────────┐
│           客户端（Claude Code / opencode / SDK）    │
└──────────────────┬───────────────────────────────┘
                   │ HTTP/1.1（OpenAI / Anthropic API）
                   ▼
┌──────────────────────────────────────────────────┐
│              CursorGateway 代理                     │
│                                                    │
│  ┌────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │ 客户端适配器 │  │  路由层      │  │ 会话管理   │ │
│  │ (Adapter)   │  │  (Routes)   │  │ (Session)  │ │
│  └──────┬─────┘  └──────┬──────┘  └─────┬──────┘ │
│         │               │               │         │
│  ┌──────┴───────────────┴───────────────┴──────┐  │
│  │           AgentClient（核心）                 │  │
│  │  • Protobuf 编解码                           │  │
│  │  • HTTP/2 双向流                             │  │
│  │  • 工具调用路由                               │  │
│  │  • MCP 工具注册                              │  │
│  └─────────────────────┬───────────────────────┘  │
└────────────────────────┼──────────────────────────┘
                         │ HTTP/2 + Protobuf
                         ▼
              ┌───────────────────┐
              │   Cursor API      │
              │ (api2.cursor.sh)  │
              └───────────────────┘
```

### 工作模式

**普通模式**：客户端发送消息 → 代理转发 → AI 回复 → 返回客户端

**Agent 模式**（请求中包含 `tools` 数组时启用）：

1. 代理与 Cursor API 建立双向 HTTP/2 流
2. AI 分析请求，决定是否需要调用工具
3. 工具调用通过 `exec_server_message` 路由到代理
4. 代理将工具调用翻译为客户端格式，返回给客户端执行
5. 客户端执行完毕后将结果回传
6. 代理将结果发回 Cursor，AI 继续处理
7. 循环直到 AI 完成任务，返回最终结果

---

## 项目结构

```text
src/
├── app.js                     # 服务入口
├── config/
│   ├── config.js              # 端口、代理等配置
│   └── constants.js           # Cursor API 地址等常量
├── adapters/                  # 多客户端适配层
│   ├── base.js                # ClientAdapter 基类
│   ├── canonical.js           # 标准化工具定义
│   ├── detector.js            # 客户端自动识别
│   ├── claude-code.js         # Claude Code 适配器
│   ├── opencode.js            # opencode 适配器
│   └── openclaw.js            # openclaw 适配器
├── routes/
│   ├── index.js               # 路由注册
│   ├── v1.js                  # OpenAI Chat Completions API
│   ├── messages.js            # Anthropic Messages API
│   ├── completions.js         # OpenAI Legacy Completions API
│   ├── responses.js           # OpenAI Responses API
│   └── cursor.js              # 登录接口
├── utils/
│   ├── agentClient.js         # Cursor Agent 协议客户端（核心）
│   ├── bidiClient.js          # HTTP/2 双向流客户端
│   ├── bidiToolFlowAdapter.js # 工具调用流适配
│   ├── kvToolAdapter.js       # KV Blob 工具适配
│   ├── sessionManager.js      # 会话生命周期管理
│   ├── toolsAdapter.js        # 工具名称/参数映射
│   ├── protoEncoder.js        # Protobuf 编解码
│   ├── modelMapper.js         # 模型名称映射
│   ├── tokenManager.js        # Token 持久化管理
│   ├── sseWriter.js           # Anthropic SSE 输出
│   ├── sseWriterOpenAI.js     # OpenAI SSE 输出
│   └── ...
├── proto/
│   ├── message.proto          # Protobuf Schema 定义
│   └── message.js             # 编译后的 Protobuf 模块
└── tool/
    └── cursorLogin.js         # CLI 登录工具

test/
├── unit/                      # 单元测试
└── integration/               # 集成测试
```

---

## 开发指南

### 运行测试

```bash
# 运行所有单元测试
for f in test/unit/*.test.js; do node "$f"; done

# 运行集成测试
for f in test/integration/*.test.js; do node "$f"; done

# 运行特定测试
node test/unit/adapter-base.test.js
```

### 重新生成 Protobuf

如果修改了 `src/proto/message.proto`：

```bash
npm run proto
```

### 日志

服务运行时的日志会同时输出到：

- 终端（stdout / stderr）
- 项目根目录的 `server.log` 文件

日志格式可通过环境变量自定义：

```bash
MORGAN_FORMAT=combined npm start
```

---

## 故障排查

### "Missing authentication" 错误

确保已执行 `npm run login` 或在 `.cursor-token` 文件中放入了有效 Token。

### "Provider Error (grpc-status: 8)" 错误

通常是 Token 过期或模型不可用。尝试：

1. 重新执行 `npm run login` 获取新 Token
2. 通过 `GET /v1/models` 确认模型名称是否正确

### Claude Code 连接后无响应

1. 确认代理服务正在运行
2. 检查 `ANTHROPIC_BASE_URL` 是否正确指向代理
3. 查看 `server.log` 中的详细日志

### 工具调用失败 / 死循环

查看 `server.log` 中的 `[AgentClient]` 和 `[SessionManager]` 日志，确认工具调用的路由和参数映射是否正确。

---

## 致谢

本项目的灵感和初始代码来源于 [JiuZ-Chn/Cursor-To-OpenAI](https://github.com/JiuZ-Chn/Cursor-To-OpenAI)，在此基础上进行了大量扩展和重构，包括完整的 Agent 双向流协议实现、多客户端适配架构、MCP 工具注册、Protobuf 编解码修复等。

其他参考项目：

- [zhx47/cursor-api](https://github.com/zhx47/cursor-api) — 早期 Cursor API 逆向实现
- [eisbaw/cursor_api_demo](https://github.com/eisbaw/cursor_api_demo) — Cursor 协议分析与 Python PoC

## 免责声明

本项目仅供学习和研究使用，请遵守 Cursor 的使用条款。请妥善保管你的 Cursor Token，不要泄露给他人。

## 许可证

MIT


---

## 桌面版（macOS）

本仓库新增 Desktop 封装（菜单栏常驻），目标是让用户**无需手动安装 Node/npm 依赖环境**即可使用（通过预打包 DMG）。

### 开发者打包

```bash
npm install
npm run dist:app
```

### 用户安装

- 安装 `dist/*.dmg`
- 打开 `Cursor Gateway Desktop`
- 使用控制面板完成登录与健康检查

默认 API：`http://127.0.0.1:3010/v1`
