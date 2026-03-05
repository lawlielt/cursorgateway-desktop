#!/usr/bin/env node
/**
 * Tool Outcome Verification Tests (E2E)
 *
 * These tests verify REAL-WORLD file outcomes through the FULL pipeline:
 *   Cursor exec_server_message → parseExecServerMessage → mapAgentChunkToToolUse
 *     (includes execRequestToToolUse + adaptKvToolUseToIde normalization)
 *   → Claude Code receives tool_use with normalized params → executes → verifies disk
 *
 * CRITICAL: This uses mapAgentChunkToToolUse (not raw execRequestToToolUse) so that
 * parameter normalization bugs (e.g. content→contents, file_path→path) are caught.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const { execRequestToToolUse, sendToolResult: sessionSendToolResult } = require('../../src/utils/sessionManager');
const { parseExecServerMessage, AgentClient } = require('../../src/utils/agentClient');
const { mapAgentChunkToToolUse } = require('../../src/utils/bidiToolFlowAdapter');
const {
  encodeStringField,
  encodeUint32Field,
  encodeMessageField,
} = require('../../src/utils/protoEncoder');

function concatBytes(...buffers) {
  return Buffer.concat(buffers.filter(Boolean));
}

// Claude Code tool definitions — the REAL schemas that the IDE declares
const CLAUDE_CODE_TOOLS = [
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path of the file to read' },
        offset: { type: 'integer', description: 'Line offset' },
        limit: { type: 'integer', description: 'Number of lines' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path of the file' },
        contents: { type: 'string', description: 'The contents to write' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'Bash',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        description: { type: 'string' },
        timeout: { type: 'number' },
        working_directory: { type: 'string' },
      },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    input_schema: {
      type: 'object',
      properties: {
        glob_pattern: { type: 'string' },
        target_directory: { type: 'string' },
      },
      required: ['glob_pattern'],
    },
  },
  {
    name: 'Grep',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Delete',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'StrReplace',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
];

(async () => {

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

function makeSession() {
  const captured = [];
  const client = new AgentClient('fake-token', { workspacePath: '/tmp' });
  client.bidiAppend = async (data) => { captured.push(data); };
  client.sendResumeAction = async () => {};
  return {
    toolCallMapping: new Map(),
    pendingToolCalls: [],
    sentText: '',
    sentToolCallIds: new Set(),
    sentCursorExecKeys: new Set(),
    agentClient: client,
    _captured: captured,
  };
}

/**
 * Full pipeline: exec_server_message → parse → mapAgentChunkToToolUse → normalized tool_use
 * This is what messages.js actually does in production.
 */
function fullPipelineToolUse(execMsg, session) {
  const parsed = parseExecServerMessage(execMsg);
  const chunk = { type: 'tool_call', execRequest: parsed };
  return mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
}

// ─── Setup temp directory ───

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cto-e2e-'));

