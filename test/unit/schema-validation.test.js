/**
 * Schema-driven validation test.
 *
 * This test validates that our exec → tool_use parameter mappings produce
 * parameters that match the ACTUAL Claude Code tool schemas (extracted from
 * a real Claude Code API request and stored in test/fixtures/).
 *
 * The fixture is the "golden source of truth". If Claude Code changes its
 * tool schemas, update the fixture and this test will catch any drift.
 */

const assert = require('assert');
const path = require('path');

const SCHEMAS = require('../fixtures/claude-code-tool-schemas.json');
const { execRequestToToolUse } = require('../../src/utils/sessionManager');

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

function makeSession() {
  const captured = [];
  return {
    toolCallMapping: new Map(),
    sentCursorExecKeys: new Set(),
    agentClient: { bidiAppend: async (data) => { captured.push(data); } },
    _captured: captured,
  };
}

// ─── Verify fixture has the tools we expect ───
console.log('\n=== Schema fixture sanity checks ===');

test('fixture has Read', () => assert(SCHEMAS.Read));
test('fixture has Write', () => assert(SCHEMAS.Write));
test('fixture has Bash', () => assert(SCHEMAS.Bash));
test('fixture has Glob', () => assert(SCHEMAS.Glob));
test('fixture has Grep', () => assert(SCHEMAS.Grep));
test('fixture has Edit', () => assert(SCHEMAS.Edit));
test('fixture does NOT have Delete', () => assert(!SCHEMAS.Delete, 'Claude Code has no Delete tool'));
test('fixture does NOT have Shell', () => assert(!SCHEMAS.Shell, 'Claude Code uses Bash, not Shell'));

// ─── Core validation: each exec mapping must produce only schema-valid params ───

/**
 * For a given tool_use, assert that:
 * 1. Every required schema param is present in input (not undefined/null/empty)
 * 2. Every param key in input exists in the schema's property list
 */
function assertMatchesSchema(toolName, input, label) {
  const schema = SCHEMAS[toolName];
  if (!schema) {
    // Tool not in Claude Code → skip schema check (e.g. Delete mapped to Bash)
    return;
  }

  // Check required params are present
  for (const req of schema.required) {
    assert(
      input[req] !== undefined && input[req] !== null && input[req] !== '',
      `${label}: required param '${req}' is missing/empty (got ${JSON.stringify(input[req])})`
    );
  }

  // Check no unknown params
  for (const key of Object.keys(input)) {
    assert(
      schema.properties.includes(key),
      `${label}: param '${key}' is NOT in ${toolName} schema (valid: ${schema.properties.join(', ')})`
    );
  }
}

console.log('\n=== Read: exec → tool_use matches schema ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'read', id: 1, path: '/a/b.js' }, session);
  test('Read tool name', () => assert.strictEqual(tu.name, 'Read'));
  test('Read params match schema', () => assertMatchesSchema('Read', tu.input, 'Read'));
  test('Read file_path has correct value', () => assert.strictEqual(tu.input.file_path, '/a/b.js'));
}

console.log('\n=== Read with offset/limit ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'read', id: 2, path: '/a.txt', startLine: 10, endLine: 20 }, session);
  test('Read+range params match schema', () => assertMatchesSchema('Read', tu.input, 'Read+range'));
  test('Read offset correct', () => assert.strictEqual(tu.input.offset, 10));
  test('Read limit correct', () => assert.strictEqual(tu.input.limit, 11));
}

console.log('\n=== Write: exec → tool_use matches schema ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'write', id: 3, path: '/a/b.txt', fileText: 'hello' }, session);
  test('Write tool name', () => assert.strictEqual(tu.name, 'Write'));
  test('Write params match schema', () => assertMatchesSchema('Write', tu.input, 'Write'));
  test('Write file_path value', () => assert.strictEqual(tu.input.file_path, '/a/b.txt'));
  test('Write content value', () => assert.strictEqual(tu.input.content, 'hello'));
}

console.log('\n=== Bash: exec → tool_use matches schema ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'shell', id: 4, command: 'ls -la', cwd: '/home' }, session);
  test('Bash tool name', () => assert.strictEqual(tu.name, 'Bash'));
  test('Bash params match schema', () => assertMatchesSchema('Bash', tu.input, 'Bash'));
  test('Bash command value', () => assert.strictEqual(tu.input.command, 'ls -la'));
}

console.log('\n=== Bash without cwd ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'shell', id: 5, command: 'pwd' }, session);
  test('Bash (no cwd) params match schema', () => assertMatchesSchema('Bash', tu.input, 'Bash-no-cwd'));
  test('Bash (no cwd) no extra keys', () => {
    assert.strictEqual(Object.keys(tu.input).length, 1, 'only command key');
  });
}

console.log('\n=== Glob: exec → tool_use matches schema ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'ls', id: 6, path: '/project/src' }, session);
  test('Glob tool name', () => assert.strictEqual(tu.name, 'Glob'));
  test('Glob params match schema', () => assertMatchesSchema('Glob', tu.input, 'Glob'));
  test('Glob pattern value', () => assert.strictEqual(tu.input.pattern, '*'));
  test('Glob path value', () => assert.strictEqual(tu.input.path, '/project/src'));
}

console.log('\n=== Grep: exec → tool_use matches schema ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'grep', id: 7, pattern: 'TODO', path: '/src' }, session);
  test('Grep tool name', () => assert.strictEqual(tu.name, 'Grep'));
  test('Grep params match schema', () => assertMatchesSchema('Grep', tu.input, 'Grep'));
  test('Grep pattern value', () => assert.strictEqual(tu.input.pattern, 'TODO'));
}

console.log('\n=== Delete: mapped to Bash (no Delete in Claude Code) ===');
{
  const session = makeSession();
  const tu = execRequestToToolUse({ type: 'delete', id: 8, path: '/tmp/x.txt' }, session);
  test('Delete maps to Bash', () => assert.strictEqual(tu.name, 'Bash'));
  test('Delete-as-Bash params match Bash schema', () => assertMatchesSchema('Bash', tu.input, 'Delete-as-Bash'));
  test('Delete command includes path', () => assert(tu.input.command.includes('/tmp/x.txt')));
}

// ─── Negative tests: ensure WRONG param names are NOT present ───

console.log('\n=== Negative: wrong param names must NOT exist ===');
{
  const session = makeSession();

  const read = execRequestToToolUse({ type: 'read', id: 10, path: '/a.js' }, session);
  test('Read: no "path" key (should be file_path)', () => assert(!('path' in read.input)));

  const write = execRequestToToolUse({ type: 'write', id: 11, path: '/b.txt', fileText: 'x' }, session);
  test('Write: no "path" key', () => assert(!('path' in write.input)));
  test('Write: no "contents" key (should be content)', () => assert(!('contents' in write.input)));

  const glob = execRequestToToolUse({ type: 'ls', id: 12, path: '/src' }, session);
  test('Glob: no "glob_pattern" key', () => assert(!('glob_pattern' in glob.input)));
  test('Glob: no "target_directory" key', () => assert(!('target_directory' in glob.input)));

  const bash = execRequestToToolUse({ type: 'shell', id: 13, command: 'ls', cwd: '/home' }, session);
  test('Bash: no "working_directory" key', () => assert(!('working_directory' in bash.input)));
}

// ─── Summary ───
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
