/**
 * Tests for MCP tool name sanitization.
 * Cursor reserves certain tool names (TodoWrite, WebFetch, Task, etc.) internally.
 * Registering MCP tools with these exact names causes grpc-status 8 (Provider Error).
 * We prefix them with "mcp_" when registering, and strip the prefix when receiving callbacks.
 */
const assert = require('assert');
const { parseProtoFields } = require('../../src/utils/utils');
const {
  _sanitizeMcpToolName: sanitizeMcpToolName,
  _restoreMcpToolName: restoreMcpToolName,
  _buildMcpToolsWrapper: buildMcpToolsWrapper,
  _buildRequestContext: buildRequestContext,
  parseExecServerMessage,
  CURSOR_RESERVED_TOOL_NAMES,
} = require('../../src/utils/agentClient');
const {
  encodeMessageField,
  encodeStringField,
  encodeProtobufStruct,
  concatBytes,
} = require('../../src/utils/protoEncoder');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

function getField(data, fieldNumber) {
  const fields = parseProtoFields(data);
  return fields.filter(f => f.fieldNumber === fieldNumber);
}

function parseString(data, fieldNumber) {
  const f = getField(data, fieldNumber);
  if (f.length > 0 && f[0].wireType === 2 && Buffer.isBuffer(f[0].value)) {
    return f[0].value.toString('utf-8');
  }
  return null;
}

console.log('\n=== MCP Tool Name Sanitization Tests ===\n');

// --- sanitizeMcpToolName ---

console.log('--- sanitizeMcpToolName ---');

test('TodoWrite → mcp_TodoWrite', () => {
  assert.strictEqual(sanitizeMcpToolName('TodoWrite'), 'mcp_TodoWrite');
});

test('WebFetch → mcp_WebFetch', () => {
  assert.strictEqual(sanitizeMcpToolName('WebFetch'), 'mcp_WebFetch');
});

test('Task → mcp_Task', () => {
  assert.strictEqual(sanitizeMcpToolName('Task'), 'mcp_Task');
});

test('EditNotebook → mcp_EditNotebook', () => {
  assert.strictEqual(sanitizeMcpToolName('EditNotebook'), 'mcp_EditNotebook');
});

test('FetchMcpResource → mcp_FetchMcpResource', () => {
  assert.strictEqual(sanitizeMcpToolName('FetchMcpResource'), 'mcp_FetchMcpResource');
});

test('Delete → mcp_Delete', () => {
  assert.strictEqual(sanitizeMcpToolName('Delete'), 'mcp_Delete');
});

test('web_search is not reserved, passes through', () => {
  assert.strictEqual(sanitizeMcpToolName('web_search'), 'web_search');
});

test('web_fetch is not reserved (only WebFetch is)', () => {
  assert.strictEqual(sanitizeMcpToolName('web_fetch'), 'web_fetch');
});

test('ReadLints is not reserved', () => {
  assert.strictEqual(sanitizeMcpToolName('ReadLints'), 'ReadLints');
});

test('SemanticSearch is not reserved', () => {
  assert.strictEqual(sanitizeMcpToolName('SemanticSearch'), 'SemanticSearch');
});

test('CallMcpTool is not reserved', () => {
  assert.strictEqual(sanitizeMcpToolName('CallMcpTool'), 'CallMcpTool');
});

test('AskQuestion is not reserved', () => {
  assert.strictEqual(sanitizeMcpToolName('AskQuestion'), 'AskQuestion');
});

// --- restoreMcpToolName ---

console.log('\n--- restoreMcpToolName ---');

test('mcp_TodoWrite → TodoWrite', () => {
  assert.strictEqual(restoreMcpToolName('mcp_TodoWrite'), 'TodoWrite');
});

test('mcp_WebFetch → WebFetch', () => {
  assert.strictEqual(restoreMcpToolName('mcp_WebFetch'), 'WebFetch');
});

test('mcp_Task → Task', () => {
  assert.strictEqual(restoreMcpToolName('mcp_Task'), 'Task');
});

test('mcp_EditNotebook → EditNotebook', () => {
  assert.strictEqual(restoreMcpToolName('mcp_EditNotebook'), 'EditNotebook');
});

test('mcp_Delete → Delete', () => {
  assert.strictEqual(restoreMcpToolName('mcp_Delete'), 'Delete');
});

test('web_search stays unchanged', () => {
  assert.strictEqual(restoreMcpToolName('web_search'), 'web_search');
});

test('mcp_unknown_tool stays unchanged (not in reserved set)', () => {
  assert.strictEqual(restoreMcpToolName('mcp_unknown_tool'), 'mcp_unknown_tool');
});

test('empty string stays empty', () => {
  assert.strictEqual(restoreMcpToolName(''), '');
});

test('null stays null', () => {
  assert.strictEqual(restoreMcpToolName(null), null);
});

// --- roundtrip ---

console.log('\n--- roundtrip sanitize→restore ---');

for (const name of CURSOR_RESERVED_TOOL_NAMES) {
  test(`roundtrip: ${name}`, () => {
    const sanitized = sanitizeMcpToolName(name);
    assert.notStrictEqual(sanitized, name, `${name} should be sanitized`);
    const restored = restoreMcpToolName(sanitized);
    assert.strictEqual(restored, name, `restored should equal original`);
  });
}

