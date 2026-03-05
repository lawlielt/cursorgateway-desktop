const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const $root = require('../proto/message.js');
const {
  generateCursorBody,
  chunkToUtf8String,
  CursorStreamDecoder,
  DEFAULT_AGENT_TOOLS,
  MCP_ONLY_TOOLS,
} = require('../utils/utils.js');
const { mapModelName } = require('../utils/modelMapper.js');
const { saveSession } = require('../utils/sessionLogger.js');
const { fetchAvailableModels, fetchChatStream, extractJsonError } = require('../services/cursorApi.js');
const { ApiError } = require('../middleware/errorHandler.js');
const {
  toolsToPrompt,
  formatResponseWithToolCalls,
  getStopReason,
  mapCursorToolsToIde,
  extractWorkingDirectory,
  filterNonNativeTools,
} = require('../utils/toolsAdapter.js');
const { AgentClient } = require('../utils/agentClient.js');
const { mapAgentChunkToToolUse } = require('../utils/bidiToolFlowAdapter.js');
const {
  createSession,
  getSession,
  findSessionByToolCallId,
  cleanupSession,
  execRequestToToolUse,
  sendToolResult: sendSessionToolResult,
} = require('../utils/sessionManager.js');
const openaiSse = require('../utils/sseWriterOpenAI.js');
const crypto = require('crypto');

const activeRequests = new Map();
const DEDUP_WINDOW_MS = 10000;

function getRequestFingerprint(messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const content = lastUserMsg ? JSON.stringify(lastUserMsg.content) : '';
  return crypto.createHash('md5').update(content).digest('hex').substring(0, 16);
}

router.get("/models", async (req, res, next) => {
  try {
    const response = await fetchAvailableModels(req.authToken, req);
    const data = await response.arrayBuffer();
    const buffer = Buffer.from(data);
    try {
      const models = $root.AvailableModelsResponse.decode(buffer).models;
      return res.json({
        object: "list",
        data: models.map(model => ({
          id: model.name,
          created: Date.now(),
          object: 'model',
          owned_by: 'cursor'
        }))
      });
    } catch (error) {
      throw new ApiError(500, buffer.toString('utf-8'));
    }
  } catch (error) {
    next(error);
  }
});

// ── OpenAI message format helpers ──────────────────────────────────────

/**
 * Convert OpenAI messages array to the internal flat text format consumed by
 * AgentClient.chatStream().
 */
function openaiToFlatPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role;
    const content = flattenContent(msg.content);

    if (role === 'system') {
      parts.push(content);
    } else if (role === 'assistant') {
      parts.push(`Assistant: ${content}`);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function || {};
          parts.push(`[Already executed tool "${fn.name}" with args: ${fn.arguments || '{}'}]`);
        }
      }
    } else if (role === 'tool') {
      parts.push(`[Tool execution result (tool_call_id=${msg.tool_call_id})]: ${content}`);
    } else {
      parts.push(`Human: ${content}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * Flatten OpenAI content (string | array of parts) to a plain string.
 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        if (part.type === 'image_url') return `[Image: ${part.image_url?.url || 'unknown'}]`;
        return '';
      })
      .join('\n');
  }
  return String(content);
}

/**
 * Detect whether this is a continuation request: the last assistant message
 * that has tool_calls is followed by tool-role messages (and no later
 * assistant message supersedes it).
 */
function hasToolResults(messages) {
  // Find the last assistant message with tool_calls
  let lastToolAssistantIdx = -1;
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      if (lastAssistantIdx < 0) lastAssistantIdx = i;
      if (lastToolAssistantIdx < 0 && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
        lastToolAssistantIdx = i;
      }
      if (lastAssistantIdx >= 0 && lastToolAssistantIdx >= 0) break;
    }
  }
  // If the last assistant message is newer than the last tool-calling one,
  // the tool round was already completed — this is NOT a continuation.
  if (lastToolAssistantIdx < 0) return false;
  if (lastAssistantIdx > lastToolAssistantIdx) return false;

  // Check if there are tool-role messages after the tool-calling assistant
  for (let j = lastToolAssistantIdx + 1; j < messages.length; j++) {
    if (messages[j].role === 'tool') return true;
  }
  return false;
}

/**
 * Extract tool results from the LATEST round only.
 *
 * OpenAI multi-turn format places tool results as `role: "tool"` messages
 * throughout the conversation history. We must only extract results that
 * correspond to the LAST assistant tool_calls, not historical ones.
 */
function extractToolResults(messages) {
  // Find the last assistant message with tool_calls
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls) && messages[i].tool_calls.length > 0) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx < 0) return [];

  // Collect the tool_call IDs from that assistant message
  const pendingIds = new Set(
    messages[lastAssistantIdx].tool_calls.map(tc => tc.id)
  );

  // Only extract tool results that match those IDs (after the assistant msg)
  const results = [];
  for (let i = lastAssistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && pendingIds.has(msg.tool_call_id)) {
      results.push({
        tool_use_id: msg.tool_call_id,
        content: flattenContent(msg.content),
        is_error: false,
      });
    }
  }
  return results;
}

/**
 * Extract system message text from OpenAI messages (may be a string or array).
 */
function extractSystemText(messages) {
  return messages
    .filter(m => m.role === 'system')
    .map(m => flattenContent(m.content))
    .join('\n');
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

// Cursor exec key for deduplication (same logic as messages.js)
function getCursorExecKey(chunk) {
  if (chunk.type === 'tool_call' && chunk.execRequest) {
    const er = chunk.execRequest;
    const parts = [];
    if (er.id !== undefined && er.id !== null) parts.push(`id:${er.id}`);
    if (er.execId) parts.push(`execId:${er.execId}`);
    return parts.length ? parts.join('|') : null;
  }
  if (chunk.type === 'tool_call_kv' && chunk.toolUse) {
    return chunk.toolUse.id ? `kv:${chunk.toolUse.id}` : null;
  }
  return null;
}

function normalizeKvToolName(name) {
  return String(name || '').trim().toLowerCase();
}

function nextSyntheticCursorId(session) {
  if (!session) return 900000001;
  if (typeof session.syntheticCursorId !== 'number' || !Number.isFinite(session.syntheticCursorId)) {
    session.syntheticCursorId = 900000000;
  }
  session.syntheticCursorId += 1;
  return session.syntheticCursorId;
}

function resolveKvCursorMapping(toolUse) {
  if (!toolUse || typeof toolUse !== 'object') return null;
  const name = normalizeKvToolName(toolUse.name);
  const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  if (!name) return null;

  if (['bash', 'shell', 'run_terminal_command', 'run_command', 'exec'].includes(name)) {
    return {
      cursorType: 'shell',
      cursorRequest: {
        command: input.command || '',
        cwd: input.working_directory || input.working_dir || input.cwd || process.cwd(),
      },
    };
  }

  if (['read', 'read_file', 'file_read'].includes(name)) {
    const path = input.file_path || input.path || input.target_file;
    if (!path) return null;
    return { cursorType: 'read', cursorRequest: { path } };
  }

  if ((['edit', 'edit_file', 'strreplace', 'str_replace'].includes(name)) &&
      ('old_string' in input || 'new_string' in input)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return {
      cursorType: 'write',
      cursorRequest: { path, fileText: '', old_string: input.old_string, new_string: input.new_string },
    };
  }

  if (['write', 'write_file', 'file_write', 'edit', 'edit_file'].includes(name)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return {
      cursorType: 'write',
      cursorRequest: { path, fileText: input.content ?? input.contents ?? input.fileText ?? '' },
    };
  }

  if (['ls', 'list_dir', 'list_dir_v2'].includes(name)) {
    return {
      cursorType: 'ls',
      cursorRequest: { path: input.path || input.target_directory || process.cwd() },
    };
  }

  if (['grep', 'ripgrep_search', 'grep_search', 'glob', 'glob_file_search',
       'pattern_search', 'file_search', 'search'].includes(name)) {
    return {
      cursorType: 'grep',
      cursorRequest: {
        pattern: input.pattern || input.query || input.search_query || input.glob_pattern || '*',
        path: input.path || input.target_directory || process.cwd(),
        glob: input.glob || input.glob_pattern,
      },
    };
  }

  if (['delete', 'delete_file', 'file_delete'].includes(name)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return { cursorType: 'delete', cursorRequest: { path } };
  }

  return null;
}

function registerKvToolCallMapping(session, toolUse) {
  if (!session || !toolUse || !toolUse.id) return;
  if (session.toolCallMapping.has(toolUse.id)) return;

  const mapped = resolveKvCursorMapping(toolUse);
  if (mapped) {
    const syntheticId = nextSyntheticCursorId(session);
    session.toolCallMapping.set(toolUse.id, {
      cursorId: syntheticId,
      cursorExecId: toolUse.id,
      cursorType: mapped.cursorType,
      cursorRequest: mapped.cursorRequest,
      kvMapped: true,
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });
    return;
  }

  session.toolCallMapping.set(toolUse.id, {
    cursorId: null,
    cursorExecId: null,
    cursorType: 'text_fallback',
    toolName: toolUse.name,
    toolInput: toolUse.input,
  });
}

// ── Main route ─────────────────────────────────────────────────────────

router.post('/chat/completions', async (req, res, next) => {
  try {
    const { model: requestModel, messages, stream = false, tools = null } = req.body;
    const model = mapModelName(requestModel);
    const authToken = req.authToken;
    const adapter = req.adapter || null;
    const agentMode = tools && Array.isArray(tools) && tools.length > 0;

    console.log('[v1/chat] model=%s stream=%s tools=%d adapter=%s',
      model, stream, tools?.length || 0, adapter?.clientType || 'none');

    // DEBUG: dump message roles and tool-related content for diagnosis
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const contentPreview = typeof m.content === 'string'
        ? m.content.substring(0, 80)
        : Array.isArray(m.content)
          ? `[${m.content.length} parts]`
          : String(m.content).substring(0, 80);
      let extra = '';
      if (m.tool_call_id) extra += ` tool_call_id=${m.tool_call_id}`;
      if (Array.isArray(m.tool_calls)) {
        extra += ` tool_calls=[${m.tool_calls.map(tc => `${tc.id}:${tc.function?.name}`).join(', ')}]`;
      }
      console.log(`[v1/chat] msg[${i}] role=${m.role} content=${contentPreview}${extra}`);
    }

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new ApiError(400, 'Invalid request. Messages should be a non-empty array');
    }

    // ── Agent mode with proper AgentClient ──────────────────────────
    if (agentMode) {
      const systemText = extractSystemText(messages);
      const workingDirectory = extractWorkingDirectory(systemText, adapter) || process.cwd();
      const nonNativeTools = filterNonNativeTools(tools, adapter);
      const allToolNames = tools.map(t => t.function?.name || t.name || '?');
      const nonNativeNames = nonNativeTools.map(t => t.function?.name || t.name || '?');
      console.log('[v1/chat] All tools (%d): %s', allToolNames.length, allToolNames.join(', '));
      console.log('[v1/chat] Non-native tools (%d): %s', nonNativeNames.length, nonNativeNames.join(', '));
      console.log('[v1/chat] Native-covered (%d): %s', allToolNames.length - nonNativeNames.length,
        allToolNames.filter(n => !nonNativeNames.includes(n)).join(', '));
      const responseId = `chatcmpl-${uuidv4()}`;

      // Check if this is a continuation (contains tool role messages)
      const isContinuation = hasToolResults(messages);

      if (isContinuation) {
        const toolResults = extractToolResults(messages);
        console.log('[v1/chat] Tool results from client:', toolResults.map(tr =>
          `id=${tr.tool_use_id} content=${String(tr.content).substring(0, 60)}`
        ));

        let session = null;
        const requestedSessionId = req.headers['x-openai-session-id'] || req.headers['x-cursor-session-id'];
        if (requestedSessionId) {
          session = getSession(requestedSessionId);
        }
        if (!session) {
          for (const tr of toolResults) {
            if (!tr.tool_use_id) continue;
            session = findSessionByToolCallId(tr.tool_use_id);
            if (session) break;
          }
        }

        if (session) {
          const hasMappableResult = toolResults.some(tr =>
            tr.tool_use_id && session.toolCallMapping.has(tr.tool_use_id)
          );
          if (!hasMappableResult) {
            console.log('[v1/chat] No mappable tool_result, fallback to fresh request');
            session = null;
          }
        }

        if (session) {
          if (!session.acquireContinuationLock()) {
            console.log('[v1/chat] Session locked, waiting...');
            try {
              await Promise.race([
                session.waitForContinuation(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('lock timeout')), 90000)),
              ]);
            } catch (e) {
              console.log('[v1/chat] Lock wait failed:', e.message);
            }
            session = null;
          }
        }

        if (session) {
          const hasMappableResult = toolResults.some(tr =>
            tr.tool_use_id && session.toolCallMapping.has(tr.tool_use_id)
          );
          if (!hasMappableResult) {
            console.log('[v1/chat] No mappable tool_result in session, fallback to fresh request');
            session = null;
          }
        }

        if (session) {
          console.log('[v1/chat] Continuing session:', session.sessionId, 'results:', toolResults.length);

          let needsFreshRequest = false;
          let sentCount = 0;
          try {
            for (const tr of toolResults) {
              if (!tr.tool_use_id) continue;
              // Skip tool_results not registered in this session
              if (!session.toolCallMapping.has(tr.tool_use_id)) {
                console.log('[v1/chat] Skipping unregistered tool_result:', tr.tool_use_id);
                continue;
              }
              const sendResult = await sendSessionToolResult(session, tr.tool_use_id, {
                is_error: !!tr.is_error,
                content: normalizeToolResultContent(tr.content),
              }, { deferResume: true });
              if (sendResult?.needsFreshRequest) needsFreshRequest = true;
              if (sendResult?.sentToCursor) sentCount++;
            }
            if (!needsFreshRequest && sentCount > 0) {
              await session.agentClient.sendResumeAction();
            }
          } catch (err) {
            console.error('[v1/chat] Failed to send tool results:', err);
            session.releaseContinuationLock();
            throw new ApiError(400, err.message || 'Failed to process tool results');
          }

          if (needsFreshRequest) {
            session.releaseContinuationLock();
            cleanupSession(session.sessionId);
            session = null;
          }
        }

        if (session) {
          // ── Continuation stream ───────────────────────────────────
          try {
            const result = await streamContinuation(res, session, {
              responseId, model, stream, tools, adapter,
            });
            session.releaseContinuationLock();
            if (result.toolCalls.length === 0) {
              cleanupSession(session.sessionId);
            }
            return;
          } catch (continuationError) {
            console.error('[v1/chat] Continuation error:', continuationError);
            session.releaseContinuationLock();
            cleanupSession(session.sessionId);

            if (res.headersSent) {
              // Partial content already sent — must end with error
              openaiSse.writeError(res, continuationError.message || 'Stream error');
              openaiSse.writeDone(res);
              res.end();
              return;
            }
            // No content sent yet — fall through to fresh request
            session = null;
          }
        }

        if (!session) {
          console.log('[v1/chat] No active session, starting fresh request with history');
        }
      }

      // ── Fresh request ─────────────────────────────────────────────
      const fingerprint = getRequestFingerprint(messages);
      const existingReq = activeRequests.get(fingerprint);
      if (existingReq && Date.now() - existingReq.timestamp < DEDUP_WINDOW_MS) {
        console.log('[v1/chat] Duplicate fresh request detected (fingerprint=%s, age=%dms), waiting for existing',
          fingerprint, Date.now() - existingReq.timestamp);
        try {
          await Promise.race([
            existingReq.promise,
            new Promise((_, rej) => setTimeout(() => rej(new Error('dedup wait timeout')), 90000)),
          ]);
        } catch {}
        if (!res.headersSent) {
          openaiSse.setSseHeaders(res);
          openaiSse.writeError(res, 'Request was deduplicated, please retry');
          openaiSse.writeDone(res);
          res.end();
        }
        return;
      }

      let resolveActiveRequest;
      const activePromise = new Promise(resolve => { resolveActiveRequest = resolve; });
      activeRequests.set(fingerprint, { timestamp: Date.now(), promise: activePromise });

      let enhancedSystemText = systemText;
      if (nonNativeTools.length > 0) {
        const toolsPrompt = toolsToPrompt(nonNativeTools, true);
        enhancedSystemText = systemText ? systemText + toolsPrompt : toolsPrompt;
      }

      const cleanupDedup = () => {
        activeRequests.delete(fingerprint);
        if (resolveActiveRequest) resolveActiveRequest();
      };

      const agentClient = new AgentClient(authToken, {
        workspacePath: workingDirectory,
        privacyMode: true,
        adapter,
      });
      const session = createSession(agentClient);

      // Build flat prompt from messages (with enhanced system)
      const nonSystemMessages = messages.filter(m => m.role !== 'system');
      const promptParts = [];
      if (enhancedSystemText) promptParts.push(enhancedSystemText);
      for (const msg of nonSystemMessages) {
        const content = flattenContent(msg.content);
        if (msg.role === 'assistant') {
          promptParts.push(`Assistant: ${content}`);
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              const fn = tc.function || {};
              promptParts.push(`[Already executed tool "${fn.name}" with args: ${fn.arguments || '{}'}]`);
            }
          }
        } else if (msg.role === 'tool') {
          promptParts.push(`[Tool execution result (tool_call_id=${msg.tool_call_id})]: ${flattenContent(msg.content)}`);
        } else {
          promptParts.push(`Human: ${content}`);
        }
      }
      const fullMessage = promptParts.join('\n\n');

      if (stream) {
        openaiSse.setSseHeaders(res);
        if (session.sessionId) {
          res.setHeader('X-Session-Id', session.sessionId);
        }
        openaiSse.writeRoleChunk(res, responseId, model);

        let fullText = '';
        const toolCalls = [];
        let toolCallIndex = 0;

        try {
          for await (const chunk of agentClient.chatStream({
            message: fullMessage,
            model,
            tools: nonNativeTools,
          })) {
            if (chunk.type === 'text' && chunk.content) {
              fullText += chunk.content;
              openaiSse.writeTextDelta(res, responseId, model, chunk.content);
            } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
              const cursorKey = getCursorExecKey(chunk);
              if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) continue;
              if (cursorKey) session.sentCursorExecKeys.add(cursorKey);

              const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
              if (!toolUse) continue;

              if (chunk.type === 'tool_call_kv') {
                registerKvToolCallMapping(session, toolUse);
              }
              toolCalls.push(toolUse);
              console.log('[v1/chat] Emitting tool_call: id=%s name=%s registered=%s',
                toolUse.id, toolUse.name, session.toolCallMapping.has(toolUse.id));

              openaiSse.writeToolCallChunk(res, responseId, model, toolCallIndex, toolUse);
              toolCallIndex++;
            } else if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Agent stream failed');
            }
          }

          // Parse text for MCP tool calls (text_fallback mechanism)
          if (nonNativeTools.length > 0 && fullText) {
            console.log('[v1/chat] Parsing text for MCP tool calls, text length=%d', fullText.length);
            const parsed = formatResponseWithToolCalls(fullText, tools);
            if (parsed.toolCalls?.length > 0) {
              console.log('[v1/chat] Found %d text-parsed tool calls: %s',
                parsed.toolCalls.length, parsed.toolCalls.map(tc => tc.name).join(', '));
              const existingNames = new Set(toolCalls.map(tc => tc.name));
              for (const tc of parsed.toolCalls) {
                if (existingNames.has(tc.name)) continue;
                session.toolCallMapping.set(tc.id, {
                  cursorId: null, cursorExecId: null,
                  cursorType: 'text_fallback',
                  toolName: tc.name, toolInput: tc.input,
                });
                toolCalls.push(tc);
                openaiSse.writeToolCallChunk(res, responseId, model, toolCallIndex, tc);
                toolCallIndex++;
              }
            }
          }

          session.sentText = fullText;
          for (const tc of toolCalls) {
            if (tc.id) session.sentToolCallIds.add(tc.id);
          }

          const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
          openaiSse.writeFinish(res, responseId, model, finishReason);
          openaiSse.writeDone(res);

          if (toolCalls.length === 0) {
            cleanupSession(session.sessionId);
          } else {
            console.log('[v1/chat] Session %s has %d pending tool calls', session.sessionId, toolCalls.length);
          }

          cleanupDedup();
          res.end();
          return;
        } catch (streamError) {
          console.error('[v1/chat] Stream error:', streamError);
          cleanupSession(session.sessionId);
          cleanupDedup();
          openaiSse.writeError(res, streamError.message || 'Stream error');
          openaiSse.writeDone(res);
          res.end();
          return;
        }
      } else {
        // Non-streaming fresh request
        try {
          let fullText = '';
          const toolCalls = [];

          for await (const chunk of agentClient.chatStream({
            message: fullMessage,
            model,
            tools: nonNativeTools,
          })) {
            if (chunk.type === 'text' && chunk.content) {
              fullText += chunk.content;
            } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
              const cursorKey = getCursorExecKey(chunk);
              if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) continue;
              if (cursorKey) session.sentCursorExecKeys.add(cursorKey);
              const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
              if (!toolUse) continue;
              if (chunk.type === 'tool_call_kv') registerKvToolCallMapping(session, toolUse);
              toolCalls.push(toolUse);
            } else if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Agent stream failed');
            }
          }

          if (nonNativeTools.length > 0 && fullText) {
            const parsed = formatResponseWithToolCalls(fullText, tools);
            if (parsed.toolCalls?.length > 0) {
              const existingNames = new Set(toolCalls.map(tc => tc.name));
              for (const tc of parsed.toolCalls) {
                if (!existingNames.has(tc.name)) toolCalls.push(tc);
              }
            }
          }

          if (toolCalls.length === 0) cleanupSession(session.sessionId);
          cleanupDedup();
          res.setHeader('X-Session-Id', session.sessionId);
          return res.json(openaiSse.buildCompletionResponse(responseId, model, fullText, toolCalls));
        } catch (error) {
          console.error('[v1/chat] Non-stream error:', error);
          cleanupSession(session.sessionId);
          cleanupDedup();
          throw new ApiError(500, error.message);
        }
      }
    }

    // ── Non-agent mode: regular unidirectional streaming ────────────
    const internalMessages = messages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      content: flattenContent(m.content),
    }));
    const cursorBody = generateCursorBody(internalMessages, model, { agentMode: false, tools: [] });
    const response = await fetchChatStream(authToken, cursorBody, req);

    if (response.status !== 200) {
      throw new ApiError(response.status, response.statusText);
    }

    const jsonError = await extractJsonError(response);
    if (jsonError) {
      throw new ApiError(401, jsonError, null, 'authentication_error');
    }

    if (stream) {
      const responseId = `chatcmpl-${uuidv4()}`;
      openaiSse.setSseHeaders(res);

      try {
        for await (const chunk of response.body) {
          const { text } = chunkToUtf8String(chunk);
          if (text.length > 0) {
            openaiSse.writeTextDelta(res, responseId, model, text);
          }
        }
      } catch (streamError) {
        console.error('[v1/chat] Stream error:', streamError);
        openaiSse.writeError(res, streamError.message || 'Stream error');
      } finally {
        openaiSse.writeFinish(res, responseId, model, 'stop');
        openaiSse.writeDone(res);
        res.end();
      }
    } else {
      try {
        let content = '';
        for await (const chunk of response.body) {
          const { text } = chunkToUtf8String(chunk);
          content += text;
        }
        return res.json(openaiSse.buildCompletionResponse(`chatcmpl-${uuidv4()}`, model, content));
      } catch (error) {
        console.error('[v1/chat] Non-stream error:', error);
        if (error.name === 'TimeoutError') throw new ApiError(408, 'Server response timeout');
        throw error;
      }
    }
  } catch (error) {
    console.error('[v1/chat] Error:', error);
    if (!res.headersSent) {
      if (req.body?.stream) {
        openaiSse.setSseHeaders(res);
        openaiSse.writeError(res, error.message || 'Internal server error');
        openaiSse.writeDone(res);
        return res.end();
      }
      next(error);
    }
  }
});

/**
 * Stream a continuation response (after tool results are sent).
 * Works for both streaming and non-streaming modes.
 */
async function streamContinuation(res, session, opts) {
  const { responseId, model, stream, tools, adapter } = opts;

  const prevSentText = session.sentText || '';
  const prevSentToolCallIds = session.sentToolCallIds || new Set();
  let textAccumulator = '';
  let fullText = '';
  const toolCalls = [];
  let toolCallIndex = 0;

  // Delay SSE headers until first meaningful content arrives.
  // If continuation fails before any content, caller can fall through to fresh request.
  let sseHeadersSent = false;
  const ensureSseHeaders = () => {
    if (stream && !sseHeadersSent) {
      openaiSse.setSseHeaders(res);
      res.setHeader('X-Session-Id', session.sessionId);
      openaiSse.writeRoleChunk(res, responseId, model);
      sseHeadersSent = true;
    }
  };

  for await (const chunk of session.agentClient.continueStream()) {
    if (chunk.type === 'text' && chunk.content) {
      textAccumulator += chunk.content;
      if (textAccumulator.length > prevSentText.length) {
        const newText = textAccumulator.substring(prevSentText.length);
        if (newText) {
          fullText += newText;
          if (stream) {
            ensureSseHeaders();
            openaiSse.writeTextDelta(res, responseId, model, newText);
          }
        }
      }
    } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
      const cursorKey = getCursorExecKey(chunk);
      if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) continue;
      if (cursorKey) session.sentCursorExecKeys.add(cursorKey);

      const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
      if (!toolUse) continue;
      if (prevSentToolCallIds.has(toolUse.id)) continue;

      if (chunk.type === 'tool_call_kv') registerKvToolCallMapping(session, toolUse);
      toolCalls.push(toolUse);

      if (stream) {
        ensureSseHeaders();
        openaiSse.writeToolCallChunk(res, responseId, model, toolCallIndex, toolUse);
        toolCallIndex++;
      }
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error || 'Continue stream failed');
    }
  }

  session.sentText = prevSentText + fullText;
  for (const tc of toolCalls) {
    if (tc.id) session.sentToolCallIds.add(tc.id);
  }

  if (stream) {
    ensureSseHeaders();
    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    openaiSse.writeFinish(res, responseId, model, finishReason);
    openaiSse.writeDone(res);
    res.end();
  } else {
    res.setHeader('X-Session-Id', session.sessionId);
    res.json(openaiSse.buildCompletionResponse(responseId, model, fullText, toolCalls));
  }

  return { fullText, toolCalls };
}

module.exports = router;
