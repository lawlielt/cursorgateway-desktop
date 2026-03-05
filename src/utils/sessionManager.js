/**
 * Session Manager
 * Manages active Cursor sessions for multi-turn tool execution
 * 
 * Flow:
 * 1. User sends message with tools
 * 2. Create session, start Cursor connection
 * 3. When tool call received, pause and return tool_use to client
 * 4. Client executes tool and sends tool_result
 * 5. Resume session, send tool result to Cursor
 * 6. Continue until done or more tool calls
 */

const { v4: uuidv4 } = require('uuid');
const { CURSOR_EXEC_TO_CANONICAL, CANONICAL_TOOLS } = require('../adapters/canonical');

// Session timeout:
// - idle sessions: 5 minutes
// - sessions waiting for tool_result continuation: 30 minutes
const SESSION_TIMEOUT_IDLE = 5 * 60 * 1000;
const SESSION_TIMEOUT_WITH_PENDING_TOOLS = 30 * 60 * 1000;

// Active sessions map: sessionId -> SessionState
const sessions = new Map();

/**
 * Session state structure
 */
class SessionState {
  constructor(sessionId, agentClient) {
    this.sessionId = sessionId;
    this.agentClient = agentClient;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    
    // Pending tool calls waiting for results
    this.pendingToolCalls = [];
    
    // Accumulated text response
    this.accumulatedText = '';
    
    // Stream state
    this.streamIterator = null;
    this.isComplete = false;
    
    // For mapping Cursor tool calls to Anthropic format
    this.toolCallMapping = new Map(); // cursorId -> anthropicToolCallId
    
    // Track already-sent content to deduplicate continuation responses.
    // Cursor's continuation stream replays the entire response from the start.
    this.sentText = '';
    this.sentToolCallIds = new Set();
    // Cursor-level exec IDs for dedup (Anthropic IDs are regenerated each time,
    // so we must track cursor's own IDs to detect replayed exec_server_messages).
    this.sentCursorExecKeys = new Set();

    // Continuation lock: prevents concurrent requests from competing for
    // the same SSE reader.  Claude Code retries tool_result when the proxy
    // is slow, causing two handlers to call continueStream() simultaneously.
    this._continuationLock = null;  // Promise that resolves when current continuation finishes
    this._continuationUnlock = null;
  }

  /**
   * Acquire the continuation lock.  Returns true if acquired, false if a
   * concurrent continuation is already running (caller should wait or skip).
   */
  acquireContinuationLock() {
    if (this._continuationLock) {
      return false;
    }
    this._continuationLock = new Promise(resolve => {
      this._continuationUnlock = resolve;
    });
    return true;
  }

  /**
   * Wait for an in-flight continuation to finish.
   * Returns the lock promise (resolves when the holder releases).
   */
  waitForContinuation() {
    return this._continuationLock;
  }

  releaseContinuationLock() {
    if (this._continuationUnlock) {
      this._continuationUnlock();
    }
    this._continuationLock = null;
    this._continuationUnlock = null;
  }
  
  touch() {
    this.lastActivityAt = Date.now();
  }
  
  isExpired() {
    const hasPendingContinuation =
      (Array.isArray(this.pendingToolCalls) && this.pendingToolCalls.length > 0) ||
      (this.toolCallMapping && this.toolCallMapping.size > 0);
    const ttl = hasPendingContinuation ? SESSION_TIMEOUT_WITH_PENDING_TOOLS : SESSION_TIMEOUT_IDLE;
    return Date.now() - this.lastActivityAt > ttl;
  }
}

/**
 * Create a new session
 */
function createSession(agentClient) {
  const sessionId = uuidv4();
  const session = new SessionState(sessionId, agentClient);
  sessions.set(sessionId, session);
  
  console.log(`[SessionManager] Created session: ${sessionId}`);
  return session;
}

/**
 * Get session by ID
 */
function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session && !session.isExpired()) {
    session.touch();
    return session;
  }
  if (session) {
    // Expired, clean up
    cleanupSession(sessionId);
  }
  return null;
}

/**
 * Find session by Anthropic tool call ID.
 * Useful when client doesn't send x-cursor-session-id header on continuation.
 */
