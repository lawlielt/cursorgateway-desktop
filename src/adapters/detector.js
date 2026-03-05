/**
 * Client detector — identifies which client is making the request.
 *
 * Strategy (three layers):
 *   1. API key exact match: key value IS the client name (e.g. "opencode")
 *   2. Tool-name heuristic: infer from the tools array in request body
 *      — When an API key matched but tools are available, tool heuristic
 *        can OVERRIDE the key match to handle misconfigured API keys.
 *   3. Default fallback: claude-code (backward compatible)
 */

const claudeCodeAdapter    = require('./claude-code');
const claudeCodeCliAdapter = require('./claude-code-cli');
const opencodeAdapter      = require('./opencode');
const openclawAdapter      = require('./openclaw');

const ADAPTERS = {
  'claude-code':     claudeCodeAdapter,
  'claude-code-cli': claudeCodeCliAdapter,
  'opencode':        opencodeAdapter,
  'openclaw':        openclawAdapter,
};

const DEFAULT_CLIENT = 'claude-code';

/**
 * Infer client type from the tools array using naming-convention heuristics.
 * @param {Array} tools
 * @returns {{ clientType: string, adapter: import('./base').ClientAdapter } | null}
 */
function detectFromTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const rawNames = tools.map(t => t.name || t.function?.name || '');
  const names = new Set(rawNames.map(n => n.toLowerCase()));
  const hasOriginalCase = new Set(rawNames);

  // opencode v1.2+: unique tools (interactive_bash, look_at, skill_mcp are opencode-only)
  // NOTE: 'skill' alone is NOT sufficient — claude-code-cli also has it
  if (names.has('interactive_bash') || names.has('look_at') || names.has('skill_mcp')) {
    return { clientType: 'opencode', adapter: ADAPTERS['opencode'] };
  }
  // opencode legacy: snake_case with _file suffix (read_file, write_file, str_replace)
  // Must check BEFORE claude-code-cli because both have "bash" and "grep"
  if (names.has('read_file') || names.has('write_file') || names.has('str_replace')) {
    return { clientType: 'opencode', adapter: ADAPTERS['opencode'] };
  }

  // Claude Code (Cursor IDE integration): PascalCase originals
  if (hasOriginalCase.has('StrReplace') || hasOriginalCase.has('Bash') || hasOriginalCase.has('Grep')) {
    return { clientType: 'claude-code', adapter: ADAPTERS['claude-code'] };
  }

  // Claude Code CLI: lowercase originals + "skill" / "task" / "todowrite" signatures
  // Distinguished from openclaw by: bash (not exec), grep (not search)
  if (names.has('bash') && names.has('read') && names.has('grep')) {
    return { clientType: 'claude-code-cli', adapter: ADAPTERS['claude-code-cli'] };
  }

  // openclaw: short names + exec (not bash)
  if (names.has('exec') || names.has('file_read') || names.has('file_write')) {
    return { clientType: 'openclaw', adapter: ADAPTERS['openclaw'] };
  }

  return null;
}

/**
 * Detect client type from the request.
 * @param {object} req - Express request (or mock with headers + body)
 * @returns {{ clientType: string, adapter: import('./base').ClientAdapter }}
 */
function detectClient(req) {
  const rawKey = (
    req.headers?.['x-api-key'] ||
    req.headers?.authorization?.replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();

  // Tool-based detection is most reliable — try it first when tools exist
  const toolResult = detectFromTools(req.body?.tools);
  if (toolResult) {
    return toolResult;
  }

  // Fall back to API key match
  const keyLower = rawKey.toLowerCase();
  if (ADAPTERS[keyLower]) {
    return { clientType: keyLower, adapter: ADAPTERS[keyLower] };
  }

  return { clientType: DEFAULT_CLIENT, adapter: ADAPTERS[DEFAULT_CLIENT] };
}

/**
 * Get adapter by client type name.
 */
function getAdapter(clientType) {
  return ADAPTERS[clientType] || ADAPTERS[DEFAULT_CLIENT];
}

module.exports = {
  detectClient,
  detectFromTools,
  getAdapter,
  ADAPTERS,
  DEFAULT_CLIENT,
};
