/**
 * Claude Code client adapter.
 *
 * Tool names: PascalCase (Read, Write, StrReplace, Bash, Grep, Glob, LS, Delete, …)
 * Param style: path, contents (plural for write), command, glob_pattern, target_directory
 */

const { ClientAdapter } = require('./base');

module.exports = new ClientAdapter({
  clientType: 'claude-code',

  toolNameMap: {
    file_read:       'Read',
    file_write:      'Write',
    file_edit:       'StrReplace',
    shell_exec:      'Bash',
    content_search:  'Grep',
    file_search:     'Glob',
    dir_list:        'LS',
    file_delete:     'Delete',
    web_fetch:       'WebFetch',
    web_search:      'WebSearch',
    todo_write:      'TodoWrite',
    todo_read:       'TodoRead',
  },

  paramMap: {
    file_read: {
      path:   'path',
      offset: 'offset',
      limit:  'limit',
    },
    file_write: {
      path:    'path',
      content: 'contents',
    },
    file_edit: {
      path:        'path',
      old_string:  'old_string',
      new_string:  'new_string',
      replace_all: 'replace_all',
    },
    shell_exec: {
      command:           'command',
      working_directory: 'working_directory',
      timeout:           'timeout',
    },
    content_search: {
      pattern: 'pattern',
      path:    'path',
    },
    file_search: {
      pattern: 'glob_pattern',
      path:    'target_directory',
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
      query: 'search_term',
    },
    todo_write: {
      todos: 'todos',
      merge: 'merge',
    },
    todo_read: {},
  },

  nativeCoveredTools: new Set([
    'file_read', 'file_write', 'file_edit', 'shell_exec',
    'content_search', 'file_search', 'dir_list', 'file_delete',
  ]),

  workspacePathPatterns: [
    /Workspace Path:\s*([^\n]+)/i,
    /Working directory:\s*([^\n]+)/i,
    /Workspace Root:\s*([^\n]+)/i,
    /CWD:\s*([^\n]+)/i,
  ],

  behaviorFlags: {
    retriesToolResult: true,
    hasTextFallback: true,
    hasThinkingBlocks: true,
  },
});
