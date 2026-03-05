/**
 * Claude Code CLI adapter instance tests.
 */

const assert = require('assert');
const cliAdapter = require('../../src/adapters/claude-code-cli');

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
  assert.strictEqual(cliAdapter.toCanonical('read'), 'file_read');
});

test('toCanonical(write) === file_write', () => {
  assert.strictEqual(cliAdapter.toCanonical('write'), 'file_write');
});

test('toCanonical(edit) === file_edit', () => {
  assert.strictEqual(cliAdapter.toCanonical('edit'), 'file_edit');
});

test('toCanonical(bash) === shell_exec', () => {
  assert.strictEqual(cliAdapter.toCanonical('bash'), 'shell_exec');
});

test('toCanonical(grep) === content_search', () => {
  assert.strictEqual(cliAdapter.toCanonical('grep'), 'content_search');
});

test('toCanonical(glob) === file_search', () => {
  assert.strictEqual(cliAdapter.toCanonical('glob'), 'file_search');
});

test('toCanonical(ls) === dir_list', () => {
  assert.strictEqual(cliAdapter.toCanonical('ls'), 'dir_list');
});

test('toCanonical(delete) === file_delete', () => {
  assert.strictEqual(cliAdapter.toCanonical('delete'), 'file_delete');
});

test('toCanonical(webfetch) === web_fetch', () => {
  assert.strictEqual(cliAdapter.toCanonical('webfetch'), 'web_fetch');
});

test('toCanonical(websearch) === web_search', () => {
  assert.strictEqual(cliAdapter.toCanonical('websearch'), 'web_search');
});

test('toCanonical(todowrite) === todo_write', () => {
  assert.strictEqual(cliAdapter.toCanonical('todowrite'), 'todo_write');
});

test('toCanonical(todoread) === todo_read', () => {
  assert.strictEqual(cliAdapter.toCanonical('todoread'), 'todo_read');
});

// ─── fromCanonical ──────────────────────────────────────────────────────────

console.log('\n[2] fromCanonical');

test('fromCanonical(file_read) === read', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_read'), 'read');
});

test('fromCanonical(file_write) === write', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_write'), 'write');
});

test('fromCanonical(file_edit) === edit', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_edit'), 'edit');
});

test('fromCanonical(shell_exec) === bash', () => {
  assert.strictEqual(cliAdapter.fromCanonical('shell_exec'), 'bash');
});

test('fromCanonical(content_search) === grep', () => {
  assert.strictEqual(cliAdapter.fromCanonical('content_search'), 'grep');
});

test('fromCanonical(file_search) === glob', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_search'), 'glob');
});

test('fromCanonical(dir_list) === ls', () => {
  assert.strictEqual(cliAdapter.fromCanonical('dir_list'), 'ls');
});

test('fromCanonical(file_delete) === delete', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_delete'), 'delete');
});

test('fromCanonical(web_fetch) === webfetch', () => {
  assert.strictEqual(cliAdapter.fromCanonical('web_fetch'), 'webfetch');
});

test('fromCanonical(web_search) === websearch', () => {
  assert.strictEqual(cliAdapter.fromCanonical('web_search'), 'websearch');
});

test('fromCanonical(todo_write) === todowrite', () => {
  assert.strictEqual(cliAdapter.fromCanonical('todo_write'), 'todowrite');
});

test('fromCanonical(todo_read) === todoread', () => {
  assert.strictEqual(cliAdapter.fromCanonical('todo_read'), 'todoread');
});

// ─── denormalizeParams ───────────────────────────────────────────────────────

console.log('\n[3] denormalizeParams');

test('denormalizeParams(file_read): path stays path', () => {
  const out = cliAdapter.denormalizeParams('file_read', { path: '/a.txt' });
  assert.strictEqual(out.path, '/a.txt');
});

test('denormalizeParams(file_write): content stays content (not plural)', () => {
  const out = cliAdapter.denormalizeParams('file_write', { path: '/b.txt', content: 'data' });
  assert.strictEqual(out.path, '/b.txt');
  assert.strictEqual(out.content, 'data');
  assert.strictEqual(out.contents, undefined);
});

test('denormalizeParams(file_edit): path stays path', () => {
  const out = cliAdapter.denormalizeParams('file_edit', { path: '/c.txt', old_string: 'x', new_string: 'y' });
  assert.strictEqual(out.path, '/c.txt');
  assert.strictEqual(out.old_string, 'x');
  assert.strictEqual(out.new_string, 'y');
});

