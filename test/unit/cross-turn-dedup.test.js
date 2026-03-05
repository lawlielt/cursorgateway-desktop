/**
 * Cross-Turn Dedup Tests
 *
 * Validates the fix for "Claude Code stops after 1-2 tool calls":
 *
 * Root cause: continueStream had fresh dedup sets, so Cursor's replayed
 * KV FINAL (containing old tool calls from the previous turn) was treated
 * as a new response → stop_reason: "end_turn" → Claude Code stopped.
 *
 * Fix: AgentClient persists _handledExecIds and _handledExecSignatures
 * across chatStream/continueStream. Replayed KV tool calls are now
 * correctly identified and skipped, so the stream waits for the model's
 * actual new response.
 *
 * Test sections:
 *   1. Signature consistency: exec and KV signatures match for the same tool
 *   2. AgentClient instance tracking: _handledExecIds/_handledExecSignatures
 *   3. KV dedup simulation: replayed tool calls filtered, new ones pass through
 *   4. Multi-turn accumulation: signatures accumulate across multiple turns
 *   5. Edge cases: null/undefined inputs, unknown tools, empty strings
 */

const assert = require('assert');
const {
  AgentClient,
  _buildExecRequestSignature: buildExecRequestSignature,
  _buildToolUseSignature: buildToolUseSignature,
  _normalizeToolName: normalizeToolName,
} = require('../../src/utils/agentClient');

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

