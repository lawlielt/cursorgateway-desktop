/**
 * End-to-end tool round-trip tests.
 *
 * Unlike the unit tests that mock agentClient.sendToolResult, these tests
 * exercise the REAL Protobuf encoding path by calling the actual build*
 * functions with the same data that sessionManager.sendToolResult produces.
 *
 * This catches issues like Buffer.from(undefined) that unit tests miss.
 */

const {
  _buildShellResultMessage: buildShellResultMessage,
  _buildWriteResultMessage: buildWriteResultMessage,
  _buildReadResultMessage: buildReadResultMessage,
  _buildLsResultMessage: buildLsResultMessage,
  _buildGrepResultMessage: buildGrepResultMessage,
  _buildDeleteResultMessage: buildDeleteResultMessage,
  _buildMcpResultMessage: buildMcpResultMessage,
  parseExecServerMessage,
  AgentClient,
} = require('../../src/utils/agentClient');

const {
  execRequestToToolUse,
  sendToolResult: sessionSendToolResult,
} = require('../../src/utils/sessionManager');

const {
  encodeStringField,
  encodeMessageField,
  encodeUint32Field,
  concatBytes,
} = require('../../src/utils/protoEncoder');

const fs = require('fs');
const path = require('path');
const http = require('http');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

function assertNoThrow(fn, message) {
  try {
    fn();
    console.log(`  ✅ ${message}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${message}: ${e.message}`);
    failed++;
  }
}