test('roundtrip: non-reserved name stays same', () => {
  const name = 'web_search';
  const sanitized = sanitizeMcpToolName(name);
  assert.strictEqual(sanitized, name);
  const restored = restoreMcpToolName(sanitized);
  assert.strictEqual(restored, name);
});

// --- buildMcpToolsWrapper uses sanitized names ---

console.log('\n--- buildMcpToolsWrapper sanitization ---');

test('buildMcpToolsWrapper sanitizes reserved tool names', () => {
  const tools = [
    { name: 'TodoWrite', description: 'Write TODOs', input_schema: { type: 'object', properties: { todos: { type: 'array' } } } },
    { name: 'web_search', description: 'Search web', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
  ];
  const wrapper = buildMcpToolsWrapper(tools);
  assert.ok(wrapper, 'wrapper should not be null');

  const toolDefs = getField(wrapper, 1); // repeated McpToolDefinition
  assert.strictEqual(toolDefs.length, 2);

  // First tool: TodoWrite → mcp_TodoWrite
  const tool1 = toolDefs[0].value;
  const tool1Name = parseString(tool1, 1);
  assert.strictEqual(tool1Name, 'mcp_TodoWrite', 'TodoWrite should be sanitized to mcp_TodoWrite');
  const tool1ToolName = parseString(tool1, 5);
  assert.strictEqual(tool1ToolName, 'mcp_TodoWrite', 'tool_name field should also be sanitized');

  // Second tool: web_search stays as-is
  const tool2 = toolDefs[1].value;
  const tool2Name = parseString(tool2, 1);
  assert.strictEqual(tool2Name, 'web_search', 'web_search should not be sanitized');
});

// --- buildRequestContext uses sanitized names ---

console.log('\n--- buildRequestContext sanitization ---');

test('buildRequestContext sanitizes reserved tool names in field 7', () => {
  const tools = [
    { name: 'Task', description: 'Launch subagent', input_schema: { type: 'object', properties: { prompt: { type: 'string' } } } },
  ];
  const ctx = buildRequestContext('/tmp/test', tools);
  assert.ok(ctx, 'context should not be null');

  const toolDefs = getField(ctx, 7); // repeated McpToolDefinition
  assert.ok(toolDefs.length > 0, 'should have tool definitions');

  const tool1 = toolDefs[0].value;
  const tool1Name = parseString(tool1, 1);
  assert.strictEqual(tool1Name, 'mcp_Task', 'Task should be sanitized to mcp_Task');
});

test('buildRequestContext sanitizes reserved names in mcp_instructions (field 14)', () => {
  const tools = [
    { name: 'WebFetch', description: 'Fetch URL', input_schema: { type: 'object', properties: { url: { type: 'string' } } } },
  ];
  const ctx = buildRequestContext('/tmp/test', tools);
  const instrFields = getField(ctx, 14);
  assert.ok(instrFields.length > 0, 'should have mcp_instructions');

  const instrContent = parseString(instrFields[0].value, 2);
  assert.ok(instrContent.includes('mcp_WebFetch'), 'instructions should use sanitized name mcp_WebFetch');
  assert.ok(!instrContent.includes('- WebFetch:'), 'instructions should NOT contain unsanitized "- WebFetch:"');
});

// --- parseExecServerMessage restores names ---

console.log('\n--- parseExecServerMessage name restoration ---');

test('MCP exec with sanitized name gets restored', () => {
  // Build a fake McpArgs message with sanitized name
  const mcpArgsData = concatBytes(
    encodeStringField(1, 'mcp_TodoWrite'),
    encodeMessageField(2, encodeProtobufStruct({ todos: [], merge: false })),
    encodeStringField(3, 'toolu_test123'),
    encodeStringField(4, 'cursor-tools'),
    encodeStringField(5, 'mcp_TodoWrite'),
  );

  // Wrap in ExecServerMessage: field 1 = id (varint), field 11 = McpArgs
  const execMsg = concatBytes(
    Buffer.from([0x08, 0x05]), // field 1, varint, value 5
    encodeMessageField(11, mcpArgsData),
  );

  const result = parseExecServerMessage(execMsg);
  assert.strictEqual(result.type, 'mcp');
  assert.strictEqual(result.name, 'TodoWrite', 'name should be restored from mcp_TodoWrite');
  assert.strictEqual(result.toolName, 'TodoWrite', 'toolName should be restored from mcp_TodoWrite');
  assert.strictEqual(result.id, 5);
});

test('MCP exec with non-reserved name stays unchanged', () => {
  const mcpArgsData = concatBytes(
    encodeStringField(1, 'web_search'),
    encodeMessageField(2, encodeProtobufStruct({ query: 'test' })),
    encodeStringField(3, 'toolu_test456'),
    encodeStringField(4, 'cursor-tools'),
    encodeStringField(5, 'web_search'),
  );

  const execMsg = concatBytes(
    Buffer.from([0x08, 0x06]),
    encodeMessageField(11, mcpArgsData),
  );

  const result = parseExecServerMessage(execMsg);
  assert.strictEqual(result.type, 'mcp');
  assert.strictEqual(result.name, 'web_search');
  assert.strictEqual(result.toolName, 'web_search');
});

// --- Summary ---

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
