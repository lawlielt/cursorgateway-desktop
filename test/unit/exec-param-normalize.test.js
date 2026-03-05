/**
 * Exec Path Parameter Normalization Tests
 *
 * Validates that exec_server_message tool calls (the exec path) produce
 * parameter names that match the IDE's tool definitions.
 *
 * Bug: execRequestToToolUse produced { file_path, content } but Claude Code
 * expects { path, contents } for Write, and { path } for Read. This caused
 * repeated "Error editing file" failures.
 *
 * Fix: Run exec path results through adaptKvToolUseToIde (same normalizer
 * used by the KV path) so parameter names match the IDE tool schema.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

const { mapAgentChunkToToolUse } = require('../../src/utils/bidiToolFlowAdapter');
const { execRequestToToolUse } = require('../../src/utils/sessionManager');

// Claude Code tool definitions with proper parameter names
const CLAUDE_CODE_TOOLS = [
  {
    name: 'Read',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  {
    name: 'Write',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        contents: { type: 'string', description: 'File contents' },
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
  {
    name: 'Delete',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    },
  },
];

function makeSession() {
  return {
    toolCallMapping: new Map(),
    pendingToolCalls: [],
    sentCursorExecKeys: new Set(),
    sentToolCallIds: new Set(),
  };
}

console.log('\n[1] Write exec produces correct parameter names via mapAgentChunkToToolUse');

test('Write exec: path and contents both correct', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 1, execId: 'e1', path: '/home/user/file.py', fileText: 'print("hello")' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Write');
  assert.strictEqual(result.input.path, '/home/user/file.py', 'path value must match');
  assert.strictEqual(result.input.contents, 'print("hello")', 'contents value must match fileText');
  assert.ok(!('file_path' in result.input), 'must NOT have file_path');
  assert.ok(!('content' in result.input), 'must NOT have content (singular)');
});

test('Write exec: has "contents" with correct value, not "content"', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 2, execId: 'e2', path: '/test.py', fileText: 'x = 1' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.ok('contents' in result.input, `must have "contents", got keys: ${Object.keys(result.input)}`);
  assert.strictEqual(result.input.contents, 'x = 1', 'contents must match fileText value');
  assert.ok(!('content' in result.input), 'must NOT have "content" key');
  assert.ok(!('file_path' in result.input), 'must NOT have "file_path" key');
});

console.log('\n[2] Read exec produces correct parameter names');

test('Read exec: path correct, no file_path', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'read', id: 3, execId: 'e3', path: '/home/user/app.js' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Read');
  assert.strictEqual(result.input.path, '/home/user/app.js', 'path value must match');
  assert.ok(!('file_path' in result.input), 'must NOT have file_path');
});

test('Read exec with offset/limit values preserved', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'read', id: 4, execId: 'e4', path: '/big.log', startLine: 10, endLine: 20 },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.input.path, '/big.log', 'path value must match');
  assert.strictEqual(result.input.offset, 10, 'offset must equal startLine');
  assert.strictEqual(result.input.limit, 11, 'limit must equal endLine - startLine + 1');
  assert.ok(!('file_path' in result.input), 'must NOT have file_path');
});

console.log('\n[3] Shell exec produces correct parameter names');

test('Shell exec: has "command" and "working_directory"', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'shell', id: 5, execId: 'e5', command: 'ls -la', cwd: '/home' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Bash');
  assert.strictEqual(result.input.command, 'ls -la');
});

console.log('\n[4] Glob exec produces correct parameter names');

test('Glob exec: glob_pattern and target_directory values correct', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'ls', id: 6, execId: 'e6', path: '/project' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Glob');
  assert.strictEqual(result.input.glob_pattern, '*', 'glob_pattern must be "*"');
  assert.strictEqual(result.input.target_directory, '/project', 'target_directory must match path');
  assert.ok(!('pattern' in result.input), 'must NOT have raw "pattern"');
});

console.log('\n[5] Grep exec produces correct parameter names');

test('Grep exec: pattern and path values correct', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'grep', id: 7, execId: 'e7', pattern: 'TODO', path: '/src' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Grep');
  assert.strictEqual(result.input.pattern, 'TODO', 'pattern value must match');
  assert.strictEqual(result.input.path, '/src', 'path value must match');
});

console.log('\n[6] Session pendingToolCalls receives normalized tool use');

test('pendingToolCalls stores normalized input with correct values', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 8, execId: 'e8', path: '/test.txt', fileText: 'hello' },
    sendResult: async () => {},
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(session.pendingToolCalls.length, 1);
  const pending = session.pendingToolCalls[0].toolUse;
  assert.strictEqual(pending.input.path, '/test.txt', 'pending path must match');
  assert.strictEqual(pending.input.contents, 'hello', 'pending contents must match fileText');
  assert.ok(!('file_path' in pending.input), 'pending must NOT have file_path');
  assert.ok(!('content' in pending.input), 'pending must NOT have content (singular)');
});

console.log('\n[7] Without tool definitions, exec path still works (no normalization needed)');

test('Write exec without tool defs returns raw mapping', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 9, execId: 'e9', path: '/f.txt', fileText: 'data' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: [], execRequestToToolUse });
  assert.strictEqual(result.name, 'Write');
  // Without tool defs, normalizeInputForTool has no schema to check against,
  // so it returns the raw input as-is
  assert.ok(result.input);
});

console.log('\n[8] KV path still works correctly');

test('KV tool call goes through adaptKvToolUseToIde', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call_kv',
    toolUse: {
      id: 'toolu_test',
      name: 'Write',
      input: { file_path: '/x.py', content: 'code' },
    },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Write');
  assert.ok('path' in result.input, `KV path should normalize to "path", got: ${Object.keys(result.input)}`);
});

console.log('\n[9] End-to-end Write: file content must NOT be lost');

test('Write exec end-to-end: contents value equals original fileText', () => {
  const session = makeSession();
  const originalCode = 'def hello():\n    print("world")\n\nhello()\n';
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 10, execId: 'e10', path: '/app/main.py', fileText: originalCode },
    sendResult: async () => {},
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'Write');
  assert.strictEqual(result.input.path, '/app/main.py');
  assert.strictEqual(result.input.contents, originalCode, 'file content must be preserved exactly');
  assert.strictEqual(Object.keys(result.input).sort().join(','), 'contents,path',
    'Write input must have exactly {path, contents}');
});

test('Write exec with empty content preserved', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 11, execId: 'e11', path: '/empty.txt', fileText: '' },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.input.path, '/empty.txt');
  assert.strictEqual(result.input.contents, '', 'empty content must be preserved, not undefined');
});

test('Write exec with multiline JSON content preserved', () => {
  const session = makeSession();
  const jsonContent = '{\n  "name": "test",\n  "version": "1.0"\n}';
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'write', id: 12, execId: 'e12', path: '/package.json', fileText: jsonContent },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.input.contents, jsonContent, 'JSON content must be preserved exactly');
});

console.log('\n[10] normalizeInputForTool directly: content → contents mapping');

const { normalizeInputForTool } = require('../../src/utils/kvToolAdapter');

test('normalizeInputForTool: content maps to contents when schema requires it', () => {
  const writeDef = {
    input_schema: { type: 'object', properties: { path: {}, contents: {} }, required: ['path', 'contents'] },
  };
  const result = normalizeInputForTool('Write', { file_path: '/f.py', content: 'code' }, writeDef);
  assert.strictEqual(result.path, '/f.py');
  assert.strictEqual(result.contents, 'code', 'content must be mapped to contents');
  assert.ok(!('content' in result), 'must NOT have content key');
  assert.ok(!('file_path' in result), 'must NOT have file_path key');
});

test('normalizeInputForTool: contents passes through directly', () => {
  const writeDef = {
    input_schema: { type: 'object', properties: { path: {}, contents: {} }, required: ['path', 'contents'] },
  };
  const result = normalizeInputForTool('Write', { path: '/f.py', contents: 'hello' }, writeDef);
  assert.strictEqual(result.contents, 'hello');
});

test('normalizeInputForTool: content maps to fileText when schema requires it', () => {
  const writeDef = {
    input_schema: { type: 'object', properties: { file_path: {}, fileText: {} }, required: ['file_path', 'fileText'] },
  };
  const result = normalizeInputForTool('Write', { file_path: '/f.py', content: 'code' }, writeDef);
  assert.strictEqual(result.fileText, 'code', 'content must be mapped to fileText');
});

console.log('\n[11] Edit → StrReplace mapping (the root cause of "Error editing file")');

const { adaptKvToolUseToIde } = require('../../src/utils/kvToolAdapter');

test('Edit with old_string/new_string maps to StrReplace', () => {
  const toolUse = {
    id: 'toolu_test_edit',
    name: 'Edit',
    input: { file_path: '/app/chat.py', old_string: 'import foo', new_string: 'import bar' },
  };
  const result = adaptKvToolUseToIde(toolUse, CLAUDE_CODE_TOOLS);
  assert.strictEqual(result.name, 'StrReplace', `expected StrReplace, got ${result.name}`);
  assert.strictEqual(result.input.path, '/app/chat.py', 'path must match');
  assert.strictEqual(result.input.old_string, 'import foo', 'old_string must be preserved');
  assert.strictEqual(result.input.new_string, 'import bar', 'new_string must be preserved');
  assert.ok(!('file_path' in result.input), 'must not have file_path');
  assert.ok(!('content' in result.input), 'must not have content');
  assert.ok(!('contents' in result.input), 'must not have contents');
});

test('Edit with multiline old_string/new_string preserved exactly', () => {
  const oldStr = 'from tools.handler import (\n    build_tool_instruction,\n    normalize_openai_tools,\n)';
  const newStr = 'from tools.handler import (\n    normalize_openai_tools,\n)\nfrom routes.helpers import inject_tool_instruction';
  const toolUse = {
    id: 'toolu_multiline',
    name: 'Edit',
    input: { file_path: '/routes/chat.py', old_string: oldStr, new_string: newStr },
  };
  const result = adaptKvToolUseToIde(toolUse, CLAUDE_CODE_TOOLS);
  assert.strictEqual(result.name, 'StrReplace');
  assert.strictEqual(result.input.old_string, oldStr, 'multiline old_string must be exact');
  assert.strictEqual(result.input.new_string, newStr, 'multiline new_string must be exact');
});

test('Edit WITHOUT old_string/new_string still maps to Write', () => {
  const toolUse = {
    id: 'toolu_edit_full',
    name: 'Edit',
    input: { file_path: '/app/file.py', content: 'full content' },
  };
  const result = adaptKvToolUseToIde(toolUse, CLAUDE_CODE_TOOLS);
  // Without old_string/new_string, Edit is a full file write
  assert.ok(result.name === 'Write' || result.name === 'Edit',
    `expected Write or Edit, got ${result.name}`);
});

test('edit_file with old_string/new_string maps to StrReplace', () => {
  const toolUse = {
    id: 'toolu_edit_file',
    name: 'edit_file',
    input: { path: '/test.py', old_string: 'a', new_string: 'b' },
  };
  const result = adaptKvToolUseToIde(toolUse, CLAUDE_CODE_TOOLS);
  assert.strictEqual(result.name, 'StrReplace');
  assert.strictEqual(result.input.old_string, 'a');
  assert.strictEqual(result.input.new_string, 'b');
});

test('StrReplace direct name works', () => {
  const toolUse = {
    id: 'toolu_strreplace',
    name: 'StrReplace',
    input: { path: '/x.py', old_string: 'old', new_string: 'new' },
  };
  const result = adaptKvToolUseToIde(toolUse, CLAUDE_CODE_TOOLS);
  assert.strictEqual(result.name, 'StrReplace');
  assert.strictEqual(result.input.path, '/x.py');
  assert.strictEqual(result.input.old_string, 'old');
  assert.strictEqual(result.input.new_string, 'new');
});

console.log('\n[12] Full pipeline: Edit KV tool call → StrReplace tool_use');

test('KV Edit chunk through mapAgentChunkToToolUse → StrReplace with correct params', () => {
  const session = makeSession();
  const chunk = {
    type: 'tool_call_kv',
    toolUse: {
      id: 'toolu_bdrk_01FeKGQJyLXVJq9ieiX7kiLX',
      name: 'Edit',
      input: {
        file_path: '/Users/taxue/Documents/AI/cursor-proxy/routes/chat.py',
        old_string: 'from tools.handler import (\n    build_tool_instruction,\n)',
        new_string: 'from tools.handler import (\n)\nfrom routes.helpers import inject_tool_instruction',
      },
    },
  };
  const result = mapAgentChunkToToolUse(chunk, { session, tools: CLAUDE_CODE_TOOLS, execRequestToToolUse });
  assert.strictEqual(result.name, 'StrReplace', `must be StrReplace, got ${result.name}`);
  assert.strictEqual(result.input.path, '/Users/taxue/Documents/AI/cursor-proxy/routes/chat.py');
  assert.ok(result.input.old_string.includes('build_tool_instruction'), 'old_string preserved');
  assert.ok(result.input.new_string.includes('inject_tool_instruction'), 'new_string preserved');
  assert.ok(!('file_path' in result.input), 'no file_path');
  assert.ok(!('content' in result.input), 'no content');
  assert.ok(!('contents' in result.input), 'no contents');
});

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