function cleanup() {
  try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

console.log(`\nTemp dir: ${TEMP_DIR}\n`);

// ═══════════════════════════════════════════════════════════════
// 1. READ — actually reads file content
// ═══════════════════════════════════════════════════════════════

console.log('=== 1. Read: returns real file content ===');
{
  const filePath = path.join(TEMP_DIR, 'read-test.txt');
  const expectedContent = 'line 1: hello world\nline 2: 你好世界\nline 3: special chars <>&"\'\\n\n';
  fs.writeFileSync(filePath, expectedContent, 'utf-8');

  const execMsg = concatBytes(
    encodeUint32Field(1, 1),
    encodeMessageField(7, encodeStringField(1, filePath)),
    encodeStringField(15, 'exec-read-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Read: normalized param is "path" (not "file_path")', () => {
    assert.ok('path' in toolUse.input, `got keys: ${Object.keys(toolUse.input)}`);
    assert.ok(!('file_path' in toolUse.input), 'must not have file_path');
  });

  test('Read: path value correct', () => {
    assert.strictEqual(toolUse.input.path, filePath);
  });

  // Claude Code executes using normalized params
  const actualContent = fs.readFileSync(toolUse.input.path, 'utf-8');

  test('Read: actual file content matches expected', () => {
    assert.strictEqual(actualContent, expectedContent);
  });

  test('Read: multi-byte characters preserved', () => {
    assert.ok(actualContent.includes('你好世界'));
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: actualContent,
  }, { deferResume: true });

  test('Read: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });

  test('Read: protobuf payload is non-empty Buffer', () => {
    assert.ok(session._captured.length >= 1);
    assert.ok(Buffer.isBuffer(session._captured[0]));
    assert.ok(session._captured[0].length > 0);
  });
}

// ═══════════════════════════════════════════════════════════════
// 2. WRITE — actually creates a file on disk
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 2. Write: creates file with correct content ===');
{
  const filePath = path.join(TEMP_DIR, 'write-test.txt');
  const writeContent = 'written by test\nsecond line\nthird line with 中文\n';

  const execMsg = concatBytes(
    encodeUint32Field(1, 2),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, filePath),
      encodeStringField(2, writeContent),
    )),
    encodeStringField(15, 'exec-write-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Write: normalized param is "path" (not "file_path")', () => {
    assert.ok('path' in toolUse.input, `got keys: ${Object.keys(toolUse.input)}`);
    assert.ok(!('file_path' in toolUse.input), 'must not have file_path');
  });

  test('Write: normalized param is "contents" (not "content")', () => {
    assert.ok('contents' in toolUse.input, `got keys: ${Object.keys(toolUse.input)}`);
    assert.ok(!('content' in toolUse.input), 'must not have content (singular)');
  });

  test('Write: path value correct', () => {
    assert.strictEqual(toolUse.input.path, filePath);
  });

  test('Write: contents value correct', () => {
    assert.strictEqual(toolUse.input.contents, writeContent);
  });

  // Claude Code executes using normalized params — THIS is what actually happens
  fs.writeFileSync(toolUse.input.path, toolUse.input.contents, 'utf-8');

  test('Write: file exists on disk', () => {
    assert.ok(fs.existsSync(filePath), `File should exist: ${filePath}`);
  });

  test('Write: file content matches exactly', () => {
    const diskContent = fs.readFileSync(filePath, 'utf-8');
    assert.strictEqual(diskContent, writeContent);
  });

  test('Write: file size correct', () => {
    const stat = fs.statSync(filePath);
    assert.strictEqual(stat.size, Buffer.byteLength(writeContent, 'utf-8'));
  });

  test('Write: multi-byte chars preserved on disk', () => {
    const diskContent = fs.readFileSync(filePath, 'utf-8');
    assert.ok(diskContent.includes('中文'));
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: JSON.stringify({
      path: filePath,
      linesCreated: writeContent.split('\n').length,
      fileSize: Buffer.byteLength(writeContent, 'utf-8'),
    }),
  }, { deferResume: true });

  test('Write: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 3. BASH — actually executes command and returns real stdout
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 3. Bash: executes command with real output ===');
{
  const execMsg = concatBytes(
    encodeUint32Field(1, 3),
    encodeMessageField(2, concatBytes(
      encodeStringField(1, `echo "hello from bash" && ls "${TEMP_DIR}"`),
    )),
    encodeStringField(15, 'exec-shell-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Bash: tool_use has command', () => {
    assert.ok(toolUse.input.command.includes('echo'));
  });

  let stdout, stderr, exitCode;
  try {
    stdout = execSync(toolUse.input.command, { encoding: 'utf-8', timeout: 5000 });
    stderr = '';
    exitCode = 0;
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    exitCode = e.status || 1;
  }

  test('Bash: command exits successfully', () => {
    assert.strictEqual(exitCode, 0);
  });

  test('Bash: stdout contains expected output', () => {
    assert.ok(stdout.includes('hello from bash'), `stdout: ${stdout}`);
  });

  test('Bash: stdout lists files from temp dir', () => {
    assert.ok(stdout.includes('read-test.txt'), `Expected files in stdout: ${stdout}`);
    assert.ok(stdout.includes('write-test.txt'), `Expected files in stdout: ${stdout}`);
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: JSON.stringify({ stdout, stderr, exitCode }),
  }, { deferResume: true });

  test('Bash: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 4. GLOB — actually lists real directory contents
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 4. Glob: lists real directory contents ===');
{
  fs.writeFileSync(path.join(TEMP_DIR, 'glob-a.js'), 'a', 'utf-8');
  fs.writeFileSync(path.join(TEMP_DIR, 'glob-b.js'), 'b', 'utf-8');
  fs.mkdirSync(path.join(TEMP_DIR, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(TEMP_DIR, 'subdir', 'nested.txt'), 'n', 'utf-8');

  const execMsg = concatBytes(
    encodeUint32Field(1, 4),
    encodeMessageField(8, encodeStringField(1, TEMP_DIR)),
    encodeStringField(15, 'exec-ls-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Glob: tool_use name is Glob', () => {
    assert.strictEqual(toolUse.name, 'Glob');
  });

  test('Glob: normalized params are glob_pattern + target_directory', () => {
    assert.ok('glob_pattern' in toolUse.input, `got keys: ${Object.keys(toolUse.input)}`);
    assert.ok('target_directory' in toolUse.input, `got keys: ${Object.keys(toolUse.input)}`);
  });

  test('Glob: target_directory value correct', () => {
    assert.strictEqual(toolUse.input.target_directory, TEMP_DIR);
  });

  // Claude Code uses target_directory to list
  const listDir = toolUse.input.target_directory || toolUse.input.path;
  const entries = fs.readdirSync(listDir);

  test('Glob: found glob-a.js', () => {
    assert.ok(entries.includes('glob-a.js'), `entries: ${entries}`);
  });
  test('Glob: found glob-b.js', () => {
    assert.ok(entries.includes('glob-b.js'), `entries: ${entries}`);
  });
  test('Glob: found subdir', () => {
    assert.ok(entries.includes('subdir'), `entries: ${entries}`);
  });
  test('Glob: found previously written files too', () => {
    assert.ok(entries.includes('read-test.txt'));
    assert.ok(entries.includes('write-test.txt'));
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: entries.join('\n'),
  }, { deferResume: true });

  test('Glob: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 5. GREP — actually finds matching lines in real files
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 5. Grep: finds real matches in files ===');
{
  const grepFile = path.join(TEMP_DIR, 'grep-target.js');
  fs.writeFileSync(grepFile, [
    'const express = require("express");',
    'const app = express();',
    'app.listen(3000);',
    '// TODO: add error handling',
    '// TODO: add logging',
  ].join('\n'), 'utf-8');

  const execMsg = concatBytes(
    encodeUint32Field(1, 5),
    encodeMessageField(5, concatBytes(
      encodeStringField(1, 'TODO'),
      encodeStringField(2, TEMP_DIR),
    )),
    encodeStringField(15, 'exec-grep-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Grep: tool_use name is Grep', () => {
    assert.strictEqual(toolUse.name, 'Grep');
  });
  test('Grep: pattern is TODO', () => {
    assert.strictEqual(toolUse.input.pattern, 'TODO');
  });
  test('Grep: path value correct', () => {
    assert.strictEqual(toolUse.input.path, TEMP_DIR);
  });

  let grepOutput;
  try {
    grepOutput = execSync(
      `grep -r "${toolUse.input.pattern}" "${toolUse.input.path}" --include="*.js" -l`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
  } catch (e) {
    grepOutput = e.stdout?.trim() || '';
  }

  test('Grep: found matches in grep-target.js', () => {
    assert.ok(grepOutput.includes('grep-target.js'), `grep output: ${grepOutput}`);
  });

  let lineOutput;
  try {
    lineOutput = execSync(
      `grep -n "TODO" "${grepFile}"`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
  } catch (e) {
    lineOutput = '';
  }

  test('Grep: found exactly 2 TODO lines', () => {
    const lines = lineOutput.split('\n').filter(l => l.trim());
    assert.strictEqual(lines.length, 2, `Expected 2 matches, got: ${lineOutput}`);
  });

  test('Grep: line numbers correct', () => {
    assert.ok(lineOutput.includes('4:'), `line 4: ${lineOutput}`);
    assert.ok(lineOutput.includes('5:'), `line 5: ${lineOutput}`);
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: grepOutput,
  }, { deferResume: true });

  test('Grep: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 6. DELETE — actually removes file from disk (via Bash rm -f)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 6. Delete: file actually removed from disk ===');
{
  const deletePath = path.join(TEMP_DIR, 'to-delete.txt');
  fs.writeFileSync(deletePath, 'this file will be deleted', 'utf-8');

  test('Delete: file exists before delete', () => {
    assert.ok(fs.existsSync(deletePath));
  });

  const execMsg = concatBytes(
    encodeUint32Field(1, 6),
    encodeMessageField(4, encodeStringField(1, deletePath)),
    encodeStringField(15, 'exec-delete-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Delete: mapped to Bash', () => {
    assert.strictEqual(toolUse.name, 'Bash');
  });
  test('Delete: command includes rm -f', () => {
    assert.ok(toolUse.input.command.includes('rm -f'));
  });
  test('Delete: command targets correct file', () => {
    assert.ok(toolUse.input.command.includes(deletePath));
  });

  execSync(toolUse.input.command, { encoding: 'utf-8', timeout: 5000 });

  test('Delete: file no longer exists on disk', () => {
    assert.ok(!fs.existsSync(deletePath), `File should be gone: ${deletePath}`);
  });

  const result = await sessionSendToolResult(session, toolUse.id, {
    content: '',
  }, { deferResume: true });

  test('Delete: result sent to Cursor successfully', () => {
    assert.strictEqual(result.sentToCursor, true);
  });
}

// ═══════════════════════════════════════════════════════════════
// 7. STRREPLACE — read + write produces correct file modification
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 7. StrReplace: file actually modified via read+write ===');
{
  const editPath = path.join(TEMP_DIR, 'strreplace-test.js');
  const originalContent = 'const port = 3000;\nconst host = "localhost";\nconsole.log("starting...");\n';
  fs.writeFileSync(editPath, originalContent, 'utf-8');

  // Step 1: read
  const readExec = concatBytes(
    encodeUint32Field(1, 70),
    encodeMessageField(7, encodeStringField(1, editPath)),
    encodeStringField(15, 'exec-strreplace-read'),
  );
  const session1 = makeSession();
  const readToolUse = fullPipelineToolUse(readExec, session1);

  const readContent = fs.readFileSync(readToolUse.input.path, 'utf-8');

  test('StrReplace step1: read returns original content', () => {
    assert.strictEqual(readContent, originalContent);
  });

  // Step 2: model modifies content, Cursor sends write exec
  const modifiedContent = readContent.replace('3000', '8080');
  const writeExec = concatBytes(
    encodeUint32Field(1, 71),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, editPath),
      encodeStringField(2, modifiedContent),
    )),
    encodeStringField(15, 'exec-strreplace-write'),
  );
  const session2 = makeSession();
  const writeToolUse = fullPipelineToolUse(writeExec, session2);

  test('StrReplace step2: write path correct', () => {
    assert.strictEqual(writeToolUse.input.path, editPath);
  });

  test('StrReplace step2: write contents has modified data', () => {
    assert.ok(writeToolUse.input.contents.includes('8080'));
    assert.ok(!writeToolUse.input.contents.includes('3000'));
  });

  // Claude Code executes using normalized params
  fs.writeFileSync(writeToolUse.input.path, writeToolUse.input.contents, 'utf-8');

  test('StrReplace step2: file on disk has modified content', () => {
    const diskContent = fs.readFileSync(editPath, 'utf-8');
    assert.ok(diskContent.includes('8080'), 'should contain 8080');
    assert.ok(!diskContent.includes('3000'), 'should not contain 3000');
  });

  test('StrReplace: only the target string changed', () => {
    const diskContent = fs.readFileSync(editPath, 'utf-8');
    assert.ok(diskContent.includes('const host = "localhost"'), 'host line unchanged');
    assert.ok(diskContent.includes('console.log("starting...")'), 'log line unchanged');
  });

  test('StrReplace: line count preserved', () => {
    const diskContent = fs.readFileSync(editPath, 'utf-8');
    assert.strictEqual(diskContent.split('\n').length, originalContent.split('\n').length);
  });
}

// ═══════════════════════════════════════════════════════════════
// 8. Overwrite existing file
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 8. Write overwrite: replaces existing file ===');
{
  const overwritePath = path.join(TEMP_DIR, 'overwrite-test.txt');
  fs.writeFileSync(overwritePath, 'original content', 'utf-8');

  const newContent = 'completely new content\nwith more lines\n';
  const execMsg = concatBytes(
    encodeUint32Field(1, 8),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, overwritePath),
      encodeStringField(2, newContent),
    )),
    encodeStringField(15, 'exec-overwrite-1'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  // Use normalized params
  fs.writeFileSync(toolUse.input.path, toolUse.input.contents, 'utf-8');

  test('Overwrite: old content gone', () => {
    const disk = fs.readFileSync(overwritePath, 'utf-8');
    assert.ok(!disk.includes('original content'));
  });

  test('Overwrite: new content present', () => {
    const disk = fs.readFileSync(overwritePath, 'utf-8');
    assert.strictEqual(disk, newContent);
  });
}

// ═══════════════════════════════════════════════════════════════
// 9. Write new file in subdirectory
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 9. Write to subdirectory: creates nested path ===');
{
  const nestedDir = path.join(TEMP_DIR, 'deep', 'nested');
  const nestedPath = path.join(nestedDir, 'file.txt');
  const nestedContent = 'deeply nested content\n';

  const execMsg = concatBytes(
    encodeUint32Field(1, 9),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, nestedPath),
      encodeStringField(2, nestedContent),
    )),
    encodeStringField(15, 'exec-nested-write'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Nested write: normalized path correct', () => {
    assert.strictEqual(toolUse.input.path, nestedPath);
  });

  test('Nested write: normalized contents correct', () => {
    assert.strictEqual(toolUse.input.contents, nestedContent);
  });

  fs.mkdirSync(path.dirname(toolUse.input.path), { recursive: true });
  fs.writeFileSync(toolUse.input.path, toolUse.input.contents, 'utf-8');

  test('Nested write: file exists', () => {
    assert.ok(fs.existsSync(nestedPath));
  });

  test('Nested write: content correct', () => {
    assert.strictEqual(fs.readFileSync(nestedPath, 'utf-8'), nestedContent);
  });
}

// ═══════════════════════════════════════════════════════════════
// 10. Read with offset/limit — partial read
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 10. Read with offset/limit ===');
{
  const bigFile = path.join(TEMP_DIR, 'big-file.txt');
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}: content`);
  fs.writeFileSync(bigFile, lines.join('\n') + '\n', 'utf-8');

  // Use mapAgentChunkToToolUse with a manual exec request (has startLine/endLine)
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'read', id: 10, execId: 'e-partial', path: bigFile, startLine: 10, endLine: 15 },
  };
  const toolUse = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });

  test('Partial read: uses "path" (normalized)', () => {
    assert.strictEqual(toolUse.input.path, bigFile);
    assert.ok(!('file_path' in toolUse.input));
  });

  test('Partial read: offset set', () => {
    assert.strictEqual(toolUse.input.offset, 10);
  });

  test('Partial read: limit set', () => {
    assert.strictEqual(toolUse.input.limit, 6);
  });

  const allLines = fs.readFileSync(toolUse.input.path, 'utf-8').split('\n');
  const slice = allLines.slice(toolUse.input.offset - 1, toolUse.input.offset - 1 + toolUse.input.limit);

  test('Partial read: returns correct line range', () => {
    assert.ok(slice[0].includes('line 10'), `first line: ${slice[0]}`);
    assert.ok(slice[5].includes('line 15'), `last line: ${slice[5]}`);
    assert.strictEqual(slice.length, 6);
  });
}

// ═══════════════════════════════════════════════════════════════
// 11. Write empty file — edge case
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 11. Write empty file ===');
{
  const emptyPath = path.join(TEMP_DIR, 'empty.txt');
  const execMsg = concatBytes(
    encodeUint32Field(1, 11),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, emptyPath),
      encodeStringField(2, ''),
    )),
    encodeStringField(15, 'exec-empty-write'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Empty write: contents is empty string, not undefined', () => {
    assert.strictEqual(toolUse.input.contents, '');
    assert.notStrictEqual(toolUse.input.contents, undefined);
  });

  fs.writeFileSync(toolUse.input.path, toolUse.input.contents, 'utf-8');

  test('Empty write: file exists with 0 bytes', () => {
    assert.ok(fs.existsSync(emptyPath));
    assert.strictEqual(fs.statSync(emptyPath).size, 0);
  });
}

// ═══════════════════════════════════════════════════════════════
// 12. Write large content — no truncation
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 12. Write large content: no truncation ===');
{
  const largePath = path.join(TEMP_DIR, 'large.txt');
  const largeContent = 'x'.repeat(100000) + '\n中文尾部\n';
  const execMsg = concatBytes(
    encodeUint32Field(1, 12),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, largePath),
      encodeStringField(2, largeContent),
    )),
    encodeStringField(15, 'exec-large-write'),
  );
  const session = makeSession();
  const toolUse = fullPipelineToolUse(execMsg, session);

  test('Large write: contents length preserved', () => {
    assert.strictEqual(toolUse.input.contents.length, largeContent.length);
  });

  fs.writeFileSync(toolUse.input.path, toolUse.input.contents, 'utf-8');

  test('Large write: disk content matches exactly', () => {
    const disk = fs.readFileSync(largePath, 'utf-8');
    assert.strictEqual(disk, largeContent);
  });

  test('Large write: file size correct', () => {
    const stat = fs.statSync(largePath);
    assert.strictEqual(stat.size, Buffer.byteLength(largeContent, 'utf-8'));
  });
}

// ═══════════════════════════════════════════════════════════════
// 13. Edit (KV) → StrReplace: actually modifies file via old_string/new_string
// ═══════════════════════════════════════════════════════════════

console.log('\n=== 13. Edit KV → StrReplace: real file modification ===');
{
  const editPath = path.join(TEMP_DIR, 'edit-kv-test.py');
  const originalContent = 'from tools.handler import (\n    build_tool_instruction,\n    normalize_openai_tools,\n    try_parse_tool_call_json,\n)\nfrom routes import get_json_body\n';
  fs.writeFileSync(editPath, originalContent, 'utf-8');

  const oldStr = 'from tools.handler import (\n    build_tool_instruction,\n    normalize_openai_tools,\n    try_parse_tool_call_json,\n)';
  const newStr = 'from tools.handler import (\n    normalize_openai_tools,\n    try_parse_tool_call_json,\n)\nfrom routes.helpers import inject_tool_instruction';

  // Simulate KV tool call from Cursor: Edit with old_string/new_string
  const { adaptKvToolUseToIde } = require('../../src/utils/kvToolAdapter');
  const kvToolUse = {
    id: 'toolu_bdrk_edit_kv',
    name: 'Edit',
    input: { file_path: editPath, old_string: oldStr, new_string: newStr },
  };

  const normalized = adaptKvToolUseToIde(kvToolUse, CLAUDE_CODE_TOOLS);

  test('Edit KV: mapped to StrReplace', () => {
    assert.strictEqual(normalized.name, 'StrReplace');
  });

  test('Edit KV: path normalized correctly', () => {
    assert.strictEqual(normalized.input.path, editPath);
    assert.ok(!('file_path' in normalized.input));
  });

  test('Edit KV: old_string preserved', () => {
    assert.strictEqual(normalized.input.old_string, oldStr);
  });

  test('Edit KV: new_string preserved', () => {
    assert.strictEqual(normalized.input.new_string, newStr);
  });

  // Claude Code executes StrReplace using normalized params
  const fileContent = fs.readFileSync(normalized.input.path, 'utf-8');
  const modifiedContent = fileContent.replace(normalized.input.old_string, normalized.input.new_string);
  fs.writeFileSync(normalized.input.path, modifiedContent, 'utf-8');

  test('Edit KV: file modified on disk', () => {
    const disk = fs.readFileSync(editPath, 'utf-8');
    assert.ok(!disk.includes('build_tool_instruction'), 'old import removed');
    assert.ok(disk.includes('inject_tool_instruction'), 'new import added');
  });

  test('Edit KV: unchanged parts preserved', () => {
    const disk = fs.readFileSync(editPath, 'utf-8');
    assert.ok(disk.includes('normalize_openai_tools'), 'other import still present');
    assert.ok(disk.includes('from routes import get_json_body'), 'unrelated line preserved');
  });

  test('Edit KV: contents value is NOT empty or undefined', () => {
    // This was the original bug: contents was undefined because Edit mapped to Write
    assert.ok(!('contents' in normalized.input) || normalized.input.contents !== undefined,
      'must not have empty contents from wrong mapping');
    assert.ok(!('content' in normalized.input), 'must not have content key');
  });
}

// ═══════════════════════════════════════════════════════════════
// Cleanup
// ═══════════════════════════════════════════════════════════════

console.log('\n=== Cleanup ===');
cleanup();
test('Temp directory removed', () => {
  assert.ok(!fs.existsSync(TEMP_DIR), `Temp dir should be gone: ${TEMP_DIR}`);
});

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'ALL PASS ✅' : 'SOME FAILED ❌');
process.exit(failed > 0 ? 1 : 0);

})().catch(err => { console.error('Fatal:', err); process.exit(1); });