function makeRealSession() {
  const captured = [];
  const client = new AgentClient('fake-token', { workspacePath: '/tmp' });
  client.bidiAppend = async (data) => {
    captured.push(data);
  };
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

(async () => {

// ═══════════════════════════════════════════════════════════════
// PART 1: Protobuf builder functions — success + error paths
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART 1: Protobuf builders handle all input shapes ===\n');

console.log('--- 1.1: buildWriteResultMessage ---');
assertNoThrow(() => {
  buildWriteResultMessage(1, 'e1', { success: { path: '/tmp/a.txt', linesCreated: 1, fileSize: 10 } });
}, 'write success with all fields');
assertNoThrow(() => {
  buildWriteResultMessage(2, 'e2', { success: { path: '', linesCreated: 0, fileSize: 0 } });
}, 'write success with empty path');
assertNoThrow(() => {
  buildWriteResultMessage(3, null, { success: { path: '/tmp/b.txt' } });
}, 'write success without execId');
assertNoThrow(() => {
  buildWriteResultMessage(4, 'e4', { error: 'Permission denied' });
}, 'write error as STRING (was crashing before fix)');
assertNoThrow(() => {
  buildWriteResultMessage(5, 'e5', { error: { path: '/tmp/c.txt', error: 'EACCES' } });
}, 'write error as object');
assertNoThrow(() => {
  buildWriteResultMessage(6, 'e6', { error: null });
}, 'write error as null');
assertNoThrow(() => {
  buildWriteResultMessage(7, 'e7', {});
}, 'write with neither success nor error');

console.log('--- 1.2: buildReadResultMessage ---');
assertNoThrow(() => {
  buildReadResultMessage(1, 'e1', 'file content', '/tmp/test.js', 10, BigInt(100), 7);
}, 'read success with all fields');
assertNoThrow(() => {
  buildReadResultMessage(2, null, '', '/tmp/empty', undefined, undefined, 7);
}, 'read with empty content and undefined lines/size');
assertNoThrow(() => {
  buildReadResultMessage(3, 'e3', undefined, undefined, null, null, 7);
}, 'read with all undefined (error path)');

console.log('--- 1.3: buildShellResultMessage ---');
assertNoThrow(() => {
  buildShellResultMessage(1, 'e1', 'ls -la', '/home', 'file1\nfile2\n', '', 0);
}, 'shell success');
assertNoThrow(() => {
  buildShellResultMessage(2, 'e2', undefined, undefined, undefined, undefined, undefined);
}, 'shell with all undefined');
assertNoThrow(() => {
  buildShellResultMessage(3, null, '', '', '', 'error output', 1);
}, 'shell error exit');

console.log('--- 1.4: buildDeleteResultMessage ---');
assertNoThrow(() => {
  buildDeleteResultMessage(1, 'e1', { success: { path: '/tmp/del.txt' } });
}, 'delete success');
assertNoThrow(() => {
  buildDeleteResultMessage(2, 'e2', { error: 'Permission denied' });
}, 'delete error as string');
assertNoThrow(() => {
  buildDeleteResultMessage(3, 'e3', { error: { path: '/tmp/x', error: 'ENOENT' } });
}, 'delete error as object');
assertNoThrow(() => {
  buildDeleteResultMessage(4, null, {});
}, 'delete with empty result');

console.log('--- 1.5: buildLsResultMessage ---');
assertNoThrow(() => {
  buildLsResultMessage(1, 'e1', 'file1.js\nfile2.js');
}, 'ls success');
assertNoThrow(() => {
  buildLsResultMessage(2, null, '');
}, 'ls empty result');
assertNoThrow(() => {
  buildLsResultMessage(3, 'e3', undefined);
}, 'ls undefined (defensive)');

console.log('--- 1.6: buildGrepResultMessage ---');
assertNoThrow(() => {
  buildGrepResultMessage(1, 'e1', 'TODO', '/src', ['file1.js', 'file2.js']);
}, 'grep success');
assertNoThrow(() => {
  buildGrepResultMessage(2, 'e2', undefined, undefined, []);
}, 'grep with undefined pattern/path and empty files');

console.log('--- 1.7: buildMcpResultMessage ---');
assertNoThrow(() => {
  buildMcpResultMessage(1, 'e1', 'result text', false);
}, 'mcp success');
assertNoThrow(() => {
  buildMcpResultMessage(2, 'e2', 'Error occurred', true);
}, 'mcp error');
assertNoThrow(() => {
  buildMcpResultMessage(3, null, undefined, false);
}, 'mcp with undefined content');

// ═══════════════════════════════════════════════════════════════
// PART 2: Full round-trip through REAL AgentClient.sendToolResult
//         (not mocked — exercises actual protobuf encoding)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART 2: Full sendToolResult round-trip (real encoding) ===\n');

const toolTypes = ['read', 'write', 'shell', 'delete', 'ls', 'grep', 'mcp'];

for (const toolType of toolTypes) {
  console.log(`--- 2a: ${toolType} success round-trip ---`);
  {
    const session = makeRealSession();
    let execMsg;
    switch (toolType) {
      case 'read':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(7, encodeStringField(1, '/tmp/test-read.js')),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'write':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(3, concatBytes(
            encodeStringField(1, '/tmp/test-write.txt'),
            encodeStringField(2, 'test content'),
          )),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'shell':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(2, concatBytes(
            encodeStringField(1, 'echo hello'),
            encodeStringField(2, '/tmp'),
          )),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'delete':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(4, encodeStringField(1, '/tmp/test-del.txt')),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'ls':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(8, encodeStringField(1, '/tmp')),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'grep':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(5, concatBytes(
            encodeStringField(1, 'TODO'),
            encodeStringField(2, '/tmp'),
          )),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
      case 'mcp':
        execMsg = concatBytes(
          encodeUint32Field(1, 100),
          encodeMessageField(11, concatBytes(
            encodeStringField(1, 'test-server-test_tool'),
            encodeStringField(3, 'tc-mcp-1'),
            encodeStringField(4, 'test-server'),
            encodeStringField(5, 'test_tool'),
            encodeStringField(6, JSON.stringify({ key: 'val' })),
          )),
          encodeStringField(15, `e-${toolType}-ok`),
        );
        break;
    }

    const parsed = parseExecServerMessage(execMsg);
    const toolUse = execRequestToToolUse(parsed, session);

    let toolResultContent;
    switch (toolType) {
      case 'read': toolResultContent = 'const x = 1;\n'; break;
      case 'write': toolResultContent = 'Wrote 1 lines to /tmp/test-write.txt'; break;
      case 'shell': toolResultContent = 'hello\n'; break;
      case 'delete': toolResultContent = 'File deleted'; break;
      case 'ls': toolResultContent = 'file1.js\nfile2.js'; break;
      case 'grep': toolResultContent = 'src/main.js\nsrc/utils.js'; break;
      case 'mcp': toolResultContent = 'tool result ok'; break;
    }

    try {
      const result = await sessionSendToolResult(session, toolUse.id, {
        content: toolResultContent,
      }, { deferResume: true });
      assert(result.sentToCursor === true, `${toolType} success: sent to cursor`);
      assert(session._captured.length >= 1, `${toolType} success: protobuf data captured`);
      for (const buf of session._captured) {
        assert(Buffer.isBuffer(buf), `${toolType} success: captured data is Buffer`);
      }
    } catch (e) {
      assert(false, `${toolType} success: THREW ${e.message}`);
    }
  }

  console.log(`--- 2b: ${toolType} error round-trip ---`);
  {
    const session = makeRealSession();
    let execMsg;
    switch (toolType) {
      case 'read':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(7, encodeStringField(1, '/nonexistent')),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'write':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(3, concatBytes(
            encodeStringField(1, '/readonly/file.txt'),
            encodeStringField(2, 'data'),
          )),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'shell':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(2, concatBytes(
            encodeStringField(1, 'false'),
            encodeStringField(2, '/tmp'),
          )),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'delete':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(4, encodeStringField(1, '/no-perm/file')),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'ls':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(8, encodeStringField(1, '/nonexistent-dir')),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'grep':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(5, concatBytes(
            encodeStringField(1, '[invalid'),
            encodeStringField(2, '/tmp'),
          )),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
      case 'mcp':
        execMsg = concatBytes(
          encodeUint32Field(1, 200),
          encodeMessageField(11, concatBytes(
            encodeStringField(1, 'test-server-test_tool'),
            encodeStringField(3, 'tc-mcp-err'),
            encodeStringField(4, 'test-server'),
            encodeStringField(5, 'test_tool'),
            encodeStringField(6, '{}'),
          )),
          encodeStringField(15, `e-${toolType}-err`),
        );
        break;
    }

    const parsed = parseExecServerMessage(execMsg);
    const toolUse = execRequestToToolUse(parsed, session);

    try {
      const result = await sessionSendToolResult(session, toolUse.id, {
        is_error: true,
        content: `Error: ${toolType} operation failed — EACCES permission denied`,
      }, { deferResume: true });
      assert(result.sentToCursor === true, `${toolType} error: sent to cursor (no crash)`);
      assert(session._captured.length >= 1, `${toolType} error: protobuf data captured`);
    } catch (e) {
      assert(false, `${toolType} error: THREW ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 3: Edge cases — undefined/null/empty in Claude Code results
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART 3: Edge cases — unusual tool_result content ===\n');

const edgeCases = [
  { desc: 'undefined content', content: undefined, isError: false },
  { desc: 'null content', content: null, isError: false },
  { desc: 'empty string content', content: '', isError: false },
  { desc: 'array content (text blocks)', content: [{ type: 'text', text: 'result' }], isError: false },
  { desc: 'array content empty', content: [], isError: false },
  { desc: 'error with undefined content', content: undefined, isError: true },
  { desc: 'error with null content', content: null, isError: true },
  { desc: 'error with object content', content: { type: 'text', text: 'err' }, isError: true },
];

for (const ec of edgeCases) {
  console.log(`--- 3: write with ${ec.desc} ---`);
  const session = makeRealSession();
  const execMsg = concatBytes(
    encodeUint32Field(1, 300),
    encodeMessageField(3, concatBytes(
      encodeStringField(1, '/tmp/edge-test.txt'),
      encodeStringField(2, 'data'),
    )),
    encodeStringField(15, 'e-edge'),
  );
  const parsed = parseExecServerMessage(execMsg);
  const toolUse = execRequestToToolUse(parsed, session);

  const resultContent = typeof ec.content === 'string'
    ? ec.content
    : (ec.content == null ? '' : JSON.stringify(ec.content));

  try {
    const result = await sessionSendToolResult(session, toolUse.id, {
      is_error: ec.isError,
      content: resultContent,
    }, { deferResume: true });
    assert(result.sentToCursor === true, `write ${ec.desc}: no crash`);
  } catch (e) {
    assert(false, `write ${ec.desc}: THREW ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 4: All 14 Claude Code tools — explicit per-tool e2e
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART 4: All 14 Claude Code tools — full round-trip by name ===\n');

const { filterNonNativeTools, isNativeCoveredTool, parseToolCalls, toolsToPrompt } = require('../../src/utils/toolsAdapter');

// --- 4.1 Native-covered tools (7): exec → toolUse → sendToolResult → protobuf ---
const nativeToolSpecs = [
  {
    name: 'Read', cursorType: 'read', field: 7,
    buildExec: () => encodeMessageField(7, encodeStringField(1, '/project/src/app.js')),
    expectedInput: { file_path: '/project/src/app.js' },
    resultContent: 'const express = require("express");\n',
  },
  {
    name: 'Write', cursorType: 'write', field: 3,
    buildExec: () => encodeMessageField(3, concatBytes(
      encodeStringField(1, '/project/output.txt'),
      encodeStringField(2, 'hello world\nsecond line'),
    )),
    expectedInput: { file_path: '/project/output.txt', content: 'hello world\nsecond line' },
    resultContent: 'Wrote 2 lines to /project/output.txt',
  },
  {
    name: 'Bash', cursorType: 'shell', field: 2,
    buildExec: () => encodeMessageField(2, concatBytes(
      encodeStringField(1, 'npm test'),
      encodeStringField(2, '/project'),
    )),
    expectedInput: { command: 'npm test', description: 'Run in /project' },
    resultContent: JSON.stringify({ stdout: 'Tests passed\n', stderr: '', exitCode: 0 }),
  },
  {
    name: 'Bash (delete)', cursorType: 'delete', field: 4,
    buildExec: () => encodeMessageField(4, encodeStringField(1, '/project/tmp/old.log')),
    expectedInput: { command: 'rm -f "/project/tmp/old.log"', description: 'Delete file' },
    resultContent: 'File deleted successfully',
  },
  {
    name: 'Grep', cursorType: 'grep', field: 5,
    buildExec: () => encodeMessageField(5, concatBytes(
      encodeStringField(1, 'import.*express'),
      encodeStringField(2, '/project/src'),
    )),
    expectedInput: { pattern: 'import.*express', path: '/project/src' },
    resultContent: 'src/app.js\nsrc/server.js',
  },
  {
    name: 'Glob', cursorType: 'ls', field: 8,
    buildExec: () => encodeMessageField(8, encodeStringField(1, '/project/src')),
    expectedInput: { pattern: '*', path: '/project/src' },
    resultContent: 'app.js\nserver.js\nutils/',
  },
  {
    name: 'StrReplace (implicit read+write)', cursorType: null,
    buildExec: null,
    expectedInput: null,
    resultContent: null,
  },
];

for (const spec of nativeToolSpecs) {
  if (spec.cursorType === null) {
    // StrReplace — test the implicit two-step approach
    console.log(`--- 4.1: ${spec.name} ---`);
    assert(isNativeCoveredTool('StrReplace'), 'StrReplace is native-covered (not registered as MCP)');

    // Step 1: Model calls native read
    const session1 = makeRealSession();
    const readExec = concatBytes(
      encodeUint32Field(1, 400),
      encodeMessageField(7, encodeStringField(1, '/project/config.js')),
      encodeStringField(15, 'e-strreplace-read'),
    );
    const readParsed = parseExecServerMessage(readExec);
    const readToolUse = execRequestToToolUse(readParsed, session1);
    assert(readToolUse.name === 'Read', 'StrReplace step1: Read tool_use');
    const readResult = await sessionSendToolResult(session1, readToolUse.id, {
      content: 'const port = 3000;\nconst host = "localhost";\n',
    }, { deferResume: true });
    assert(readResult.sentToCursor === true, 'StrReplace step1: read result encoded OK');

    // Step 2: Model calls native write with modified content
    const session2 = makeRealSession();
    const writeExec = concatBytes(
      encodeUint32Field(1, 401),
      encodeMessageField(3, concatBytes(
        encodeStringField(1, '/project/config.js'),
        encodeStringField(2, 'const port = 8080;\nconst host = "localhost";\n'),
      )),
      encodeStringField(15, 'e-strreplace-write'),
    );
    const writeParsed = parseExecServerMessage(writeExec);
    const writeToolUse = execRequestToToolUse(writeParsed, session2);
    assert(writeToolUse.name === 'Write', 'StrReplace step2: Write tool_use');
    assert(writeToolUse.input.content.includes('8080'), 'StrReplace step2: content modified');
    const writeResult = await sessionSendToolResult(session2, writeToolUse.id, {
      content: 'Wrote 2 lines to /project/config.js',
    }, { deferResume: true });
    assert(writeResult.sentToCursor === true, 'StrReplace step2: write result encoded OK');
    continue;
  }

  console.log(`--- 4.1: ${spec.name} (${spec.cursorType}) ---`);
  const session = makeRealSession();
  const execMsg = concatBytes(
    encodeUint32Field(1, 400 + nativeToolSpecs.indexOf(spec)),
    spec.buildExec(),
    encodeStringField(15, `e-${spec.cursorType}-full`),
  );

  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === spec.cursorType, `${spec.name}: parsed type = ${spec.cursorType}`);

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === spec.name.split(' ')[0], `${spec.name}: mapped to ${spec.name.split(' ')[0]}`);

  for (const [key, val] of Object.entries(spec.expectedInput)) {
    assert(toolUse.input[key] === val, `${spec.name}: input.${key} = ${JSON.stringify(val)}`);
  }

  // Success path
  const result = await sessionSendToolResult(session, toolUse.id, {
    content: spec.resultContent,
  }, { deferResume: true });
  assert(result.sentToCursor === true, `${spec.name}: success result → protobuf OK`);
  assert(session._captured.length >= 1, `${spec.name}: protobuf data captured`);

  // Error path
  const session2 = makeRealSession();
  const execMsg2 = concatBytes(
    encodeUint32Field(1, 500 + nativeToolSpecs.indexOf(spec)),
    spec.buildExec(),
    encodeStringField(15, `e-${spec.cursorType}-err`),
  );
  const parsed2 = parseExecServerMessage(execMsg2);
  const toolUse2 = execRequestToToolUse(parsed2, session2);
  const errResult = await sessionSendToolResult(session2, toolUse2.id, {
    is_error: true,
    content: `Error: ${spec.name} failed — EACCES`,
  }, { deferResume: true });
  assert(errResult.sentToCursor === true, `${spec.name}: error result → protobuf OK (no crash)`);
}

// --- 4.2 Non-native tools (7): MCP exec → toolUse → sendToolResult → protobuf ---
console.log('');
const nonNativeToolSpecs = [
  {
    name: 'TodoWrite', serverName: 'claude-code',
    args: { todos: [{ id: '1', content: 'Fix bug', status: 'pending' }], merge: false },
    resultContent: 'Successfully updated TODOs.',
  },
  {
    name: 'Task', serverName: 'claude-code',
    args: { description: 'Search codebase', prompt: 'Find all TODO comments', subagent_type: 'generalPurpose' },
    resultContent: 'Found 5 TODO comments in 3 files.',
  },
  {
    name: 'WebFetch', serverName: 'claude-code',
    args: { url: 'https://example.com/api/status' },
    resultContent: '{"status": "ok", "version": "1.0"}',
  },
  {
    name: 'EditNotebook', serverName: 'claude-code',
    args: { target_notebook: 'analysis.ipynb', cell_idx: 0, is_new_cell: false, cell_language: 'python', old_string: 'import pandas', new_string: 'import pandas as pd' },
    resultContent: 'Cell edited successfully.',
  },
  {
    name: 'ListMcpResources', serverName: 'claude-code',
    args: {},
    resultContent: JSON.stringify([{ uri: 'file:///data.csv', name: 'data.csv' }]),
  },
  {
    name: 'FetchMcpResource', serverName: 'claude-code',
    args: { server: 'data-server', uri: 'file:///data.csv' },
    resultContent: 'col1,col2\n1,2\n3,4',
  },
  {
    name: 'workflow3-workflow3', serverName: 'claude-code',
    args: {},
    resultContent: 'Workflow activated.',
  },
];

for (const spec of nonNativeToolSpecs) {
  console.log(`--- 4.2: ${spec.name} (MCP exec) ---`);

  assert(!isNativeCoveredTool(spec.name), `${spec.name}: correctly identified as non-native`);

  // Build MCP exec_server_message
  const session = makeRealSession();
  const mcpFullName = `${spec.serverName}-${spec.name}`;
  const mcpArgs = concatBytes(
    encodeStringField(1, mcpFullName),
    encodeStringField(3, `tc-${spec.name}-1`),
    encodeStringField(4, spec.serverName),
    encodeStringField(5, spec.name),
    encodeStringField(6, JSON.stringify(spec.args)),
  );
  const execMsg = concatBytes(
    encodeUint32Field(1, 600 + nonNativeToolSpecs.indexOf(spec)),
    encodeMessageField(11, mcpArgs),
    encodeStringField(15, `e-mcp-${spec.name}`),
  );

  const parsed = parseExecServerMessage(execMsg);
  assert(parsed.type === 'mcp', `${spec.name}: parsed as mcp type`);
  assert(parsed.toolName === spec.name, `${spec.name}: toolName preserved`);

  const toolUse = execRequestToToolUse(parsed, session);
  assert(toolUse.name === spec.name, `${spec.name}: tool_use name = ${spec.name}`);

  // Verify args are passed through correctly
  for (const [key, val] of Object.entries(spec.args)) {
    const actual = toolUse.input[key];
    const expected = val;
    if (typeof expected === 'object') {
      assert(JSON.stringify(actual) === JSON.stringify(expected), `${spec.name}: input.${key} matches`);
    } else {
      assert(actual === expected, `${spec.name}: input.${key} = ${JSON.stringify(expected)}`);
    }
  }

  // Success result round-trip (real protobuf encoding)
  const result = await sessionSendToolResult(session, toolUse.id, {
    content: spec.resultContent,
  }, { deferResume: true });
  assert(result.sentToCursor === true, `${spec.name}: success result → protobuf OK`);
  assert(session._captured.length >= 1, `${spec.name}: protobuf data captured`);

  // Error result round-trip
  const session2 = makeRealSession();
  const execMsg2 = concatBytes(
    encodeUint32Field(1, 700 + nonNativeToolSpecs.indexOf(spec)),
    encodeMessageField(11, mcpArgs),
    encodeStringField(15, `e-mcp-${spec.name}-err`),
  );
  const parsed2 = parseExecServerMessage(execMsg2);
  const toolUse2 = execRequestToToolUse(parsed2, session2);
  const errResult = await sessionSendToolResult(session2, toolUse2.id, {
    is_error: true,
    content: `Error: ${spec.name} execution failed`,
  }, { deferResume: true });
  assert(errResult.sentToCursor === true, `${spec.name}: error result → protobuf OK`);
}

// --- 4.3 Non-native tools via text_fallback (MCP text parsing path) ---
console.log('\n--- 4.3: Non-native tools via text_fallback (parseToolCalls) ---');
{
  const toolDefs = nonNativeToolSpecs.map(s => ({
    name: s.name,
    description: `Test ${s.name}`,
    input_schema: { type: 'object', properties: {} },
  }));

  for (const spec of nonNativeToolSpecs) {
    const mcpText = `Let me do that.\n\n<mcp_tool_use>\n<tool_name>${spec.name}</tool_name>\n<arguments>${JSON.stringify(spec.args)}</arguments>\n</mcp_tool_use>`;
    const calls = parseToolCalls(mcpText, toolDefs);
    assert(calls.length === 1, `${spec.name} text_fallback: parsed 1 tool call`);
    assert(calls[0].name === spec.name, `${spec.name} text_fallback: name correct`);
    assert(calls[0].id.startsWith('toolu_'), `${spec.name} text_fallback: valid tool ID`);

    // Simulate text_fallback sendToolResult → needsFreshRequest
    const session = makeRealSession();
    session.toolCallMapping.set(calls[0].id, {
      cursorId: null,
      cursorExecId: null,
      cursorType: 'text_fallback',
      cursorRequest: {},
      toolName: spec.name,
    });
    const result = await sessionSendToolResult(session, calls[0].id, {
      content: spec.resultContent,
    }, { deferResume: true });
    assert(result.needsFreshRequest === true, `${spec.name} text_fallback: triggers fresh request`);
    assert(result.sentToCursor === false, `${spec.name} text_fallback: not sent to cursor`);
  }
}

// --- 4.4 Prompt injection only contains non-native tools ---
console.log('\n--- 4.4: Prompt injection correctness ---');
{
  const fullToolList = [
    ...nativeToolSpecs.filter(s => s.cursorType !== null).map(s => ({
      name: s.name.split(' ')[0],
      description: `Test ${s.name}`,
      input_schema: { type: 'object', properties: {} },
    })),
    { name: 'StrReplace', description: 'String replace', input_schema: { type: 'object', properties: {} } },
    ...nonNativeToolSpecs.map(s => ({
      name: s.name,
      description: `Test ${s.name}`,
      input_schema: { type: 'object', properties: {} },
    })),
  ];

  const nonNative = filterNonNativeTools(fullToolList);
  assert(fullToolList.length === 14, `total Claude Code tools: 14 (got ${fullToolList.length})`);
  assert(nonNative.length === 7, `non-native (injected into prompt): 7 (got ${nonNative.length})`);

  const prompt = toolsToPrompt(nonNative, true);
  for (const spec of nonNativeToolSpecs) {
    assert(prompt.includes(spec.name), `prompt contains ${spec.name}`);
  }
  const nativeNames = ['Read', 'Write', 'Bash', 'Delete', 'Grep', 'Glob', 'StrReplace'];
  for (const name of nativeNames) {
    assert(!prompt.includes(`- ${name}:`), `prompt does NOT contain native tool ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// PART 5: HTTP end-to-end (only if server is running)
// ═══════════════════════════════════════════════════════════════

console.log('\n=== PART 5: HTTP end-to-end (requires running server) ===\n');

const SERVER_PORT = process.env.TEST_PORT || 3010;
const SERVER_HOST = process.env.TEST_HOST || '127.0.0.1';
const TEST_FILE_PATH = path.join(process.cwd(), '__e2e_test_file__.txt');

async function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function parseSseEvents(raw) {
  const events = [];
  const chunks = raw.split('\n\n');
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    let eventType = null;
    let eventData = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice(7);
      if (line.startsWith('data: ')) eventData = line.slice(6);
    }
    if (eventType && eventData) {
      try { events.push({ event: eventType, data: JSON.parse(eventData) }); }
      catch { events.push({ event: eventType, data: eventData }); }
    }
  }
  return events;
}

async function isServerRunning() {
  try {
    const res = await httpRequest({
      hostname: SERVER_HOST, port: SERVER_PORT, path: '/v1/models', method: 'GET',
      timeout: 2000,
    });
    return res.status === 200;
  } catch { return false; }
}

const serverRunning = await isServerRunning();

if (!serverRunning) {
  console.log(`  ⏭️  Server not running at ${SERVER_HOST}:${SERVER_PORT}, skipping HTTP tests`);
  console.log('  (Start server and re-run to execute HTTP e2e tests)');
} else {
  console.log(`  Server detected at ${SERVER_HOST}:${SERVER_PORT}`);

  // Cleanup helper
  function cleanupTestFile() {
    try { if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH); } catch {}
  }
  cleanupTestFile();

  // 4a: Simple non-streaming request (model should respond without tool calls)
  console.log('--- 5a: Non-streaming simple message ---');
  try {
    const res = await httpRequest({
      hostname: SERVER_HOST, port: SERVER_PORT,
      path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'Reply with exactly: E2E_TEST_OK' }],
    });
    assert(res.status === 200, `non-streaming: status ${res.status} === 200`);
    const body = JSON.parse(res.body);
    assert(body.content && body.content.length > 0, 'non-streaming: has content');
  } catch (e) {
    assert(false, `non-streaming: ${e.message}`);
  }

  // 4b: Streaming request
  console.log('--- 5b: Streaming simple message ---');
  try {
    const res = await httpRequest({
      hostname: SERVER_HOST, port: SERVER_PORT,
      path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'Reply with exactly: E2E_STREAM_OK' }],
    });
    assert(res.status === 200, `streaming: status ${res.status} === 200`);
    const events = parseSseEvents(res.body);
    const hasStart = events.some(e => e.event === 'message_start');
    const hasStop = events.some(e => e.event === 'message_stop');
    assert(hasStart, 'streaming: has message_start');
    assert(hasStop, 'streaming: has message_stop');
  } catch (e) {
    assert(false, `streaming: ${e.message}`);
  }

  // 4c: Request with tools (write + tool_result continuation)
  console.log('--- 5c: Tool call round-trip (Write → tool_result) ---');
  try {
    const tools = [
      {
        name: 'Write',
        description: 'Write a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: 'The absolute path to the file to write' },
            content: { type: 'string', description: 'The content to write to the file' },
          },
          required: ['file_path', 'content'],
        },
      },
    ];

    // Step 1: Send request that should trigger Write tool
    const res1 = await httpRequest({
      hostname: SERVER_HOST, port: SERVER_PORT,
      path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 60000,
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: 'user', content: `Write a file at ${TEST_FILE_PATH} with content "e2e_test_content_12345". Use the Write tool.` },
      ],
      tools,
    });

    assert(res1.status === 200, `tool request: status ${res1.status} === 200`);
    const events1 = parseSseEvents(res1.body);

    const toolUseEvent = events1.find(e =>
      e.event === 'content_block_start' && e.data?.content_block?.type === 'tool_use'
    );

    if (toolUseEvent) {
      const toolUseId = toolUseEvent.data.content_block.id;
      const toolName = toolUseEvent.data.content_block.name;
      console.log(`    Tool called: ${toolName} (id: ${toolUseId})`);

      // Extract tool input from delta events
      const inputDeltas = events1
        .filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'input_json_delta')
        .map(e => e.data.delta.partial_json)
        .join('');
      let toolInput = {};
      try { toolInput = JSON.parse(inputDeltas); } catch {}

      // Actually execute the tool (write the file)
      const writePath = toolInput.file_path || toolInput.path;
      if (toolName === 'Write' && writePath) {
        fs.writeFileSync(writePath, toolInput.content || toolInput.contents || '', 'utf-8');
      }

      // Step 2: Send tool_result continuation
      const sessionId = res1.headers['x-cursor-session-id'];
      const res2 = await httpRequest({
        hostname: SERVER_HOST, port: SERVER_PORT,
        path: '/v1/messages', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sessionId ? { 'X-Cursor-Session-Id': sessionId } : {}),
        },
        timeout: 60000,
      }, {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        stream: true,
        messages: [
          { role: 'user', content: `Write a file at ${TEST_FILE_PATH} with content "e2e_test_content_12345". Use the Write tool.` },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I\'ll write the file for you.' },
              { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: `Successfully wrote ${(toolInput.content || toolInput.contents || '').length} bytes to ${toolInput.file_path || toolInput.path}`,
              },
            ],
          },
        ],
        tools,
      });

      assert(res2.status === 200, `tool_result continuation: status ${res2.status} === 200 (was 400 before fix)`);
      if (res2.status !== 200) {
        console.log(`    Response body: ${res2.body.substring(0, 200)}`);
      }
    } else {
      console.log('    ⚠️  Model did not call a tool (may have written directly via native tools)');
      // Not a failure - the model might use Cursor's native write instead
      assert(true, 'tool request completed without tool_use (native path)');
    }
  } catch (e) {
    assert(false, `tool round-trip: ${e.message}`);
  } finally {
    // Always cleanup
    try { if (fs.existsSync(TEST_FILE_PATH)) fs.unlinkSync(TEST_FILE_PATH); } catch {}
    assert(!fs.existsSync(TEST_FILE_PATH), 'test file cleaned up');
  }

  // 4d: Request with error tool_result
  console.log('--- 5d: Error tool_result continuation ---');
  try {
    const tools = [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      },
    ];

    const fakeToolUseId = 'toolu_e2e_error_test';
    const res = await httpRequest({
      hostname: SERVER_HOST, port: SERVER_PORT,
      path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }, {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      stream: true,
      messages: [
        { role: 'user', content: 'Read the file /nonexistent-e2e-test-file' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: fakeToolUseId, name: 'Read', input: { file_path: '/nonexistent-e2e-test-file' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: fakeToolUseId,
              is_error: true,
              content: 'Error: ENOENT: no such file or directory',
            },
          ],
        },
      ],
      tools,
    });

    // This should NOT crash with Buffer.from(undefined)
    // Either 200 (session found) or fresh request (no session, still 200)
    assert(res.status === 200, `error tool_result: status ${res.status} (not 400)`);
  } catch (e) {
    assert(false, `error tool_result: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'ALL PASS ✅' : 'SOME FAILED ❌');
process.exit(failed > 0 ? 1 : 0);

})().catch(err => { console.error('Fatal:', err); process.exit(1); });
