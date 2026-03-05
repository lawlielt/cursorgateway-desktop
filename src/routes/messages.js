const express = require('express');
const router = express.Router();

const { v4: uuidv4 } = require('uuid');
const {
  generateCursorBody,
  chunkToUtf8String,
  CursorStreamDecoder,
  DEFAULT_AGENT_TOOLS,
  MCP_ONLY_TOOLS,
} = require('../utils/utils.js');
const {
  setSseHeaders,
  writeMessageStart,
  writePing,
  writeTextBlockStart,
  writeTextDelta,
  writeToolUseBlock,
  writeContentBlockStop,
  writeMessageDelta,
  writeMessageStop,
  writeSseError,
} = require('../utils/sseWriter.js');
const { mapModelName } = require('../utils/modelMapper.js');
const { saveSession } = require('../utils/sessionLogger.js');
const { toolsToPrompt, formatResponseWithToolCalls, getStopReason, mapCursorToolsToIde, extractWorkingDirectory, filterNonNativeTools } = require('../utils/toolsAdapter.js');
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
const { fetchChatStream, extractJsonError } = require('../services/cursorApi.js');

/**
 * Convert Anthropic Messages API messages to internal format.
 * Anthropic format:
 *   - system: top-level string or array of content blocks
 *   - messages: array of { role: "user"|"assistant", content: string | ContentBlock[] }
 */
function anthropicToMessages(system, anthropicMessages) {
  const messages = [];

  // Handle system prompt
  if (system) {
    if (typeof system === 'string') {
      messages.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      // Array of content blocks
      const systemText = system
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }
  }

  // Handle messages
  if (anthropicMessages && Array.isArray(anthropicMessages)) {
    for (const msg of anthropicMessages) {
      let content = '';
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Content blocks array - extract text and image blocks
        const blockTypes = msg.content.map(b => b.type);
        const hasThinking = blockTypes.includes('thinking') || blockTypes.includes('redacted_thinking');
        if (hasThinking) {
          console.log(`[Messages API] WARNING: ${msg.role} message contains thinking blocks: [${blockTypes.join(', ')}]`);
        }
        const textParts = [];
        for (const block of msg.content) {
          if (block.type === 'thinking' || block.type === 'redacted_thinking') {
            // Explicitly skip thinking blocks - do NOT send to Cursor
            continue;
          } else if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            // Cursor API doesn't support direct image data, add reference
            const mediaType = block.source?.media_type || 'unknown';
            const sourceType = block.source?.type || 'unknown';
            if (sourceType === 'base64') {
              // For base64 images, note their presence (Cursor can't process them directly)
              textParts.push(`[Image attached: ${mediaType}, base64 encoded. Note: Image data cannot be processed directly by Cursor. Please use file path if available.]`);
            } else if (sourceType === 'url') {
              textParts.push(`[Image URL: ${block.source?.url || 'unknown'}]`);
            } else {
              textParts.push(`[Image: ${mediaType}]`);
            }
          } else if (block.type === 'tool_use') {
            // Format as completed action so the model doesn't re-execute it
            const argsSummary = JSON.stringify(block.input);
            textParts.push(`[Already executed tool "${block.name}" with args: ${argsSummary}]`);
          } else if (block.type === 'tool_result') {
            const resultContent = normalizeToolResultContent(block.content);
            textParts.push(`[Tool execution result]: ${resultContent}`);
          }
        }
        content = textParts.join('\n');
      }
      messages.push({ role: msg.role, content });
    }
  }

  return messages;
}

function normalizeToolResultContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('');
  }
  if (content == null) {
    return '';
  }
  return JSON.stringify(content);
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

  if (['bash', 'shell', 'run_terminal_command', 'run_command'].includes(name)) {
    return {
      cursorType: 'shell',
      cursorRequest: {
        command: input.command || '',
        cwd: input.working_directory || input.cwd || process.cwd(),
      },
    };
  }

  if (['read', 'read_file'].includes(name)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return {
      cursorType: 'read',
      cursorRequest: { path },
    };
  }

  // Edit/StrReplace with old_string+new_string: partial file modification
  if ((['edit', 'edit_file', 'strreplace', 'str_replace'].includes(name)) &&
      ('old_string' in input || 'new_string' in input)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return {
      cursorType: 'write',
      cursorRequest: {
        path,
        fileText: '',
        old_string: input.old_string,
        new_string: input.new_string,
      },
    };
  }

  if (['write', 'write_file', 'edit', 'edit_file'].includes(name)) {
    const path = input.file_path || input.path;
    if (!path) return null;
    return {
      cursorType: 'write',
      cursorRequest: {
        path,
        fileText: input.content ?? input.contents ?? input.fileText ?? '',
      },
    };
  }

  if (['ls', 'list_dir', 'list_dir_v2'].includes(name)) {
    return {
      cursorType: 'ls',
      cursorRequest: {
        path: input.path || input.target_directory || process.cwd(),
      },
    };
  }

  if (['grep', 'ripgrep_search', 'grep_search', 'glob', 'glob_file_search', 'pattern_search', 'file_search', 'search'].includes(name)) {
    const pattern = input.pattern || input.query || input.search_query || input.glob_pattern || '*';
    return {
      cursorType: 'grep',
      cursorRequest: {
        pattern,
        path: input.path || input.target_directory || process.cwd(),
        glob: input.glob || input.glob_pattern,
      },
    };
  }

  return null;
}

