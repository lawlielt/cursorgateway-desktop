const { mapAgentChunkToToolUse } = require('../../src/utils/bidiToolFlowAdapter');

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

console.log('\n=== tool_call (exec) chunk mapping ===');
{
  const session = { pendingToolCalls: [] };
  const chunk = {
    type: 'tool_call',
    execRequest: { type: 'mcp', id: 7, args: { x: 1 } },
    sendResult: async () => {},
  };
  const fakeExecRequestToToolUse = (execRequest) => ({
    type: 'tool_use',
    id: 'toolu_test',
    name: 'my_custom_tool',
    input: execRequest.args,
  });

  const toolUse = mapAgentChunkToToolUse(chunk, {
    session,
    tools: [],
    execRequestToToolUse: fakeExecRequestToToolUse,
  });

  test('exec tool_call maps using execRequestToToolUse', () => {
    if (!toolUse) throw new Error('toolUse is null');
    if (toolUse.name !== 'my_custom_tool') throw new Error(`got ${toolUse.name}`);
  });
  test('pending tool call registered', () => {
    if (session.pendingToolCalls.length !== 1) throw new Error(`got ${session.pendingToolCalls.length}`);
  });
  test('pending entry has correct toolUse', () => {
    if (session.pendingToolCalls[0].toolUse.id !== 'toolu_test') throw new Error('wrong id');
  });
}

console.log('\n=== tool_call_kv: native-covered tools now pass through (dedup in agentClient) ===');
{
  const session = { pendingToolCalls: [] };
  const tools = [{ name: 'Bash' }, { name: 'Read' }, { name: 'Write' }, { name: 'Glob' }];
  const fakeExecRequestToToolUse = () => null;

  const nativeKvCases = [
    { name: 'Shell', input: { command: 'ls' } },
    { name: 'Read', input: { file_path: '/tmp/a.txt' } },
    { name: 'Write', input: { file_path: '/tmp/b.txt', content: 'abc' } },
    { name: 'Bash', input: { command: 'pwd' } },
    { name: 'Glob', input: { pattern: '*' } },
    { name: 'Grep', input: { pattern: 'TODO' } },
    { name: 'Delete', input: { file_path: '/tmp/x' } },
  ];

  for (const tc of nativeKvCases) {
    const result = mapAgentChunkToToolUse(
      {
        type: 'tool_call_kv',
        toolUse: { type: 'tool_use', id: `kv_${tc.name}`, name: tc.name, input: tc.input },
      },
      { session, tools, execRequestToToolUse: fakeExecRequestToToolUse }
    );
    test(`KV ${tc.name} → adapted (no longer hard-skipped)`, () => {
      if (!result) throw new Error(`expected non-null, got null`);
    });
  }
}

console.log('\n=== tool_call_kv: non-native tools pass through KV adapter ===');
{
  const session = { pendingToolCalls: [] };
  const tools = [
    { name: 'TodoWrite' },
    { name: 'WebFetch' },
  ];
  const fakeExecRequestToToolUse = () => null;

  const result = mapAgentChunkToToolUse(
    {
      type: 'tool_call_kv',
      toolUse: { type: 'tool_use', id: 'kv_todo', name: 'TodoWrite', input: { todos: [] } },
    },
    { session, tools, execRequestToToolUse: fakeExecRequestToToolUse }
  );

  test('KV TodoWrite → adapted (non-native)', () => {
    if (!result) throw new Error('expected non-null result');
    if (result.name !== 'TodoWrite') throw new Error(`got ${result.name}`);
  });
}

console.log('\n=== edge cases ===');
{
  const session = { pendingToolCalls: [] };

  test('null chunk → null', () => {
    const r = mapAgentChunkToToolUse(null, { session, tools: [], execRequestToToolUse: () => null });
    if (r !== null) throw new Error('expected null');
  });

  test('wrong chunk type → null', () => {
    const r = mapAgentChunkToToolUse({ type: 'text' }, { session, tools: [], execRequestToToolUse: () => null });
    if (r !== null) throw new Error('expected null');
  });
}

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
