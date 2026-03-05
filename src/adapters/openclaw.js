/**
 * openclaw client adapter.
 *
 * Tool names: short verbs (read, write, edit, exec, web_fetch, web_search, …)
 * Param style: path for files (edit uses file_path), content (singular), command
 */

const { ClientAdapter } = require('./base');

module.exports = new ClientAdapter({
  clientType: 'openclaw',

  toolNameMap: {
    file_read:       'read',
    file_write:      'write',
    file_edit:       'edit',
    shell_exec:      'exec',
    content_search:  'search',
    file_search:     'glob',
    dir_list:        'list_dir',
    file_delete:     'delete',
    web_fetch:       'web_fetch',
    web_search:      'web_search',
  },

  paramMap: {
    file_read: {
      path:   'path',
      offset: 'offset',
      limit:  'limit',
    },
    file_write: {
      path:    'path',
      content: 'content',
    },
    file_edit: {
      path:        'file_path',
      old_string:  'old_string',
      new_string:  'new_string',
    },
    shell_exec: {
      command:           'command',
      working_directory: 'working_dir',
      timeout:           'timeout',
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
  ]),

  workspacePathPatterns: [
    /Workspace Path:\s*([^\n]+)/i,
    /Working directory:\s*([^\n]+)/i,
    /CWD:\s*([^\n]+)/i,
  ],

  behaviorFlags: {
    retriesToolResult: false,
    hasTextFallback: false,
    hasThinkingBlocks: false,
  },
});
