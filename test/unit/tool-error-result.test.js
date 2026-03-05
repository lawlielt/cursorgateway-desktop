/**
 * Tool Error Result Tests
 *
 * Validates that is_error=true tool results are correctly formatted per tool type.
 *
 * Root cause bug: sessionManager.sendToolResult converted ALL error results to
 * a generic { error: "..." } object.  agentClient.sendToolResult then accessed
 * result.stdout/result.exitCode which were undefined, sending the Cursor model
 * stdout='', stderr='', exitCode=0 — making it think the shell command SUCCEEDED.
 *
 * Fix: sessionManager now formats error results per tool type (shell gets
 * { stdout, stderr, exitCode }, write gets { error: { path, error } }, etc.).
 * agentClient.sendToolResult also has a fallback for the old generic error format.
 */

const assert = require('assert');

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
// Simulate the sessionManager.sendToolResult error handling logic
// ═══════════════════════════════════════════════════════════════

function simulateCursorResult(cursorType, isError, content, cursorRequest = {}) {
  if (isError) {
    const errorContent = typeof content === 'string'
      ? content
      : (Array.isArray(content)
        ? content.map(b => b.text || '').join('')
        : JSON.stringify(content) || 'Tool execution failed');

    switch (cursorType) {
      case 'shell': {
        const exitCodeMatch = errorContent.match(/Exit code (\d+)/i);
        const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 1;
        return { stdout: '', stderr: errorContent, exitCode };
      }
      case 'write':
        return { error: { path: cursorRequest.path || '', error: errorContent } };
      case 'read':
      case 'read_v1':
        return { content: errorContent, totalLines: 0, fileSize: BigInt(0) };
      default:
        return { error: errorContent };
    }
  }
  return { content };
}

// Simulate agentClient.sendToolResult shell fallback
function simulateShellResult(result) {
  let stdout = result.stdout || '';
  let stderr = result.stderr || '';
  let exitCode = result.exitCode || 0;
  if (!stdout && !stderr && exitCode === 0 && result.error) {
    const errMsg = typeof result.error === 'string' ? result.error : (result.error.error || 'Command failed');
    stderr = errMsg;
    const exitMatch = errMsg.match(/Exit code (\d+)/i);
    exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 1;
  }
  return { stdout, stderr, exitCode };
}

// ═══════════════════════════════════════════════════════════════
console.log('\n--- Shell error results ---');

test('Shell exit code 127: binary not found', () => {
  const r = simulateCursorResult('shell', true, 'Exit code 127\n(eval):1: no such file or directory: ./todo-tracker');
  assert.strictEqual(r.exitCode, 127);
  assert.ok(r.stderr.includes('no such file or directory'));
  assert.strictEqual(r.stdout, '');
});

test('Shell exit code 1: compilation error', () => {
  const r = simulateCursorResult('shell', true, 'Exit code 1\nmain.go:7:2: no required module provides package');
  assert.strictEqual(r.exitCode, 1);
  assert.ok(r.stderr.includes('no required module'));
});

test('Shell error without explicit exit code', () => {
  const r = simulateCursorResult('shell', true, 'Command not found: foobar');
  assert.strictEqual(r.exitCode, 1); // default non-zero
  assert.ok(r.stderr.includes('Command not found'));
});

test('Shell error with array content', () => {
  const r = simulateCursorResult('shell', true, [{ type: 'text', text: 'Exit code 2\nSome error' }]);
  assert.strictEqual(r.exitCode, 2);
  assert.ok(r.stderr.includes('Some error'));
});

// ═══════════════════════════════════════════════════════════════
console.log('\n--- agentClient shell fallback (old generic error) ---');

test('Old-style { error: "Exit code 127..." } → shell result with correct exitCode', () => {
  const oldResult = { error: 'Exit code 127\nno such file' };
  const r = simulateShellResult(oldResult);
  assert.strictEqual(r.exitCode, 127);
  assert.ok(r.stderr.includes('no such file'));
  assert.strictEqual(r.stdout, '');
});

test('Old-style { error: "some msg" } without exit code → exitCode=1', () => {
  const oldResult = { error: 'Something went wrong' };
  const r = simulateShellResult(oldResult);
  assert.strictEqual(r.exitCode, 1);
  assert.strictEqual(r.stderr, 'Something went wrong');
});

test('Normal shell result (no error) passes through unchanged', () => {
  const r = simulateShellResult({ stdout: 'hello', stderr: '', exitCode: 0 });
  assert.strictEqual(r.stdout, 'hello');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.exitCode, 0);
});

test('Normal shell error result (proper format) passes through', () => {
  const r = simulateShellResult({ stdout: '', stderr: 'error msg', exitCode: 2 });
  assert.strictEqual(r.stderr, 'error msg');
  assert.strictEqual(r.exitCode, 2);
});

// ═══════════════════════════════════════════════════════════════
console.log('\n--- Write error results ---');

test('Write error preserves path', () => {
  const r = simulateCursorResult('write', true, 'Permission denied', { path: '/tmp/foo.txt' });
  assert.strictEqual(r.error.path, '/tmp/foo.txt');
  assert.strictEqual(r.error.error, 'Permission denied');
});

test('Write error with no path', () => {
  const r = simulateCursorResult('write', true, 'Disk full');
  assert.strictEqual(r.error.path, '');
  assert.strictEqual(r.error.error, 'Disk full');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n--- Read error results ---');

test('Read error returns content with error message', () => {
  const r = simulateCursorResult('read', true, 'ENOENT: no such file or directory');
  assert.strictEqual(r.content, 'ENOENT: no such file or directory');
  assert.strictEqual(r.totalLines, 0);
  assert.strictEqual(r.fileSize, BigInt(0));
});

// ═══════════════════════════════════════════════════════════════
console.log('\n--- Default error results ---');

test('Unknown tool type gets generic error', () => {
  const r = simulateCursorResult('mcp', true, 'MCP tool failed');
  assert.strictEqual(r.error, 'MCP tool failed');
});

// ═══════════════════════════════════════════════════════════════
console.log('\n--- Bug reproduction: exact Claude Code error ---');

test('Exact bug: ./todo-tracker exit 127 → model sees non-zero exitCode', () => {
  // This is the exact error from the user's session
  const errorContent = 'Exit code 127\n(eval):1: no such file or directory: ./todo-tracker\n\n(eval):1: no such file or directory: ./todo-tracker';
  
  // Step 1: sessionManager creates cursor result
  const cursorResult = simulateCursorResult('shell', true, errorContent);
  assert.strictEqual(cursorResult.exitCode, 127, 'sessionManager must preserve exit code 127');
  assert.ok(cursorResult.stderr.includes('no such file or directory'), 'stderr must contain error');
  
  // Step 2: agentClient formats for Cursor model
  const shellResult = simulateShellResult(cursorResult);
  assert.strictEqual(shellResult.exitCode, 127, 'agentClient must send exit code 127');
  assert.ok(shellResult.stderr.length > 0, 'stderr must not be empty');
});

test('Exact bug: go build exit 1 → model sees compilation error', () => {
  const errorContent = "Exit code 1\nmain.go:7:2: no required module provides package github.com/example/todo-tracker/cmd; to add it:\n\tgo get github.com/example/todo-tracker/cmd";
  
  const cursorResult = simulateCursorResult('shell', true, errorContent);
  assert.strictEqual(cursorResult.exitCode, 1);
  assert.ok(cursorResult.stderr.includes('no required module'));
  
  const shellResult = simulateShellResult(cursorResult);
  assert.strictEqual(shellResult.exitCode, 1);
});

// ═══════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
