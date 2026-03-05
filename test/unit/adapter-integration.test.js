/**
 * Phase 2 integration tests: verify that adapter-based canonical path produces
 * correct tool names and parameters for all three clients, AND that the legacy
 * (no-adapter) path still works unchanged.
 */
const assert = require('assert');
const { execRequestToToolUse, SessionState } = require('../../src/utils/sessionManager');
const { adaptKvToolUseToIde } = require('../../src/utils/kvToolAdapter');
const { mapAgentChunkToToolUse } = require('../../src/utils/bidiToolFlowAdapter');
const { isNativeCoveredTool, filterNonNativeTools, extractWorkingDirectory } = require('../../src/utils/toolsAdapter');

const claudeAdapter = require('../../src/adapters/claude-code');
const cliAdapter = require('../../src/adapters/claude-code-cli');
const opencodeAdapter = require('../../src/adapters/opencode');
const openclawAdapter = require('../../src/adapters/openclaw');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

function makeSession() {
  return new SessionState('test-session', null);
}

// ─── execRequestToToolUse with adapter ───────────────────────────────────
console.log('\n=== execRequestToToolUse with adapter ===');

test('read exec → Claude Code: name=Read, param=path', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'read', id: 1, execId: 'e1', path: '/tmp/a.txt' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'Read');
  assert.strictEqual(result.input.path, '/tmp/a.txt');
});

test('read exec → opencode: name=read, param=file_path', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'read', id: 1, execId: 'e1', path: '/tmp/a.txt' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.input.file_path, '/tmp/a.txt');
});

test('read exec → claude-code-cli: name=read, param=path', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'read', id: 1, execId: 'e1', path: '/tmp/a.txt' }, session, cliAdapter);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.input.path, '/tmp/a.txt');
});

test('read exec → openclaw: name=read, param=path', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'read', id: 1, execId: 'e1', path: '/tmp/a.txt' }, session, openclawAdapter);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.input.path, '/tmp/a.txt');
});

test('write exec → Claude Code: name=Write, content→contents', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'write', id: 2, execId: 'e2', path: '/tmp/b.txt', fileText: 'hello' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'Write');
  assert.strictEqual(result.input.contents, 'hello');
  assert.strictEqual(result.input.path, '/tmp/b.txt');
});

test('write exec → claude-code-cli: name=write, content stays content (singular)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'write', id: 2, execId: 'e2', path: '/tmp/b.txt', fileText: 'hello' }, session, cliAdapter);
  assert.strictEqual(result.name, 'write');
  assert.strictEqual(result.input.content, 'hello');
  assert.strictEqual(result.input.path, '/tmp/b.txt');
});

test('write exec → opencode: name=write, content stays content', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'write', id: 2, execId: 'e2', path: '/tmp/b.txt', fileText: 'hello' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'write');
  assert.strictEqual(result.input.content, 'hello');
  assert.strictEqual(result.input.file_path, '/tmp/b.txt');
});

test('shell exec → Claude Code: name=Bash, has description', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls -la' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'Bash');
  assert.strictEqual(result.input.command, 'ls -la');
  assert.strictEqual(typeof result.input.description, 'string');
  assert.ok(result.input.description.length > 0, 'description should not be empty');
});

test('shell exec → opencode: name=bash, has description', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls -la' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'bash');
  assert.strictEqual(result.input.command, 'ls -la');
  assert.strictEqual(typeof result.input.description, 'string');
  assert.ok(result.input.description.length > 0, 'description should not be empty');
});

test('shell exec → claude-code-cli: name=bash', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls -la' }, session, cliAdapter);
  assert.strictEqual(result.name, 'bash');
  assert.strictEqual(result.input.command, 'ls -la');
});

test('shell exec → openclaw: name=exec, has description', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls -la' }, session, openclawAdapter);
  assert.strictEqual(result.name, 'exec');
  assert.strictEqual(result.input.command, 'ls -la');
  assert.strictEqual(typeof result.input.description, 'string');
});

test('shell exec with cwd → openclaw: working_dir + description mentions cwd', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls', cwd: '/tmp' }, session, openclawAdapter);
  assert.strictEqual(result.input.working_dir, '/tmp');
  assert.ok(result.input.description.includes('/tmp'), 'description should mention cwd');
});

test('shell exec with cwd → Claude Code: working_directory + description', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls', cwd: '/tmp' }, session, claudeAdapter);
  assert.strictEqual(result.input.working_directory, '/tmp');
  assert.ok(result.input.description.includes('/tmp'), 'description should mention cwd');
});

test('shell exec with cwd → opencode: description includes cwd', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'npm test', cwd: '/home/user' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'bash');
  assert.strictEqual(result.input.command, 'npm test');
  assert.strictEqual(result.input.working_directory, '/home/user');
  assert.ok(result.input.description.includes('/home/user'), 'description should mention cwd');
});

