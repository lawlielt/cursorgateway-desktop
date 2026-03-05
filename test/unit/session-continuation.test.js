/**
 * Session Continuation & Concurrency Tests
 *
 * Covers the complex scenarios that caused real production bugs:
 *
 * 1. Continuation lock: concurrent duplicate requests don't compete for SSE reader
 * 2. Lock release on all code paths (success, error, cleanup)
 * 3. Multi-turn session lifecycle: create → tool_call → tool_result → continue → repeat
 * 4. Session expiry with pending tools vs idle
 * 5. Tool call mapping round-trip: exec → toolUse → tool_result → cursor result
 * 6. KV-mapped / text_fallback tool results trigger needsFreshRequest
 * 7. findSessionByToolCallId across multiple sessions
 */

const assert = require('assert');
const {
  SessionState,
  createSession,
  getSession,
  findSessionByToolCallId,
  cleanupSession,
  execRequestToToolUse,
  sendToolResult,
} = require('../../src/utils/sessionManager');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++;
        console.log(`  ✅ ${name}`);
      }).catch(e => {
        failed++;
        console.log(`  ❌ ${name}: ${e.message}`);
      });
    }
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function makeStubAgentClient() {
  const calls = [];
  return {
    calls,
    sendToolResult: async (execReq, result) => {
      calls.push({ method: 'sendToolResult', execReq, result });
    },
    sendResumeAction: async () => {
      calls.push({ method: 'sendResumeAction' });
    },
    close: () => {
      calls.push({ method: 'close' });
    },
  };
}

