/**
 * ClientAdapter base class tests.
 * Uses a synthetic test adapter to verify core behavior.
 */
'use strict';

const assert = require('assert');
const { ClientAdapter } = require('../../src/adapters/base');

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

const syntheticAdapter = new ClientAdapter({
  clientType: 'test',
  toolNameMap: {
    file_read:  'Read',
    file_write: 'Write',
    file_edit:  'StrReplace',
    dir_list:   'LS',
    file_search: 'Glob',
  },
  paramMap: {
    file_read:  { path: 'path' },
    file_write: { path: 'path', content: 'contents' },
    file_edit:  { path: 'path', old_string: 'old_string', new_string: 'new_string' },
  },
  nativeCoveredTools: new Set(['file_read', 'file_write']),
  workspacePathPatterns: [
    /Workspace Path:\s*([^\n]+)/i,
    /Working directory:\s*([^\n]+)/i,
  ],
  behaviorFlags: { retriesToolResult: true },
});

// ─── toCanonical ────────────────────────────────────────────────────────────

console.log('\n[1] toCanonical');

test('toCanonical: exact match', () => {
  assert.strictEqual(syntheticAdapter.toCanonical('Read'), 'file_read');
});

test('toCanonical: case insensitive', () => {
  assert.strictEqual(syntheticAdapter.toCanonical('READ'), 'file_read');
  assert.strictEqual(syntheticAdapter.toCanonical('read'), 'file_read');
});

test('toCanonical: unknown returns null', () => {
  assert.strictEqual(syntheticAdapter.toCanonical('UnknownTool'), null);
});

test('toCanonical: null returns null', () => {
  assert.strictEqual(syntheticAdapter.toCanonical(null), null);
});

test('toCanonical: undefined returns null', () => {
  assert.strictEqual(syntheticAdapter.toCanonical(undefined), null);
});

// ─── fromCanonical ──────────────────────────────────────────────────────────

console.log('\n[2] fromCanonical');

test('fromCanonical: file_read → Read', () => {
  assert.strictEqual(syntheticAdapter.fromCanonical('file_read'), 'Read');
});

test('fromCanonical: file_write → Write', () => {
  assert.strictEqual(syntheticAdapter.fromCanonical('file_write'), 'Write');
});

test('fromCanonical: file_edit → StrReplace', () => {
  assert.strictEqual(syntheticAdapter.fromCanonical('file_edit'), 'StrReplace');
});

test('fromCanonical: unknown returns null', () => {
  assert.strictEqual(syntheticAdapter.fromCanonical('unknown_tool'), null);
});

test('fromCanonical: null returns null', () => {
  assert.strictEqual(syntheticAdapter.fromCanonical(null), null);
});

// ─── normalizeParams ─────────────────────────────────────────────────────────

console.log('\n[3] normalizeParams');

test('normalizeParams: client→canonical for file_read', () => {
  const out = syntheticAdapter.normalizeParams('file_read', { path: '/a.txt' });
  assert.strictEqual(out.path, '/a.txt');
});

test('normalizeParams: client→canonical for file_write (contents→content)', () => {
  const out = syntheticAdapter.normalizeParams('file_write', { path: '/b.txt', contents: 'hi' });
  assert.strictEqual(out.path, '/b.txt');
  assert.strictEqual(out.content, 'hi');
});

test('normalizeParams: unknown canonical passes through', () => {
  const in_ = { foo: 'bar' };
  const out = syntheticAdapter.normalizeParams('unknown_tool', in_);
  assert.deepStrictEqual(out, { foo: 'bar' });
});

test('normalizeParams: null input → {}', () => {
  const out = syntheticAdapter.normalizeParams('file_read', null);
  assert.deepStrictEqual(out, {});
});

// ─── denormalizeParams ───────────────────────────────────────────────────────

console.log('\n[4] denormalizeParams');

test('denormalizeParams: canonical→client for file_write', () => {
  const out = syntheticAdapter.denormalizeParams('file_write', { path: '/a.txt', content: 'hi' });
  assert.strictEqual(out.path, '/a.txt');
  assert.strictEqual(out.contents, 'hi');
});

test('denormalizeParams: unmapped keys pass through', () => {
  const out = syntheticAdapter.denormalizeParams('file_read', { path: '/a.txt', extra: 42 });
  assert.strictEqual(out.path, '/a.txt');
  assert.strictEqual(out.extra, 42);
});