test('shell exec with cwd → claude-code-cli: working_directory', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 3, execId: 'e3', command: 'ls', cwd: '/tmp' }, session, cliAdapter);
  assert.strictEqual(result.input.working_directory, '/tmp');
});

test('grep exec → Claude Code: name=Grep', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'grep', id: 4, execId: 'e4', pattern: 'TODO', path: '/src' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'Grep');
  assert.strictEqual(result.input.pattern, 'TODO');
  assert.strictEqual(result.input.path, '/src');
});

test('grep exec → claude-code-cli: name=grep', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'grep', id: 4, execId: 'e4', pattern: 'TODO', path: '/src' }, session, cliAdapter);
  assert.strictEqual(result.name, 'grep');
  assert.strictEqual(result.input.pattern, 'TODO');
});

test('grep exec → opencode: name=grep', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'grep', id: 4, execId: 'e4', pattern: 'TODO', path: '/src' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'grep');
});

test('ls exec → Claude Code: name=LS (dir_list canonical)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'ls', id: 5, execId: 'e5', path: '/home' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'LS');
});

test('ls exec → opencode: name=ls (dir_list canonical)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'ls', id: 5, execId: 'e5', path: '/home' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'ls');
});

test('delete exec → Claude Code: name=Delete', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'delete', id: 6, execId: 'e6', path: '/tmp/c.txt' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'Delete');
  assert.strictEqual(result.input.path, '/tmp/c.txt');
});

test('delete exec → claude-code-cli: name=delete', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'delete', id: 6, execId: 'e6', path: '/tmp/c.txt' }, session, cliAdapter);
  assert.strictEqual(result.name, 'delete');
  assert.strictEqual(result.input.path, '/tmp/c.txt');
});

test('delete exec → opencode: name=delete', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'delete', id: 6, execId: 'e6', path: '/tmp/c.txt' }, session, opencodeAdapter);
  assert.strictEqual(result.name, 'delete');
});

test('mcp exec → passes through with adapter', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'mcp', id: 7, execId: 'e7', toolName: 'custom_tool', args: { foo: 'bar' } }, session, claudeAdapter);
  assert.strictEqual(result.name, 'custom_tool');
  assert.strictEqual(result.input.foo, 'bar');
});

test('request_context → stays request_context with adapter', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'request_context', id: 8, execId: 'e8' }, session, claudeAdapter);
  assert.strictEqual(result.name, 'request_context');
});

// ─── Legacy (no adapter) still works ─────────────────────────────────────
console.log('\n=== execRequestToToolUse without adapter (legacy) ===');

test('read exec without adapter → Glob (legacy)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'ls', id: 1, execId: 'e1', path: '/tmp' }, session);
  assert.strictEqual(result.name, 'Glob');
});

test('shell exec without adapter → Bash (legacy)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'shell', id: 2, execId: 'e2', command: 'pwd' }, session);
  assert.strictEqual(result.name, 'Bash');
});

test('delete exec without adapter → Bash rm -f (legacy)', () => {
  const session = makeSession();
  const result = execRequestToToolUse({ type: 'delete', id: 3, execId: 'e3', path: '/tmp/x' }, session);
  assert.strictEqual(result.name, 'Bash');
  assert.ok(result.input.command.includes('rm -f'));
});

// ─── adaptKvToolUseToIde with adapter ────────────────────────────────────
console.log('\n=== adaptKvToolUseToIde with adapter ===');

test('KV Read → Claude Code: Read, path stays path', () => {
  const toolUse = { id: 'kv1', name: 'Read', input: { path: '/a.txt' } };
  const result = adaptKvToolUseToIde(toolUse, [], claudeAdapter);
  assert.strictEqual(result.name, 'Read');
  assert.strictEqual(result.input.path, '/a.txt');
});

test('KV read → opencode: read, file_path', () => {
  const toolUse = { id: 'kv2', name: 'read', input: { file_path: '/a.txt' } };
  const result = adaptKvToolUseToIde(toolUse, [], opencodeAdapter);
  assert.strictEqual(result.name, 'read');
  assert.strictEqual(result.input.file_path, '/a.txt');
});

test('KV Write → Claude Code: Write, content→contents', () => {
  const toolUse = { id: 'kv3', name: 'Write', input: { path: '/b.txt', content: 'hi' } };
  const result = adaptKvToolUseToIde(toolUse, [], claudeAdapter);
  assert.strictEqual(result.name, 'Write');
  assert.strictEqual(result.input.contents, 'hi');
});

