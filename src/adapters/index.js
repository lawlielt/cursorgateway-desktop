/**
 * Adapters barrel export.
 */

const { ClientAdapter } = require('./base');
const { CANONICAL_TOOLS, CANONICAL_NAMES, CURSOR_EXEC_TO_CANONICAL } = require('./canonical');
const { detectClient, getAdapter, ADAPTERS, DEFAULT_CLIENT } = require('./detector');

module.exports = {
  ClientAdapter,
  CANONICAL_TOOLS,
  CANONICAL_NAMES,
  CURSOR_EXEC_TO_CANONICAL,
  detectClient,
  getAdapter,
  ADAPTERS,
  DEFAULT_CLIENT,
};
