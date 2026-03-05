/**
 * opencode client adapter.
 *
 * opencode v1.2+ uses short lowercase names: read, write, edit, bash, grep, glob, …
 * Param style: file_path for files, content (singular), command
 */

const { ClientAdapter } = require('./base');

module.exports = new ClientAdapter({
  clientType: 'opencode',

  // canonical → client tool name
  toolNameMap: {
    file_read:       'read',
    file_write:      'write',
    file_edit:       'edit',
    shell_exec:      'bash',
    content_search:  'grep',
    file_search:     'glob',
    dir_list:        'ls',
    file_delete:     'delete',
    web_fetch:       'webfetch',
    web_search:      'websearch',
    task:            'task',
    todo_write:      'todowrite',
  },

  paramMap: {
    file_read: {
      path:   'file_path',
      offset: 'offset',
      limit:  'limit',
    },
    file_write: {
      path:    'file_path',
      content: 'content',
    },
    file_edit: {
      path:        'file_path',
      old_string:  'old_string',
      new_string:  'new_string',
    },
    shell_exec: {
      command:           'command',
      working_directory: 'working_directory',
      timeout:           'timeout',
      description:       'description',
    },
    content_search: {
      pattern: 'pattern',
      path:    'path',
    },
    file_search: {
      pattern: 'pattern',
      path:    'path',
    },
    dir_list: {
      path: 'path',
    },
    file_delete: {
      path: 'path',
    },
    web_fetch: {
      url: 'url',
    },
    web_search: {
      query: 'query',
    },
  },

  nativeCoveredTools: new Set([
    'file_read', 'file_write', 'file_edit', 'shell_exec',
    'content_search', 'file_search', 'dir_list', 'file_delete',
  ]),

  workspacePathPatterns: [
    /Working directory:\s*([^\n]+)/i,
    /CWD:\s*([^\n]+)/i,
    /Workspace Path:\s*([^\n]+)/i,
    /Workspace Root:\s*([^\n]+)/i,
  ],

  behaviorFlags: {
    retriesToolResult: false,
    hasTextFallback: false,
    hasThinkingBlocks: false,
  },
});
