/**
 * Tool Executor
 * Minimal version: only handles request_context locally.
 * All other tools (read, write, ls, shell, grep) are forwarded to the client.
 */

function getRequestContext(workspacePath) {
  const os = require('os');
  return {
    os: `${process.platform} ${os.release()}`,
    cwd: workspacePath || process.cwd(),
    shell: process.env.SHELL || '/bin/zsh',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

module.exports = {
  getRequestContext,
};