test('KV Edit with old_string → Claude Code: StrReplace', () => {
  const toolUse = { id: 'kv4', name: 'Edit', input: { path: '/c.txt', old_string: 'x', new_string: 'y' } };
  const result = adaptKvToolUseToIde(toolUse, [], claudeAdapter);
  assert.strictEqual(result.name, 'StrReplace');
  assert.strictEqual(result.input.old_string, 'x');
  assert.strictEqual(result.input.new_string, 'y');
});

test('KV unknown tool → falls through to legacy', () => {
  const toolUse = { id: 'kv5', name: 'some_custom_tool', input: { a: 1 } };
  const result = adaptKvToolUseToIde(toolUse, [], claudeAdapter);
  assert.strictEqual(result.name, 'some_custom_tool');
});

// ─── isNativeCoveredTool with adapter ────────────────────────────────────
console.log('\n=== isNativeCoveredTool with adapter ===');

test('Claude Code: Read is native covered', () => {
  assert.strictEqual(isNativeCoveredTool('Read', claudeAdapter), true);
});

test('Claude Code: WebFetch is NOT native covered', () => {
  assert.strictEqual(isNativeCoveredTool('WebFetch', claudeAdapter), false);
});

test('claude-code-cli: read is native covered', () => {
  assert.strictEqual(isNativeCoveredTool('read', cliAdapter), true);
});

test('claude-code-cli: webfetch is NOT native covered', () => {
  assert.strictEqual(isNativeCoveredTool('webfetch', cliAdapter), false);
});

test('opencode: read is native covered', () => {
  assert.strictEqual(isNativeCoveredTool('read', opencodeAdapter), true);
});

test('opencode: webfetch is NOT native covered', () => {
  assert.strictEqual(isNativeCoveredTool('webfetch', opencodeAdapter), false);
});

test('openclaw: read is native covered', () => {
  assert.strictEqual(isNativeCoveredTool('read', openclawAdapter), true);
});

test('openclaw: search is NOT native covered (only 4 native)', () => {
  assert.strictEqual(isNativeCoveredTool('search', openclawAdapter), false);
});

test('legacy (no adapter): read is native covered', () => {
  assert.strictEqual(isNativeCoveredTool('read'), true);
});

test('legacy (no adapter): WebFetch is NOT native covered', () => {
  assert.strictEqual(isNativeCoveredTool('WebFetch'), false);
});

// ─── filterNonNativeTools with adapter ───────────────────────────────────
console.log('\n=== filterNonNativeTools with adapter ===');

test('Claude Code: filters out Read/Write/Bash, keeps WebFetch/TodoWrite', () => {
  const tools = [
    { name: 'Read' }, { name: 'Write' }, { name: 'Bash' },
    { name: 'WebFetch' }, { name: 'TodoWrite' },
  ];
  const result = filterNonNativeTools(tools, claudeAdapter);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].name, 'WebFetch');
  assert.strictEqual(result[1].name, 'TodoWrite');
});

test('opencode: filters out read/write/bash, keeps webfetch/skill', () => {
  const tools = [
    { name: 'read' }, { name: 'write' }, { name: 'bash' },
    { name: 'webfetch' }, { name: 'skill' },
  ];
  const result = filterNonNativeTools(tools, opencodeAdapter);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].name, 'webfetch');
  assert.strictEqual(result[1].name, 'skill');
});

test('claude-code-cli: filters out read/write/bash/grep/glob/edit, keeps webfetch/todowrite/task', () => {
  const tools = [
    { name: 'read' }, { name: 'write' }, { name: 'bash' },
    { name: 'grep' }, { name: 'glob' }, { name: 'edit' },
    { name: 'webfetch' }, { name: 'todowrite' }, { name: 'task' },
  ];
  const result = filterNonNativeTools(tools, cliAdapter);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].name, 'webfetch');
  assert.strictEqual(result[1].name, 'todowrite');
  assert.strictEqual(result[2].name, 'task');
});

// ─── extractWorkingDirectory with adapter ────────────────────────────────
console.log('\n=== extractWorkingDirectory with adapter ===');

test('Claude Code adapter: Workspace Path: → /home/user/proj', () => {
  const result = extractWorkingDirectory('Some text\nWorkspace Path: /home/user/proj\nMore text', claudeAdapter);
  assert.strictEqual(result, '/home/user/proj');
});

test('opencode adapter: Working directory: → /tmp/proj', () => {
  const result = extractWorkingDirectory('Working directory: /tmp/proj', opencodeAdapter);
  assert.strictEqual(result, '/tmp/proj');
});

test('legacy (no adapter): Workspace Path: → /home/user', () => {
  const result = extractWorkingDirectory('Workspace Path: /home/user');
  assert.strictEqual(result, '/home/user');
});

// ─── mapAgentChunkToToolUse with adapter ─────────────────────────────────
console.log('\n=== mapAgentChunkToToolUse with adapter ===');

