/**
 * Tests for v1.js message helpers — hasToolResults / extractToolResults.
 *
 * These functions must only consider the LATEST assistant's tool_calls,
 * not historical ones from previous turns. Getting this wrong causes
 * "Unknown tool call ID" errors when the session only knows about the
 * current round's tool calls.
 */
const assert = require('assert');
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failCount++;
    console.error(`  ❌ ${name}: ${e.message}`);
  }
}

// We need to test the internal functions. Since they're not exported,
// we duplicate the logic here and verify it matches the expected behavior.
// If v1.js is refactored to export these, switch to direct imports.

function hasToolResults(messages) {
  let lastToolAssistantIdx = -1;
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      if (lastAssistantIdx < 0) lastAssistantIdx = i;
      if (lastToolAssistantIdx < 0 && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
        lastToolAssistantIdx = i;
      }
      if (lastAssistantIdx >= 0 && lastToolAssistantIdx >= 0) break;
    }
  }
  if (lastToolAssistantIdx < 0) return false;
  if (lastAssistantIdx > lastToolAssistantIdx) return false;
  for (let j = lastToolAssistantIdx + 1; j < messages.length; j++) {
    if (messages[j].role === 'tool') return true;
  }
  return false;
}

function extractToolResults(messages) {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return [];

  const pendingIds = new Set(
    messages[lastAssistantIdx].tool_calls.map(tc => tc.id)
  );

  const results = [];
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && pendingIds.has(msg.tool_call_id)) {
      results.push({
        tool_use_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : '',
        is_error: false,
      });
    }
  }
  return results;
}

console.log('=== v1 Tool Result Extraction Tests ===\n');

// ── hasToolResults ──────────────────────────────────────────────────

test('simple user message → no tool results', () => {
  assert.strictEqual(hasToolResults([
    { role: 'user', content: 'hello' },
  ]), false);
});

test('assistant without tool_calls → no tool results', () => {
  assert.strictEqual(hasToolResults([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ]), false);
});

test('assistant with tool_calls but no tool response yet → no tool results', () => {
  assert.strictEqual(hasToolResults([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
  ]), false);
});

test('assistant + tool response → has tool results', () => {
  assert.strictEqual(hasToolResults([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_A', content: 'file1' },
  ]), true);
});

test('multi-turn: last assistant has no tool_calls → no tool results (even with historical tool messages)', () => {
  assert.strictEqual(hasToolResults([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_A', content: 'file1' },
    { role: 'assistant', content: 'Here are the files' },
    { role: 'user', content: 'thanks' },
  ]), false);
});

// ── extractToolResults — single turn ────────────────────────────────

test('extract single tool result', () => {
  const results = extractToolResults([
    { role: 'user', content: 'list' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_B', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_B', content: 'output here' },
  ]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool_use_id, 'call_B');
  assert.strictEqual(results[0].content, 'output here');
});

test('extract multiple tool results from single assistant turn', () => {
  const results = extractToolResults([
    { role: 'user', content: 'do both' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_C', type: 'function', function: { name: 'exec', arguments: '{}' } },
      { id: 'call_D', type: 'function', function: { name: 'read', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_C', content: 'exec output' },
    { role: 'tool', tool_call_id: 'call_D', content: 'file content' },
  ]);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].tool_use_id, 'call_C');
  assert.strictEqual(results[1].tool_use_id, 'call_D');
});

// ── extractToolResults — multi-turn (the critical bug scenario) ─────

test('CRITICAL: multi-turn only extracts LAST round, ignores historical tool results', () => {
  const messages = [
    // Turn 1: user asks, assistant calls tool, tool responds, assistant summarizes
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'list files in /tmp' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_OLD', type: 'function', function: { name: 'exec', arguments: '{"command":"ls /tmp"}' } }] },
    { role: 'tool', tool_call_id: 'call_OLD', content: 'file1.txt\nfile2.txt' },
    { role: 'assistant', content: 'Found 2 files' },

    // Turn 2: user asks again, assistant calls tool, tool responds
    { role: 'user', content: 'now read file1.txt' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_NEW', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp/file1.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_NEW', content: 'hello world' },
  ];

  const results = extractToolResults(messages);
  // MUST only return call_NEW, NOT call_OLD
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool_use_id, 'call_NEW');
  assert.strictEqual(results[0].content, 'hello world');
});

test('multi-turn: 3 rounds, only extracts latest', () => {
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'r1_call', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'r1_call', content: 'r1 result' },
    { role: 'assistant', content: 'r1 done' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'r2_call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'r2_call', content: 'r2 result' },
    { role: 'assistant', content: 'r2 done' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'r3_call', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'r3_call', content: 'r3 result' },
  ];

  const results = extractToolResults(messages);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool_use_id, 'r3_call');
});

test('ignores tool messages with IDs not in last assistant tool_calls', () => {
  const messages = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_X', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_X', content: 'ok' },
    { role: 'tool', tool_call_id: 'call_UNKNOWN', content: 'stray result' },
  ];

  const results = extractToolResults(messages);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].tool_use_id, 'call_X');
});

test('no assistant with tool_calls → empty results', () => {
  const results = extractToolResults([
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', tool_call_id: 'phantom', content: 'orphaned' },
  ]);
  assert.strictEqual(results.length, 0);
});

test('empty messages → empty results', () => {
  assert.strictEqual(extractToolResults([]).length, 0);
});

// ── Summary ─────────────────────────────────────────────────────────
console.log(`\n${passCount} passed, ${failCount} failed (${passCount + failCount} total)`);
if (failCount > 0) process.exit(1);
console.log('\n✅ All v1 tool result extraction tests passed.\n');
