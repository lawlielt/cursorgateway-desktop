/**
 * Workspace Path Propagation Tests
 *
 * Validates that the client's working directory (from Claude Code's system prompt)
 * is correctly propagated to Cursor's request_context responses, rather than
 * leaking the proxy server's own process.cwd().
 *
 * Bug: When Claude Code operates on project A, the proxy (running from project B)
 * returned project B's path as the workspace, causing Cursor's model to operate
 * in the wrong directory.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err.message}`);
  }
}

// ─── 1. buildRequestContextResultMessage uses workspacePath ──────────────────

console.log('\n[1] buildRequestContextResultMessage workspace propagation');

const {
  _buildRequestContextResultMessage: buildRequestContextResultMessage,
  _buildShellResultMessage: buildShellResultMessage,
} = require('../../src/utils/agentClient');

test('returns buffer with custom workspace path embedded', () => {
  const customPath = '/Users/test/projects/cursor-proxy';
  const buf = buildRequestContextResultMessage(1, 'exec-1', customPath);
  assert.ok(Buffer.isBuffer(buf), 'should return a Buffer');
  const content = buf.toString('utf-8');
  assert.ok(content.includes(customPath), `buffer should contain "${customPath}"`);
});

test('does NOT contain process.cwd() when custom path provided', () => {
  const customPath = '/Users/test/projects/cursor-proxy';
  const proxyCwd = process.cwd();
  if (customPath === proxyCwd) {
    console.log('    (skipped: customPath equals process.cwd())');
    return;
  }
  const buf = buildRequestContextResultMessage(1, 'exec-1', customPath);
  const content = buf.toString('utf-8');
  assert.ok(!content.includes(proxyCwd),
    `buffer should NOT contain proxy cwd "${proxyCwd}"`);
});

test('falls back to process.cwd() when workspacePath is undefined', () => {
  const buf = buildRequestContextResultMessage(1, 'exec-1', undefined);
  assert.ok(Buffer.isBuffer(buf));
  const content = buf.toString('utf-8');
  assert.ok(content.includes(process.cwd()),
    'should fall back to process.cwd() when no path provided');
});

test('falls back to process.cwd() when workspacePath is empty string', () => {
  const buf = buildRequestContextResultMessage(1, 'exec-1', '');
  assert.ok(Buffer.isBuffer(buf));
  const content = buf.toString('utf-8');
  assert.ok(content.includes(process.cwd()),
    'should fall back to process.cwd() when empty string');
});

test('workspace path appears twice in buffer (cwd + workspace_path fields)', () => {
  const customPath = '/unique/test/workspace/path';
  const buf = buildRequestContextResultMessage(1, 'exec-1', customPath);
  const content = buf.toString('utf-8');
  const firstIdx = content.indexOf(customPath);
  const secondIdx = content.indexOf(customPath, firstIdx + customPath.length);
  assert.ok(firstIdx >= 0, 'should find first occurrence');
  assert.ok(secondIdx >= 0, 'should find second occurrence (cwd + workspace_path)');
});

// ─── 2. buildShellResultMessage uses provided cwd ────────────────────────────

console.log('\n[2] buildShellResultMessage cwd propagation');

test('shell result contains the provided cwd, not process.cwd()', () => {
  const customCwd = '/Users/test/projects/cursor-proxy';
  const buf = buildShellResultMessage(1, 'exec-1', 'ls -la', customCwd, 'file.txt\n', '', 0);
  const content = buf.toString('utf-8');
  assert.ok(content.includes(customCwd), `should contain cwd "${customCwd}"`);
});

// ─── 3. AgentClient constructor stores workspacePath ─────────────────────────

console.log('\n[3] AgentClient.workspacePath initialization');

const { AgentClient } = require('../../src/utils/agentClient');

test('stores provided workspacePath in constructor', () => {
  const client = new AgentClient('fake-token', {
    workspacePath: '/custom/workspace',
  });
  assert.strictEqual(client.workspacePath, '/custom/workspace');
});

test('defaults to process.cwd() when no workspacePath', () => {
  const client = new AgentClient('fake-token', {});
  assert.strictEqual(client.workspacePath, process.cwd());
});

// ─── 4. extractWorkingDirectory from system prompt ───────────────────────────

console.log('\n[4] extractWorkingDirectory extracts Claude Code working dir');

const { extractWorkingDirectory } = require('../../src/utils/toolsAdapter');

// 4a. Claude Code CLI format (the REAL format that caused the bug)
test('extracts "Workspace Path:" — Claude Code CLI actual format', () => {
  const system = 'OS Version: darwin 24.6.0\nShell: zsh\nWorkspace Path: /Users/taxue/Documents/AI/cursor-proxy\nIs directory a git repo: Yes';
  assert.strictEqual(extractWorkingDirectory(system), '/Users/taxue/Documents/AI/cursor-proxy');
});

test('extracts "Workspace Path:" from array system prompt (Claude Code format)', () => {
  const system = [
    { type: 'text', text: 'You are an AI assistant.' },
    { type: 'text', text: 'Workspace Path: /Users/test/cursor-proxy\nMore info here.' },
  ];
  assert.strictEqual(extractWorkingDirectory(system), '/Users/test/cursor-proxy');
});

test('extracts "Workspace Path:" case insensitive', () => {
  assert.strictEqual(extractWorkingDirectory('workspace path: /tmp/test'), '/tmp/test');
});

// 4b. "Working directory:" format (Cursor IDE format)
test('extracts "Working directory:" format', () => {
  const system = 'You are an AI assistant.\nWorking directory: /Users/test/cursor-proxy\nPlease help.';
  assert.strictEqual(extractWorkingDirectory(system), '/Users/test/cursor-proxy');
});

test('extracts "Working directory:" from array system prompt', () => {
  const system = [
    { type: 'text', text: 'Working directory: /Users/test/cursor-proxy\n' },
  ];
  assert.strictEqual(extractWorkingDirectory(system), '/Users/test/cursor-proxy');
});

// 4c. Other formats
test('extracts "Workspace Root:" format', () => {
  assert.strictEqual(extractWorkingDirectory('Workspace Root: /home/user/project'), '/home/user/project');
});

test('extracts "CWD:" format', () => {
  assert.strictEqual(extractWorkingDirectory('CWD: /home/user/app'), '/home/user/app');
});

// 4d. Edge cases
test('returns empty string when no working directory', () => {
  assert.strictEqual(extractWorkingDirectory('Just a regular prompt'), '');
});

test('returns empty string for null input', () => {
  assert.strictEqual(extractWorkingDirectory(null), '');
});

test('returns empty string for undefined input', () => {
  assert.strictEqual(extractWorkingDirectory(undefined), '');
});

test('handles paths with spaces', () => {
  assert.strictEqual(extractWorkingDirectory('Workspace Path: /Users/test/My Projects/app'), '/Users/test/My Projects/app');
});

// 4e. Priority: "Workspace Path:" should match before "Working directory:"
test('"Workspace Path:" takes priority when both present', () => {
  const system = 'Workspace Path: /correct/path\nWorking directory: /wrong/path';
  assert.strictEqual(extractWorkingDirectory(system), '/correct/path');
});

// 4f. Realistic full Claude Code system prompt
test('works with realistic full Claude Code system prompt', () => {
  const system = [
    { type: 'text', text: `You are an interactive CLI tool that helps users with software engineering tasks.

OS Version: darwin 24.6.0
Shell: zsh
Workspace Path: /Users/taxue/Documents/AI/cursor-proxy
Is directory a git repo: Yes

Today's date: Tuesday Mar 3, 2026` },
  ];
  assert.strictEqual(extractWorkingDirectory(system), '/Users/taxue/Documents/AI/cursor-proxy');
});

// ─── 5. getRequestContext uses workspacePath ─────────────────────────────────

console.log('\n[5] getRequestContext workspace propagation');

const { getRequestContext } = require('../../src/utils/toolExecutor');

test('returns custom workspacePath as cwd', () => {
  const ctx = getRequestContext('/custom/path');
  assert.strictEqual(ctx.cwd, '/custom/path');
});

test('falls back to process.cwd() when no path', () => {
  const ctx = getRequestContext();
  assert.strictEqual(ctx.cwd, process.cwd());
});

test('falls back to process.cwd() for empty string', () => {
  const ctx = getRequestContext('');
  assert.strictEqual(ctx.cwd, process.cwd());
});

// ─── 6. End-to-end: system prompt → AgentClient.workspacePath ────────────────

console.log('\n[6] End-to-end workspace path flow');

test('Claude Code system prompt → extract → AgentClient → request_context uses correct path', () => {
  // Simulate real Claude Code system prompt format
  const systemPrompt = [
    { type: 'text', text: 'You are an AI assistant.\n\nOS Version: darwin 24.6.0\nShell: zsh\nWorkspace Path: /Users/test/cursor-proxy\nIs directory a git repo: Yes' },
  ];
  const workDir = extractWorkingDirectory(systemPrompt);
  assert.strictEqual(workDir, '/Users/test/cursor-proxy',
    'should extract Workspace Path from Claude Code format');

  const client = new AgentClient('fake-token', { workspacePath: workDir });
  assert.strictEqual(client.workspacePath, '/Users/test/cursor-proxy');

  const buf = buildRequestContextResultMessage(1, 'exec-1', client.workspacePath);
  const content = buf.toString('utf-8');
  assert.ok(content.includes('/Users/test/cursor-proxy'),
    'request_context response should contain user workspace path');
  assert.ok(!content.includes(process.cwd()) || process.cwd() === '/Users/test/cursor-proxy',
    'should NOT leak proxy process.cwd()');
});

test('if extraction fails, process.cwd() is the fallback (documented behavior)', () => {
  const systemPrompt = 'No path info in this prompt';
  const workDir = extractWorkingDirectory(systemPrompt);
  assert.strictEqual(workDir, '', 'should return empty when no path found');

  const client = new AgentClient('fake-token', {
    workspacePath: workDir || process.cwd(),
  });
  assert.strictEqual(client.workspacePath, process.cwd(),
    'should fall back to process.cwd() when extraction fails');
});

// ─── 7. BidiAppend has timeout protection ────────────────────────────────────

console.log('\n[7] BidiAppend timeout protection');

test('bidiAppend rejects on connection failure (not hang forever)', async () => {
  const client = new AgentClient('fake-token', {
    baseUrl: 'http://127.0.0.1:1',
    workspacePath: '/test',
  });
  client.requestId = 'test-req-id';
  client.appendSeqno = 0n;

  try {
    await client.bidiAppend(Buffer.from('test'), { maxRetries: 1 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message, 'should have an error message');
  }
});

test('bidiAppend retries on failure before giving up', async () => {
  let attempts = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    attempts++;
    throw new Error('fetch failed');
  };
  
  const client = new AgentClient('fake-token', { workspacePath: '/test' });
  client.requestId = 'test-req-id';
  client.appendSeqno = 0n;

  try {
    await client.bidiAppend(Buffer.from('test'), { maxRetries: 3 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('fetch failed'), 'should propagate fetch error');
    assert.strictEqual(attempts, 3, 'should have retried 3 times');
  } finally {
    global.fetch = realFetch;
  }
});

test('bidiAppend succeeds on retry after initial failure', async () => {
  let attempts = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    attempts++;
    if (attempts < 2) throw new Error('fetch failed');
    return { ok: true };
  };
  
  const client = new AgentClient('fake-token', { workspacePath: '/test' });
  client.requestId = 'test-req-id';
  client.appendSeqno = 0n;

  try {
    await client.bidiAppend(Buffer.from('test'), { maxRetries: 3 });
    assert.strictEqual(attempts, 2, 'should succeed on 2nd attempt');
  } finally {
    global.fetch = realFetch;
  }
});

test('bidiAppend has AbortController for timeout', () => {
  const client = new AgentClient('fake-token', {});
  const source = client.bidiAppend.toString();
  assert.ok(source.includes('AbortController'),
    'bidiAppend should use AbortController for timeout');
});

test('bidiAppend does not retry on 4xx errors', async () => {
  let attempts = 0;
  const realFetch = global.fetch;
  global.fetch = async () => {
    attempts++;
    return { ok: false, status: 400, text: async () => 'bad request' };
  };
  
  const client = new AgentClient('fake-token', { workspacePath: '/test' });
  client.requestId = 'test-req-id';
  client.appendSeqno = 0n;

  try {
    await client.bidiAppend(Buffer.from('test'), { maxRetries: 3 });
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(attempts, 1, 'should NOT retry on 4xx');
    assert.ok(err.message.includes('400'), 'error should contain status code');
  } finally {
    global.fetch = realFetch;
  }
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
