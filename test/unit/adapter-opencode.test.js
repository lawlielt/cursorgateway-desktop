/**
 * opencode adapter instance tests.
 */

const assert = require('assert');
const opencodeAdapter = require('../../src/adapters/opencode');

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
  assert.strictEqual(opencodeAdapter.toCanonical('read'), 'file_read');
});

test('toCanonical(write) === file_write', () => {
  assert.strictEqual(opencodeAdapter.toCanonical('write'), 'file_write');
});

test('toCanonical(edit) === file_edit', () => {
  assert.strictEqual(opencodeAdapter.toCanonical('edit'), 'file_edit');
});

test('toCanonical(bash) === shell_exec', () => {
  assert.strictEqual(opencodeAdapter.toCanonical('bash'), 'shell_exec');
});

test('toCanonical(grep) === content_search', () => {
  assert.strictEqual(opencodeAdapter.toCanonical('grep'), 'content_search');
});

test('toCanonical(glob) === file_search', () => {
  assert.strictEqual(opencodeAdapter.toCanonical('glob'), 'file_search');
});

// ─── fromCanonical ──────────────────────────────────────────────────────────

console.log('\n[2] fromCanonical');

test('fromCanonical(file_read) === read', () => {
  assert.strictEqual(opencodeAdapter.fromCanonical('file_read'), 'read');
});

test('fromCanonical(file_write) === write', () => {
  assert.strictEqual(opencodeAdapter.fromCanonical('file_write'), 'write');
});

test('fromCanonical(file_edit) === edit', () => {
  assert.strictEqual(opencodeAdapter.fromCanonical('file_edit'), 'edit');
});

test('fromCanonical(shell_exec) === bash', () => {
  assert.strictEqual(opencodeAdapter.fromCanonical('shell_exec'), 'bash');
});

// ─── denormalizeParams ───────────────────────────────────────────────────────

console.log('\n[3] denormalizeParams');

test('denormalizeParams(file_read): path→file_path', () => {
  const out = opencodeAdapter.denormalizeParams('file_read', { path: '/a.txt' });
  assert.strictEqual(out.file_path, '/a.txt');
});

test('denormalizeParams(file_write): path→file_path, content stays singular', () => {
  const out = opencodeAdapter.denormalizeParams('file_write', {
    path: '/b.txt',
    content: 'data',
  });
  assert.strictEqual(out.file_path, '/b.txt');
  assert.strictEqual(out.content, 'data');
});

test('denormalizeParams(shell_exec): description is passed through', () => {
  const out = opencodeAdapter.denormalizeParams('shell_exec', {
    command: 'ls -la',
    description: 'Run command',
  });
  assert.strictEqual(out.command, 'ls -la');
  assert.strictEqual(out.description, 'Run command');
});

test('denormalizeParams(shell_exec): description with cwd', () => {
  const out = opencodeAdapter.denormalizeParams('shell_exec', {
    command: 'npm test',
    working_directory: '/home/user/project',
    description: 'Run in /home/user/project',
  });
  assert.strictEqual(out.command, 'npm test');
  assert.strictEqual(out.working_directory, '/home/user/project');
  assert.strictEqual(out.description, 'Run in /home/user/project');
});

// ─── normalizeParams ─────────────────────────────────────────────────────────

console.log('\n[4] normalizeParams');

test('normalizeParams(file_read): file_path→path', () => {
  const out = opencodeAdapter.normalizeParams('file_read', { file_path: '/a.txt' });
  assert.strictEqual(out.path, '/a.txt');
});

test('normalizeParams(file_write): file_path→path, content stays', () => {
  const out = opencodeAdapter.normalizeParams('file_write', {
    file_path: '/b.txt',
    content: 'data',
  });
  assert.strictEqual(out.path, '/b.txt');
  assert.strictEqual(out.content, 'data');
});

// ─── isNativeCovered ─────────────────────────────────────────────────────────

console.log('\n[5] isNativeCovered');

test('isNativeCovered: 8 native tools covered', () => {
  const native = [
    'file_read', 'file_write', 'file_edit', 'shell_exec',
    'content_search', 'file_search', 'dir_list', 'file_delete',
  ];
  for (const t of native) {
    assert.strictEqual(opencodeAdapter.isNativeCovered(t), true, `expected ${t} to be native`);
  }
});

test('isNativeCovered(web_fetch) === false', () => {
  assert.strictEqual(opencodeAdapter.isNativeCovered('web_fetch'), false);
});

test('isNativeCovered(web_search) === false', () => {
  assert.strictEqual(opencodeAdapter.isNativeCovered('web_search'), false);
});

// ─── extractWorkspacePath ─────────────────────────────────────────────────────

console.log('\n[6] extractWorkspacePath');

test('extractWorkspacePath: Working directory format', () => {
  assert.strictEqual(
    opencodeAdapter.extractWorkspacePath('Working directory: /home/user'),
    '/home/user'
  );
});

// ─── behaviorFlags ───────────────────────────────────────────────────────────

console.log('\n[7] behaviorFlags');

test('behaviorFlags.retriesToolResult === false', () => {
  assert.strictEqual(opencodeAdapter.behaviorFlags.retriesToolResult, false);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
