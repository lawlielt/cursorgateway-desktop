const assert = require('assert');
const { formatResponseWithToolCalls } = require('../../src/utils/toolsAdapter');

function toolNames(content) {
  return content.filter(b => b.type === 'tool_use').map(b => b.name);
}

function toolInputs(content) {
  return content.filter(b => b.type === 'tool_use').map(b => b.input);
}

// Simulate Cursor/Claude style UI text (no actual tool_call events)
const tools = [
  {
    name: 'WebFetch',
    description: 'Fetch a web page',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'Bash',
    description: 'Run a shell command',
    input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];

const text = [
  '我来抓取这个网页，看看有哪些技术文章。',
  '',
  '⬢ WebFetch https://www.anthropic.com/engineering',
  '',
  '找到文章后我会创建文件夹。',
  '',
  '$ mkdir -p ./doc/anthropic-engineering-articles',
  '',
  '然后继续抓取。',
  '⬢ WebFetch https://www.anthropic.com/engineering/advanced-tool-use',
].join('\n');

const parsed = formatResponseWithToolCalls(text, tools);

assert.equal(parsed.hasToolCalls, true, 'should detect tool calls from tool lines');
assert.deepEqual(toolNames(parsed.content), ['WebFetch', 'Bash', 'WebFetch']);

const inputs = toolInputs(parsed.content);
assert.deepEqual(inputs[0], { url: 'https://www.anthropic.com/engineering' });
assert.deepEqual(inputs[1], { command: 'mkdir -p ./doc/anthropic-engineering-articles' });
assert.deepEqual(inputs[2], { url: 'https://www.anthropic.com/engineering/advanced-tool-use' });

// Cleaned text should not contain the extracted tool lines.
const cleanedTextBlock = parsed.content.find(b => b.type === 'text')?.text || '';
assert.ok(!cleanedTextBlock.includes('WebFetch https://www.anthropic.com/engineering'));
assert.ok(!cleanedTextBlock.includes('$ mkdir -p'));

console.log('PASS: text fallback parses Claude Code style tool lines (WebFetch, $ Bash)');

