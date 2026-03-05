#!/usr/bin/env node

/**
 * Test MCP Tool Conversion Fix
 * Verifies that MCP tool parameters are correctly parsed and returned
 */

const { execRequestToToolUse } = require('../../src/utils/sessionManager.js');

// Mock session object
const mockSession = {
  toolCallMapping: new Map(),
};

// Test case 1: MCP tool with parameters
console.log('=== Test 1: MCP Tool with Parameters ===');
const mcpExecRequest1 = {
  type: 'mcp',
  id: 123,
  execId: 'exec-456',
  name: 'test_mcp',
  toolName: 'my_mcp_tool',
  toolCallId: 'call-789',
  providerIdentifier: 'my-provider',
  args: {
    param1: 'value1',
    param2: 'value2'
  }
};

try {
  const toolUse1 = execRequestToToolUse(mcpExecRequest1, mockSession);
  console.log('✅ Tool Use Generated:');
  console.log(JSON.stringify(toolUse1, null, 2));

  if (toolUse1.name === 'my_mcp_tool' && toolUse1.input.param1 === 'value1') {
    console.log('✅ PASS: MCP tool parameters correctly converted');
  } else {
    console.log('❌ FAIL: MCP tool parameters not correctly converted');
  }
} catch (e) {
  console.log('❌ ERROR:', e.message);
}

// Test case 2: MCP tool without parameters
console.log('\n=== Test 2: MCP Tool without Parameters ===');
const mcpExecRequest2 = {
  type: 'mcp',
  id: 124,
  execId: 'exec-457',
  name: 'test_mcp2',
  toolName: 'another_tool',
  toolCallId: 'call-790',
  providerIdentifier: 'another-provider',
  args: {}
};

try {
  const toolUse2 = execRequestToToolUse(mcpExecRequest2, mockSession);
  console.log('✅ Tool Use Generated:');
  console.log(JSON.stringify(toolUse2, null, 2));

  if (toolUse2.name === 'another_tool' && Object.keys(toolUse2.input).length === 0) {
    console.log('✅ PASS: MCP tool without parameters correctly handled');
  } else {
    console.log('❌ FAIL: MCP tool without parameters not correctly handled');
  }
} catch (e) {
  console.log('❌ ERROR:', e.message);
}

// Test case 3: Regular tool (non-MCP)
console.log('\n=== Test 3: Regular Tool (Read) ===');
const readExecRequest = {
  type: 'read',
  id: 125,
  execId: 'exec-458',
  path: '/path/to/file.txt'
};

try {
  const toolUse3 = execRequestToToolUse(readExecRequest, mockSession);
  console.log('✅ Tool Use Generated:');
  console.log(JSON.stringify(toolUse3, null, 2));

  if (toolUse3.name === 'Read' && toolUse3.input.file_path === '/path/to/file.txt') {
    console.log('✅ PASS: Regular tool correctly converted');
  } else {
    console.log('❌ FAIL: Regular tool not correctly converted');
  }
} catch (e) {
  console.log('❌ ERROR:', e.message);
}

console.log('\n=== All Tests Completed ===');
process.exit(0);
