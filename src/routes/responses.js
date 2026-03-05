const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { generateCursorBody, chunkToUtf8String } = require('../utils/utils.js');
const { mapModelName } = require('../utils/modelMapper.js');
const { fetchChatStream, extractJsonError } = require('../services/cursorApi.js');
const { ApiError } = require('../middleware/errorHandler.js');

function inputToMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: instructions });
  if (!input) return messages;

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
      if (item.type === 'message' || item.role) {
        const role = item.role || 'user';
        let content = '';
        if (typeof item.content === 'string') {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content
            .filter(b => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
            .map(b => b.text || '').join('');
        }
        messages.push({ role, content });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'user', content: `[Tool result for call ${item.call_id}]: ${item.output}` });
      }
    }
  }
  return messages;
}

/**
 * OpenAI Responses API
 * POST /v1/responses
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      model: requestModel, input, instructions = null, stream = false,
      temperature = 1, top_p = 1, max_output_tokens = null,
      tools = null, tool_choice = 'auto', parallel_tool_calls = true,
      previous_response_id = null, store = true, metadata = {}, truncation = 'disabled', text = null,
    } = req.body;

    const model = mapModelName(requestModel);
    const authToken = req.authToken;
    console.log('[Responses API] Using token:', authToken ? `${authToken.substring(0, 10)}...${authToken.substring(authToken.length - 5)}` : 'null');

    const messages = inputToMessages(input, instructions);
    if (messages.length === 0) throw new ApiError(400, 'input is required');

    const agentModeHeader = req.headers['x-cursor-agent-mode'];
    const agentMode = agentModeHeader !== 'false';
    if (agentMode) console.log('[Responses API] Agent mode enabled');

    const cursorBody = generateCursorBody(messages, model, { agentMode, tools: [] });
    const cursorResponse = await fetchChatStream(authToken, cursorBody, req);

    if (cursorResponse.status !== 200) {
      throw new ApiError(cursorResponse.status, cursorResponse.statusText);
    }
    const jsonError = await extractJsonError(cursorResponse);
    if (jsonError) {
      throw new ApiError(401, jsonError, null, 'authentication_error');
    }

    const responseId = `resp_${uuidv4().replace(/-/g, '')}`;
    const messageId = `msg_${uuidv4().replace(/-/g, '')}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const baseResponse = {
        id: responseId, object: 'response', created_at: created, status: 'in_progress',
        completed_at: null, error: null, incomplete_details: null, instructions,
        max_output_tokens, model, output: [], parallel_tool_calls, previous_response_id,
        reasoning: { effort: null, summary: null }, store, temperature,
        text: text || { format: { type: 'text' } }, tool_choice, tools: tools || [],
        top_p, truncation, usage: null, user: null, metadata: metadata || {},
      };

      let seqNum = 0;
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data, sequence_number: ++seqNum })}\n\n`);

      emit('response.created', { response: { ...baseResponse } });
      emit('response.in_progress', { response: { ...baseResponse } });
      emit('response.output_item.added', { output_index: 0, item: { id: messageId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
      emit('response.content_part.added', { item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });

      let fullText = '';
      try {
        for await (const chunk of cursorResponse.body) {
          const { text: chunkText } = chunkToUtf8String(chunk);
          if (chunkText.length > 0) {
            fullText += chunkText;
            emit('response.output_text.delta', { item_id: messageId, output_index: 0, content_index: 0, delta: chunkText });
          }
        }

        emit('response.output_text.done', { item_id: messageId, output_index: 0, content_index: 0, text: fullText });
        emit('response.content_part.done', { item_id: messageId, output_index: 0, content_index: 0, part: { type: 'output_text', text: fullText, annotations: [] } });
        emit('response.output_item.done', { output_index: 0, item: { id: messageId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] } });

        const completedResponse = {
          ...baseResponse, status: 'completed', completed_at: Math.floor(Date.now() / 1000),
          output: [{ type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText, annotations: [] }] }],
          usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
        };
        emit('response.completed', { response: completedResponse });
        res.end();
      } catch (streamError) {
        console.error('Responses stream error:', streamError);
        emit('error', { code: 'server_error', message: 'Stream processing error' });
        res.end();
      }
    } else {
      let content = '';
      for await (const chunk of cursorResponse.body) {
        const { text: chunkText } = chunkToUtf8String(chunk);
        content += chunkText;
      }

      return res.json({
        id: responseId, object: 'response', created_at: created, status: 'completed',
        completed_at: Math.floor(Date.now() / 1000), error: null, incomplete_details: null,
        instructions, max_output_tokens, model,
        output: [{ type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] }],
        parallel_tool_calls, previous_response_id, reasoning: { effort: null, summary: null },
        store, temperature, text: text || { format: { type: 'text' } }, tool_choice, tools: tools || [], top_p, truncation,
        usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
        user: null, metadata: metadata || {},
      });
    }
  } catch (error) {
    console.error('Responses error:', error);
    if (!res.headersSent) return next(error);
  }
});

module.exports = router;