/**
 * Merge Cursor native tool calls that may be split across chunks,
 * then map them to Anthropic tool_use format.
 */
function mergeCursorNativeToolCalls(cursorToolCalls, hasCustomTools, tools, workingDirectory) {
  const mergedToolCalls = [];
  const toolCallMap = new Map();

  for (const tc of cursorToolCalls) {
    if (!tc.toolCallId) continue;

    if (toolCallMap.has(tc.toolCallId)) {
      const existing = toolCallMap.get(tc.toolCallId);
      if (tc.rawArgs && existing.rawArgs) {
        if (!existing.rawArgs.includes(tc.rawArgs) && !tc.rawArgs.includes(existing.rawArgs)) {
          existing.rawArgs += tc.rawArgs;
        }
      } else if (tc.rawArgs) {
        existing.rawArgs = tc.rawArgs;
      }
      if (tc.name && !existing.name) existing.name = tc.name;
      if (tc.tool && !existing.tool) existing.tool = tc.tool;
    } else {
      const entry = { ...tc };
      toolCallMap.set(tc.toolCallId, entry);
      mergedToolCalls.push(entry);
    }
  }

  const mappedToolCalls = hasCustomTools
    ? mapCursorToolsToIde(mergedToolCalls, tools, workingDirectory)
    : mergedToolCalls;

  const result = [];
  for (const tc of mappedToolCalls) {
    let input = tc.input || {};
    if (!tc.input && tc.rawArgs) {
      try {
        input = JSON.parse(tc.rawArgs);
      } catch (e) {
        console.error('[Messages API] Failed to parse tool args:', tc.rawArgs);
      }
    }
    result.push({
      id: tc.toolCallId || `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
      name: tc.name || `cursor_tool_${tc.tool}`,
      input,
    });
  }
  return result;
}

/**
 * Build a stable key from a chunk's cursor-level identifiers.
 * Used for deduplication across chatStream / continueStream rounds,
 * because Anthropic tool call IDs are regenerated each time.
 */
function getCursorExecKey(chunk) {
  if (chunk.type === 'tool_call' && chunk.execRequest) {
    const er = chunk.execRequest;
    const parts = [];
    if (er.id !== undefined && er.id !== null) parts.push(`id:${er.id}`);
    if (er.execId) parts.push(`execId:${er.execId}`);
    if (parts.length === 0) return null;
    return parts.join('|');
  }
  if (chunk.type === 'tool_call_kv' && chunk.toolUse) {
    return chunk.toolUse.id ? `kv:${chunk.toolUse.id}` : null;
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
    console.log(`[Messages API] Registered KV tool mapping: ${toolUse.name} -> ${mapped.cursorType} (synthetic id=${syntheticId})`);
    return;
  }

  // Unknown KV tool call shape: keep legacy text fallback behavior.
  session.toolCallMapping.set(toolUse.id, {
    cursorId: null,
    cursorExecId: null,
    cursorType: 'text_fallback',
    toolName: toolUse.name,
    toolInput: toolUse.input,
  });
  console.log(`[Messages API] Registered KV tool mapping as text_fallback: ${toolUse.name}`);
}

/**
 * Anthropic Messages API
 * POST /v1/messages
 * https://docs.anthropic.com/en/api/messages/create
 */
router.post('/', async (req, res) => {
  try {
    const {
      model: requestModel,
      messages: anthropicMessages,
      max_tokens,
      system = null,
      stream = false,
      temperature = 1.0,
      top_p = null,
      top_k = null,
      stop_sequences = null,
      metadata = null,
      tools = null,
      tool_choice = null,
    } = req.body;

    // Map external model name to Cursor internal model name
    const model = mapModelName(requestModel);

    // authToken injected by authMiddleware
    const authToken = req.authToken;
    const tokenPreview = authToken.length > 20
      ? `${authToken.substring(0, 15)}...${authToken.substring(authToken.length - 5)}`
      : `${authToken.substring(0, 10)}...`;
    const tokenType = authToken.startsWith('eyJ') ? 'JWT' :
                      authToken.startsWith('user_') ? 'user_id' : 'unknown';
    console.log(`[Messages API] Using token: ${tokenPreview} (${tokenType}, ${authToken.length} chars)`);

    if (!anthropicMessages || !Array.isArray(anthropicMessages) || anthropicMessages.length === 0) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages is required and must be a non-empty array' }
      });
    }

    if (!max_tokens) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens is required' }
      });
    }

    // MCP mode can be enabled via header: x-cursor-mcp-mode: true
    const mcpModeHeader = req.headers['x-cursor-mcp-mode'];
    const useMcpMode = mcpModeHeader === 'true';
    
    // Bidirectional agent mode can be enabled via header: x-cursor-bidi-agent: true
    // Bidirectional Agent Mode - enables proper tool execution with Cursor's Agent API
    // This uses the new AgentClient for tool execution via BidiAppend
    // Can be:
    //   - Explicitly enabled via x-cursor-bidi-agent: true header
    //   - Explicitly disabled via x-cursor-bidi-agent: false header
    //   - Auto-enabled when tools are present (default for Claude Code compatibility)
    const bidiAgentHeader = req.headers['x-cursor-bidi-agent'];
    const hasTools = tools && Array.isArray(tools) && tools.length > 0;
    
    // Auto-enable bidi mode when tools are present, unless explicitly disabled
    let useBidiAgent = bidiAgentHeader === 'false' ? false : (bidiAgentHeader === 'true' || hasTools);
    
    if (useBidiAgent && hasTools) {
      console.log('[Messages API] Bidirectional Agent mode auto-enabled for', tools.length, 'tools');
    }
    
    // Convert tools to prompt and append to system.
    // Only inject non-native tools: native tools (Read/Write/Bash/Grep/etc.) are handled
    // by Cursor's built-in exec system and mapped via execRequestToToolUse.
    // Injecting them as MCP confuses the model, causing loops (e.g. StrReplace).
    let enhancedSystem = system;
    const adapter = req.adapter || null;
    const nonNativeTools = filterNonNativeTools(tools, adapter);
    if (nonNativeTools.length > 0) {
      const toolsPrompt = toolsToPrompt(nonNativeTools, useBidiAgent ? true : useMcpMode);
      if (typeof enhancedSystem === 'string') {
        enhancedSystem = enhancedSystem + toolsPrompt;
      } else if (Array.isArray(enhancedSystem)) {
        enhancedSystem = [...enhancedSystem, { type: 'text', text: toolsPrompt }];
      } else {
        enhancedSystem = toolsPrompt;
      }
      console.log(`[Messages API] Non-native tools injected into prompt: ${nonNativeTools.length}/${tools.length} tools`, (useBidiAgent || useMcpMode) ? '(MCP format)' : '');
      console.log(`[Messages API] Native-covered tools (not injected): ${tools.length - nonNativeTools.length}`);
    } else if (hasTools) {
      console.log(`[Messages API] All ${tools.length} tools are native-covered, no prompt injection needed`);
    }

    const messages = anthropicToMessages(enhancedSystem, anthropicMessages);
    
    // Debug: log the system message that will be sent to Cursor
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg && tools && tools.length > 0) {
      console.log('[Messages API] System prompt length:', systemMsg.content.length);
      console.log('[Messages API] Tools prompt included:', systemMsg.content.includes('[IMPORTANT INSTRUCTION]'));
      // Log first 500 chars of system prompt for debugging
      console.log('[Messages API] System prompt preview:', systemMsg.content.substring(0, 500));
    }

    // Extract working directory from system message for path resolution
    const workingDirectory = extractWorkingDirectory(system, adapter);
    if (workingDirectory) {
      console.log('[Messages API] Working directory:', workingDirectory);
    }
    
    // Agent mode is enabled by default
    // Can be disabled via x-cursor-agent-mode: false header
    const agentModeHeader = req.headers['x-cursor-agent-mode'];
    const agentMode = agentModeHeader === 'false' ? false : true;
    
    if (agentMode) {
      console.log('[Messages API] Agent mode enabled');
    }

    // Strategy for tool handling:
    // - MCP mode: use MCP_ONLY_TOOLS to tell Cursor we support MCP tools
    // - If IDE provides custom tools that don't match Cursor's built-in tools,
    //   we use Ask mode (no supportedTools) and rely on prompt injection.
    // - If IDE tools can be mapped to Cursor tools, we use Agent mode for better results.
    const hasCustomTools = tools && Array.isArray(tools) && tools.length > 0;
    
    // Determine which tools to send to Cursor
    // Use Cursor's native Agent mode (via StreamChat with supportedTools)
    // This makes Cursor return tool_call_v2 which we convert to Anthropic format
    // NOTE: Cursor will report ERROR_USER_ABORTED_REQUEST because we don't send tool_result,
    // but the tool call info is still extracted successfully
    let cursorTools = [];
    let useAgentMode = false;
    
    if (hasCustomTools && !useBidiAgent) {
      // Use Cursor's native tools in Agent mode
      useAgentMode = true;
      cursorTools = DEFAULT_AGENT_TOOLS;
      console.log('[Messages API] Using Cursor Agent mode with', cursorTools.length, 'native tools');
    } else if (hasCustomTools && useBidiAgent) {
      // Experimental: Use bidirectional Agent mode (requires x-cursor-bidi-agent header)
      console.log('[Messages API] Using bidirectional Agent mode for', tools.length, 'tools');
    }

    const messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 20)}`;
    const created = Math.floor(Date.now() / 1000);

    // ==== BIDIRECTIONAL AGENT MODE WITH EXTERNAL TOOL EXECUTION ====
    // This mode returns tool_use to client and waits for tool_result
    // Client (Claude Code) executes tools and sends results back
    if (useBidiAgent && hasCustomTools) {
      console.log('[Messages API] Starting bidirectional agent with external tools...');
      
      // Check if this is a continuation (has tool_result in messages)
      const hasToolResult = anthropicMessages.some(msg => 
        msg.role === 'user' && 
        Array.isArray(msg.content) && 
        msg.content.some(block => block.type === 'tool_result')
      );
      
      if (hasToolResult) {
        console.log('[Messages API] Processing tool_result continuation...');

        // Extract tool results from the latest user message with tool_result blocks
        const userMessagesWithResults = anthropicMessages.filter(msg =>
          msg.role === 'user' &&
          Array.isArray(msg.content) &&
          msg.content.some(block => block.type === 'tool_result')
        );
        const lastUserMsg = userMessagesWithResults[userMessagesWithResults.length - 1];
        const toolResults = lastUserMsg?.content?.filter(block => block.type === 'tool_result') || [];

        // Find active session by header first, then fallback to tool_use_id mapping
        const requestedSessionId = req.headers['x-cursor-session-id'];
        let session = requestedSessionId ? getSession(requestedSessionId) : null;

        if (!session) {
          for (const tr of toolResults) {
            if (!tr.tool_use_id) continue;
            session = findSessionByToolCallId(tr.tool_use_id);
            if (session) break;
          }
        }

        if (session) {
          const hasMappableToolResult = toolResults.some(tr =>
            tr.tool_use_id && session.toolCallMapping.has(tr.tool_use_id)
          );
          if (!hasMappableToolResult) {
            console.log('[Messages API] No mappable tool_result in session, fallback to fresh request with conversation history');
            session = null;
          }
        }

        if (session) {
          // Acquire continuation lock to prevent concurrent requests from
          // competing for the same SSE reader.  Claude Code retries when the
          // proxy is slow, causing duplicate tool_result POSTs.
          if (!session.acquireContinuationLock()) {
            console.log(`[Messages API] Session ${session.sessionId} already has an active continuation, waiting...`);
            try {
              const waitTimeout = 90000; // 90s max wait
              await Promise.race([
                session.waitForContinuation(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('lock timeout')), waitTimeout)),
              ]);
              console.log(`[Messages API] Previous continuation finished, falling through to fresh request`);
            } catch (e) {
              console.log(`[Messages API] Continuation lock wait failed: ${e.message}`);
            }
            // After the previous continuation finishes, fall through to fresh
            // request (the session may have been cleaned up or tool_results
            // already consumed).
            session = null;
          }
        }

        if (session) {
          console.log('[Messages API] Continuing session:', session.sessionId, 'tool_results:', toolResults.length);

          let needsFreshRequest = false;
          let sentToolResultsToCursor = 0;
          try {
            for (const tr of toolResults) {
              if (!tr.tool_use_id) continue;
              const sendResult = await sendSessionToolResult(session, tr.tool_use_id, {
                is_error: !!tr.is_error,
                content: normalizeToolResultContent(tr.content),
              }, { deferResume: true });
              if (sendResult && sendResult.needsFreshRequest) {
                needsFreshRequest = true;
              }
              if (sendResult && sendResult.sentToCursor) {
                sentToolResultsToCursor++;
              }
            }

            // Batch optimization: after sending all tool_results, resume only once.
            if (!needsFreshRequest && sentToolResultsToCursor > 0) {
              await session.agentClient.sendResumeAction();
              console.log(`[Messages API] Resumed session once after ${sentToolResultsToCursor} tool_result(s)`);
            }
          } catch (err) {
            console.error('[Messages API] Failed to send tool results:', err);
            session.releaseContinuationLock();
            return res.status(400).json({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: err.message || 'Failed to process tool_result'
              }
            });
          }

          if (needsFreshRequest) {
            console.log('[Messages API] text_fallback tool results, falling through to fresh request with full history.');
            session.releaseContinuationLock();
            cleanupSession(session.sessionId);
            session = null;
          }
        }

        if (!session) {
          console.log('[Messages API] No active continuation session. Starting a fresh request with full history.');
        } else if (stream) {
          // Delay writing SSE headers until first meaningful content arrives.
          // If the continuation stream fails before any content is sent, we can
          // transparently fall through to a fresh request instead of erroring out.
          let sseHeadersSent = false;
          const ensureSseHeaders = () => {
            if (!sseHeadersSent) {
              setSseHeaders(res);
              res.setHeader('X-Cursor-Session-Id', session.sessionId);
              writeMessageStart(res, messageId, model);
              writePing(res);
              sseHeadersSent = true;
            }
          };

          let fullText = '';
          const toolCalls = [];
          let contentIndex = 0;
          let hasTextBlock = false;
          let staleContinuation = false;

          // Cursor's continuation stream replays the entire response from the
          // start. We must skip text and tool calls already sent to the client.
          const prevSentText = session.sentText || '';
          const prevSentToolCallIds = session.sentToolCallIds || new Set();
          let textAccumulator = ''; // accumulates ALL text (including replayed)

          try {
            for await (const chunk of session.agentClient.continueStream()) {
              if (chunk.type === 'stale_continuation') {
                staleContinuation = true;
                continue;
              }
              if (chunk.type === 'text' && chunk.content) {
                textAccumulator += chunk.content;
                // Only emit the NEW portion that wasn't sent before
                if (textAccumulator.length > prevSentText.length) {
                  const newText = textAccumulator.substring(prevSentText.length);
                  // Reset: once we start emitting new text, update the base
                  if (newText && !prevSentText.startsWith(textAccumulator)) {
                    // text diverged, emit the chunk as-is
                  }
                  if (!hasTextBlock && newText) {
                    ensureSseHeaders();
                    writeTextBlockStart(res, contentIndex);
                    hasTextBlock = true;
                  }
                  if (newText) {
                    fullText += newText;
                    writeTextDelta(res, contentIndex, newText);
                  }
                }
              } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
                // Dedup using cursor-level exec IDs (Anthropic IDs are regenerated)
                const cursorKey = getCursorExecKey(chunk);
                if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) {
                  console.log(`[Messages API] Skipping duplicate exec in continueStream: ${cursorKey}`);
                  continue;
                }
                if (cursorKey) session.sentCursorExecKeys.add(cursorKey);

                const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
                if (!toolUse) continue;

                // Also check Anthropic-level ID (for KV tool calls with stable IDs)
                if (prevSentToolCallIds.has(toolUse.id)) {
                  console.log(`[Messages API] Skipping duplicate tool call by Anthropic ID: ${toolUse.name} (${toolUse.id})`);
                  continue;
                }

                ensureSseHeaders();
                if (hasTextBlock) {
                  writeContentBlockStop(res, contentIndex);
                  contentIndex++;
                  hasTextBlock = false;
                }

                if (chunk.type === 'tool_call_kv') {
                  registerKvToolCallMapping(session, toolUse);
                }
                toolCalls.push(toolUse);

                writeToolUseBlock(res, contentIndex, toolUse);
                contentIndex++;
              } else if (chunk.type === 'error') {
                throw new Error(chunk.error || 'Continue stream failed');
              }
            }

            // If continuation was stale (no new content after replayed FINAL)
            // and we haven't sent SSE headers yet, fall back to fresh request
            if (staleContinuation && !sseHeadersSent && toolCalls.length === 0) {
              console.log('[Messages API] Stale continuation detected (no new model output), falling back to fresh request');
              session.releaseContinuationLock();
              cleanupSession(session.sessionId);
              session = null;
              // Do NOT return — fall through to fresh request path below
            } else {
              ensureSseHeaders();
              if (hasTextBlock) {
                writeContentBlockStop(res, contentIndex);
              }

              // Update session tracking for next continuation
              session.sentText = prevSentText + fullText;
              for (const tc of toolCalls) {
                session.sentToolCallIds.add(tc.id);
              }

              const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
              writeMessageDelta(res, stopReason);
              writeMessageStop(res);

              if (toolCalls.length === 0) {
                session.releaseContinuationLock();
                cleanupSession(session.sessionId);
              } else {
                session.releaseContinuationLock();
              }

              saveSession('messages-bidi-continuation-stream',
                { method: 'POST', path: req.path, headers: req.headers, body: req.body },
                { status: 200, body: { fullText, toolCalls } },
                { model: requestModel, modelMapped: model, bidiAgent: true, stream: true, sessionId: session?.sessionId || 'unknown' }
              );

              res.end();
              return;
            }
          } catch (continuationError) {
            console.error('Bidirectional continuation stream error:', continuationError);
            session.releaseContinuationLock();
            cleanupSession(session.sessionId);

            if (!sseHeadersSent) {
              // No content sent yet — transparently fall through to fresh request
              console.log('[Messages API] Continuation failed before any SSE content was sent, falling through to fresh request');
              session = null;
              // Do NOT return — let execution continue to fresh request path below
            } else {
              // Partial content already sent — must end with error
              console.warn('[Messages API] Continuation failed after partial content, ending with error');
              writeSseError(res, continuationError.message || 'Stream error');
              res.end();
              return;
            }
          }
        } else {
          // Non-stream continuation
          try {
            let fullText = '';
            const toolCalls = [];

            for await (const chunk of session.agentClient.continueStream()) {
              if (chunk.type === 'text' && chunk.content) {
                fullText += chunk.content;
              } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
                const cursorKey = getCursorExecKey(chunk);
                if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) {
                  continue;
                }
                if (cursorKey) session.sentCursorExecKeys.add(cursorKey);
                const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
                if (!toolUse) continue;
                if (chunk.type === 'tool_call_kv') {
                  registerKvToolCallMapping(session, toolUse);
                }
                toolCalls.push(toolUse);
              } else if (chunk.type === 'error') {
                throw new Error(chunk.error || 'Continue stream failed');
              }
            }

            const content = [];
            if (fullText) {
              content.push({ type: 'text', text: fullText });
            }
            for (const toolUse of toolCalls) {
              content.push(toolUse);
            }

            const responseBody = {
              id: messageId,
              type: 'message',
              role: 'assistant',
              content,
              model: model,
              stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            };

            res.setHeader('X-Cursor-Session-Id', session.sessionId);

            if (toolCalls.length === 0) {
              session.releaseContinuationLock();
              cleanupSession(session.sessionId);
            } else {
              session.releaseContinuationLock();
            }

            saveSession('messages-bidi-continuation',
              { method: 'POST', path: req.path, headers: req.headers, body: req.body },
              { status: 200, body: responseBody },
              { model: requestModel, modelMapped: model, bidiAgent: true, stream: false, sessionId: session.sessionId }
            );

            return res.json(responseBody);
          } catch (continuationError) {
            console.error('Bidirectional continuation error:', continuationError);
            session.releaseContinuationLock();
            cleanupSession(session.sessionId);
            // Non-stream: fall through to fresh request transparently
            console.log('[Messages API] Non-stream continuation failed, falling through to fresh request');
            session = null;
          }
        } // end else (non-stream continuation)
      } // end if (hasToolResult)
      
      const agentClient = new AgentClient(authToken, {
        workspacePath: workingDirectory || process.cwd(),
        privacyMode: true,
        adapter: adapter,
      });
      
      // Create session for this conversation
      const session = createSession(agentClient);
      
      // Combine system and user messages into single prompt
      const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
      const userText = messages.filter(m => m.role !== 'system').map(m => {
        const role = m.role === 'user' ? 'Human' : 'Assistant';
        return `${role}: ${m.content}`;
      }).join('\n\n');
      
      const fullMessage = systemText ? `${systemText}\n\n${userText}` : userText;
      
      if (stream) {
        setSseHeaders(res);
        res.setHeader('X-Cursor-Session-Id', session.sessionId);

        writeMessageStart(res, messageId, model);
        writePing(res);

        let fullText = '';
        const toolCalls = [];
        let contentIndex = 0;
        let hasTextBlock = false;
        let streamEnded = false;

        try {
          for await (const chunk of agentClient.chatStream({
            message: fullMessage,
            model: model,
            tools: nonNativeTools,
          })) {
            if (chunk.type === 'text' && chunk.content) {
              if (!hasTextBlock) {
                writeTextBlockStart(res, contentIndex);
                hasTextBlock = true;
              }

              fullText += chunk.content;
              writeTextDelta(res, contentIndex, chunk.content);

            } else if (chunk.type === 'tool_call') {
              // Dedup: skip if this cursor exec was already emitted
              const cursorKey = getCursorExecKey(chunk);
              if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) {
                console.log(`[Messages API] Skipping duplicate exec in chatStream: ${cursorKey}`);
                continue;
              }
              if (cursorKey) session.sentCursorExecKeys.add(cursorKey);

              if (hasTextBlock) {
                writeContentBlockStop(res, contentIndex);
                contentIndex++;
                hasTextBlock = false;
              }

              const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
              toolCalls.push({ execRequest: chunk.execRequest, toolUse, sendResult: chunk.sendResult });

              console.log(`[Messages API] Tool call (external): ${toolUse.name}`, toolUse.input);

              writeToolUseBlock(res, contentIndex, toolUse);
              contentIndex++;
            } else if (chunk.type === 'tool_call_kv') {
              const cursorKey = getCursorExecKey(chunk);
              if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) {
                console.log(`[Messages API] Skipping duplicate KV tool in chatStream: ${cursorKey}`);
                continue;
              }
              if (cursorKey) session.sentCursorExecKeys.add(cursorKey);

              const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
              if (!toolUse) continue;
              registerKvToolCallMapping(session, toolUse);
              toolCalls.push({ execRequest: null, toolUse, sendResult: null });

              console.log(`[Messages API] Tool call (kv): ${toolUse.name}`, toolUse.input);

              if (hasTextBlock) {
                writeContentBlockStop(res, contentIndex);
                contentIndex++;
                hasTextBlock = false;
              }

              writeToolUseBlock(res, contentIndex, toolUse);
              contentIndex++;

            } else if (chunk.type === 'done') {
              // Stream ended
              streamEnded = true;
              console.log('[Messages API] Stream ended');
            } else if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Agent stream failed');
            }
          }
          
          if (hasTextBlock) {
            writeContentBlockStop(res, contentIndex);
          }

          // Always try to parse tool calls from text (e.g. <mcp_tool_use> tags).
          // MCP tools that don't overlap with Cursor's native tools only appear
          // in the text, so this must run even when exec tool calls exist.
          if (hasCustomTools && fullText) {
            const parsed = formatResponseWithToolCalls(fullText, tools);
            if (parsed.toolCalls && parsed.toolCalls.length > 0) {
              // Deduplicate against exec-based tool calls already captured
              const existingNames = new Set(toolCalls.map(tc => tc.toolUse?.name));
              const newTextCalls = parsed.toolCalls.filter(tc => !existingNames.has(tc.name));
              if (newTextCalls.length > 0) {
                console.log('[Messages API] Text-parsed tool calls (bidi stream):', newTextCalls.length,
                  '(filtered from', parsed.toolCalls.length, ')');
                for (const tc of newTextCalls) {
                  const toolUse = { ...tc };
                  session.toolCallMapping.set(toolUse.id, {
                    cursorId: null,
                    cursorExecId: null,
                    cursorType: 'text_fallback',
                    toolName: toolUse.name,
                    toolInput: toolUse.input,
                  });
                  toolCalls.push({ execRequest: null, toolUse, sendResult: null });

                  writeToolUseBlock(res, contentIndex, toolUse);
                  contentIndex++;
                }
              }
            }
          }
          
          const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
          writeMessageDelta(res, stopReason);
          writeMessageStop(res);

          // Track sent content for deduplication in continuation responses
          session.sentText = fullText;
          for (const tc of toolCalls) {
            if (tc.toolUse?.id) session.sentToolCallIds.add(tc.toolUse.id);
          }

          // If there are pending tool calls, keep session alive
          // Otherwise, clean up
          if (toolCalls.length === 0) {
            cleanupSession(session.sessionId);
          } else {
            console.log(`[Messages API] Session ${session.sessionId} has ${toolCalls.length} pending tool calls`);
          }

          saveSession('messages-bidi-external-stream',
            { method: 'POST', path: req.path, headers: req.headers, body: req.body },
            { status: 200, body: { fullText, toolCalls: toolCalls.map(t => t.toolUse) } },
            { model: requestModel, modelMapped: model, bidiAgent: true, stream: true, sessionId: session.sessionId }
          );

          res.end();
          return;
        } catch (streamError) {
          console.error('Bidirectional external stream error:', streamError);
          cleanupSession(session.sessionId);
          writeSseError(res, streamError.message || 'Stream error');
          res.end();
          return;
        }
      } else {
        // Non-streaming mode with external tools
        try {
          let fullText = '';
          const toolCalls = [];
          
          for await (const chunk of agentClient.chatStream({
            message: fullMessage,
            model: model,
            tools: nonNativeTools,
          })) {
            if (chunk.type === 'text' && chunk.content) {
              fullText += chunk.content;
            } else if (chunk.type === 'tool_call' || chunk.type === 'tool_call_kv') {
              const cursorKey = getCursorExecKey(chunk);
              if (cursorKey && session.sentCursorExecKeys.has(cursorKey)) {
                continue;
              }
              if (cursorKey) session.sentCursorExecKeys.add(cursorKey);
              const toolUse = mapAgentChunkToToolUse(chunk, { session, tools, execRequestToToolUse, adapter });
              if (!toolUse) continue;
              if (chunk.type === 'tool_call_kv') {
                registerKvToolCallMapping(session, toolUse);
              }
              toolCalls.push(toolUse);
            } else if (chunk.type === 'error') {
              throw new Error(chunk.error || 'Agent stream failed');
            }
          }

          // Always parse text for MCP tool calls (not just when exec calls are empty)
          if (hasCustomTools && fullText) {
            const parsed = formatResponseWithToolCalls(fullText, tools);
            if (parsed.toolCalls && parsed.toolCalls.length > 0) {
              const existingNames = new Set(toolCalls.map(tc => tc.name));
              const newTextCalls = parsed.toolCalls.filter(tc => !existingNames.has(tc.name));
              if (newTextCalls.length > 0) {
                console.log('[Messages API] Text-parsed tool calls (bidi non-stream):', newTextCalls.length);
                toolCalls.push(...newTextCalls);
              }
            }
          }
          
          // Build content array
          const content = [];
          if (fullText) {
            content.push({ type: 'text', text: fullText });
          }
          for (const toolUse of toolCalls) {
            content.push(toolUse);
          }
          
          const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
          
          const responseBody = {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: content,
            model: model,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
          
          // Include session ID in response header
          res.setHeader('X-Cursor-Session-Id', session.sessionId);

          // Clean up if no pending tool calls
          if (toolCalls.length === 0) {
            cleanupSession(session.sessionId);
          }

          saveSession('messages-bidi-external',
            { method: 'POST', path: req.path, headers: req.headers, body: req.body },
            { status: 200, body: responseBody },
            { model: requestModel, modelMapped: model, bidiAgent: true, stream: false, sessionId: session.sessionId }
          );

          return res.json(responseBody);
        } catch (error) {
          console.error('Bidirectional external chat error:', error);
          cleanupSession(session.sessionId);
          return res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: error.message || 'Internal server error' }
          });
        }
      }
    }
    // ==== LEGACY MODE (no bidirectional communication) ====
    const cursorBody = generateCursorBody(messages, model, {
      agentMode: useAgentMode,
      tools: cursorTools
    });

    const cursorResponse = await fetchChatStream(authToken, cursorBody, req);

    if (cursorResponse.status !== 200) {
      return res.status(cursorResponse.status).json({
        type: 'error',
        error: { type: 'api_error', message: cursorResponse.statusText }
      });
    }

    const jsonError = await extractJsonError(cursorResponse);
    if (jsonError) {
      console.error('[Messages API] Cursor API returned JSON error:', jsonError);
      return res.status(401).json({
        type: 'error',
        error: { type: 'authentication_error', message: jsonError }
      });
    }

    if (stream) {
      setSseHeaders(res);

      writeMessageStart(res, messageId, model);
      writeTextBlockStart(res, 0);
      writePing(res);

      let fullText = '';
      let cursorToolCalls = [];
      const streamDecoder = new CursorStreamDecoder();

      try {
        for await (const chunk of cursorResponse.body) {
          const { text, toolCalls: chunkToolCalls } = streamDecoder.feedData(chunk);
          
          if (chunkToolCalls && chunkToolCalls.length > 0) {
            cursorToolCalls.push(...chunkToolCalls);
          }
          
          if (text.length > 0) {
            fullText += text;
            writeTextDelta(res, 0, text);
          }
        }

        // Get any pending streaming tool calls that didn't get finalized
        const pendingToolCalls = streamDecoder.getPendingStreamingToolCalls();
        if (pendingToolCalls.length > 0) {
          console.log('[Messages API] Adding pending streaming tool calls:', pendingToolCalls.length);
          cursorToolCalls.push(...pendingToolCalls);
        }

        writeContentBlockStop(res, 0);

        // Collect all tool calls from various sources
        let allToolCalls = [];
        
        // 1. First try to parse tool calls from text (for custom tools via prompt injection)
        if (hasCustomTools) {
          const { toolCalls: textToolCalls } = formatResponseWithToolCalls(fullText, tools);
          if (textToolCalls.length > 0) {
            console.log('[Messages API] Text-parsed tool calls:', textToolCalls.length);
            allToolCalls = textToolCalls;
          }
        }
        
        // 2. If no text-parsed tool calls, try Cursor's native tool calls
        if (allToolCalls.length === 0 && cursorToolCalls.length > 0) {
          allToolCalls = mergeCursorNativeToolCalls(cursorToolCalls, hasCustomTools, tools, workingDirectory);
          console.log('[Messages API] Cursor native tool calls (stream):', allToolCalls.length);
        }
        
        const hasToolCalls = allToolCalls.length > 0;
        
        for (let i = 0; i < allToolCalls.length; i++) {
          writeToolUseBlock(res, i + 1, allToolCalls[i]);
        }

        writeMessageDelta(res, getStopReason(hasToolCalls));
        writeMessageStop(res);

        // Save session log for streaming
        saveSession('messages-stream',
          { method: 'POST', path: req.path, headers: req.headers, body: req.body },
          { status: 200, body: { fullText, hasToolCalls } },
          { model: requestModel, modelMapped: model, agentMode, stream: true, hasToolCalls }
        );

        res.end();
      } catch (streamError) {
        console.error('Messages stream error:', streamError);
        saveSession('messages-stream',
          { method: 'POST', path: req.path, headers: req.headers, body: req.body },
          { status: 500, error: streamError.message },
          { model: requestModel, modelMapped: model, agentMode, stream: true }
        );
        writeSseError(res, 'Stream processing error');
        res.end();
      }
    } else {
      // Non-streaming response
      const startTime = Date.now();
      try {
        let rawContent = '';
        let cursorToolCalls = [];
        
        for await (const chunk of cursorResponse.body) {
          const { text, toolCalls: chunkToolCalls } = chunkToUtf8String(chunk);
          rawContent += text;
          if (chunkToolCalls && chunkToolCalls.length > 0) {
            cursorToolCalls.push(...chunkToolCalls);
          }
        }

        // Collect all tool calls from various sources
        let allToolCalls = [];
        let content = [];
        
        // 1. First try to parse tool calls from text (for custom tools via prompt injection)
        if (hasCustomTools) {
          const result = formatResponseWithToolCalls(rawContent, tools);
          if (result.toolCalls.length > 0) {
            console.log('[Messages API] Text-parsed tool calls (non-stream):', result.toolCalls.length);
            allToolCalls = result.toolCalls;
            content = result.content;
          }
        }
        
        // 2. If no text-parsed tool calls, try Cursor's native tool calls
        if (allToolCalls.length === 0 && cursorToolCalls.length > 0) {
          allToolCalls = mergeCursorNativeToolCalls(cursorToolCalls, hasCustomTools, tools, workingDirectory);
          console.log('[Messages API] Cursor native tool calls (non-stream):', allToolCalls.length);
        }
        
        // 3. Build content if not already built
        if (content.length === 0) {
          if (rawContent) {
            content.push({ type: 'text', text: rawContent });
          }
          for (const tc of allToolCalls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
          }
        }
        
        const hasToolCalls = allToolCalls.length > 0;

        const responseBody = {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: content,
          model: model,
          stop_reason: getStopReason(hasToolCalls),
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        };

        // Save session log
        saveSession('messages', 
          { method: 'POST', path: req.path, headers: req.headers, body: req.body },
          { status: 200, body: responseBody, rawContent },
          { model: requestModel, modelMapped: model, agentMode, stream: false, duration: Date.now() - startTime, hasToolCalls }
        );

        return res.json(responseBody);
      } catch (error) {
        console.error('Messages non-stream error:', error);
        saveSession('messages',
          { method: 'POST', path: req.path, headers: req.headers, body: req.body },
          { status: 500, error: error.message },
          { model: requestModel, modelMapped: model, agentMode, stream: false }
        );
        return res.status(500).json({
          type: 'error',
          error: { type: 'api_error', message: 'Internal server error' }
        });
      }
    }
  } catch (error) {
    console.error('Messages error:', error);
    saveSession('messages',
      { method: 'POST', path: req.path, headers: req.headers, body: req.body },
      { status: 500, error: error.message },
      {}
    );
    if (!res.headersSent) {
      return res.status(500).json({
        type: 'error',
        error: { type: 'api_error', message: 'Internal server error' }
      });
    }
  }
});

module.exports = router;