async function runAll() {

// ═══════════════════════════════════════════════════════════════
// Section 1: Continuation Lock — acquire / release / concurrent
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 1. Continuation lock basics ===');
{
  const session = new SessionState('test-lock-1', makeStubAgentClient());

  test('initially unlocked', () => {
    assert.strictEqual(session._continuationLock, null);
  });

  test('acquireContinuationLock returns true on first call', () => {
    assert.strictEqual(session.acquireContinuationLock(), true);
  });

  test('acquireContinuationLock returns false when already locked', () => {
    assert.strictEqual(session.acquireContinuationLock(), false);
  });

  test('waitForContinuation returns a promise', () => {
    const p = session.waitForContinuation();
    assert.ok(p instanceof Promise);
  });

  test('releaseContinuationLock clears the lock', () => {
    session.releaseContinuationLock();
    assert.strictEqual(session._continuationLock, null);
    assert.strictEqual(session._continuationUnlock, null);
  });

  test('can re-acquire after release', () => {
    assert.strictEqual(session.acquireContinuationLock(), true);
    session.releaseContinuationLock();
  });

  test('double release is safe (no-op)', () => {
    session.releaseContinuationLock();
    session.releaseContinuationLock();
    assert.strictEqual(session._continuationLock, null);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 2: Concurrent lock — waiter gets unblocked on release
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 2. Concurrent lock: waiter unblocked on release ===');
{
  const session = new SessionState('test-lock-2', makeStubAgentClient());
  session.acquireContinuationLock();

  let waiterResolved = false;
  const waiterPromise = session.waitForContinuation().then(() => {
    waiterResolved = true;
  });

  await test('waiter is blocked before release', () => {
    assert.strictEqual(waiterResolved, false);
  });

  session.releaseContinuationLock();
  await waiterPromise;

  await test('waiter is unblocked after release', () => {
    assert.strictEqual(waiterResolved, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 3: cleanupSession releases lock
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 3. cleanupSession releases continuation lock ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);
  const sid = session.sessionId;
  session.acquireContinuationLock();

  let waiterResolved = false;
  const waiterPromise = session.waitForContinuation().then(() => {
    waiterResolved = true;
  });

  cleanupSession(sid);
  await waiterPromise;

  await test('cleanup unblocks waiter', () => {
    assert.strictEqual(waiterResolved, true);
  });

  await test('cleanup calls agentClient.close()', () => {
    assert.ok(client.calls.some(c => c.method === 'close'));
  });

  await test('session is removed after cleanup', () => {
    assert.strictEqual(getSession(sid), null);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 4: Concurrent request simulation — full flow
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 4. Concurrent request simulation ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  // Register a tool call mapping (simulates what happens during chatStream)
  const toolCallId = 'toolu_concurrent_test';
  session.toolCallMapping.set(toolCallId, {
    cursorId: 1,
    cursorExecId: 'exec-1',
    cursorType: 'shell',
    cursorRequest: { command: 'ls', cwd: '/tmp' },
  });

  // Request A acquires lock
  const lockA = session.acquireContinuationLock();
  await test('Request A acquires lock', () => {
    assert.strictEqual(lockA, true);
  });

  // Request B arrives, cannot acquire
  const lockB = session.acquireContinuationLock();
  await test('Request B cannot acquire lock', () => {
    assert.strictEqual(lockB, false);
  });

  // Request B waits with timeout
  let requestBTimedOut = false;
  const waitPromise = Promise.race([
    session.waitForContinuation(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 50)),
  ]).catch(e => {
    requestBTimedOut = e.message === 'timeout';
  });

  // Request A finishes before timeout
  await new Promise(r => setTimeout(r, 10));
  session.releaseContinuationLock();
  await waitPromise;

  await test('Request B did NOT timeout (A finished in time)', () => {
    assert.strictEqual(requestBTimedOut, false);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 5: Concurrent request timeout scenario
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 5. Concurrent request timeout scenario ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  session.acquireContinuationLock();

  let timedOut = false;
  const waitPromise = Promise.race([
    session.waitForContinuation(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('lock timeout')), 30)),
  ]).catch(e => {
    timedOut = e.message === 'lock timeout';
  });

  await waitPromise;

  await test('Request B times out when A holds lock too long', () => {
    assert.strictEqual(timedOut, true);
  });

  session.releaseContinuationLock();
  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 6: Multi-turn tool call lifecycle
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 6. Multi-turn tool call lifecycle ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  // Turn 1: Cursor sends shell exec → mapped to Anthropic tool_use
  const execReq1 = { type: 'shell', id: 1, execId: 'exec-shell-1', command: 'ls -la', cwd: '/project' };
  const toolUse1 = execRequestToToolUse(execReq1, session);

  await test('turn 1: tool_use has correct name', () => {
    assert.strictEqual(toolUse1.name, 'Bash');
  });

  await test('turn 1: tool_use has correct input', () => {
    assert.strictEqual(toolUse1.input.command, 'ls -la');
  });

  await test('turn 1: mapping registered', () => {
    assert.ok(session.toolCallMapping.has(toolUse1.id));
  });

  // Claude Code executes and returns result
  const result1 = await sendToolResult(session, toolUse1.id, {
    is_error: false,
    content: 'total 42\ndrwxr-xr-x  5 user ...',
  }, { deferResume: true });

  await test('turn 1: sendToolResult succeeds', () => {
    assert.strictEqual(result1.sentToCursor, true);
    assert.strictEqual(result1.needsFreshRequest, false);
  });

  await test('turn 1: mapping cleaned up after sendToolResult', () => {
    assert.ok(!session.toolCallMapping.has(toolUse1.id));
  });

  await test('turn 1: agentClient.sendToolResult was called', () => {
    assert.ok(client.calls.some(c => c.method === 'sendToolResult'));
  });

  // Turn 2: Cursor sends read exec
  const execReq2 = { type: 'read', id: 2, execId: 'exec-read-1', path: '/project/package.json' };
  const toolUse2 = execRequestToToolUse(execReq2, session);

  await test('turn 2: Read tool_use', () => {
    assert.strictEqual(toolUse2.name, 'Read');
    assert.strictEqual(toolUse2.input.file_path, '/project/package.json');
  });

  const result2 = await sendToolResult(session, toolUse2.id, {
    is_error: false,
    content: '{"name": "test-project"}',
  }, { deferResume: true });

  await test('turn 2: sendToolResult succeeds', () => {
    assert.strictEqual(result2.sentToCursor, true);
  });

  // Turn 3: Cursor sends write exec
  const execReq3 = { type: 'write', id: 3, execId: 'exec-write-1', path: '/project/out.txt', fileText: 'hello' };
  const toolUse3 = execRequestToToolUse(execReq3, session);

  await test('turn 3: Write tool_use', () => {
    assert.strictEqual(toolUse3.name, 'Write');
    assert.strictEqual(toolUse3.input.file_path, '/project/out.txt');
    assert.strictEqual(toolUse3.input.content, 'hello');
  });

  const result3 = await sendToolResult(session, toolUse3.id, {
    is_error: false,
    content: 'File written successfully',
  }, { deferResume: true });

  await test('turn 3: sendToolResult succeeds', () => {
    assert.strictEqual(result3.sentToCursor, true);
  });

  await test('all 3 turns: 3 sendToolResult calls + 0 resume (all deferred)', () => {
    const sendCalls = client.calls.filter(c => c.method === 'sendToolResult');
    const resumeCalls = client.calls.filter(c => c.method === 'sendResumeAction');
    assert.strictEqual(sendCalls.length, 3);
    assert.strictEqual(resumeCalls.length, 0);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 7: text_fallback / kvMapped → needsFreshRequest
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 7. text_fallback / kvMapped tool results ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  // Register a text_fallback mapping
  const tfId = 'toolu_text_fallback_1';
  session.toolCallMapping.set(tfId, {
    cursorId: null,
    cursorExecId: null,
    cursorType: 'text_fallback',
    cursorRequest: {},
    toolName: 'TodoWrite',
  });

  const tfResult = await sendToolResult(session, tfId, {
    is_error: false,
    content: 'OK',
  });

  await test('text_fallback → needsFreshRequest: true', () => {
    assert.strictEqual(tfResult.needsFreshRequest, true);
    assert.strictEqual(tfResult.sentToCursor, false);
  });

  await test('text_fallback mapping removed after result', () => {
    assert.ok(!session.toolCallMapping.has(tfId));
  });

  // Register a kvMapped mapping
  const kvId = 'toolu_kv_mapped_1';
  session.toolCallMapping.set(kvId, {
    cursorId: 900000001,
    cursorExecId: kvId,
    cursorType: 'shell',
    cursorRequest: { command: 'pwd' },
    kvMapped: true,
    toolName: 'Shell',
  });

  const kvResult = await sendToolResult(session, kvId, {
    is_error: false,
    content: '/home/user',
  });

  await test('kvMapped → needsFreshRequest: true', () => {
    assert.strictEqual(kvResult.needsFreshRequest, true);
    assert.strictEqual(kvResult.sentToCursor, false);
  });

  await test('kvMapped: agentClient.sendToolResult NOT called', () => {
    const sendCalls = client.calls.filter(c => c.method === 'sendToolResult');
    assert.strictEqual(sendCalls.length, 0);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 8: Error tool results
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 8. Error tool results ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  const execReq = { type: 'shell', id: 10, execId: 'exec-err-1', command: 'bad_cmd' };
  const toolUse = execRequestToToolUse(execReq, session);

  const result = await sendToolResult(session, toolUse.id, {
    is_error: true,
    content: 'command not found: bad_cmd',
  }, { deferResume: true });

  await test('error result: sentToCursor = true (still sent)', () => {
    assert.strictEqual(result.sentToCursor, true);
  });

  await test('error result: agentClient receives error content', () => {
    const call = client.calls.find(c => c.method === 'sendToolResult');
    assert.ok(call);
    // Shell errors now use { stderr, exitCode } format instead of generic { error }
    assert.strictEqual(call.result.stderr, 'command not found: bad_cmd');
    assert.strictEqual(call.result.exitCode, 1);
    assert.strictEqual(call.result.stdout, '');
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 9: Unknown tool call ID → throws
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 9. Unknown tool call ID ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  await test('unknown tool call ID throws', async () => {
    try {
      await sendToolResult(session, 'toolu_does_not_exist', {
        is_error: false,
        content: 'whatever',
      });
      throw new Error('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Unknown tool call ID'));
    }
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 10: findSessionByToolCallId
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 10. findSessionByToolCallId ===');
{
  const client1 = makeStubAgentClient();
  const client2 = makeStubAgentClient();
  const session1 = createSession(client1);
  const session2 = createSession(client2);

  // Register tool calls in different sessions
  const id1 = 'toolu_session1_tool';
  session1.toolCallMapping.set(id1, { cursorId: 1, cursorType: 'shell' });

  const id2 = 'toolu_session2_tool';
  session2.toolCallMapping.set(id2, { cursorId: 2, cursorType: 'read' });

  await test('finds session1 by its tool call ID', () => {
    const found = findSessionByToolCallId(id1);
    assert.ok(found);
    assert.strictEqual(found.sessionId, session1.sessionId);
  });

  await test('finds session2 by its tool call ID', () => {
    const found = findSessionByToolCallId(id2);
    assert.ok(found);
    assert.strictEqual(found.sessionId, session2.sessionId);
  });

  await test('returns null for unknown ID', () => {
    assert.strictEqual(findSessionByToolCallId('toolu_unknown'), null);
  });

  await test('returns null for null ID', () => {
    assert.strictEqual(findSessionByToolCallId(null), null);
  });

  cleanupSession(session1.sessionId);
  cleanupSession(session2.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 11: Session expiry
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 11. Session expiry ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);
  const sid = session.sessionId;

  await test('fresh session is not expired', () => {
    assert.strictEqual(session.isExpired(), false);
  });

  // Simulate idle timeout (5 min)
  session.lastActivityAt = Date.now() - 6 * 60 * 1000;
  await test('idle session expires after 5 min', () => {
    assert.strictEqual(session.isExpired(), true);
  });

  // Add pending tool call → extends TTL to 30 min
  session.lastActivityAt = Date.now() - 6 * 60 * 1000;
  session.toolCallMapping.set('pending-tool', { cursorType: 'shell' });
  await test('session with pending tools NOT expired at 6 min', () => {
    assert.strictEqual(session.isExpired(), false);
  });

  session.lastActivityAt = Date.now() - 31 * 60 * 1000;
  await test('session with pending tools expires after 30 min', () => {
    assert.strictEqual(session.isExpired(), true);
  });

  // getSession auto-cleans expired sessions
  session.lastActivityAt = Date.now() - 31 * 60 * 1000;
  await test('getSession returns null for expired session', () => {
    assert.strictEqual(getSession(sid), null);
  });
}

// ═══════════════════════════════════════════════════════════════
// Section 12: Dedup tracking on session (sentCursorExecKeys, sentToolCallIds)
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 12. Session dedup tracking fields ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  await test('sentText starts empty', () => {
    assert.strictEqual(session.sentText, '');
  });

  await test('sentToolCallIds starts empty', () => {
    assert.strictEqual(session.sentToolCallIds.size, 0);
  });

  await test('sentCursorExecKeys starts empty', () => {
    assert.strictEqual(session.sentCursorExecKeys.size, 0);
  });

  // Simulate what messages.js does after a streaming turn
  session.sentText = 'Hello, I will help you.';
  session.sentToolCallIds.add('toolu_abc');
  session.sentCursorExecKeys.add('id:1|execId:exec-1');

  await test('dedup fields persist across accesses', () => {
    assert.strictEqual(session.sentText, 'Hello, I will help you.');
    assert.ok(session.sentToolCallIds.has('toolu_abc'));
    assert.ok(session.sentCursorExecKeys.has('id:1|execId:exec-1'));
  });

  // Second turn appends
  session.sentText += ' Let me check.';
  session.sentToolCallIds.add('toolu_def');
  session.sentCursorExecKeys.add('id:2|execId:exec-2');

  await test('dedup fields accumulate across turns', () => {
    assert.ok(session.sentText.includes('Hello'));
    assert.ok(session.sentText.includes('Let me check'));
    assert.strictEqual(session.sentToolCallIds.size, 2);
    assert.strictEqual(session.sentCursorExecKeys.size, 2);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 13: All exec types produce correct tool_use mappings
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 13. execRequestToToolUse for all types ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  const cases = [
    { exec: { type: 'shell', id: 1, command: 'echo hi', cwd: '/tmp' }, name: 'Bash', checkInput: i => i.command === 'echo hi' && i.description },
    { exec: { type: 'read', id: 2, path: '/a.txt' }, name: 'Read', checkInput: i => i.file_path === '/a.txt' },
    { exec: { type: 'write', id: 3, path: '/b.txt', fileText: 'content' }, name: 'Write', checkInput: i => i.file_path === '/b.txt' && i.content === 'content' },
    { exec: { type: 'grep', id: 4, pattern: 'TODO', path: '/src' }, name: 'Grep', checkInput: i => i.pattern === 'TODO' && i.path === '/src' },
    { exec: { type: 'ls', id: 5, path: '/home' }, name: 'Glob', checkInput: i => i.pattern === '*' && i.path === '/home' },
    { exec: { type: 'delete', id: 6, path: '/tmp/x.txt' }, name: 'Bash', checkInput: i => i.command.includes('rm -f') && i.command.includes('/tmp/x.txt') },
    { exec: { type: 'mcp', id: 7, toolName: 'MyTool', args: { x: 1 } }, name: 'MyTool', checkInput: i => i.x === 1 },
  ];

  for (const { exec, name, checkInput } of cases) {
    const toolUse = execRequestToToolUse(exec, session);
    await test(`${exec.type} → ${name}`, () => {
      assert.strictEqual(toolUse.name, name);
      assert.ok(toolUse.id.startsWith('toolu_'));
      assert.ok(checkInput(toolUse.input), `input check failed: ${JSON.stringify(toolUse.input)}`);
    });
  }

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 14: Lock + multi-turn integration (the real "refactor" scenario)
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 14. Lock + multi-turn integration ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);

  // Simulate 5 tool-call turns with lock acquire/release each time
  for (let turn = 1; turn <= 5; turn++) {
    const acquired = session.acquireContinuationLock();
    await test(`turn ${turn}: lock acquired`, () => {
      assert.strictEqual(acquired, true);
    });

    const execReq = { type: 'shell', id: turn, execId: `exec-${turn}`, command: `cmd-${turn}` };
    const toolUse = execRequestToToolUse(execReq, session);

    const result = await sendToolResult(session, toolUse.id, {
      is_error: false,
      content: `output-${turn}`,
    }, { deferResume: true });

    await test(`turn ${turn}: result sent`, () => {
      assert.strictEqual(result.sentToCursor, true);
    });

    session.releaseContinuationLock();
  }

  await test('5 turns completed: 5 sendToolResult calls', () => {
    const calls = client.calls.filter(c => c.method === 'sendToolResult');
    assert.strictEqual(calls.length, 5);
  });

  await test('5 turns: all mappings cleaned up', () => {
    assert.strictEqual(session.toolCallMapping.size, 0);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
// Section 15: Concurrent requests — one works, retry falls through
// ═══════════════════════════════════════════════════════════════
console.log('\n=== 15. Simulated concurrent retry behavior ===');
{
  const client = makeStubAgentClient();
  const session = createSession(client);
  const toolCallId = 'toolu_retry_test';
  session.toolCallMapping.set(toolCallId, {
    cursorId: 1,
    cursorExecId: 'exec-retry-1',
    cursorType: 'shell',
    cursorRequest: { command: 'ls' },
  });

  const events = [];

  // Request A: acquires lock, processes normally
  const requestA = (async () => {
    const locked = session.acquireContinuationLock();
    assert.strictEqual(locked, true);
    events.push('A:locked');

    // Simulate some processing time
    await new Promise(r => setTimeout(r, 30));

    await sendToolResult(session, toolCallId, {
      is_error: false,
      content: 'output from A',
    }, { deferResume: true });
    events.push('A:sent');

    session.releaseContinuationLock();
    events.push('A:released');
  })();

  // Request B: arrives 5ms later, cannot lock, waits
  const requestB = (async () => {
    await new Promise(r => setTimeout(r, 5));
    const locked = session.acquireContinuationLock();
    events.push(`B:lock=${locked}`);

    if (!locked) {
      await session.waitForContinuation();
      events.push('B:unblocked');
    }
  })();

  await Promise.all([requestA, requestB]);

  await test('Request A processes first', () => {
    assert.ok(events.indexOf('A:locked') < events.indexOf('A:sent'));
  });

  await test('Request B was blocked', () => {
    assert.ok(events.includes('B:lock=false'));
  });

  await test('Request B unblocked after A finished', () => {
    assert.ok(events.includes('B:unblocked'));
    assert.ok(events.indexOf('A:released') <= events.indexOf('B:unblocked'));
  });

  await test('Tool result sent exactly once (not duplicated)', () => {
    const sends = client.calls.filter(c => c.method === 'sendToolResult');
    assert.strictEqual(sends.length, 1);
  });

  cleanupSession(session.sessionId);
}

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);

}

runAll();
