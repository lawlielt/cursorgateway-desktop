/**
 * Comprehensive test: all Claude Code tools through the proxy
 *
 * Tests every tool in both categories:
 * A) Native-covered tools: exec parsing → execRequestToToolUse → sendToolResult round-trip
 * B) Non-native tools: MCP text parsing (<mcp_tool_use> tags)
 *
 * Claude Code full tool list (14 tools):
 *   Native: Read, Write, StrReplace, Bash/Shell, Grep, Glob, Delete
 *   Non-native: TodoWrite, Task, WebFetch, EditNotebook, ListMcpResources, FetchMcpResource, workflow3-workflow3
 */

const { filterNonNativeTools, isNativeCoveredTool, parseToolCalls } = require('../../src/utils/toolsAdapter');
const { execRequestToToolUse, sendToolResult: sessionSendToolResult } = require('../../src/utils/sessionManager');
const { parseExecServerMessage } = require('../../src/utils/agentClient');
const {
  encodeStringField,
  encodeMessageField,
  encodeUint32Field,
  concatBytes,
  encodeProtobufStruct,
} = require('../../src/utils/protoEncoder');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function makeSession() {
  return {
    toolCallMapping: new Map(),
    pendingToolCalls: [],
    sentText: '',
    sentToolCallIds: new Set(),
    sentCursorExecKeys: new Set(),
    agentClient: {
      sendToolResult: async () => {},
      sendResumeAction: async () => {},
    },
  };
}

