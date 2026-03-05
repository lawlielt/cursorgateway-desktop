# Cursor IDE 源码逆向分析报告 — MCP 请求构建对比

> 分析时间：2026-03-05
> 来源：/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js (52.9MB)

---

## 1. AgentRunRequest 字段定义（确认）

```protobuf
message AgentRunRequest {
  ConversationState conversation_state = 1;
  ConversationAction action = 2;
  ModelDetails model_details = 3;
  McpTools mcp_tools = 4;
  string conversation_id = 5;     // optional
  McpFileSystemOptions mcp_file_system_options = 6;  // optional
  SkillOptions skill_options = 7;  // optional
  string custom_system_prompt = 8; // optional
  RequestedModel requested_model = 9; // optional
  bool suggest_next_prompt = 10;  // optional
  string subagent_type_name = 11; // optional
}
```

## 2. McpTools / McpToolDefinition 定义

```protobuf
message McpTools {
  repeated McpToolDefinition mcp_tools = 1;
}

message McpToolDefinition {
  string name = 1;
  string description = 2;
  google.protobuf.Value input_schema = 3;  // ★ 是 Value，不是 Struct！
  string provider_identifier = 4;
  string tool_name = 5;
}
```

### 关键差异：input_schema 类型

| 项目 | 类型 | 编码方式 |
|------|------|---------|
| **Cursor IDE（正确）** | `google.protobuf.Value` | `Value.fromJson(schema)` → `Value { structValue (field 5) = Struct {...} }` |
| **我们的实现（错误）** | `google.protobuf.Struct` | `encodeProtobufStruct(schema)` → 裸 `Struct {...}` |

当 JSON schema 是 `{type: "object", properties: {...}}` 时：
- Cursor 编码为：`Value` wrapper → field 5 (structValue) → `Struct` 内容
- 我们编码为：直接 `Struct` 内容（缺少 Value wrapper 的 field 5 标签）

**这是 SSE 卡死的根本原因**：Cursor 服务端按 `Value` 格式解析 field 3，但拿到的字节是裸 `Struct`，解析失败/错误，导致请求被拒绝或流异常终止。

## 3. McpFileSystemOptions 定义

```protobuf
message McpFileSystemOptions {
  bool enabled = 1;
  string workspace_project_dir = 2;
  repeated McpDescriptor mcp_descriptors = 3;
}

message McpDescriptor {
  string server_name = 1;
  string server_identifier = 2;
  string folder_path = 3;  // optional
  string server_use_instructions = 4;  // optional
  repeated McpToolDescriptor tools = 5;
}

message McpToolDescriptor {
  string tool_name = 1;
  string definition_path = 2;  // optional
  string description = 3;  // optional
  google.protobuf.Value input_schema = 4;  // optional, 也是 Value
}
```

## 4. Cursor IDE 构建 runRequest 的代码

```javascript
// 格式化后的关键代码
const Pe = u.map(qe => ({
  name: qe.name,
  providerIdentifier: qe.providerIdentifier,
  toolName: qe.toolName,
  description: qe.description,
  inputSchema: qe.inputSchema ? nhe.fromJson(qe.inputSchema) : void 0
  //                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  //                            nhe = google.protobuf.Value
  //                            fromJson() 把 JSON schema 转成 Value message
}));

ae = ne.write(new zNe({
  message: {
    case: "runRequest",
    value: new RVl({
      conversationState: e,
      action: t,
      modelDetails: i,
      requestedModel: d.requestedModel,
      mcpTools: new nha({ mcpTools: Pe }),
      conversationId: d.conversationId,
      mcpFileSystemOptions: d.mcpFileSystemOptions,
      customSystemPrompt: d.customSystemPrompt,
      suggestNextPrompt: d.suggestNextPrompt,
      subagentTypeName: d.subagentTypeName
    })
  }
}));

// Headers:
const We = {
  "x-request-id": m,
  ...d.headers ?? {}
};
```

## 5. Cursor IDE 请求头

| Header | 值 |
|--------|---|
| `x-cursor-checksum` | checksum + token hash |
| `x-cursor-client-version` | Cursor 版本号 |
| `x-cursor-client-type` | `"ide"` |
| `x-cursor-client-os` | OS 名称 |
| `x-cursor-client-arch` | CPU 架构 |
| `x-cursor-client-os-version` | OS 版本 |
| `x-cursor-client-device-type` | `"desktop"` |
| `x-cursor-timezone` | 时区 |
| `x-request-id` | 请求 UUID |
| `x-amzn-trace-id` | `Root=${requestId}` |
| `x-ghost-mode` | ghost mode flag |
| `x-cursor-config-version` | 配置版本 |
| `x-session-id` | 会话 ID |
| `Authorization` | `Bearer ${token}` |

## 6. 修复方案

### 6.1 input_schema 编码修复

将 `encodeProtobufStruct(schema)` 替换为 `encodeProtobufValue(schema)`：

```javascript
// 修复前（错误）：
toolParts.push(encodeMessageField(3, encodeProtobufStruct(inputSchema)));
// 编码结果：field 3 = Struct{fields} （裸 Struct）

// 修复后（正确）：
toolParts.push(encodeMessageField(3, encodeProtobufValue(inputSchema)));
// 编码结果：field 3 = Value{structValue: Struct{fields}} （Value 包装的 Struct）
```

由于 `inputSchema` 是 JSON object，`encodeProtobufValue` 会走 `typeof value === 'object'` 分支，
编码为 `Value { field 5 (structValue) = Struct {...} }`，这正是 Cursor 服务端期望的格式。

### 6.2 McpFileSystemOptions（可选）

Cursor IDE 会携带 `mcpFileSystemOptions`，我们目前不发这个字段。
可能不是必需的，但如果修复 input_schema 后仍有问题，可以尝试添加。