test('denormalizeParams(shell_exec): working_directory stays same', () => {
  const out = cliAdapter.denormalizeParams('shell_exec', { command: 'ls', working_directory: '/tmp' });
  assert.strictEqual(out.command, 'ls');
  assert.strictEqual(out.working_directory, '/tmp');
});

test('denormalizeParams(file_search): pattern stays pattern, path stays path', () => {
  const out = cliAdapter.denormalizeParams('file_search', { pattern: '*.js', path: '/src' });
  assert.strictEqual(out.pattern, '*.js');
  assert.strictEqual(out.path, '/src');
});

// ─── normalizeParams ──────────────────────────────────────────────────────────

console.log('\n[4] normalizeParams');

test('normalizeParams(file_read): path stays path', () => {
  const out = cliAdapter.normalizeParams('file_read', { path: '/a.txt' });
  assert.strictEqual(out.path, '/a.txt');
});

test('normalizeParams(file_write): content stays content', () => {
  const out = cliAdapter.normalizeParams('file_write', { path: '/b.txt', content: 'data' });
  assert.strictEqual(out.path, '/b.txt');
  assert.strictEqual(out.content, 'data');
});

// ─── isNativeCovered ────────────────────────────────────────────────────────

console.log('\n[5] isNativeCovered');

test('isNativeCovered: all 8 native tools covered', () => {
  const native = [
    'file_read', 'file_write', 'file_edit', 'shell_exec',
    'content_search', 'file_search', 'dir_list', 'file_delete',
  ];
  for (const t of native) {
    assert.strictEqual(cliAdapter.isNativeCovered(t), true, `expected ${t} to be native`);
  }
});

test('isNativeCovered(web_fetch) === false', () => {
  assert.strictEqual(cliAdapter.isNativeCovered('web_fetch'), false);
});

test('isNativeCovered(todo_write) === false', () => {
  assert.strictEqual(cliAdapter.isNativeCovered('todo_write'), false);
});

// ─── extractWorkspacePath ──────────────────────────────────────────────────

console.log('\n[6] extractWorkspacePath');

test('extractWorkspacePath: Workspace Path format', () => {
  assert.strictEqual(
    cliAdapter.extractWorkspacePath('Workspace Path: /home/user/project'),
    '/home/user/project'
  );
});

test('extractWorkspacePath: Working directory format', () => {
  assert.strictEqual(
    cliAdapter.extractWorkspacePath('Working directory: /tmp/test'),
    '/tmp/test'
  );
});

test('extractWorkspacePath: CWD format', () => {
  assert.strictEqual(
    cliAdapter.extractWorkspacePath('CWD: /home/user'),
    '/home/user'
  );
});

// ─── clientType & behaviorFlags ───────────────────────────────────────────

console.log('\n[7] clientType & behaviorFlags');

test('clientType === claude-code-cli', () => {
  assert.strictEqual(cliAdapter.clientType, 'claude-code-cli');
});

test('behaviorFlags.retriesToolResult === true', () => {
  assert.strictEqual(cliAdapter.behaviorFlags.retriesToolResult, true);
});

test('behaviorFlags.hasTextFallback === true', () => {
  assert.strictEqual(cliAdapter.behaviorFlags.hasTextFallback, true);
});

test('behaviorFlags.hasThinkingBlocks === true', () => {
  assert.strictEqual(cliAdapter.behaviorFlags.hasThinkingBlocks, true);
});

// ─── Distinguish from claude-code adapter ─────────────────────────────────

console.log('\n[8] Distinct from claude-code adapter');

const claudeAdapter = require('../../src/adapters/claude-code');

test('claude-code uses PascalCase: fromCanonical(file_read)=Read', () => {
  assert.strictEqual(claudeAdapter.fromCanonical('file_read'), 'Read');
});

test('claude-code-cli uses lowercase: fromCanonical(file_read)=read', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_read'), 'read');
});

test('claude-code uses "contents" (plural) for write', () => {
  const out = claudeAdapter.denormalizeParams('file_write', { path: '/a', content: 'x' });
  assert.strictEqual(out.contents, 'x');
});

test('claude-code-cli uses "content" (singular) for write', () => {
  const out = cliAdapter.denormalizeParams('file_write', { path: '/a', content: 'x' });
  assert.strictEqual(out.content, 'x');
  assert.strictEqual(out.contents, undefined);
});

test('claude-code uses "StrReplace" for edit', () => {
  assert.strictEqual(claudeAdapter.fromCanonical('file_edit'), 'StrReplace');
});

test('claude-code-cli uses "edit" for edit', () => {
  assert.strictEqual(cliAdapter.fromCanonical('file_edit'), 'edit');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