test('denormalizeParams: null input → {}', () => {
  const out = syntheticAdapter.denormalizeParams('file_read', null);
  assert.deepStrictEqual(out, {});
});

// ─── isNativeCovered ─────────────────────────────────────────────────────────

console.log('\n[5] isNativeCovered');

test('isNativeCovered: covered returns true', () => {
  assert.strictEqual(syntheticAdapter.isNativeCovered('file_read'), true);
  assert.strictEqual(syntheticAdapter.isNativeCovered('file_write'), true);
});

test('isNativeCovered: uncovered returns false', () => {
  assert.strictEqual(syntheticAdapter.isNativeCovered('file_edit'), false);
  assert.strictEqual(syntheticAdapter.isNativeCovered('unknown'), false);
});

// ─── extractWorkspacePath ────────────────────────────────────────────────────

console.log('\n[6] extractWorkspacePath');

test('extractWorkspacePath: string match Workspace Path', () => {
  assert.strictEqual(
    syntheticAdapter.extractWorkspacePath('Workspace Path: /home/user/project'),
    '/home/user/project'
  );
});

test('extractWorkspacePath: string match Working directory', () => {
  assert.strictEqual(
    syntheticAdapter.extractWorkspacePath('Working directory: /tmp/test'),
    '/tmp/test'
  );
});

test('extractWorkspacePath: no match → empty string', () => {
  assert.strictEqual(syntheticAdapter.extractWorkspacePath('No path here'), '');
});

test('extractWorkspacePath: null → empty string', () => {
  assert.strictEqual(syntheticAdapter.extractWorkspacePath(null), '');
});

test('extractWorkspacePath: array content blocks (text only)', () => {
  const blocks = [
    { type: 'text', text: 'Workspace Path: /foo/bar' },
    { type: 'image', url: 'x' },
  ];
  assert.strictEqual(syntheticAdapter.extractWorkspacePath(blocks), '/foo/bar');
});

// ─── toCanonicalWithInput ────────────────────────────────────────────────────

console.log('\n[7] toCanonicalWithInput');

test('toCanonicalWithInput: file_write + old_string → file_edit', () => {
  const canon = syntheticAdapter.toCanonicalWithInput('Write', { old_string: 'x', new_string: 'y' });
  assert.strictEqual(canon, 'file_edit');
});

test('toCanonicalWithInput: file_write without old_string → file_write', () => {
  const canon = syntheticAdapter.toCanonicalWithInput('Write', { path: '/a.txt', content: 'hi' });
  assert.strictEqual(canon, 'file_write');
});

test('toCanonicalWithInput: dir_list with pattern → file_search', () => {
  const canon = syntheticAdapter.toCanonicalWithInput('LS', { pattern: '*.js' });
  assert.strictEqual(canon, 'file_search');
});

test('toCanonicalWithInput: dir_list with pattern * → dir_list', () => {
  const canon = syntheticAdapter.toCanonicalWithInput('LS', { pattern: '*' });
  assert.strictEqual(canon, 'dir_list');
});

// ─── supportedCanonicalTools / supportedClientTools ─────────────────────────

console.log('\n[8] supportedCanonicalTools / supportedClientTools');

test('supportedCanonicalTools: correct count', () => {
  const tools = syntheticAdapter.supportedCanonicalTools();
  assert.strictEqual(tools.length, 5);
});

test('supportedCanonicalTools: contains file_read', () => {
  const tools = syntheticAdapter.supportedCanonicalTools();
  assert.ok(tools.includes('file_read'));
});

test('supportedClientTools: correct count', () => {
  const tools = syntheticAdapter.supportedClientTools();
  assert.strictEqual(tools.length, 5);
});

test('supportedClientTools: contains Read', () => {
  const tools = syntheticAdapter.supportedClientTools();
  assert.ok(tools.includes('Read'));
});

// ─── behaviorFlags: frozen ──────────────────────────────────────────────────

console.log('\n[9] behaviorFlags frozen');

test('behaviorFlags: frozen (throws on mutation)', () => {
  assert.throws(
    () => { syntheticAdapter.behaviorFlags.retriesToolResult = false; },
    TypeError
  );
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
