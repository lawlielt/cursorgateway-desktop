/**
 * Claude Code CLI client adapter.
 *
 * Claude Code (the standalone CLI, not the Cursor IDE integration) uses
 * lowercase tool names: bash, read, write, edit, grep, glob, etc.
 * Param style: path for files, content (singular for write), command for shell.
 *
 * Distinguished from the Cursor-integrated "claude-code" adapter which uses
 * PascalCase names (Bash, Read, Write, StrReplace, Grep, Glob, …).
 */

const { ClientAdapter } = require('./base');

module.exports = new ClientAdapter({
  clientType: 'claude-code-cli',

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
    todo_write:      'todowrite',
    todo_read:       'todoread',
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
