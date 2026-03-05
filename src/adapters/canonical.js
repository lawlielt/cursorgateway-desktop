/**
 * Canonical tool definitions — the internal standard that Core layer uses.
 * Every client adapter translates to/from these names and param shapes.
 */

const CANONICAL_TOOLS = {
  file_read: {
    description: 'Read file contents',
    cursorExecType: 'read',
    params: {
      path:   { type: 'string', required: true },
      offset: { type: 'number', required: false },
      limit:  { type: 'number', required: false },
    },
  },
  file_write: {
    description: 'Write/overwrite entire file',
    cursorExecType: 'write',
    params: {
      path:    { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
  },
  file_edit: {
    description: 'Partial edit (string replacement)',
    cursorExecType: 'write',
    params: {
      path:        { type: 'string',  required: true },
      old_string:  { type: 'string',  required: true },
      new_string:  { type: 'string',  required: true },
      replace_all: { type: 'boolean', required: false },
    },
  },
  shell_exec: {
    description: 'Execute shell command',
    cursorExecType: 'shell',
    params: {
      command:           { type: 'string', required: true },
      working_directory: { type: 'string', required: false },
      timeout:           { type: 'number', required: false },
    },
  },
  content_search: {
    description: 'Search file contents (grep)',
    cursorExecType: 'grep',
    params: {
      pattern: { type: 'string', required: true },
      path:    { type: 'string', required: false },
    },
  },
  file_search: {
    description: 'Search/list files by pattern (glob)',
    cursorExecType: 'ls',
    params: {
      pattern: { type: 'string', required: true },
      path:    { type: 'string', required: false },
    },
  },
  dir_list: {
    description: 'List directory contents',
    cursorExecType: 'ls',
    params: {
      path: { type: 'string', required: true },
    },
  },
  file_delete: {
    description: 'Delete a file',
    cursorExecType: 'delete',
    params: {
      path: { type: 'string', required: true },
    },
  },
  web_fetch: {
    description: 'Fetch a web page',
    cursorExecType: null,
    params: {
      url: { type: 'string', required: true },
    },
  },
  web_search: {
    description: 'Search the web',
    cursorExecType: null,
    params: {
      query: { type: 'string', required: true },
    },
  },
  todo_write: {
    description: 'Write/update todo items',
    cursorExecType: null,
    params: {
      todos: { type: 'array',   required: true },
      merge: { type: 'boolean', required: false },
    },
  },
  todo_read: {
    description: 'Read todo items',
    cursorExecType: null,
    params: {},
  },
  request_context: {
    description: 'Request workspace context (handled locally)',
    cursorExecType: 'request_context',
    params: {},
  },
  mcp_custom: {
    description: 'Generic MCP tool passthrough',
    cursorExecType: 'mcp',
    params: {},
  },
};

const CANONICAL_NAMES = Object.keys(CANONICAL_TOOLS);

/**
 * Map Cursor exec type → canonical name.
 * Some exec types map to multiple canonicals (e.g. write → file_write or file_edit);
 * the caller must disambiguate using input content.
 */
const CURSOR_EXEC_TO_CANONICAL = {
  read:            'file_read',
  write:           'file_write',
  shell:           'shell_exec',
  grep:            'content_search',
  ls:              'dir_list',
  delete:          'file_delete',
  mcp:             'mcp_custom',
  request_context: 'request_context',
};

module.exports = {
  CANONICAL_TOOLS,
  CANONICAL_NAMES,
  CURSOR_EXEC_TO_CANONICAL,
};
