const { adaptKvToolUseToIde } = require('./kvToolAdapter');

/**
 * Convert a tool-related agent chunk to Anthropic tool_use and optionally
 * register it as a pending external tool call.
 *
 * KV tool calls for native-covered tools (Shell, Read, Write, etc.) are NO
 * LONGER unconditionally skipped here.  Instead, deduplication is handled in
 * agentClient.js via persistent exec-signature tracking across chatStream and
 * continueStream.  If the same tool call already came through the exec path,
 * the KV duplicate is filtered there; if only KV delivers it (e.g. replayed
 * KV FINALs in continuation streams), it passes through normally.
 *
 * @param {object} chunk
 * @param {object} opts
 * @param {import('./sessionManager').SessionState} opts.session
 * @param {Array}  opts.tools
 * @param {Function} opts.execRequestToToolUse
 * @param {import('../adapters/base').ClientAdapter} [opts.adapter]
 */
function mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter }) {
  if (!chunk || (chunk.type !== 'tool_call' && chunk.type !== 'tool_call_kv')) {
    return null;
  }

  if (chunk.type === 'tool_call_kv') {
    return adaptKvToolUseToIde(chunk.toolUse, tools, adapter);
  }

  const toolUse = execRequestToToolUse(chunk.execRequest, session, adapter);
  const normalized = adaptKvToolUseToIde(toolUse, tools, adapter);
  session.pendingToolCalls.push({
    execRequest: chunk.execRequest,
    toolUse: normalized,
    sendResult: chunk.sendResult,
  });
  return normalized;
}

module.exports = {
  mapAgentChunkToToolUse,
};