test('exec chunk → Claude Code adapter: Bash', () => {
  const session = makeSession();
  const chunk = { type: 'tool_call', execRequest: { type: 'shell', id: 1, execId: 'e1', command: 'echo hi' } };
  const result = mapAgentChunkToToolUse(chunk, {
    session, tools: [], execRequestToToolUse, adapter: claudeAdapter
  });
  assert.strictEqual(result.name, 'Bash');
  assert.strictEqual(result.input.command, 'echo hi');
});

test('exec chunk → opencode adapter: bash', () => {
  const session = makeSession();
  const chunk = { type: 'tool_call', execRequest: { type: 'shell', id: 2, execId: 'e2', command: 'echo hi' } };
  const result = mapAgentChunkToToolUse(chunk, {
    session, tools: [], execRequestToToolUse, adapter: opencodeAdapter
  });
  assert.strictEqual(result.name, 'bash');
});

test('exec chunk → openclaw adapter: exec', () => {
  const session = makeSession();
  const chunk = { type: 'tool_call', execRequest: { type: 'shell', id: 3, execId: 'e3', command: 'echo hi' } };
  const result = mapAgentChunkToToolUse(chunk, {
    session, tools: [], execRequestToToolUse, adapter: openclawAdapter
  });
  assert.strictEqual(result.name, 'exec');
});

// ─── Cross-adapter consistency ───────────────────────────────────────────
console.log('\n=== Cross-adapter consistency ===');

test('same exec (read), all adapters produce type=tool_use', () => {
  const exec = { type: 'read', id: 1, execId: 'e1', path: '/tmp/test.txt' };
  for (const adapter of [claudeAdapter, opencodeAdapter, openclawAdapter]) {
    const session = makeSession();
    const result = execRequestToToolUse(exec, session, adapter);
    assert.strictEqual(result.type, 'tool_use');
    assert.ok(result.id.startsWith('toolu_'));
  }
});

test('same exec (write), content value is preserved across adapters', () => {
  const exec = { type: 'write', id: 2, execId: 'e2', path: '/tmp/x.txt', fileText: 'hello world' };
  const claude = execRequestToToolUse(exec, makeSession(), claudeAdapter);
  const oc = execRequestToToolUse(exec, makeSession(), opencodeAdapter);
  const oclaw = execRequestToToolUse(exec, makeSession(), openclawAdapter);
  // Different param names but same value
  assert.strictEqual(claude.input.contents, 'hello world');
  assert.strictEqual(oc.input.content, 'hello world');
  assert.strictEqual(oclaw.input.content, 'hello world');
});

// ─── path fallback uses session workspacePath, not process.cwd() ─────────
console.log('\n=== path fallback uses session workspacePath ===');

function makeSessionWithCwd(cwd) {
  const s = new SessionState('test-session', { workspacePath: cwd });
  return s;
}

test('grep exec with path=undefined → uses session workspacePath (adapter)', () => {
  const session = makeSessionWithCwd('/home/user/project');
  const result = execRequestToToolUse({ type: 'grep', id: 1, execId: 'e1', pattern: 'TODO', path: undefined }, session, claudeAdapter);
  assert.strictEqual(result.input.path, '/home/user/project');
});

test('grep exec with path=undefined → uses session workspacePath (legacy)', () => {
  const session = makeSessionWithCwd('/home/user/project');
  const result = execRequestToToolUse({ type: 'grep', id: 1, execId: 'e1', pattern: 'TODO', path: undefined }, session);
  assert.strictEqual(result.input.path, '/home/user/project');
});

test('ls exec with path=undefined → uses session workspacePath (adapter)', () => {
  const session = makeSessionWithCwd('/tmp/work');
  const result = execRequestToToolUse({ type: 'ls', id: 2, execId: 'e2', path: undefined }, session, claudeAdapter);
  assert.strictEqual(result.input.path, '/tmp/work');
});

test('ls exec with path=undefined → uses session workspacePath (legacy)', () => {
  const session = makeSessionWithCwd('/tmp/work');
  const result = execRequestToToolUse({ type: 'ls', id: 2, execId: 'e2', path: undefined }, session);
  assert.strictEqual(result.input.path, '/tmp/work');
});

test('grep exec with explicit path → uses explicit path, not fallback', () => {
  const session = makeSessionWithCwd('/home/user/project');
  const result = execRequestToToolUse({ type: 'grep', id: 3, execId: 'e3', pattern: 'TODO', path: '/explicit/path' }, session, claudeAdapter);
  assert.strictEqual(result.input.path, '/explicit/path');
});

test('grep exec with null agentClient → falls back to process.cwd()', () => {
  const session = new SessionState('test-session', null);
  const result = execRequestToToolUse({ type: 'grep', id: 4, execId: 'e4', pattern: 'TODO', path: undefined }, session, claudeAdapter);
  assert.strictEqual(result.input.path, process.cwd());
});

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
