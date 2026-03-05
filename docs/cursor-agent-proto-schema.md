# Cursor Agent 协议 Protobuf Schema

本文档记录通过逆向 Cursor IDE（`workbench.desktop.main.js`）得到的 Protobuf 消息结构定义。

> **逆向方法**：在 Cursor.app 的 `workbench.desktop.main.js` 中搜索 `agent.v1.` 或 `aiserver.v1.` 的 `typeName` 定义，可找到所有消息类型的字段编号和类型。

---

## 1. 通信架构

```text
Client → Server:
  POST /agent.v1.AgentService/RunSSE      初始请求（AgentRunRequest）
  POST /agent.v1.AgentService/BidiAppend  工具结果/续传（ExecClientMessage）

Server → Client (SSE):
  InteractionUpdate    field 1  模型输出（文本/心跳/完成状态）
  ExecServerMessage    field 2  工具调用请求
  CheckpointUpdate     field 3  断点
  KvServerMessage      field 4  KV blob 大数据
```

SSE 帧格式（Connect/gRPC-Web）：

```text
[flags:1字节][length:4字节 BE][data:protobuf]
flags & 0x80 = trailer（含 grpc-status / grpc-message）
否则为数据帧
```

---

## 2. AgentRunRequest（顶层请求）

```protobuf
message AgentRunRequest {
  UserMessageAction user_message = 1;  // 用户消息 + 上下文
  string model = 2;                     // 模型名（Cursor 内部名）
  McpTools mcp_tools = 4;              // MCP 工具注册（路由层）
  bool explicit_agent_mode = 6;         // 强制 agent 模式
  string custom_system_prompt = 8;      // 自定义系统提示
  string conversation_id = 10;          // 会话 ID
  bool privacy_mode = 14;              // 隐私模式
}
```

### 2.1 UserMessageAction

```protobuf
message UserMessageAction {
  string text = 1;                     // 用户消息文本
  RequestContext context = 3;          // 请求上下文
}
```

### 2.2 McpTools（field 4）

```protobuf
message McpTools {
  repeated McpToolDescriptor tools = 1;
}

message McpToolDescriptor {
  string name = 1;
  string description = 2;
  google.protobuf.Value input_schema = 3;  // JSON Schema
  string provider_identifier = 4;          // "cursor-tools"
  string tool_name = 5;                    // 同 name
}
```

> **重要**：`input_schema` 的类型是 `google.protobuf.Value`，不是 `google.protobuf.Struct`。编码时必须用 `encodeProtobufValue(schema)` 而非 `encodeProtobufStruct(schema)`。

---

## 3. RequestContext（请求上下文）

```protobuf
message RequestContext {
  // ... 其他字段 ...
  repeated McpToolDefinition tools = 7;       // 模型可见的工具列表
  repeated McpInstructions mcp_instructions = 14;  // 工具使用说明
}
```

### 3.1 McpToolDefinition（field 7）

```protobuf
message McpToolDefinition {
  string name = 1;
  string description = 2;
  google.protobuf.Value input_schema = 3;  // JSON Schema
  string provider_identifier = 4;
  string tool_name = 5;
}
```

### 3.2 McpInstructions（field 14）

```protobuf
message McpInstructions {
  string identifier = 1;      // provider 标识，如 "cursor-tools"
  string instructions = 2;    // 文本描述：可用工具列表及使用方法
}
```

---

## 4. ExecServerMessage（工具调用请求）

Cursor → Client 方向，告诉客户端执行某个工具。

```protobuf
message ExecServerMessage {
  uint32 id = 1;              // 请求序号
  ShellArgs shell = 2;        // Shell 命令
  WriteArgs write = 3;        // 写文件
  DeleteArgs delete = 4;      // 删除文件
  GrepArgs grep = 5;          // 搜索
  ReadArgs read = 7;          // 读文件
  LsArgs ls = 8;              // 列目录
  RequestContextArgs request_context = 10;  // 请求上下文
  McpArgs mcp = 11;           // MCP 工具调用
  ShellArgs shell_v2 = 14;    // 流式 Shell
  string exec_id = 15;        // 执行标识
  FetchArgs fetch = 20;       // 网络请求
  SubagentArgs subagent = 28; // 子代理
}
```

### 4.1 ShellArgs

```protobuf
message ShellArgs {
  string command = 1;
  string cwd = 2;
}
```

### 4.2 WriteArgs

```protobuf
message WriteArgs {
  string path = 1;
  string file_text = 2;
  string tool_call_id = 3;
}
```

### 4.3 DeleteArgs

```protobuf
message DeleteArgs {
  string path = 1;
}
```

### 4.4 GrepArgs

```protobuf
message GrepArgs {
  string pattern = 1;
  string path = 2;
  string glob = 3;
}
```

### 4.5 ReadArgs

```protobuf
message ReadArgs {
  string path = 1;
}
```

### 4.6 LsArgs

```protobuf
message LsArgs {
  string path = 1;
}
```

### 4.7 McpArgs

```protobuf
message McpArgs {
  string name = 1;                        // 工具名（可能有 mcp_ 前缀）
  google.protobuf.Struct args = 2;        // 工具参数
  string tool_call_id = 3;
  string provider_identifier = 4;
  string tool_name = 5;
}
```

> **注意**：`args` 是 `google.protobuf.Struct`（field 2），不是 JSON 字符串。可能以单个 Struct 消息或 repeated MapEntry 形式出现，需要用 `decodeProtobufStruct()` 或 `decodeProtobufStructFromRepeatedEntries()` 解码。

---

## 5. ExecClientMessage（工具结果返回）

