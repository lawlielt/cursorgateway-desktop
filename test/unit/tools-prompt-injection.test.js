/**
 * Tools Prompt Injection Tests
 *
 * Validates that toolsToPrompt injects COMPLETE tool schemas into the prompt,
 * including enum constraints, required fields, and nested properties.
 *
 * Bug: MCP format only injected `parameters.properties`, losing `enum`, `required`,
 * etc. This caused Cursor's model to call Task(subagent_type: "Explore") when
 * only "generalPurpose" is valid, leading to infinite retry loops.
 */

const assert = require('assert');
const { toolsToPrompt } = require('../../src/utils/toolsAdapter');

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

const TASK_TOOL = {
  name: 'Task',
  description: 'Launch a subagent to handle complex tasks',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short description' },
      prompt: { type: 'string', description: 'Task prompt' },
      subagent_type: {
        type: 'string',
        description: 'Subagent type',
        enum: ['generalPurpose'],
      },
      model: {
        type: 'string',
        enum: ['fast'],
      },
    },
    required: ['description', 'prompt'],
  },
};

const WEBFETCH_TOOL = {
  name: 'WebFetch',
  description: 'Fetch content from a URL',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch' },
    },
    required: ['url'],
  },
};

// ─── 1. MCP format: enum constraints ─────────────────────────────────────────

console.log('\n[1] MCP format preserves enum constraints');

test('Task tool prompt contains enum value "generalPurpose"', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  assert.ok(prompt.includes('generalPurpose'),
    'prompt should contain enum value "generalPurpose"');
});

test('Task tool prompt contains "enum" keyword', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  assert.ok(prompt.includes('"enum"'),
    'prompt should contain "enum" key in schema');
});

test('Task tool prompt contains model enum value "fast"', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  assert.ok(prompt.includes('"fast"'),
    'prompt should contain enum value "fast" for model param');
});

test('MCP prompt contains "required" field', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  assert.ok(prompt.includes('"required"'),
    'prompt should contain "required" key');
  assert.ok(prompt.includes('"description"') && prompt.includes('"prompt"'),
    'prompt should list required field names');
});

test('MCP prompt contains "type": "object"', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  assert.ok(prompt.includes('"type"'),
    'prompt should contain schema type info');
});

// ─── 2. Standard format: already correct ─────────────────────────────────────

console.log('\n[2] Standard format preserves full schema');

test('standard format contains enum constraints', () => {
  const prompt = toolsToPrompt([TASK_TOOL], false);
  assert.ok(prompt.includes('generalPurpose'),
    'standard format should contain enum value');
  assert.ok(prompt.includes('"enum"'),
    'standard format should contain enum key');
});

test('standard format contains required fields', () => {
  const prompt = toolsToPrompt([TASK_TOOL], false);
  assert.ok(prompt.includes('"required"'),
    'standard format should contain required key');
});

// ─── 3. Multiple tools ──────────────────────────────────────────────────────

console.log('\n[3] Multiple tools all preserve schema');

test('both tools appear in MCP prompt with full schema', () => {
  const prompt = toolsToPrompt([TASK_TOOL, WEBFETCH_TOOL], true);
  assert.ok(prompt.includes('Task'), 'should contain Task tool');
  assert.ok(prompt.includes('WebFetch'), 'should contain WebFetch tool');
  assert.ok(prompt.includes('generalPurpose'), 'Task enum preserved');
  assert.ok(prompt.includes('"url"'), 'WebFetch url param preserved');
});

// ─── 4. Edge cases ───────────────────────────────────────────────────────────

console.log('\n[4] Edge cases');

test('empty tools array returns empty string', () => {
  assert.strictEqual(toolsToPrompt([], true), '');
  assert.strictEqual(toolsToPrompt([], false), '');
});

test('null/undefined tools returns empty string', () => {
  assert.strictEqual(toolsToPrompt(null, true), '');
  assert.strictEqual(toolsToPrompt(undefined, false), '');
});

test('tool without input_schema still appears in prompt', () => {
  const tool = { name: 'SimpleAction', description: 'Does something' };
  const prompt = toolsToPrompt([tool], true);
  assert.ok(prompt.includes('SimpleAction'), 'tool name should appear');
  assert.ok(prompt.includes('Does something'), 'tool description should appear');
});

test('tool with empty properties object still includes type', () => {
  const tool = {
    name: 'NoParams',
    description: 'No params tool',
    input_schema: { type: 'object', properties: {} },
  };
  const prompt = toolsToPrompt([tool], true);
  assert.ok(prompt.includes('NoParams'), 'tool name should appear');
});

// ─── 5. Real-world scenario: Task enum NOT lost ──────────────────────────────

console.log('\n[5] Real-world scenario: Task subagent_type enum validation');

test('MCP prompt makes "generalPurpose" discoverable, "Explore" absent from enum', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  const schemaStr = prompt.substring(prompt.indexOf('Parameters:') + 'Parameters:'.length);
  assert.ok(schemaStr.includes('"generalPurpose"'),
    'generalPurpose should be in the schema');
  assert.ok(!schemaStr.includes('"Explore"'),
    'Explore should NOT appear as valid enum value');
});

test('parsing the injected schema recovers full enum constraint', () => {
  const prompt = toolsToPrompt([TASK_TOOL], true);
  const paramStart = prompt.indexOf('Parameters:') + 'Parameters:'.length;
  const paramEnd = prompt.indexOf('\n</mcp_tools>');
  const schemaJson = prompt.substring(paramStart, paramEnd).trim();
  const schema = JSON.parse(schemaJson);
  assert.deepStrictEqual(schema.properties.subagent_type.enum, ['generalPurpose'],
    'parsed schema should have correct enum');
  assert.deepStrictEqual(schema.required, ['description', 'prompt'],
    'parsed schema should have correct required fields');
});

// ─── 6. extractWorkingDirectory still works (regression check) ───────────────

console.log('\n[6] extractWorkingDirectory regression check');

const { extractWorkingDirectory } = require('../../src/utils/toolsAdapter');

test('Workspace Path format (Claude Code CLI)', () => {
  assert.strictEqual(
    extractWorkingDirectory('Workspace Path: /Users/test/project'),
    '/Users/test/project'
  );
});

test('Working directory format (Cursor IDE)', () => {
  assert.strictEqual(
    extractWorkingDirectory('Working directory: /tmp/test'),
    '/tmp/test'
  );
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed > 0 ? 1 : 0);
