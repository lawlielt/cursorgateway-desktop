/**
 * SSE helper functions for Anthropic Messages API streaming responses.
 */

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
}

function writeMessageStart(res, messageId, model) {
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })}\n\n`);
}

function writePing(res) {
  res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
}

function writeContentBlockStart(res, index, contentBlock) {
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index,
    content_block: contentBlock,
  })}\n\n`);
}

function writeContentBlockDelta(res, index, delta) {
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index,
    delta,
  })}\n\n`);
}

function writeContentBlockStop(res, index) {
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index,
  })}\n\n`);
}

function writeTextBlockStart(res, index) {
  writeContentBlockStart(res, index, { type: 'text', text: '' });
}

function writeTextDelta(res, index, text) {
  writeContentBlockDelta(res, index, { type: 'text_delta', text });
}

function writeToolUseBlock(res, index, toolUse) {
  writeContentBlockStart(res, index, { type: 'tool_use', id: toolUse.id, name: toolUse.name, input: {} });
  writeContentBlockDelta(res, index, { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) });
  writeContentBlockStop(res, index);
}

function writeMessageDelta(res, stopReason) {
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  })}\n\n`);
}

function writeMessageStop(res) {
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
}

function writeSseError(res, message) {
  res.write(`event: error\ndata: ${JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message },
  })}\n\n`);
}

module.exports = {
  setSseHeaders,
  writeMessageStart,
  writePing,
  writeContentBlockStart,
  writeContentBlockDelta,
  writeContentBlockStop,
  writeTextBlockStart,
  writeTextDelta,
  writeToolUseBlock,
  writeMessageDelta,
  writeMessageStop,
  writeSseError,
};
