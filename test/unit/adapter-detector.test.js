/**
 * Client detector tests.
 *
 * Detection priority: tools heuristic > API key > default fallback.
 */

const assert = require('assert');
const { detectClient, detectFromTools, getAdapter } = require('../../src/adapters/detector');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// ─── Key-only detection (no tools) ─────────────────────────────────────────

console.log('\n[1] Key-only detection (no tools)');

test('key=opencode, no tools → opencode', () => {
  const req = { headers: { 'x-api-key': 'opencode' } };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

test('key=claude-code, no tools → claude-code', () => {
  const req = { headers: { 'x-api-key': 'claude-code' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code');
});

test('key=claude-code-cli, no tools → claude-code-cli', () => {
  const req = { headers: { 'x-api-key': 'claude-code-cli' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

test('key=openclaw, no tools → openclaw', () => {
  const req = { headers: { 'x-api-key': 'openclaw' } };
  assert.strictEqual(detectClient(req).clientType, 'openclaw');
});

// ─── Key case insensitive ──────────────────────────────────────────────────

console.log('\n[2] Key case insensitive');

test('key=OpenCode → opencode', () => {
  const req = { headers: { 'x-api-key': 'OpenCode' } };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

test('key=CLAUDE-CODE → claude-code', () => {
  const req = { headers: { 'x-api-key': 'CLAUDE-CODE' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code');
});

test('key=CLAUDE-CODE-CLI → claude-code-cli', () => {
  const req = { headers: { 'x-api-key': 'CLAUDE-CODE-CLI' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

// ─── Tool inference ───────────────────────────────────────────────────────

console.log('\n[3] Tool inference');

test('tools=[{name:StrReplace},{name:Bash}] → claude-code (PascalCase)', () => {
  const req = { body: { tools: [{ name: 'StrReplace' }, { name: 'Bash' }] } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code');
});

test('tools=[{name:read_file}] → opencode', () => {
  const req = { body: { tools: [{ name: 'read_file' }] } };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

test('tools=[{name:exec}] → openclaw', () => {
  const req = { body: { tools: [{ name: 'exec' }] } };
  assert.strictEqual(detectClient(req).clientType, 'openclaw');
});

test('tools=[{name:bash},{name:read},{name:grep}] → claude-code-cli', () => {
  const req = { body: { tools: [{ name: 'bash' }, { name: 'read' }, { name: 'grep' }] } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

// ─── Claude Code CLI with many tools (real scenario) ──────────────────────

console.log('\n[4] Claude Code CLI real scenario');

test('Claude Code CLI 44 tools → claude-code-cli (not opencode)', () => {
  const tools = [
    'question', 'bash', 'read', 'glob', 'grep', 'edit', 'write', 'task',
    'webfetch', 'todowrite', 'skill', 'lsp_goto_definition',
  ].map(name => ({ name }));
  const req = {
    headers: { authorization: 'Bearer opencode' },
    body: { tools },
  };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

test('Claude Code CLI with function format tools', () => {
  const tools = [
    { function: { name: 'bash' } },
    { function: { name: 'read' } },
    { function: { name: 'grep' } },
    { function: { name: 'glob' } },
  ];
  const req = { body: { tools } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

// ─── Tools override API key ──────────────────────────────────────────────

console.log('\n[5] Tools override API key');

test('key=opencode + tools=[{name:bash},{name:read},{name:grep}] → claude-code-cli (tools win)', () => {
  const req = {
    headers: { 'x-api-key': 'opencode' },
    body: { tools: [{ name: 'bash' }, { name: 'read' }, { name: 'grep' }] },
  };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

test('key=opencode + tools=[{name:read_file}] → opencode (tools agree)', () => {
  const req = {
    headers: { 'x-api-key': 'opencode' },
    body: { tools: [{ name: 'read_file' }] },
  };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

test('key=claude-code + tools=[{name:StrReplace}] → claude-code (PascalCase)', () => {
  const req = {
    headers: { 'x-api-key': 'claude-code' },
    body: { tools: [{ name: 'StrReplace' }, { name: 'Bash' }] },
  };
  assert.strictEqual(detectClient(req).clientType, 'claude-code');
});

// ─── Default ──────────────────────────────────────────────────────────────

console.log('\n[6] Default');

test('no key no tools → claude-code', () => {
  assert.strictEqual(detectClient({}).clientType, 'claude-code');
});

test('key=sk-xxx, no tools → claude-code (default)', () => {
  const req = { headers: { 'x-api-key': 'sk-xxx' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code');
});

// ─── Unknown key with tools ──────────────────────────────────────────────

console.log('\n[7] Unknown key with tools');

test('key=sk-xxx + tools=[{name:str_replace}] → opencode', () => {
  const req = {
    headers: { 'x-api-key': 'sk-xxx' },
    body: { tools: [{ name: 'str_replace' }] },
  };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

// ─── detectFromTools standalone ──────────────────────────────────────────

console.log('\n[8] detectFromTools');

test('detectFromTools(null) → null', () => {
  assert.strictEqual(detectFromTools(null), null);
});

test('detectFromTools([]) → null', () => {
  assert.strictEqual(detectFromTools([]), null);
});

test('detectFromTools(claude-code PascalCase) → claude-code', () => {
  const result = detectFromTools([{ name: 'StrReplace' }, { name: 'Bash' }]);
  assert.strictEqual(result.clientType, 'claude-code');
});

test('detectFromTools(claude-code-cli lowercase) → claude-code-cli', () => {
  const result = detectFromTools([{ name: 'bash' }, { name: 'read' }, { name: 'grep' }]);
  assert.strictEqual(result.clientType, 'claude-code-cli');
});

// ─── getAdapter ──────────────────────────────────────────────────────────

console.log('\n[9] getAdapter');

test('getAdapter(opencode) returns opencode adapter', () => {
  assert.strictEqual(getAdapter('opencode').clientType, 'opencode');
});

test('getAdapter(claude-code-cli) returns claude-code-cli adapter', () => {
  assert.strictEqual(getAdapter('claude-code-cli').clientType, 'claude-code-cli');
});

test('getAdapter(unknown) returns claude-code adapter (default)', () => {
  assert.strictEqual(getAdapter('unknown').clientType, 'claude-code');
});

// ─── Bearer token format ─────────────────────────────────────────────────

console.log('\n[10] Bearer token format');

test('authorization Bearer opencode, no tools → opencode', () => {
  const req = { headers: { authorization: 'Bearer opencode' } };
  assert.strictEqual(detectClient(req).clientType, 'opencode');
});

test('authorization Bearer claude-code-cli, no tools → claude-code-cli', () => {
  const req = { headers: { authorization: 'Bearer claude-code-cli' } };
  assert.strictEqual(detectClient(req).clientType, 'claude-code-cli');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
