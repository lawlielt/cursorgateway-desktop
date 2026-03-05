/**
 * Claude Code adapter instance tests.
 */

const assert = require('assert');
const claudeCodeAdapter = require('../../src/adapters/claude-code');

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

test('toCanonical(Read) === file_read', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Read'), 'file_read');
});

test('toCanonical(Write) === file_write', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Write'), 'file_write');
});

test('toCanonical(StrReplace) === file_edit', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('StrReplace'), 'file_edit');
});

test('toCanonical(Bash) === shell_exec', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Bash'), 'shell_exec');
});

test('toCanonical(Grep) === content_search', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Grep'), 'content_search');
});

test('toCanonical(Glob) === file_search', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Glob'), 'file_search');
});

test('toCanonical(LS) === dir_list', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('LS'), 'dir_list');
});

test('toCanonical(Delete) === file_delete', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('Delete'), 'file_delete');
});

test('toCanonical(WebFetch) === web_fetch', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('WebFetch'), 'web_fetch');
});

test('toCanonical(WebSearch) === web_search', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('WebSearch'), 'web_search');
});

test('toCanonical(TodoWrite) === todo_write', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('TodoWrite'), 'todo_write');
});

test('toCanonical(TodoRead) === todo_read', () => {
  assert.strictEqual(claudeCodeAdapter.toCanonical('TodoRead'), 'todo_read');
});

// ─── fromCanonical ──────────────────────────────────────────────────────────

console.log('\n[2] fromCanonical');

test('fromCanonical(file_read) === Read', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('file_read'), 'Read');
});

test('fromCanonical(file_write) === Write', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('file_write'), 'Write');
});

test('fromCanonical(file_edit) === StrReplace', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('file_edit'), 'StrReplace');
});

test('fromCanonical(shell_exec) === Bash', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('shell_exec'), 'Bash');
});

test('fromCanonical(content_search) === Grep', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('content_search'), 'Grep');
});

test('fromCanonical(file_search) === Glob', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('file_search'), 'Glob');
});

test('fromCanonical(dir_list) === LS', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('dir_list'), 'LS');
});

test('fromCanonical(file_delete) === Delete', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('file_delete'), 'Delete');
});

test('fromCanonical(web_fetch) === WebFetch', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('web_fetch'), 'WebFetch');
});

test('fromCanonical(web_search) === WebSearch', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('web_search'), 'WebSearch');
});

test('fromCanonical(todo_write) === TodoWrite', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('todo_write'), 'TodoWrite');
});

test('fromCanonical(todo_read) === TodoRead', () => {
  assert.strictEqual(claudeCodeAdapter.fromCanonical('todo_read'), 'TodoRead');
});

// ─── denormalizeParams ───────────────────────────────────────────────────────

console.log('\n[3] denormalizeParams');

test('denormalizeParams(file_write): content→contents (plural)', () => {
  const out = claudeCodeAdapter.denormalizeParams('file_write', { path: '/a.txt', content: 'hi' });
  assert.strictEqual(out.path, '/a.txt');
  assert.strictEqual(out.contents, 'hi');
});

test('denormalizeParams(file_search): pattern→glob_pattern, path→target_directory', () => {
  const out = claudeCodeAdapter.denormalizeParams('file_search', { pattern: '*.js', path: '/src' });
  assert.strictEqual(out.glob_pattern, '*.js');
  assert.strictEqual(out.target_directory, '/src');
});

test('denormalizeParams(web_search): query→search_term', () => {
  const out = claudeCodeAdapter.denormalizeParams('web_search', { query: 'test' });
  assert.strictEqual(out.search_term, 'test');
});

// ─── normalizeParams ──────────────────────────────────────────────────────────

console.log('\n[4] normalizeParams');

test('normalizeParams(file_write): contents→content (reverse)', () => {
  const out = claudeCodeAdapter.normalizeParams('file_write', { path: '/a.txt', contents: 'hi' });
  assert.strictEqual(out.path, '/a.txt');
  assert.strictEqual(out.content, 'hi');
});

test('normalizeParams(file_search): glob_pattern→pattern, target_directory→path', () => {
  const out = claudeCodeAdapter.normalizeParams('file_search', {
    glob_pattern: '*.js',
    target_directory: '/src',
  });
  assert.strictEqual(out.pattern, '*.js');
  assert.strictEqual(out.path, '/src');
});

// ─── isNativeCovered ─────────────────────────────────────────────────────────

console.log('\n[5] isNativeCovered');

test('isNativeCovered: all 8 native tools covered', () => {
  const native = [
    'file_read', 'file_write', 'file_edit', 'shell_exec',
    'content_search', 'file_search', 'dir_list', 'file_delete',
  ];
  for (const t of native) {
    assert.strictEqual(claudeCodeAdapter.isNativeCovered(t), true, `expected ${t} to be native`);
  }
});

test('isNativeCovered(web_fetch) === false', () => {
  assert.strictEqual(claudeCodeAdapter.isNativeCovered('web_fetch'), false);
});

test('isNativeCovered(todo_write) === false', () => {
  assert.strictEqual(claudeCodeAdapter.isNativeCovered('todo_write'), false);
});

// ─── extractWorkspacePath ─────────────────────────────────────────────────────

console.log('\n[6] extractWorkspacePath');

test('extractWorkspacePath: Workspace Path format', () => {
  assert.strictEqual(
    claudeCodeAdapter.extractWorkspacePath('Workspace Path: /home/user/project'),
    '/home/user/project'
  );
});

test('extractWorkspacePath: Working directory format', () => {
  assert.strictEqual(
    claudeCodeAdapter.extractWorkspacePath('Working directory: /tmp/test'),
    '/tmp/test'
  );
});

// ─── clientType & behaviorFlags ───────────────────────────────────────────────

console.log('\n[7] clientType & behaviorFlags');

test('clientType === claude-code', () => {
  assert.strictEqual(claudeCodeAdapter.clientType, 'claude-code');
});

test('behaviorFlags.retriesToolResult === true', () => {
  assert.strictEqual(claudeCodeAdapter.behaviorFlags.retriesToolResult, true);
});

test('behaviorFlags.hasTextFallback === true', () => {
  assert.strictEqual(claudeCodeAdapter.behaviorFlags.hasTextFallback, true);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
