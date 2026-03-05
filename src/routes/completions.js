const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { generateCursorBody, chunkToUtf8String } = require('../utils/utils.js');
const { mapModelName } = require('../utils/modelMapper.js');
const { fetchChatStream, extractJsonError } = require('../services/cursorApi.js');
const { ApiError } = require('../middleware/errorHandler.js');

/**
 * OpenAI Legacy Completions API
 * POST /v1/completions
 */
router.post('/completions', async (req, res, next) => {
  try {
    const {
      model: requestModel, prompt, echo = false, stream = false,
    } = req.body;
    const authToken = req.authToken;

    console.log('[Completions API] Using token:', authToken ? `${authToken.substring(0, 10)}...${authToken.substring(authToken.length - 5)}` : 'null');

    if (!prompt) {
      throw new ApiError(400, 'Invalid request. prompt is required');
    }

    const model = mapModelName(requestModel);

    const prompts = Array.isArray(prompt) ? prompt : [prompt];
    const promptText = typeof prompts[0] === 'string' ? prompts[0] : prompts[0].toString();
    const messages = [{ role: 'user', content: promptText }];

    const agentModeHeader = req.headers['x-cursor-agent-mode'];
    const agentMode = agentModeHeader !== 'false';
    if (agentMode) console.log('[Completions API] Agent mode enabled');

    const cursorBody = generateCursorBody(messages, model, { agentMode, tools: [] });
    const response = await fetchChatStream(authToken, cursorBody, req);

    if (response.status !== 200) {
      throw new ApiError(response.status, response.statusText);
    }

    const jsonError = await extractJsonError(response);
    if (jsonError) {
      throw new ApiError(401, jsonError, null, 'authentication_error');
    }

    const completionId = `cmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      try {
        for await (const chunk of response.body) {
          const { text } = chunkToUtf8String(chunk);
          if (text.length > 0) {
            res.write(`data: ${JSON.stringify({
              id: completionId, object: 'text_completion', created, model,
              choices: [{ text, index: 0, logprobs: null, finish_reason: null }],
            })}\n\n`);
          }
        }
        res.write(`data: ${JSON.stringify({
          id: completionId, object: 'text_completion', created, model,
          choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (streamError) {
        console.error('Completions stream error:', streamError);
        res.write(`data: ${JSON.stringify({ error: { message: 'Stream processing error', type: 'server_error' } })}\n\n`);
        res.end();
      }
    } else {
      let content = '';
      for await (const chunk of response.body) {
        const { text } = chunkToUtf8String(chunk);
        content += text;
      }

      const outputText = echo ? promptText + content : content;
      return res.json({
        id: completionId, object: 'text_completion', created, model,
        system_fingerprint: `fp_${uuidv4().replace(/-/g, '').substring(0, 12)}`,
        choices: [{ text: outputText, index: 0, logprobs: null, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (error) {
    console.error('Completions error:', error);
    if (!res.headersSent) return next(error);
  }
});

module.exports = router;