(async () => {

// ═══════════════════════════════════════════════════════════════
// PART A: Native-covered tools — full round-trip
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART A: Native tool round-trip (exec → toolUse → sendResult) ===\n');

// --- A1: read ---
console.log('--- A1: read ---');
{
  const session = makeSession();
  const execMsg = concatBytes(
    encodeUint32Field(1, 1),
    encodeMessageField(7, encodeStringField(1, '/home/user/app.js')),
    encodeStringField(15, 'e-read-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'read', 'parsed type is read');
  assert(parsed.path === '/home/user/app.js', 'parsed path correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Read', 'mapped to Read');
  assert(toolUse.input.file_path === '/home/user/app.js', 'input.file_path correct');

  const mapping = session.toolCallMapping.get(toolUse.id);
  assert(mapping && mapping.cursorType === 'read', 'mapping stored as read');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'const x = 1;\n',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'result sent to cursor');
}

// --- A2: write ---
console.log('--- A2: write ---');
{
  const session = makeSession();
  const writeArgs = concatBytes(
    encodeStringField(1, '/home/user/new.txt'),
    encodeStringField(2, 'hello world'),
  );
  const execMsg = concatBytes(
    encodeUint32Field(1, 2),
    encodeMessageField(3, writeArgs),
    encodeStringField(15, 'e-write-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'write', 'parsed type is write');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Write', 'mapped to Write');
  assert(toolUse.input.file_path === '/home/user/new.txt', 'input.file_path correct');
  assert(toolUse.input.content === 'hello world', 'input.content correct');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: JSON.stringify({ path: '/home/user/new.txt', linesCreated: 1, fileSize: 11 }),
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'write result sent');
}

// --- A3: shell (Bash) ---
console.log('--- A3: shell → Bash ---');
{
  const session = makeSession();
  const shellArgs = concatBytes(
    encodeStringField(1, 'ls -la /tmp'),
    encodeStringField(2, '/home'),
  );
  const execMsg = concatBytes(
    encodeUint32Field(1, 3),
    encodeMessageField(2, shellArgs),
    encodeStringField(15, 'e-shell-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'shell', 'parsed type is shell');
  assert(parsed.command === 'ls -la /tmp', 'command correct');
  assert(parsed.cwd === '/home', 'cwd correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Bash', 'mapped to Bash');
  assert(toolUse.input.command === 'ls -la /tmp', 'input.command correct');
  assert(toolUse.input.description, 'input.description set for cwd');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'total 0\ndrwxr-xr-x  2 user user 64 Jan  1 00:00 .\n',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'shell result sent');
}

// --- A4: delete ---
console.log('--- A4: delete ---');
{
  const session = makeSession();
  const deleteArgs = encodeStringField(1, '/home/user/trash.txt');
  const execMsg = concatBytes(
    encodeUint32Field(1, 4),
    encodeMessageField(4, deleteArgs),
    encodeStringField(15, 'e-del-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'delete', 'parsed type is delete (not read_v1)');
  assert(parsed.path === '/home/user/trash.txt', 'path correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Bash', 'mapped to Bash (delete → rm)');
  assert(toolUse.input.command.includes('rm -f'), 'uses rm -f');
  assert(toolUse.input.command.includes('/home/user/trash.txt'), 'path in command');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'File deleted',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'delete result sent');
}

// --- A5: grep ---
console.log('--- A5: grep ---');
{
  const session = makeSession();
  const grepArgs = concatBytes(
    encodeStringField(1, 'TODO'),
    encodeStringField(2, '/home/user/src'),
  );
  const execMsg = concatBytes(
    encodeUint32Field(1, 5),
    encodeMessageField(5, grepArgs),
    encodeStringField(15, 'e-grep-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'grep', 'parsed type is grep');
  assert(parsed.pattern === 'TODO', 'pattern correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Grep', 'mapped to Grep');
  assert(toolUse.input.pattern === 'TODO', 'input.pattern correct');
  assert(toolUse.input.path === '/home/user/src', 'input.path correct');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'src/main.js\nsrc/utils.js',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'grep result sent');
}

// --- A6: ls → Glob ---
console.log('--- A6: ls → Glob ---');
{
  const session = makeSession();
  const lsArgs = encodeStringField(1, '/home/user/project');
  const execMsg = concatBytes(
    encodeUint32Field(1, 6),
    encodeMessageField(8, lsArgs),
    encodeStringField(15, 'e-ls-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'ls', 'parsed type is ls');
  assert(parsed.path === '/home/user/project', 'path correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'Glob', 'mapped to Glob (not LS)');
  assert(toolUse.input.pattern === '*', 'pattern is *');
  assert(toolUse.input.path === '/home/user/project', 'path correct');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'index.js\npackage.json\nsrc/',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'ls result sent');
}

// --- A7: mcp tool (e.g. get_weather) ---
console.log('--- A7: mcp tool ---');
{
  const session = makeSession();
  const mcpArgs = concatBytes(
    encodeStringField(1, 'cursor-tools-get_weather'),
    encodeMessageField(2, encodeProtobufStruct({ city: 'Beijing' })),
    encodeStringField(3, 'tc-mcp-1'),
    encodeStringField(4, 'cursor-tools'),
    encodeStringField(5, 'get_weather'),
  );
  const execMsg = concatBytes(
    encodeUint32Field(1, 7),
    encodeMessageField(11, mcpArgs),
    encodeStringField(15, 'e-mcp-1'),
  );
  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'mcp', 'parsed type is mcp');
  assert(parsed.toolName === 'get_weather', 'toolName correct');
  assert(parsed.args && parsed.args.city === 'Beijing', 'args.city correct');

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === 'get_weather', 'mcp tool name passed through');
  assert(toolUse.input.city === 'Beijing', 'mcp input preserved');

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: 'Sunny, 25°C',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'mcp result sent');
}

// --- A8: StrReplace (implicit via read+write, verify not in MCP) ---
console.log('--- A8: StrReplace handled implicitly ---');
{
  assert(isNativeCoveredTool('StrReplace'), 'StrReplace is native-covered');
  const allTools = [
    { name: 'StrReplace', input_schema: { type: 'object', properties: { file_path: {}, old_string: {}, new_string: {} } } },
    { name: 'TodoWrite', input_schema: { type: 'object', properties: {} } },
  ];
  const nonNative = filterNonNativeTools(allTools);
  assert(nonNative.length === 1, 'StrReplace filtered out of MCP');
  assert(nonNative[0].name === 'TodoWrite', 'only TodoWrite remains');
}

// ═══════════════════════════════════════════════════════════════
// PART B: Non-native tools — MCP text parsing
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART B: Non-native tools (MCP text parsing) ===\n');

const nonNativeToolDefs = [
  { name: 'TodoWrite', description: 'Write todos' },
  { name: 'Task', description: 'Launch a task' },
  { name: 'WebFetch', description: 'Fetch a URL' },
  { name: 'EditNotebook', description: 'Edit notebook cell' },
  { name: 'ListMcpResources', description: 'List MCP resources' },
  { name: 'FetchMcpResource', description: 'Fetch MCP resource' },
  { name: 'workflow3-workflow3', description: 'Activate workflow' },
];

for (const toolDef of nonNativeToolDefs) {
  console.log(`--- B: ${toolDef.name} ---`);
  assert(!isNativeCoveredTool(toolDef.name), `${toolDef.name} is NOT native-covered`);

  // Build <mcp_tool_use> text that the model would emit
  const testArgs = { test_param: 'test_value', num: 42 };
  const mcpText = `I'll help you with that.\n\n<mcp_tool_use>\n<tool_name>${toolDef.name}</tool_name>\n<arguments>${JSON.stringify(testArgs)}</arguments>\n</mcp_tool_use>`;

  const toolCalls = parseToolCalls(mcpText, [toolDef]);
  assert(toolCalls.length === 1, `${toolDef.name}: parsed 1 tool call from text`);
  if (toolCalls.length > 0) {
    assert(toolCalls[0].name === toolDef.name, `${toolDef.name}: name matches`);
    assert(toolCalls[0].input.test_param === 'test_value', `${toolDef.name}: args preserved`);
    assert(toolCalls[0].input.num === 42, `${toolDef.name}: numeric arg preserved`);
    assert(toolCalls[0].id && toolCalls[0].id.startsWith('toolu_'), `${toolDef.name}: has valid tool call ID`);
  }
}

// ═══════════════════════════════════════════════════════════════
// PART C: Error handling round-trip
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART C: Error handling ===\n');

// --- C1: read error ---
console.log('--- C1: read error ---');
{
  const session = makeSession();
  const exec = { type: 'read', id: 101, execId: 'e-err-read', path: '/nonexistent' };
  const toolUse = execRequestToToolUse(exec, session);
  const result = await sessionSendToolResult(session, toolUse.id, {
    is_error: true,
    content: 'File not found: /nonexistent',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'read error result sent');
}

// --- C2: delete error ---
console.log('--- C2: delete error ---');
{
  const session = makeSession();
  const exec = { type: 'delete', id: 102, execId: 'e-err-del', path: '/no-perm' };
  const toolUse = execRequestToToolUse(exec, session);
  const result = await sessionSendToolResult(session, toolUse.id, {
    is_error: true,
    content: 'Permission denied',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'delete error result sent');
}

// --- C3: shell error (non-zero exit) ---
console.log('--- C3: shell error ---');
{
  const session = makeSession();
  const exec = { type: 'shell', id: 103, execId: 'e-err-sh', command: 'false' };
  const toolUse = execRequestToToolUse(exec, session);
  const result = await sessionSendToolResult(session, toolUse.id, {
    is_error: true,
    content: 'Command failed with exit code 1',
  }, { deferResume: true });
  assert(result.sentToCursor === true, 'shell error result sent');
}

// ═══════════════════════════════════════════════════════════════
// PART D: text_fallback and kvMapped tools → needsFreshRequest
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART D: text_fallback / kvMapped → fresh request ===\n');

// --- D1: text_fallback ---
{
  const session = makeSession();
  const tcId = 'toolu_textfallback_001';
  session.toolCallMapping.set(tcId, {
    cursorId: null,
    cursorExecId: null,
    cursorType: 'text_fallback',
    toolName: 'TodoWrite',
    toolInput: {},
  });
  const result = await sessionSendToolResult(session, tcId, { content: 'ok' }, { deferResume: true });
  assert(result.needsFreshRequest === true, 'text_fallback triggers fresh request');
  assert(result.sentToCursor === false, 'text_fallback not sent to cursor');
}

// --- D2: kvMapped ---
{
  const session = makeSession();
  const tcId = 'toolu_kvmapped_001';
  session.toolCallMapping.set(tcId, {
    cursorId: 999,
    cursorExecId: 'kv-1',
    cursorType: 'shell',
    cursorRequest: { command: 'echo hi' },
    kvMapped: true,
  });
  const result = await sessionSendToolResult(session, tcId, { content: 'hi' }, { deferResume: true });
  assert(result.needsFreshRequest === true, 'kvMapped triggers fresh request');
  assert(result.sentToCursor === false, 'kvMapped not sent to cursor');
}

// ═══════════════════════════════════════════════════════════════
// PART E: filterNonNativeTools with full Claude Code tool list
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART E: Full Claude Code tool list filtering ===\n');
{
  const fullToolList = [
    { name: 'Shell' }, { name: 'Read' }, { name: 'Write' },
    { name: 'StrReplace' }, { name: 'Glob' }, { name: 'Grep' },
    { name: 'Delete' }, { name: 'EditNotebook' }, { name: 'TodoWrite' },
    { name: 'Task' }, { name: 'WebFetch' }, { name: 'ListMcpResources' },
    { name: 'FetchMcpResource' }, { name: 'workflow3-workflow3' },
  ];

  const nonNative = filterNonNativeTools(fullToolList);
  const nonNativeNames = new Set(nonNative.map(t => t.name));

  assert(fullToolList.length === 14, `total tools: 14 (got ${fullToolList.length})`);
  assert(nonNative.length === 7, `non-native count: 7 (got ${nonNative.length})`);

  const expectedNonNative = ['EditNotebook', 'TodoWrite', 'Task', 'WebFetch', 'ListMcpResources', 'FetchMcpResource', 'workflow3-workflow3'];
  for (const name of expectedNonNative) {
    assert(nonNativeNames.has(name), `${name} passes through as non-native`);
  }

  const expectedNative = ['Shell', 'Read', 'Write', 'StrReplace', 'Glob', 'Grep', 'Delete'];
  for (const name of expectedNative) {
    assert(!nonNativeNames.has(name), `${name} is filtered as native-covered`);
  }

  // workflow3-workflow3 is a special case: not in NATIVE_COVERED_TOOLS
  // but also not in the standard non-native list since it has a dash
  assert(!isNativeCoveredTool('workflow3-workflow3'), 'workflow3-workflow3 is not native-covered');
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);

})().catch(err => { console.error(err); process.exit(1); });