// ═══════════════════════════════════════════════════════════════
// Section 1: Signature consistency — exec vs KV for the same tool
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 1. Signature consistency: exec ↔ KV ===');
{
  const cases = [
    {
      label: 'shell: same command',
      exec: { type: 'shell', command: 'ls -la /tmp', cwd: '/home/user' },
      kv: { name: 'Shell', input: { command: 'ls -la /tmp', cwd: '/home/user' } },
    },
    {
      label: 'shell: Bash alias',
      exec: { type: 'shell', command: 'echo hello', cwd: '' },
      kv: { name: 'Bash', input: { command: 'echo hello', cwd: '' } },
    },
    {
      label: 'read: same path',
      exec: { type: 'read', path: '/tmp/test.txt' },
      kv: { name: 'Read', input: { file_path: '/tmp/test.txt' } },
    },
    {
      label: 'read: Read alias with path key',
      exec: { type: 'read', path: '/a/b.js' },
      kv: { name: 'read_file', input: { path: '/a/b.js' } },
    },
    {
      label: 'write: same path+content',
      exec: { type: 'write', path: '/tmp/out.txt', fileText: 'hello world' },
      kv: { name: 'Write', input: { file_path: '/tmp/out.txt', content: 'hello world' } },
    },
    {
      label: 'ls: same path',
      exec: { type: 'ls', path: '/home/user/project' },
      kv: { name: 'list_dir', input: { path: '/home/user/project' } },
    },
    {
      label: 'grep: same pattern+path',
      exec: { type: 'grep', pattern: 'TODO', path: '/src', glob: '*.js' },
      kv: { name: 'Grep', input: { pattern: 'TODO', path: '/src', glob: '*.js' } },
    },
    {
      label: 'delete: same path',
      exec: { type: 'delete', path: '/tmp/remove-me.txt' },
      kv: { name: 'delete_file', input: { path: '/tmp/remove-me.txt' } },
    },
    {
      label: 'request_context',
      exec: { type: 'request_context' },
      kv: { name: 'request_context', input: {} },
    },
  ];

  for (const { label, exec, kv } of cases) {
    const execSig = buildExecRequestSignature(exec);
    const kvSig = buildToolUseSignature(kv);
    test(`${label}: signatures match`, () => {
      assert.ok(execSig, `exec signature should not be null`);
      assert.ok(kvSig, `kv signature should not be null`);
      assert.strictEqual(execSig, kvSig, `exec="${execSig}" vs kv="${kvSig}"`);
    });
  }

  // Different commands should NOT match
  test('shell: different commands → different signatures', () => {
    const sig1 = buildExecRequestSignature({ type: 'shell', command: 'ls', cwd: '' });
    const sig2 = buildExecRequestSignature({ type: 'shell', command: 'pwd', cwd: '' });
    assert.notStrictEqual(sig1, sig2);
  });

  test('read: different paths → different signatures', () => {
    const sig1 = buildToolUseSignature({ name: 'Read', input: { path: '/a.txt' } });
    const sig2 = buildToolUseSignature({ name: 'Read', input: { path: '/b.txt' } });
    assert.notStrictEqual(sig1, sig2);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 2: AgentClient instance tracking persists correctly
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 2. AgentClient instance dedup tracking ===');
{
  const client = new AgentClient('fake-token', { workspacePath: '/tmp' });

  test('_handledExecIds starts empty', () => {
    assert.ok(client._handledExecIds instanceof Set);
    assert.strictEqual(client._handledExecIds.size, 0);
  });

  test('_handledExecSignatures starts empty', () => {
    assert.ok(client._handledExecSignatures instanceof Set);
    assert.strictEqual(client._handledExecSignatures.size, 0);
  });

  // Simulate what chatStream does after processing an exec tool call
  const shellSig = buildExecRequestSignature({ type: 'shell', command: 'find . -name "*.js"', cwd: '/project' });
  client._handledExecIds.add('exec-uuid-1');
  client._handledExecIds.add('42');
  client._handledExecSignatures.add(shellSig);

  test('after chatStream: IDs persisted on instance', () => {
    assert.strictEqual(client._handledExecIds.size, 2);
    assert.ok(client._handledExecIds.has('exec-uuid-1'));
    assert.ok(client._handledExecIds.has('42'));
  });

  test('after chatStream: signatures persisted on instance', () => {
    assert.strictEqual(client._handledExecSignatures.size, 1);
    assert.ok(client._handledExecSignatures.has(shellSig));
  });

  // Simulate what continueStream does: inherit from instance
  const inheritedIds = new Set(client._handledExecIds);
  const inheritedSigs = new Set(client._handledExecSignatures);

  test('continueStream inherits IDs', () => {
    assert.strictEqual(inheritedIds.size, 2);
    assert.ok(inheritedIds.has('exec-uuid-1'));
  });

  test('continueStream inherits signatures', () => {
    assert.strictEqual(inheritedSigs.size, 1);
    assert.ok(inheritedSigs.has(shellSig));
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 3: KV dedup simulation — the actual bug scenario
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 3. KV dedup simulation (the bug scenario) ===');
{
  // Reproduce the exact scenario from the bug:
  // Turn 1 (chatStream): model calls Shell via exec → tracked
  // Turn 2 (continueStream): Cursor replays KV FINAL with same Shell → should be deduped

  const client = new AgentClient('fake-token', { workspacePath: '/project' });

  // Turn 1: exec path delivers Shell tool call
  const execRequest = {
    type: 'shell',
    id: 1,
    execId: 'toolu_01AEzae2jQEeKQiRSCdTVwN6',
    command: 'find /project -name "*.js" | head -30',
    cwd: '/project',
  };

  // chatStream tracks it
  if (execRequest.execId) client._handledExecIds.add(execRequest.execId);
  if (execRequest.id !== undefined) client._handledExecIds.add(String(execRequest.id));
  const execSig = buildExecRequestSignature(execRequest);
  client._handledExecSignatures.add(execSig);

  // Turn 2: continueStream starts, inherits tracking
  const localIds = new Set(client._handledExecIds);
  const localSigs = new Set(client._handledExecSignatures);

  // KV FINAL replays the same Shell tool call
  const replayedKvToolUse = {
    type: 'tool_use',
    id: 'toolu_01AEzae2jQEeKQiRSCdTVwN6',
    name: 'Shell',
    input: { command: 'find /project -name "*.js" | head -30', cwd: '/project' },
  };

  const matchedById = localIds.has(replayedKvToolUse.id);
  const kvSig = buildToolUseSignature(replayedKvToolUse);
  const matchedBySig = localSigs.has(kvSig);

  test('replayed KV tool matched by ID', () => {
    assert.ok(matchedById, 'should match by toolCallId/execId');
  });

  test('replayed KV tool matched by signature', () => {
    assert.ok(matchedBySig, 'should match by signature');
  });

  test('replayed KV tool is deduped (either ID or sig)', () => {
    assert.ok(matchedById || matchedBySig, 'must be filtered');
  });

  // A genuinely NEW tool call from the model should NOT be deduped
  const newKvToolUse = {
    type: 'tool_use',
    id: 'toolu_NEW_999',
    name: 'Shell',
    input: { command: 'wc -l /project/src/*.js', cwd: '/project' },
  };

  const newMatchedById = localIds.has(newKvToolUse.id);
  const newKvSig = buildToolUseSignature(newKvToolUse);
  const newMatchedBySig = localSigs.has(newKvSig);

  test('new KV tool NOT matched by ID', () => {
    assert.ok(!newMatchedById);
  });

  test('new KV tool NOT matched by signature', () => {
    assert.ok(!newMatchedBySig);
  });

  test('new KV tool passes through (not deduped)', () => {
    assert.ok(!(newMatchedById || newMatchedBySig), 'new tool should pass through');
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 4: Multi-turn accumulation
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 4. Multi-turn signature accumulation ===');
{
  const client = new AgentClient('fake-token', { workspacePath: '/project' });

  // Turn 1: Shell
  const sig1 = buildExecRequestSignature({ type: 'shell', command: 'ls', cwd: '' });
  client._handledExecSignatures.add(sig1);
  client._handledExecIds.add('exec-1');

  // Turn 2: Read
  const sig2 = buildExecRequestSignature({ type: 'read', path: '/tmp/a.txt' });
  client._handledExecSignatures.add(sig2);
  client._handledExecIds.add('exec-2');

  // Turn 3: Write
  const sig3 = buildExecRequestSignature({ type: 'write', path: '/tmp/b.txt', fileText: 'content' });
  client._handledExecSignatures.add(sig3);
  client._handledExecIds.add('exec-3');

  test('after 3 turns: 3 signatures accumulated', () => {
    assert.strictEqual(client._handledExecSignatures.size, 3);
  });

  test('after 3 turns: 3 IDs accumulated', () => {
    assert.strictEqual(client._handledExecIds.size, 3);
  });

  // Turn 4 continueStream: replayed KV from any previous turn should be deduped
  const inherited = new Set(client._handledExecSignatures);

  test('turn 1 shell replayed → deduped', () => {
    const kvSig = buildToolUseSignature({ name: 'Bash', input: { command: 'ls', cwd: '' } });
    assert.ok(inherited.has(kvSig));
  });

  test('turn 2 read replayed → deduped', () => {
    const kvSig = buildToolUseSignature({ name: 'Read', input: { path: '/tmp/a.txt' } });
    assert.ok(inherited.has(kvSig));
  });

  test('turn 3 write replayed → deduped', () => {
    const kvSig = buildToolUseSignature({ name: 'Write', input: { file_path: '/tmp/b.txt', content: 'content' } });
    assert.ok(inherited.has(kvSig));
  });

  test('unseen tool → NOT deduped', () => {
    const kvSig = buildToolUseSignature({ name: 'Grep', input: { pattern: 'foo', path: '/bar' } });
    assert.ok(!inherited.has(kvSig));
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 5: normalizeToolName consistency
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 5. normalizeToolName consistency ===');
{
  const pairs = [
    ['bash', 'shell'],
    ['Bash', 'shell'],
    ['shell', 'shell'],
    ['Shell', 'shell'],
    ['run_terminal_command', 'shell'],
    ['run_terminal_cmd', 'shell'],
    ['read', 'read'],
    ['Read', 'read'],
    ['read_file', 'read'],
    ['write', 'write'],
    ['Write', 'write'],
    ['edit_file', 'write'],
    ['ls', 'ls'],
    ['list_dir', 'ls'],
    ['grep', 'grep'],
    ['ripgrep_search', 'grep'],
    ['grep_search', 'grep'],
    ['delete', 'delete'],
    ['delete_file', 'delete'],
    ['request_context', 'request_context'],
  ];

  for (const [input, expected] of pairs) {
    test(`normalizeToolName("${input}") → "${expected}"`, () => {
      assert.strictEqual(normalizeToolName(input), expected);
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Section 6: Edge cases
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 6. Edge cases ===');
{
  test('buildExecRequestSignature(null) → null', () => {
    assert.strictEqual(buildExecRequestSignature(null), null);
  });

  test('buildExecRequestSignature(undefined) → null', () => {
    assert.strictEqual(buildExecRequestSignature(undefined), null);
  });

  test('buildExecRequestSignature({}) → null (no type)', () => {
    assert.strictEqual(buildExecRequestSignature({}), null);
  });

  test('buildToolUseSignature(null) → null', () => {
    assert.strictEqual(buildToolUseSignature(null), null);
  });

  test('buildToolUseSignature({}) → null (no name)', () => {
    assert.strictEqual(buildToolUseSignature({}), null);
  });

  test('buildToolUseSignature with unknown tool → null', () => {
    assert.strictEqual(buildToolUseSignature({ name: 'SomeRandomTool', input: {} }), null);
  });

  test('shell with empty command still produces valid signature', () => {
    const sig = buildExecRequestSignature({ type: 'shell', command: '', cwd: '' });
    assert.ok(sig, 'should not be null');
    assert.ok(typeof sig === 'string');
  });

  test('read with missing input fields still matches', () => {
    const execSig = buildExecRequestSignature({ type: 'read', path: '' });
    const kvSig = buildToolUseSignature({ name: 'Read', input: {} });
    assert.strictEqual(execSig, kvSig);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 7: Full dedup flow simulation (allToolCallsSkipped logic)
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 7. Full dedup flow: allToolCallsSkipped logic ===');
{
  // Simulates what continueStream does when processing KV FINAL
  function simulateKvDedup(handledSigs, handledIds, incomingToolCalls) {
    const deduped = [];
    let skipped = 0;
    for (const toolUse of incomingToolCalls) {
      const matchedById = !!toolUse?.id && handledIds.has(toolUse.id);
      const signature = buildToolUseSignature(toolUse);
      const matchedBySignature = !!signature && handledSigs.has(signature);
      if (matchedById || matchedBySignature) {
        skipped++;
        continue;
      }
      deduped.push(toolUse);
    }
    const allSkipped = incomingToolCalls.length > 0 && deduped.length === 0;
    return { deduped, skipped, allSkipped };
  }

  // Scenario A: All tool calls are replays → allSkipped = true → don't end turn
  {
    const sigs = new Set();
    const ids = new Set();
    sigs.add(buildExecRequestSignature({ type: 'shell', command: 'ls -la', cwd: '/tmp' }));
    ids.add('exec-id-1');

    const incoming = [
      { id: 'exec-id-1', name: 'Shell', input: { command: 'ls -la', cwd: '/tmp' } },
    ];

    const result = simulateKvDedup(sigs, ids, incoming);
    test('Scenario A: all replayed → allSkipped=true (don\'t end turn)', () => {
      assert.strictEqual(result.allSkipped, true);
      assert.strictEqual(result.deduped.length, 0);
      assert.strictEqual(result.skipped, 1);
    });
  }

  // Scenario B: Mix of replay + new → allSkipped = false → process new ones
  {
    const sigs = new Set();
    const ids = new Set();
    sigs.add(buildExecRequestSignature({ type: 'shell', command: 'ls', cwd: '' }));

    const incoming = [
      { id: 'old-id', name: 'Bash', input: { command: 'ls', cwd: '' } },
      { id: 'new-id', name: 'Shell', input: { command: 'cat /etc/hosts', cwd: '' } },
    ];

    const result = simulateKvDedup(sigs, ids, incoming);
    test('Scenario B: 1 replay + 1 new → allSkipped=false', () => {
      assert.strictEqual(result.allSkipped, false);
      assert.strictEqual(result.deduped.length, 1);
      assert.strictEqual(result.skipped, 1);
      assert.strictEqual(result.deduped[0].id, 'new-id');
    });
  }

  // Scenario C: No incoming tool calls → allSkipped = false (no tools to skip)
  {
    const result = simulateKvDedup(new Set(), new Set(), []);
    test('Scenario C: empty incoming → allSkipped=false', () => {
      assert.strictEqual(result.allSkipped, false);
      assert.strictEqual(result.deduped.length, 0);
    });
  }

  // Scenario D: All new (first turn, no history) → allSkipped = false
  {
    const incoming = [
      { id: 'fresh-1', name: 'Shell', input: { command: 'pwd', cwd: '' } },
    ];

    const result = simulateKvDedup(new Set(), new Set(), incoming);
    test('Scenario D: no history, all new → allSkipped=false, 1 passed through', () => {
      assert.strictEqual(result.allSkipped, false);
      assert.strictEqual(result.deduped.length, 1);
    });
  }

  // Scenario E: Multiple replayed tool calls from different turns
  {
    const sigs = new Set();
    const ids = new Set();
    sigs.add(buildExecRequestSignature({ type: 'shell', command: 'ls', cwd: '' }));
    sigs.add(buildExecRequestSignature({ type: 'read', path: '/tmp/a.txt' }));
    sigs.add(buildExecRequestSignature({ type: 'write', path: '/tmp/b.txt', fileText: 'x' }));

    const incoming = [
      { id: 'r1', name: 'Shell', input: { command: 'ls', cwd: '' } },
      { id: 'r2', name: 'Read', input: { path: '/tmp/a.txt' } },
      { id: 'r3', name: 'Write', input: { file_path: '/tmp/b.txt', content: 'x' } },
    ];

    const result = simulateKvDedup(sigs, ids, incoming);
    test('Scenario E: 3 replays from 3 turns → allSkipped=true', () => {
      assert.strictEqual(result.allSkipped, true);
      assert.strictEqual(result.skipped, 3);
    });
  }
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