function findSessionByToolCallId(toolCallId) {
  if (!toolCallId) return null;

  for (const [sessionId, session] of sessions.entries()) {
    if (session.isExpired()) {
      cleanupSession(sessionId);
      continue;
    }
    if (session.toolCallMapping.has(toolCallId)) {
      session.touch();
      return session;
    }
  }

  return null;
}

/**
 * Clean up a session
 */
function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    console.log(`[SessionManager] Cleaning up session: ${sessionId}`);
    // Release continuation lock to unblock any waiting requests
    session.releaseContinuationLock();
    // Close agent client connection if needed
    if (session.agentClient && typeof session.agentClient.close === 'function') {
      try {
        session.agentClient.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    sessions.delete(sessionId);
  }
}

/**
 * Clean up expired sessions (call periodically)
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.isExpired()) {
      cleanupSession(sessionId);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredSessions, 60 * 1000);

/**
 * Map Cursor exec_request to Anthropic tool_use format.
 * When an adapter is provided, uses canonical names → client names.
 * @param {object} execRequest
 * @param {SessionState} session
 * @param {import('../adapters/base').ClientAdapter} [adapter]
 */
function execRequestToToolUse(execRequest, session, adapter) {
  const toolCallId = `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
  
  // Store mapping for later when we receive tool_result
  session.toolCallMapping.set(toolCallId, {
    cursorId: execRequest.id,
    cursorExecId: execRequest.execId,
    cursorType: execRequest.type,
    cursorRequest: {
      command: execRequest.command,
      cwd: execRequest.cwd,
      path: execRequest.path,
      pattern: execRequest.pattern,
      glob: execRequest.glob,
      toolName: execRequest.toolName,
      args: execRequest.args,
    },
  });
  
  let name, input;

  const sessionCwd = session.agentClient?.workspacePath || process.cwd();

  if (adapter) {
    // Canonical path: exec type → canonical → client name, canonical params → client params
    const canonicalName = CURSOR_EXEC_TO_CANONICAL[execRequest.type];
    if (canonicalName && canonicalName !== 'mcp_custom' && canonicalName !== 'request_context') {
      let canonInput;
      switch (execRequest.type) {
        case 'ls':
          canonInput = { path: execRequest.path || sessionCwd, pattern: '*' };
          break;
        case 'read':
          canonInput = { path: execRequest.path };
          if (execRequest.startLine) canonInput.offset = execRequest.startLine;
          if (execRequest.endLine && execRequest.startLine) {
            canonInput.limit = execRequest.endLine - execRequest.startLine + 1;
          }
          break;
        case 'write':
          canonInput = {
            path: execRequest.path || execRequest.filePath || '',
            content: execRequest.fileText || '',
          };
          break;
        case 'shell':
          canonInput = { command: execRequest.command };
          if (execRequest.cwd) canonInput.working_directory = execRequest.cwd;
          canonInput.description = execRequest.cwd
            ? `Run in ${execRequest.cwd}`
            : `Run command`;
          break;
        case 'grep':
          canonInput = {
            pattern: execRequest.pattern,
            path: execRequest.path || sessionCwd,
          };
          break;
        case 'delete':
          canonInput = { path: execRequest.path };
          break;
        default:
          canonInput = {};
      }

      name = adapter.fromCanonical(canonicalName);
      input = adapter.denormalizeParams(canonicalName, canonInput);

      if (!name) {
        name = execRequest.type || 'unknown_tool';
        input = canonInput;
      }
    } else if (execRequest.type === 'mcp') {
      name = execRequest.toolName || execRequest.name || 'unknown_tool';
      input = execRequest.args || {};
    } else if (execRequest.type === 'request_context') {
      name = 'request_context';
      input = {};
    } else {
      name = execRequest.type || 'unknown_tool';
      input = execRequest.args || {};
    }
  } else {
    // Legacy path: hardcoded Claude Code names
    switch (execRequest.type) {
      case 'ls':
        name = 'Glob';
        input = {
          pattern: '*',
          path: execRequest.path || sessionCwd,
        };
        break;
      case 'read':
        name = 'Read';
        input = { file_path: execRequest.path };
        if (execRequest.startLine) input.offset = execRequest.startLine;
        if (execRequest.endLine && execRequest.startLine) {
          input.limit = execRequest.endLine - execRequest.startLine + 1;
        }
        break;
      case 'write':
        name = 'Write';
        input = { 
          file_path: execRequest.path || execRequest.filePath || '',
          content: execRequest.fileText || '',
        };
        break;
      case 'shell':
        name = 'Bash';
        input = { command: execRequest.command };
        if (execRequest.cwd) input.description = `Run in ${execRequest.cwd}`;
        break;
      case 'grep':
        name = 'Grep';
        input = { 
          pattern: execRequest.pattern,
          path: execRequest.path || sessionCwd,
        };
        break;
      case 'delete':
        name = 'Bash';
        input = { command: `rm -f "${execRequest.path}"`, description: 'Delete file' };
        break;
      case 'mcp':
        name = execRequest.toolName || execRequest.name || 'unknown_tool';
        input = execRequest.args || {};
        break;
      case 'request_context':
        name = 'request_context';
        input = {};
        break;
      default:
        name = execRequest.type || 'unknown_tool';
        input = execRequest.args || {};
    }
  }
  
  return {
    type: 'tool_use',
    id: toolCallId,
    name: name,
    input: input,
  };
}

function normalizeFileListFromToolResultContent(content) {
  if (Array.isArray(content)) {
    return content.map(item => String(item).trim()).filter(Boolean);
  }
  if (content == null) {
    return [];
  }

  const raw = String(content).trim();
  if (!raw) {
    return [];
  }

  // Try structured formats first.
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map(item => String(item).trim()).filter(Boolean);
    }
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.files)) {
        return parsed.files.map(item => String(item).trim()).filter(Boolean);
      }
      if (typeof parsed.path === 'string' && parsed.path.trim()) {
        return [parsed.path.trim()];
      }
    }
  } catch (_) {
    // Fall through to text parsing.
  }

  const lines = raw
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-*]\s+/, '').replace(/^\d+[\).\s-]+/, '').trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const pathLike = lines.filter(line =>
    line.includes('/') || line.includes('\\') || /\.[a-z0-9]+$/i.test(line)
  );
  return pathLike.length > 0 ? pathLike : lines;
}

/**
 * Convert Anthropic tool_result to Cursor format and send via BidiAppend
 */
async function sendToolResult(session, toolCallId, result, options = {}) {
  const mapping = session.toolCallMapping.get(toolCallId);
  if (!mapping) {
    throw new Error(`Unknown tool call ID: ${toolCallId}`);
  }
  const deferResume = options && options.deferResume === true;
  
  const { cursorId, cursorExecId, cursorType, cursorRequest = {}, kvMapped = false } = mapping;
  const agentClient = session.agentClient;
  
  // Convert Anthropic tool_result to Cursor format based on tool type
  let cursorResult;
  
  // Handle error results — tool-type-specific formatting is critical!
  // Generic { error: "..." } loses type-specific fields (e.g., exitCode for shell).
  if (result.is_error) {
    const errorContent = typeof result.content === 'string'
      ? result.content
      : (Array.isArray(result.content)
        ? result.content.map(b => b.text || '').join('')
        : JSON.stringify(result.content) || 'Tool execution failed');

    switch (cursorType) {
      case 'shell': {
        // Parse exit code from error message like "Exit code 127\n..."
        const exitCodeMatch = errorContent.match(/Exit code (\d+)/i);
        const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 1;
        cursorResult = {
          stdout: '',
          stderr: errorContent,
          exitCode,
        };
        break;
      }
      case 'write':
        cursorResult = {
          error: { path: cursorRequest.path || '', error: errorContent }
        };
        break;
      case 'read':
      case 'read_v1':
        cursorResult = {
          content: errorContent,
          totalLines: 0,
          fileSize: BigInt(0),
        };
        break;
      default:
        cursorResult = { error: errorContent };
    }
  } else {
    // Parse the result content
    const content = typeof result.content === 'string' 
      ? result.content 
      : JSON.stringify(result.content);
    
    switch (cursorType) {
      case 'ls':
        cursorResult = { files: content };
        break;
        
      case 'read':
      case 'read_v1':
        cursorResult = { 
          content: content,
          totalLines: content.split('\n').length,
          fileSize: BigInt(Buffer.byteLength(content, 'utf-8'))
        };
        break;
        
      case 'write':
        try {
          const parsed = JSON.parse(content);
          cursorResult = {
            success: {
              path: parsed.path || cursorRequest.path || '',
              linesCreated: parsed.linesCreated || content.split('\n').length,
              fileSize: parsed.fileSize || Buffer.byteLength(content, 'utf-8')
            }
          };
        } catch {
          cursorResult = {
            success: {
              path: cursorRequest.path || '',
              linesCreated: content ? content.split('\n').length : 0,
              fileSize: content ? Buffer.byteLength(content, 'utf-8') : 0
            }
          };
        }
        break;
        
      case 'shell':
        // Parse shell result
        try {
          const parsed = JSON.parse(content);
          cursorResult = {
            stdout: parsed.stdout || content,
            stderr: parsed.stderr || '',
            exitCode: parsed.exitCode || 0
          };
        } catch {
          cursorResult = {
            stdout: content,
            stderr: '',
            exitCode: 0
          };
        }
        break;
        
      case 'grep':
        cursorResult = { 
          files: normalizeFileListFromToolResultContent(result.content)
        };
        break;

      case 'delete':
        cursorResult = {
          success: { path: cursorRequest.path || '' },
        };
        break;
        
      case 'mcp':
        cursorResult = {
          success: { content: content, isError: false }
        };
        break;
        
      default:
        cursorResult = { content: content };
    }
  }
  
  // text_fallback and kvMapped tools have no matching exec_server_message on the
  // Cursor SSE stream.  Sending a result via BidiAppend would be silently ignored,
  // so we signal the caller to start a fresh request with full conversation history.
  if (cursorType === 'text_fallback' || kvMapped) {
    const reason = kvMapped ? 'KV-mapped' : 'text_fallback';
    console.log(`[SessionManager] ${reason} tool result for ${cursorType}, signalling fresh request`);
    session.toolCallMapping.delete(toolCallId);
    session.pendingToolCalls = session.pendingToolCalls.filter(
      call => call.toolUse?.id !== toolCallId
    );
    return { needsFreshRequest: true, sentToCursor: false };
  }

  // Build the exec request object for sendToolResult
  const execRequest = {
    type: cursorType,
    id: cursorId,
    execId: cursorExecId,
    // Include original request data for some tool types
    command: cursorType === 'shell' ? (cursorRequest.command || '') : undefined,
    cwd: cursorRequest.cwd || session.agentClient?.workspacePath || process.cwd(),
    path: cursorRequest.path || '',
    pattern: cursorType === 'grep' ? (cursorRequest.pattern || '') : undefined,
    glob: cursorType === 'grep' ? cursorRequest.glob : undefined,
    toolName: cursorType === 'mcp' ? cursorRequest.toolName : undefined,
    args: cursorType === 'mcp' ? cursorRequest.args : undefined,
  };
  
  // Send result to Cursor.
  // KV-mapped tool calls are best-effort: if Cursor rejects them, gracefully
  // fall back to a fresh full-history request instead of hard-failing.
  try {
    await agentClient.sendToolResult(execRequest, cursorResult);
  } catch (err) {
    if (kvMapped) {
      console.warn(`[SessionManager] KV mapped tool result failed for ${cursorType}, fallback to fresh request: ${err.message}`);
      session.toolCallMapping.delete(toolCallId);
      session.pendingToolCalls = session.pendingToolCalls.filter(
        call => call.toolUse?.id !== toolCallId
      );
      return { needsFreshRequest: true, sentToCursor: false };
    }
    throw err;
  }
  
  // Send resume action unless caller batches multiple tool_results.
  if (!deferResume) {
    await agentClient.sendResumeAction();
  }
  
  // Remove from mapping
  session.toolCallMapping.delete(toolCallId);
  // Remove from pending calls list
  session.pendingToolCalls = session.pendingToolCalls.filter(
    call => call.toolUse?.id !== toolCallId
  );
  
  console.log(`[SessionManager] Sent tool result for ${cursorType} (id=${cursorId})${deferResume ? ' (resume deferred)' : ''}`);
  return { needsFreshRequest: false, sentToCursor: true, resumeDeferred: deferResume };
}

/**
 * Get session stats (for debugging)
 */
function getStats() {
  return {
    activeSessions: sessions.size,
    sessions: Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      pendingToolCalls: s.pendingToolCalls.length,
      isComplete: s.isComplete,
    }))
  };
}

module.exports = {
  SessionState,
  createSession,
  getSession,
  findSessionByToolCallId,
  cleanupSession,
  cleanupExpiredSessions,
  execRequestToToolUse,
  sendToolResult,
  getStats,
};
