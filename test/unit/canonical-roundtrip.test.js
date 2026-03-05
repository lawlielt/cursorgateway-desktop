/**
 * Canonical↔client roundtrip tests.
 * Verifies lossless translation for all adapters.
 */

const assert = require('assert');
const { getAdapter } = require('../../src/adapters/detector');
const { CANONICAL_TOOLS } = require('../../src/adapters/canonical');

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

// Test canonical inputs based on CANONICAL_TOOLS params
const CANONICAL_TEST_INPUTS = {
  file_read:       { path: '/a.txt' },
  file_write:      { path: '/b.txt', content: 'hello' },
  file_edit:       { path: '/c.txt', old_string: 'x', new_string: 'y' },
  shell_exec:      { command: 'ls', working_directory: '/tmp' },
  content_search:  { pattern: 'foo', path: '/src' },
  file_search:     { pattern: '*.js', path: '/src' },
  dir_list:        { path: '/home' },
  file_delete:     { path: '/d.txt' },
  web_fetch:       { url: 'https://example.com' },
  web_search:      { query: 'test query' },
  todo_write:      { todos: [{ id: '1', content: 'x', status: 'pending' }], merge: true },
  todo_read:       {},
};

// ─── Per-adapter roundtrip: toCanonical(fromCanonical(canon)) === canon ─────

console.log('\n[1] Per-adapter: toCanonical(fromCanonical(canon)) === canon');

for (const clientType of ['claude-code', 'opencode', 'openclaw']) {
  const adapter = getAdapter(clientType);
  const canonicals = adapter.supportedCanonicalTools();

  for (const canon of canonicals) {
    test(`${clientType} ${canon}: toCanonical(fromCanonical(canon)) === canon`, () => {
      const clientName = adapter.fromCanonical(canon);
      if (!clientName) return; // skip if no mapping
      const back = adapter.toCanonical(clientName);
      assert.strictEqual(back, canon);
    });
  }
}

// ─── Per-adapter: normalizeParams(denormalizeParams(canon, input)) === input ──

console.log('\n[2] Per-adapter: param roundtrip for tools with paramMap');

for (const clientType of ['claude-code', 'opencode', 'openclaw']) {
  const adapter = getAdapter(clientType);
  const paramMap = adapter.paramMap;

  for (const [canon, mapping] of Object.entries(paramMap)) {
    if (Object.keys(mapping).length === 0) continue;

    const canonInput = CANONICAL_TEST_INPUTS[canon];
    if (!canonInput) continue;

    // Build canonical input from CANONICAL_TOOLS params (only include mapped keys)
    const input = {};
    for (const key of Object.keys(mapping)) {
      if (key in (CANONICAL_TOOLS[canon]?.params || {})) {
        const val = canonInput[key];
        if (val !== undefined) input[key] = val;
      }
    }
    if (Object.keys(input).length === 0) {
      for (const [k, v] of Object.entries(canonInput)) {
        if (k in mapping) input[k] = v;
      }
    }
    if (Object.keys(input).length === 0) continue;

    test(`${clientType} ${canon}: param roundtrip`, () => {
      const clientParams = adapter.denormalizeParams(canon, input);
      const back = adapter.normalizeParams(canon, clientParams);
      assert.deepStrictEqual(back, input);
    });
  }
}

// ─── Cross-adapter consistency ───────────────────────────────────────────────

console.log('\n[3] Cross-adapter consistency');

test('same canonical input → denormalize → different client params → normalize back → same canonical', () => {
  const canonInput = { path: '/a.txt', content: 'hi' };
  const canon = 'file_write';

  const claudeClient = getAdapter('claude-code').denormalizeParams(canon, canonInput);
  const opencodeClient = getAdapter('opencode').denormalizeParams(canon, canonInput);
  const openclawClient = getAdapter('openclaw').denormalizeParams(canon, canonInput);

  // Client params differ
  assert.strictEqual(claudeClient.contents, 'hi');
  assert.strictEqual(opencodeClient.content, 'hi');
  assert.strictEqual(openclawClient.content, 'hi');

  // Normalize back to canonical
  const claudeBack = getAdapter('claude-code').normalizeParams(canon, claudeClient);
  const opencodeBack = getAdapter('opencode').normalizeParams(canon, opencodeClient);
  const openclawBack = getAdapter('openclaw').normalizeParams(canon, openclawClient);

  assert.deepStrictEqual(claudeBack, canonInput);
  assert.deepStrictEqual(opencodeBack, canonInput);
  assert.deepStrictEqual(openclawBack, canonInput);
});

test('file_edit cross-adapter roundtrip', () => {
  const canonInput = { path: '/x.txt', old_string: 'a', new_string: 'b' };
  const canon = 'file_edit';

  for (const clientType of ['claude-code', 'opencode', 'openclaw']) {
    const adapter = getAdapter(clientType);
    const clientParams = adapter.denormalizeParams(canon, canonInput);
    const back = adapter.normalizeParams(canon, clientParams);
    assert.deepStrictEqual(back, canonInput);
  }
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
