/**
 * SSE helper functions for OpenAI Chat Completions API streaming responses.
 * Mirrors sseWriter.js but uses OpenAI's delta-based SSE format.
 */

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

function writeChunk(res, responseId, model, delta, finishReason = null) {
  const chunk = {
    id: responseId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
    }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeRoleChunk(res, responseId, model) {
  writeChunk(res, responseId, model, { role: 'assistant' });
}

function writeTextDelta(res, responseId, model, content) {
  writeChunk(res, responseId, model, { content });
}

function writeToolCallChunk(res, responseId, model, toolCallIndex, toolCall) {
  writeChunk(res, responseId, model, {
    tool_calls: [{
      index: toolCallIndex,
      id: toolCall.id,
      type: 'function',
      function: {
        name: toolCall.name,
        arguments: typeof toolCall.input === 'string'
          ? toolCall.input
          : JSON.stringify(toolCall.input || {}),
      },
    }],
  });
}

function writeFinish(res, responseId, model, finishReason = 'stop') {
  writeChunk(res, responseId, model, {}, finishReason);
}

function writeDone(res) {
  res.write('data: [DONE]\n\n');
}

function writeError(res, message) {
  res.write(`data: ${JSON.stringify({
    error: { message, type: 'server_error' },
  })}\n\n`);
}

/**
 * Build a non-streaming chat.completion response body.
 */
function buildCompletionResponse(responseId, model, content, toolCalls = [], finishReason = 'stop') {
  const message = { role: 'assistant', content: content || null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.input === 'string'
          ? tc.input
          : JSON.stringify(tc.input || {}),
      },
    }));
    finishReason = 'tool_calls';
  }
  return {
    id: responseId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

module.exports = {
  setSseHeaders,
  writeChunk,
  writeRoleChunk,
  writeTextDelta,
  writeToolCallChunk,
  writeFinish,
  writeDone,
  writeError,
  buildCompletionResponse,
};