Client → Cursor 方向，返回工具执行结果。

```protobuf
message ExecClientMessage {
  uint32 id = 1;                    // 对应 ExecServerMessage.id
  ShellResult shell = 2;
  WriteResult write = 3;
  DeleteResult delete = 4;
  GrepResult grep = 5;
  ReadResult read = 7;
  LsResult ls = 8;
  RequestContextResult context = 10;
  McpResult mcp = 11;               // MCP 工具结果
  string exec_id = 15;
}
```

### 5.1 Shell 结果

```protobuf
message ShellResult {
  string output = 1;
  int32 exit_code = 2;
  string cwd = 3;
}
```

### 5.2 Read 结果

```protobuf
message ReadResult {
  string content = 1;
  string path = 2;
  // ... 其他字段
}
```

### 5.3 Write 结果

```protobuf
message WriteResult {
  oneof result {
    WriteSuccess success = 1;
    WriteError error = 2;
  }
}

message WriteSuccess {
  string path = 1;
  uint32 lines_written = 2;
}

message WriteError {
  string path = 1;
  string error = 2;
}
```

### 5.4 MCP 结果（McpResult）

```protobuf
message McpResult {
  oneof result {
    McpSuccess success = 1;
    McpError error = 2;
    McpRejected rejected = 3;
    McpPermissionDenied permission_denied = 4;
    McpToolNotFound tool_not_found = 5;
    McpToolError tool_error = 6;
  }
}

message McpSuccess {
  repeated McpToolResultContentItem content = 1;
  bool is_error = 2;
}

message McpToolResultContentItem {
  oneof content {
    McpTextContent text = 1;
    McpImageContent image = 2;
  }
}

message McpTextContent {
  string text = 1;
}

message McpError {
  string error = 1;
}
```

### 5.5 RequestContext 结果

```protobuf
message RequestContextResult {
  string workspace_path = 1;
  string os = 2;
  string shell = 3;
  // ... 其他字段
}
```

---

## 6. SSE 响应消息

### 6.1 InteractionUpdate（field 1）

```protobuf
message InteractionUpdate {
  string text = 1;              // 模型输出文本
  // ... 
  bool heartbeat = 13;          // 心跳（不算有意义活动）
  ToolCallV2 tool_call_v2 = 15; // 结构化工具调用
}
```

### 6.2 KvServerMessage（field 4）

KV 消息包含大数据 blob。当 JSON 内容包含 `role: "assistant"` 和 `id` 时，表示模型最终响应。`content` 数组可能包含 `tool-call` / `tool-use` 类型块。

---

## 7. google.protobuf.Value / Struct 编码

### 7.1 Value

```protobuf
message Value {
  oneof kind {
    NullValue null_value = 1;    // varint 0
    double number_value = 2;     // fixed64
    string string_value = 3;     // length-delimited
    bool bool_value = 4;         // varint
    Struct struct_value = 5;     // length-delimited
    ListValue list_value = 6;    // length-delimited
  }
}
```

### 7.2 Struct

```protobuf
message Struct {
  map<string, Value> fields = 1;
  // 编码为 repeated MapEntry { string key = 1; Value value = 2; }
}
```

### 7.3 ListValue

```protobuf
message ListValue {
  repeated Value values = 1;
  // 每个元素独立编码为 field 1（repeated field 规则）
}
```

> **陷阱**：ListValue 的每个元素必须是独立的 field 1 编码，不能把所有元素拼在一个 field 1 里。否则 protobuf 解析器只保留最后一个。

---

## 8. aiserver.v1 vs agent.v1

| 特性 | aiserver.v1 (StreamChat) | agent.v1 (RunSSE + BidiAppend) |
|------|--------------------------|-------------------------------|
| 通信 | 单向流（请求-响应） | 双向流（SSE + BidiAppend） |
| 工具 | `supportedTools` 枚举 (ClientSideToolV2) | MCP 注册 + 原生 exec |
| 状态 | 无状态 | 有状态（session） |
| MCP 工具注册 | `StreamChatRequest.mcp_tools` (field 34) | `AgentRunRequest.mcp_tools` (field 4) |
| 适用场景 | 简单聊天 | Agent 模式（工具调用） |

CursorGateway 主要使用 `agent.v1` 协议。

---

## 9. 逆向方法参考

在 Cursor IDE 的 `workbench.desktop.main.js` 中：

1. 搜索 `agent.v1.AgentRunRequest` 找到请求结构
2. 搜索 `agent.v1.ExecServerMessage` 找到工具调用字段
3. 搜索 `McpToolDefinition` 找到 MCP 工具定义
4. 搜索 `McpArgs` 找到 MCP 参数结构
5. 搜索 `McpResult` / `McpSuccess` 找到结果编码

关键搜索模式：`typeName: "agent.v1.XXX"` 或 `fieldNo: N, T.{类型}`

---

## 10. 编码注意事项

1. **`input_schema` 用 Value 不是 Struct** — `McpToolDefinition.input_schema` 是 `google.protobuf.Value`，编码时用 `encodeProtobufValue(schema)`
2. **`McpArgs.args` 是 Struct** — 解码时可能是单个 Struct 或 repeated MapEntry
3. **ListValue 每元素独立编码** — repeated field 1，不能合并
4. **NullValue 需要 tag + value** — `encodeTag(1, 0)` + `encodeVarint(0)`，不能只写 tag
5. **所有 encode 函数防御 undefined** — `encodeStringField(n, undefined)` 不能崩溃
6. **MCP 工具名要 sanitize** — 避免与 Cursor 保留名冲突
