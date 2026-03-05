/**
 * Test: Native Tool Filtering
 *
 * Verifies that:
 * 1. Claude Code tools with Cursor native equivalents are filtered out of MCP/prompt
 * 2. Tools without native equivalents pass through for MCP registration
 * 3. execRequestToToolUse produces correct Claude Code parameter names
 * 4. Field 4 is correctly parsed as 'delete' (not 'read_v1')
 */

const {
  filterNonNativeTools,
  isNativeCoveredTool,
} = require('../../src/utils/toolsAdapter');
const { execRequestToToolUse } = require('../../src/utils/sessionManager');
const { parseExecServerMessage } = require('../../src/utils/agentClient');
const {
  encodeStringField,
  encodeMessageField,
  encodeUint32Field,
  concatBytes,
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
  return { toolCallMapping: new Map(), pendingToolCalls: [] };
}

// ─── Section 1: isNativeCoveredTool ───────────────────────────

console.log('\n=== isNativeCoveredTool ===');

const nativeTools = ['Read', 'Write', 'StrReplace', 'Bash', 'Shell', 'Grep', 'Glob', 'LS', 'Delete'];
const nonNativeTools = ['TodoWrite', 'Task', 'WebFetch', 'EditNotebook', 'ListMcpResources', 'FetchMcpResource'];

for (const name of nativeTools) {
  assert(isNativeCoveredTool(name), `${name} is native-covered`);
}
for (const name of nonNativeTools) {
  assert(!isNativeCoveredTool(name), `${name} is NOT native-covered`);
}
assert(isNativeCoveredTool('read'), 'case-insensitive: read');
assert(isNativeCoveredTool('BASH'), 'case-insensitive: BASH');
assert(!isNativeCoveredTool(''), 'empty string → false');
assert(!isNativeCoveredTool(null), 'null → false');

// ─── Section 2: filterNonNativeTools ──────────────────────────

console.log('\n=== filterNonNativeTools ===');

const allTools = [
  { name: 'Read' }, { name: 'Write' }, { name: 'StrReplace' },
  { name: 'Bash' }, { name: 'Grep' }, { name: 'Glob' }, { name: 'Delete' },
  { name: 'TodoWrite' }, { name: 'Task' }, { name: 'WebFetch' }, { name: 'EditNotebook' },
];

const filtered = filterNonNativeTools(allTools);
const filteredNames = filtered.map(t => t.name);

assert(filteredNames.length === 4, `filtered count is 4 (got ${filteredNames.length})`);
assert(filteredNames.includes('TodoWrite'), 'TodoWrite passes through');
assert(filteredNames.includes('Task'), 'Task passes through');
assert(filteredNames.includes('WebFetch'), 'WebFetch passes through');
assert(filteredNames.includes('EditNotebook'), 'EditNotebook passes through');
assert(!filteredNames.includes('StrReplace'), 'StrReplace is filtered out');
assert(!filteredNames.includes('Read'), 'Read is filtered out');
assert(!filteredNames.includes('Delete'), 'Delete is filtered out');

assert(filterNonNativeTools(null).length === 0, 'null tools → empty array');
assert(filterNonNativeTools([]).length === 0, 'empty tools → empty array');

// ─── Section 3: execRequestToToolUse parameter mapping ────────

console.log('\n=== execRequestToToolUse parameter names ===');

const session = makeSession();

// Read: uses 'file_path' to match Claude Code's Read tool schema
const readResult = execRequestToToolUse({ type: 'read', id: 1, path: '/a/b.txt' }, session);
assert(readResult.name === 'Read', 'read → Read');
assert(readResult.input.file_path === '/a/b.txt', 'Read uses input.file_path');

// Write: uses 'file_path' and 'content' to match Claude Code's Write tool schema
const writeResult = execRequestToToolUse({ type: 'write', id: 2, path: '/a/b.txt', fileText: 'hello' }, session);
assert(writeResult.name === 'Write', 'write → Write');
assert(writeResult.input.file_path === '/a/b.txt', 'Write uses input.file_path');
assert(writeResult.input.content === 'hello', 'Write uses input.content');

// Shell: should use 'command'
const shellResult = execRequestToToolUse({ type: 'shell', id: 3, command: 'ls', cwd: '/home' }, session);
assert(shellResult.name === 'Bash', 'shell → Bash');
assert(shellResult.input.command === 'ls', 'Bash uses input.command');
assert(shellResult.input.description, 'Bash includes description for cwd');

// Delete: mapped to Bash rm -f (Claude Code has no Delete tool)
const deleteResult = execRequestToToolUse({ type: 'delete', id: 4, path: '/tmp/x.txt' }, session);
assert(deleteResult.name === 'Bash', 'delete → Bash');
assert(deleteResult.input.command.includes('rm -f'), 'Delete uses rm -f command');
assert(deleteResult.input.command.includes('/tmp/x.txt'), 'Delete command includes path');

// LS → Glob
const lsResult = execRequestToToolUse({ type: 'ls', id: 5, path: '/home/user' }, session);
assert(lsResult.name === 'Glob', 'ls → Glob');
assert(lsResult.input.pattern === '*', 'Glob has pattern=*');
assert(lsResult.input.path === '/home/user', 'Glob has path');

// Grep
const grepResult = execRequestToToolUse({ type: 'grep', id: 6, pattern: 'TODO', path: '/src' }, session);
assert(grepResult.name === 'Grep', 'grep → Grep');
assert(grepResult.input.pattern === 'TODO', 'Grep uses input.pattern');
assert(grepResult.input.path === '/src', 'Grep uses input.path');

// MCP tool passthrough
const mcpResult = execRequestToToolUse({ type: 'mcp', id: 7, toolName: 'get_weather', args: { city: 'Beijing' } }, session);
assert(mcpResult.name === 'get_weather', 'mcp → uses toolName directly');
assert(mcpResult.input.city === 'Beijing', 'mcp preserves args');

// ─── Section 4: parseExecServerMessage field 4 = delete ───────

console.log('\n=== parseExecServerMessage field 4 = delete ===');

const deleteArgs = encodeStringField(1, '/home/user/test.txt');
const execMsg = concatBytes(
  encodeUint32Field(1, 42),
  encodeMessageField(4, deleteArgs),
  encodeStringField(15, 'exec-abc'),
);
const parsed = parseExecServerMessage(execMsg);

assert(parsed.type === 'delete', 'field 4 parsed as delete (not read_v1)');
assert(parsed.path === '/home/user/test.txt', 'delete path is correct');
assert(parsed.id === 42, 'delete id is 42');
assert(parsed.execId === 'exec-abc', 'delete execId is exec-abc');

// ─── Summary ──────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
