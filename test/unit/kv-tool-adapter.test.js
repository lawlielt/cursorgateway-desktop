const { adaptKvToolUseToIde } = require('../../src/utils/kvToolAdapter');

const claudeCodeTools = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Write' },
  { name: 'Glob' },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run() {
  const cases = [
    {
      title: 'Shell -> Bash',
      input: { type: 'tool_use', id: '1', name: 'Shell', input: { command: 'ls', description: 'list' } },
      check: (out) => {
        assert(out.name === 'Bash', `expected Bash, got ${out.name}`);
        assert(out.input.command === 'ls', 'expected command to be preserved');
      },
    },
    {
      title: 'Read path -> file_path',
      input: { type: 'tool_use', id: '2', name: 'Read', input: { path: '/tmp/a.txt' } },
      check: (out) => {
        assert(out.name === 'Read', `expected Read, got ${out.name}`);
        assert(out.input.file_path === '/tmp/a.txt', 'expected file_path from path');
      },
    },
    {
      title: 'Glob glob_pattern -> pattern',
      input: { type: 'tool_use', id: '3', name: 'Glob', input: { glob_pattern: 'src/**/*.js' } },
      check: (out) => {
        assert(out.input.pattern === 'src/**/*.js', 'expected pattern from glob_pattern');
      },
    },
    {
      title: 'Write contents -> content',
      input: { type: 'tool_use', id: '4', name: 'Write', input: { path: '/tmp/b.txt', contents: 'abc' } },
      check: (out) => {
        assert(out.input.file_path === '/tmp/b.txt', 'expected file_path from path');
        assert(out.input.content === 'abc', 'expected content from contents');
      },
    },
  ];

  for (const tc of cases) {
    const out = adaptKvToolUseToIde(tc.input, claudeCodeTools);
    tc.check(out);
    console.log(`PASS: ${tc.title}`);
  }

  console.log('All kv tool adapter tests passed.');
}

run();

