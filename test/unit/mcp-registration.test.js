/**
 * Tests for MCP tool registration in AgentRunRequest (field 4) and RequestContext (field 7/14)
 * Validates the fix for the root cause: MCP tools must be registered at the AgentRunRequest
 * top level (field 4) for Cursor to route tool calls back via exec_server_message field 11.
 */
const assert = require('assert');
const { parseProtoFields } = require('../../src/utils/utils');
const {
  _buildMcpToolsWrapper: buildMcpToolsWrapper,
  _buildAgentRunRequest: buildAgentRunRequest,
  _buildRequestContext: buildRequestContext,
} = require('../../src/utils/agentClient');
const {
  encodeMessageField,
  encodeStringField,
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

// Helper: recursively parse protobuf to find a specific field at a path
function getField(data, fieldNumber) {
  const fields = parseProtoFields(data);
  return fields.filter(f => f.fieldNumber === fieldNumber);
}

function getFirstField(data, fieldNumber) {
  const matches = getField(data, fieldNumber);
  return matches.length > 0 ? matches[0] : null;
}

function parseString(data, fieldNumber) {
  const f = getFirstField(data, fieldNumber);
  if (f && f.wireType === 2 && Buffer.isBuffer(f.value)) {
    return f.value.toString('utf-8');
  }
  return null;
}

// =========================================================================
console.log('\n=== buildMcpToolsWrapper tests ===');
// =========================================================================

test('returns null for empty tools', () => {
  assert.strictEqual(buildMcpToolsWrapper([]), null);
  assert.strictEqual(buildMcpToolsWrapper(null), null);
  assert.strictEqual(buildMcpToolsWrapper(undefined), null);
});

test('wraps single tool as field 1 (repeated McpToolDefinition)', () => {
  const tools = [{
    name: 'web_fetch',
    description: 'Fetch a URL',
    input_schema: { type: 'object', properties: { url: { type: 'string' } } },
  }];
  const wrapper = buildMcpToolsWrapper(tools);
  assert.ok(wrapper, 'wrapper should not be null');
  
  // Parse: McpTools has repeated field 1 (McpToolDefinition)
  const toolDefs = getField(wrapper, 1);
  assert.strictEqual(toolDefs.length, 1, 'should have exactly 1 McpToolDefinition');
  
  const toolData = toolDefs[0].value;
  assert.ok(Buffer.isBuffer(toolData));
  
  // Parse McpToolDefinition fields
  const name = parseString(toolData, 1);
  const desc = parseString(toolData, 2);
  const provider = parseString(toolData, 4);
  const toolName = parseString(toolData, 5);
  
  assert.strictEqual(name, 'web_fetch');
  assert.strictEqual(desc, 'Fetch a URL');
  assert.strictEqual(provider, 'cursor-tools');
  assert.strictEqual(toolName, 'web_fetch');
  
  // Field 3 = input_schema (Struct) — should exist
  const schemaField = getFirstField(toolData, 3);
  assert.ok(schemaField, 'input_schema should be present');
});

test('wraps multiple tools correctly', () => {
  const tools = [
    { name: 'web_fetch', description: 'Fetch URL', input_schema: { type: 'object' } },
    { name: 'todo_write', description: 'Write todos', input_schema: { type: 'object' } },
    { name: 'web_search', description: 'Search web', input_schema: { type: 'object' } },
  ];
  const wrapper = buildMcpToolsWrapper(tools);
  const toolDefs = getField(wrapper, 1);
  assert.strictEqual(toolDefs.length, 3, 'should have 3 McpToolDefinitions');
  
  const names = toolDefs.map(td => parseString(td.value, 1));
  assert.deepStrictEqual(names, ['web_fetch', 'todo_write', 'web_search']);
});

test('handles OpenAI function format', () => {
  const tools = [{
    function: {
      name: 'my_tool',
      description: 'My tool desc',
      parameters: { type: 'object', properties: { x: { type: 'number' } } },
    },
  }];
  const wrapper = buildMcpToolsWrapper(tools);
  const toolDefs = getField(wrapper, 1);
  assert.strictEqual(toolDefs.length, 1);
  assert.strictEqual(parseString(toolDefs[0].value, 1), 'my_tool');
  assert.strictEqual(parseString(toolDefs[0].value, 2), 'My tool desc');
});

// =========================================================================
console.log('\n=== buildAgentRunRequest tests ===');
// =========================================================================

test('field 4 (mcp_tools) is ENABLED — tools registered in AgentRunRequest', () => {
  const action = encodeMessageField(1, encodeStringField(1, 'hello'));
  const modelDetails = encodeStringField(1, 'claude-4-sonnet');
  const tools = [
    { name: 'web_fetch', description: 'Fetch', input_schema: { type: 'object' } },
  ];
  
  const request = buildAgentRunRequest(action, modelDetails, 'conv-123', tools);
  
  const field4 = getFirstField(request, 4);
  assert.ok(field4, 'field 4 (mcp_tools) should be present');
  assert.strictEqual(field4.wireType, 2, 'field 4 should be length-delimited');
  
  const toolDefs = getField(field4.value, 1);
  assert.strictEqual(toolDefs.length, 1, 'should have 1 tool');
  assert.strictEqual(parseString(toolDefs[0].value, 1), 'web_fetch');
});

test('omits field 4 when no tools', () => {
  const action = encodeMessageField(1, encodeStringField(1, 'hello'));
  const modelDetails = encodeStringField(1, 'claude-4-sonnet');
  
  const request = buildAgentRunRequest(action, modelDetails, 'conv-123', null);
  
  const field4 = getFirstField(request, 4);
  assert.strictEqual(field4, null, 'field 4 should not be present without tools');
});

test('omits field 4 when empty tools array', () => {
  const action = encodeMessageField(1, encodeStringField(1, 'hello'));
  const modelDetails = encodeStringField(1, 'claude-4-sonnet');
  
  const request = buildAgentRunRequest(action, modelDetails, 'conv-123', []);
  
  const field4 = getFirstField(request, 4);
  assert.strictEqual(field4, null, 'field 4 should not be present with empty tools');
});

test('preserves all fields (1,2,3,4,5) when tools provided', () => {
  const action = encodeMessageField(1, encodeStringField(1, 'hello'));
  const modelDetails = encodeStringField(1, 'claude-4-sonnet');
  const tools = [{ name: 'test_tool', description: 'test', input_schema: { type: 'object' } }];
  
  const request = buildAgentRunRequest(action, modelDetails, 'conv-abc', tools);
  
  const field1 = getFirstField(request, 1);
  const field2 = getFirstField(request, 2);
  const field3 = getFirstField(request, 3);
  const field4 = getFirstField(request, 4);
  const field5 = getFirstField(request, 5);
  
  assert.ok(field1, 'field 1 (conversation_state) should exist');
  assert.ok(field2, 'field 2 (action) should exist');
  assert.ok(field3, 'field 3 (model_details) should exist');
  assert.ok(field4, 'field 4 (mcp_tools) should exist');
  assert.ok(field5, 'field 5 (conversation_id) should exist');
  assert.strictEqual(field5.value.toString('utf-8'), 'conv-abc');
});

// =========================================================================
console.log('\n=== buildRequestContext tools registration tests ===');
// =========================================================================

test('RequestContext field 7 contains McpToolDefinitions', () => {
  const tools = [
    { name: 'web_fetch', description: 'Fetch URL', input_schema: { type: 'object' } },
    { name: 'todo_write', description: 'Write todos', input_schema: { type: 'object' } },
  ];
  const ctx = buildRequestContext('/tmp/test', tools);
  
  // Field 7 = repeated McpToolDefinition
  const toolFields = getField(ctx, 7);
  assert.strictEqual(toolFields.length, 2, 'should have 2 tool definitions in field 7');
  
  const names = toolFields.map(tf => parseString(tf.value, 1));
  assert.deepStrictEqual(names, ['web_fetch', 'todo_write']);
});

test('RequestContext field 14 contains McpInstructions', () => {
  const tools = [
    { name: 'web_fetch', description: 'Fetch URL', input_schema: { type: 'object' } },
  ];
  const ctx = buildRequestContext('/tmp/test', tools);
  
  // Field 14 = McpInstructions
  const instrField = getFirstField(ctx, 14);
  assert.ok(instrField, 'field 14 (mcp_instructions) should exist');
  
  const serverName = parseString(instrField.value, 1);
  const instructions = parseString(instrField.value, 2);
  
  assert.strictEqual(serverName, 'cursor-tools');
  assert.ok(instructions.includes('web_fetch'), 'instructions should mention tool name');
});

test('RequestContext without tools has no field 7 or 14', () => {
  const ctx = buildRequestContext('/tmp/test', null);
  
  const toolFields = getField(ctx, 7);
  const instrField = getFirstField(ctx, 14);
  
  assert.strictEqual(toolFields.length, 0, 'no field 7 without tools');
  assert.strictEqual(instrField, null, 'no field 14 without tools');
});

test('RequestContext field 4 (env) has correct workspace path', () => {
  const ctx = buildRequestContext('/my/workspace', []);
  const envField = getFirstField(ctx, 4);
  assert.ok(envField, 'field 4 (env) should exist');
  
  const cwd = parseString(envField.value, 2);
  const workspacePath = parseString(envField.value, 11);
  assert.strictEqual(cwd, '/my/workspace');
  assert.strictEqual(workspacePath, '/my/workspace');
});

// =========================================================================
console.log('\n=== Integration: AgentRunRequest + RequestContext both carry tools ===');
// =========================================================================

test('input_schema is encoded as google.protobuf.Value (not Struct)', () => {
  const tools = [{
    name: 'test',
    description: 'test',
    input_schema: { type: 'object', properties: { path: { type: 'string' } } },
  }];
  const wrapper = buildMcpToolsWrapper(tools);
  const toolDefs = getField(wrapper, 1);
  const schemaField = getFirstField(toolDefs[0].value, 3);
  assert.ok(schemaField, 'input_schema field should exist');
  assert.strictEqual(schemaField.value[0], 0x2a,
    'input_schema should start with Value.structValue tag (0x2a), not Struct.fields tag (0x0a)');
});

test('buildMcpToolsWrapper produces valid encoding with all fields', () => {
  const tools = [
    { name: 'web_fetch', description: 'Fetch', input_schema: { type: 'object' } },
    { name: 'todo_write', description: 'Write todos', input_schema: { type: 'object' } },
  ];
  
  const wrapper = buildMcpToolsWrapper(tools);
  assert.ok(wrapper, 'wrapper should not be null');
  
  const toolDefs = getField(wrapper, 1);
  assert.strictEqual(toolDefs.length, 2);
  
  // Verify each tool has all 5 required fields
  for (const td of toolDefs) {
    assert.ok(parseString(td.value, 1), 'name should exist');
    assert.ok(parseString(td.value, 2), 'description should exist');
    assert.ok(getFirstField(td.value, 3), 'input_schema should exist');
    assert.strictEqual(parseString(td.value, 4), 'cursor-tools', 'provider should be cursor-tools');
    assert.ok(parseString(td.value, 5), 'tool_name should exist');
  }
});

// =========================================================================
console.log('\n============================================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
