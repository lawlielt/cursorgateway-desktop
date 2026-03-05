/**
 * openclaw adapter instance tests.
 */

const assert = require('assert');
const openclawAdapter = require('../../src/adapters/openclaw');

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

// ─── toCanonical ────────────────────────────────────────────────────────────

console.log('\n[1] toCanonical');

test('toCanonical(read) === file_read', () => {
  assert.strictEqual(openclawAdapter.toCanonical('read'), 'file_read');
});

test('toCanonical(write) === file_write', () => {
  assert.strictEqual(openclawAdapter.toCanonical('write'), 'file_write');
});

test('toCanonical(edit) === file_edit', () => {
  assert.strictEqual(openclawAdapter.toCanonical('edit'), 'file_edit');
});

test('toCanonical(exec) === shell_exec', () => {
  assert.strictEqual(openclawAdapter.toCanonical('exec'), 'shell_exec');
});

test('toCanonical(search) === content_search', () => {
  assert.strictEqual(openclawAdapter.toCanonical('search'), 'content_search');
});

// ─── fromCanonical ──────────────────────────────────────────────────────────

console.log('\n[2] fromCanonical');

test('fromCanonical(shell_exec) === exec', () => {
  assert.strictEqual(openclawAdapter.fromCanonical('shell_exec'), 'exec');
});

// ─── denormalizeParams ───────────────────────────────────────────────────────

console.log('\n[3] denormalizeParams');

test('denormalizeParams(shell_exec): working_directory→working_dir', () => {
  const out = openclawAdapter.denormalizeParams('shell_exec', {
    command: 'ls',
    working_directory: '/tmp',
  });
  assert.strictEqual(out.command, 'ls');
  assert.strictEqual(out.working_dir, '/tmp');
});

test('denormalizeParams(file_edit): path→file_path', () => {
  const out = openclawAdapter.denormalizeParams('file_edit', {
    path: '/a',
    old_string: 'x',
    new_string: 'y',
  });
  assert.strictEqual(out.file_path, '/a');
  assert.strictEqual(out.old_string, 'x');
  assert.strictEqual(out.new_string, 'y');
});

// ─── isNativeCovered ─────────────────────────────────────────────────────────

console.log('\n[4] isNativeCovered');

test('isNativeCovered: only 4 tools (file_read, file_write, file_edit, shell_exec)', () => {
  assert.strictEqual(openclawAdapter.isNativeCovered('file_read'), true);
  assert.strictEqual(openclawAdapter.isNativeCovered('file_write'), true);
  assert.strictEqual(openclawAdapter.isNativeCovered('file_edit'), true);
  assert.strictEqual(openclawAdapter.isNativeCovered('shell_exec'), true);
});

test('isNativeCovered(content_search) === false', () => {
  assert.strictEqual(openclawAdapter.isNativeCovered('content_search'), false);
});

test('isNativeCovered(file_search) === false', () => {
  assert.strictEqual(openclawAdapter.isNativeCovered('file_search'), false);
});

// ─── clientType ──────────────────────────────────────────────────────────────

console.log('\n[5] clientType');

test('clientType === openclaw', () => {
  assert.strictEqual(openclawAdapter.clientType, 'openclaw');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
