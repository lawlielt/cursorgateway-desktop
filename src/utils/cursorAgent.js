/**
 * Cursor Agent Client
 * Implements bidirectional communication with Cursor's Agent API
 * Based on yet-another-opencode-cursor-auth/src/lib/api/agent-service.ts
 */

const crypto = require('crypto');
const {
  encodeStringField,
  encodeMessageField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeBoolField,
  concatBytes,
  addConnectEnvelope,
} = require('./protoEncoder');
const { parseProtoFields, generateChecksum } = require('./utils');

const CURSOR_API_URL = 'https://api2.cursor.sh';

/**
 * Encode BidiRequestId
 */
function encodeBidiRequestId(requestId) {
  return encodeStringField(1, requestId);
}

/**
 * Encode BidiAppendRequest
 * - data: field 1 (string, hex-encoded)
 * - request_id: field 2 (BidiRequestId message)
 * - append_seqno: field 3 (int64)
 */
function encodeBidiAppendRequest(hexData, requestId, appendSeqno) {
  const requestIdMsg = encodeBidiRequestId(requestId);
  return concatBytes(
    encodeStringField(1, hexData),
    encodeMessageField(2, requestIdMsg),
    encodeInt64Field(3, appendSeqno)
  );
}

/**
 * Parse exec_server_message to extract tool execution requests
 * Based on yet-another-opencode-cursor-auth/src/lib/api/proto/exec.ts
 */
function parseExecServerMessage(data) {
  const fields = parseProtoFields(data);
  let id = 0;
  let execId = undefined;
  let result = null;

  // First pass: get id and execId
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      id = field.value;
    } else if (field.fieldNumber === 15 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      execId = field.value.toString('utf-8');
    }
  }

  // Second pass: determine exec type
  for (const field of fields) {
    if (field.wireType !== 2 || !Buffer.isBuffer(field.value)) continue;

    switch (field.fieldNumber) {
      case 2: // shell (run_shell_command)
      case 14: { // shell v2
        const args = parseShellArgs(field.value);
        result = { type: 'shell', id, execId, command: args.command, cwd: args.cwd };
        break;
      }
      case 3: { // write
        const args = parseWriteArgs(field.value);
        result = { type: 'write', id, execId, ...args };
        break;
      }
      case 5: { // grep
        const args = parseGrepArgs(field.value);
        result = { type: 'grep', id, execId, ...args };
        break;
      }
      case 7: { // read
        const args = parseReadArgs(field.value);
        result = { type: 'read', id, execId, path: args.path };
        break;
      }
      case 8: { // ls
        const args = parseLsArgs(field.value);
        result = { type: 'ls', id, execId, path: args.path };
        break;
      }
      case 10: { // request_context
        result = { type: 'request_context', id, execId };
        break;
      }
      case 11: { // mcp
        const args = parseMcpArgs(field.value);
        result = { type: 'mcp', id, execId, ...args };
        break;
      }
    }

    if (result) break;
  }

  return result;
}

function parseShellArgs(data) {
  const fields = parseProtoFields(data);
  let command = '';
  let cwd = undefined;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      command = field.value.toString('utf-8');
    } else if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      cwd = field.value.toString('utf-8');
    }
  }

  return { command, cwd };
}

function parseWriteArgs(data) {
  const fields = parseProtoFields(data);
  let path = '';
  let fileText = '';
  let toolCallId = undefined;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      path = field.value.toString('utf-8');
    } else if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      fileText = field.value.toString('utf-8');
    } else if (field.fieldNumber === 3 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      toolCallId = field.value.toString('utf-8');
    }
  }

  return { path, fileText, toolCallId };
}

function parseReadArgs(data) {
  const fields = parseProtoFields(data);
  let path = '';

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      path = field.value.toString('utf-8');
    }
  }

  return { path };
}

function parseLsArgs(data) {
  const fields = parseProtoFields(data);
  let path = process.cwd();

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      path = field.value.toString('utf-8');
    }
  }

  return { path };
}

function parseGrepArgs(data) {
  const fields = parseProtoFields(data);
  let pattern = '';
  let path = undefined;
  let glob = undefined;

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      pattern = field.value.toString('utf-8');
    } else if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      path = field.value.toString('utf-8');
    } else if (field.fieldNumber === 3 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      glob = field.value.toString('utf-8');
    }
  }

  return { pattern, path, glob };
}

function parseMcpArgs(data) {
  const fields = parseProtoFields(data);
  let name = '';
  let args = {};
  let toolCallId = '';
  let providerIdentifier = '';
  let toolName = '';
  let rawArgs = '';

  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      name = field.value.toString('utf-8');
    } else if (field.fieldNumber === 3 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      toolCallId = field.value.toString('utf-8');
    } else if (field.fieldNumber === 4 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      providerIdentifier = field.value.toString('utf-8');
    } else if (field.fieldNumber === 5 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      toolName = field.value.toString('utf-8');
    } else if (field.fieldNumber === 6 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      rawArgs = field.value.toString('utf-8');
    }
  }

  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch (e) {
      args = { raw: rawArgs };
    }
  }

  return { name, args, toolCallId, providerIdentifier, toolName };
}

/**
 * Build exec client message with shell result
 */
function buildShellResultMessage(id, execId, command, cwd, stdout, stderr, exitCode) {
  const shellOutcome = concatBytes(
    encodeStringField(1, command),
    encodeStringField(2, cwd || process.cwd()),
    encodeInt32Field(3, exitCode),
    encodeStringField(4, ''),
    encodeStringField(5, stdout),
    encodeStringField(6, stderr)
  );
  const resultField = exitCode === 0 ? 1 : 2;
  const shellResult = encodeMessageField(resultField, shellOutcome);
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(2, shellResult));
  
  return concatBytes(...parts);
}

/**
 * Build exec client message with write result
 */
function buildWriteResultMessage(id, execId, result) {
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  
  if (result.success) {
    const success = concatBytes(
      encodeStringField(1, result.success.path),
      encodeInt32Field(2, result.success.linesCreated || 0),
      encodeInt32Field(3, result.success.fileSize || 0)
    );
    parts.push(encodeMessageField(3, encodeMessageField(1, success)));
  } else if (result.error) {
    const error = concatBytes(
      encodeStringField(1, result.error.path),
      encodeStringField(2, result.error.error)
    );
    parts.push(encodeMessageField(3, encodeMessageField(5, error)));
  }
  
  return concatBytes(...parts);
}

/**
 * Build exec client message with read result
 */
function buildReadResultMessage(id, execId, content, path, totalLines, fileSize) {
  const readSuccess = concatBytes(
    encodeStringField(1, path),
    encodeStringField(2, content),
    totalLines ? encodeInt32Field(3, totalLines) : Buffer.alloc(0),
    fileSize ? encodeInt64Field(4, BigInt(fileSize)) : Buffer.alloc(0)
  );
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(7, encodeMessageField(1, readSuccess)));
  
  return concatBytes(...parts);
}

/**
 * Build exec client message with ls result
 */
function buildLsResultMessage(id, execId, filesString) {
  const lsSuccess = encodeStringField(1, filesString);
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(8, encodeMessageField(1, lsSuccess)));
  
  return concatBytes(...parts);
}

/**
 * Build exec client message with grep result
 */
function buildGrepResultMessage(id, execId, pattern, path, files) {
  const filesResult = concatBytes(
    ...files.map(f => encodeStringField(1, f)),
    encodeInt32Field(2, files.length)
  );
  const unionResult = encodeMessageField(2, filesResult);
  const mapEntry = concatBytes(
    encodeStringField(1, path || '.'),
    encodeMessageField(2, unionResult)
  );
  const grepSuccess = concatBytes(
    encodeStringField(1, pattern),
    encodeStringField(2, path || '.'),
    encodeStringField(3, 'files_with_matches'),
    encodeMessageField(4, mapEntry)
  );
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(5, encodeMessageField(1, grepSuccess)));
  
  return concatBytes(...parts);
}

/**
 * Build exec client message with request context result
 */
function buildRequestContextResultMessage(id, execId, workspacePath) {
  const os = require('os');
  const resolvedPath = workspacePath || process.cwd();
  const env = concatBytes(
    encodeStringField(1, `darwin ${os.release()}`),
    encodeStringField(2, resolvedPath),
    encodeStringField(3, process.env.SHELL || '/bin/zsh'),
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone),
    encodeStringField(11, resolvedPath)
  );
  const requestContext = encodeMessageField(4, env);
  const success = encodeMessageField(1, requestContext);
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(10, encodeMessageField(1, success)));
  
  return concatBytes(...parts);
}

/**
 * Build exec client control message (stream close)
 */
function buildExecControlMessage(id) {
  const streamClose = encodeUint32Field(1, id);
  return encodeMessageField(1, streamClose);
}

/**
 * Wrap exec client message in AgentClientMessage
 */
function wrapInAgentClientMessage(execClientMessage, fieldNumber = 2) {
  return encodeMessageField(fieldNumber, execClientMessage);
}

/**
 * Cursor Agent Session
 * Manages bidirectional communication for a single chat session
 */
class CursorAgentSession {
  constructor(accessToken, options = {}) {
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl || CURSOR_API_URL;
    this.workspacePath = options.workspacePath || process.cwd();
    
    this.requestId = null;
    this.appendSeqno = 0n;
    this.pendingExecRequests = new Map(); // id -> exec request
    this.isActive = false;
  }

  getHeaders() {
    const checksum = generateChecksum(this.accessToken);
    return {
      'authorization': `Bearer ${this.accessToken}`,
      'content-type': 'application/grpc-web+proto',
      'user-agent': 'connect-es/1.4.0',
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': 'cli-unknown',
      'x-cursor-client-type': 'cli',
      'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'x-ghost-mode': 'true',
      'x-cursor-streaming': 'true',
    };
  }

  /**
   * Send BidiAppend request
   */
  async bidiAppend(data) {
    if (!this.requestId) {
      throw new Error('No active session - cannot send bidiAppend');
    }

    const hexData = data.toString('hex');
    const appendRequest = encodeBidiAppendRequest(hexData, this.requestId, this.appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);

    const url = `${this.baseUrl}/aiserver.v1.BidiService/BidiAppend`;
    
    console.log(`[BidiAppend] Sending seqno=${this.appendSeqno}, data=${data.length} bytes`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'x-request-id': this.requestId,
      },
      body: envelope,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
    }

    this.appendSeqno++;
    console.log(`[BidiAppend] Success, new seqno=${this.appendSeqno}`);
  }

  /**
   * Send tool result back to Cursor
   */
  async sendToolResult(execRequest, result) {
    let execClientMessage;

    switch (execRequest.type) {
      case 'shell':
        execClientMessage = buildShellResultMessage(
          execRequest.id,
          execRequest.execId,
          execRequest.command,
          execRequest.cwd || process.cwd(),
          result.stdout || '',
          result.stderr || '',
          result.exitCode || 0
        );
        break;

      case 'write':
        execClientMessage = buildWriteResultMessage(
          execRequest.id,
          execRequest.execId,
          result
        );
        break;

      case 'read':
        execClientMessage = buildReadResultMessage(
          execRequest.id,
          execRequest.execId,
          result.content || '',
          execRequest.path,
          result.totalLines,
          result.fileSize
        );
        break;

      case 'ls':
        execClientMessage = buildLsResultMessage(
          execRequest.id,
          execRequest.execId,
          result.files || ''
        );
        break;

      case 'grep':
        execClientMessage = buildGrepResultMessage(
          execRequest.id,
          execRequest.execId,
          execRequest.pattern,
          execRequest.path,
          result.files || []
        );
        break;

      case 'request_context':
        execClientMessage = buildRequestContextResultMessage(
          execRequest.id,
          execRequest.execId,
          this.workspacePath
        );
        break;

      default:
        console.log(`[CursorAgent] Unknown exec type: ${execRequest.type}`);
        return;
    }

    // Send the result
    const agentMessage = wrapInAgentClientMessage(execClientMessage, 2);
    await this.bidiAppend(agentMessage);

    // Send stream close control message
    const controlMessage = buildExecControlMessage(execRequest.id);
    const controlAgentMessage = wrapInAgentClientMessage(controlMessage, 5);
    await this.bidiAppend(controlAgentMessage);

    console.log(`[CursorAgent] Tool result sent for ${execRequest.type} id=${execRequest.id}`);
  }

  /**
   * Start a new session
   */
  start(requestId) {
    this.requestId = requestId;
    this.appendSeqno = 0n;
    this.pendingExecRequests.clear();
    this.isActive = true;
    console.log(`[CursorAgent] Session started: ${requestId}`);
  }

  /**
   * End the session
   */
  end() {
    this.isActive = false;
    this.requestId = null;
    console.log(`[CursorAgent] Session ended`);
  }

  /**
   * Add a pending exec request
   */
  addPendingExecRequest(execRequest) {
    this.pendingExecRequests.set(execRequest.id, execRequest);
    console.log(`[CursorAgent] Added pending exec request: ${execRequest.type} id=${execRequest.id}`);
  }

  /**
   * Get and remove a pending exec request
   */
  getPendingExecRequest(id) {
    const request = this.pendingExecRequests.get(id);
    if (request) {
      this.pendingExecRequests.delete(id);
    }
    return request;
  }
}

module.exports = {
  CursorAgentSession,
  parseExecServerMessage,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  buildShellResultMessage,
  buildWriteResultMessage,
  buildReadResultMessage,
  buildLsResultMessage,
  buildGrepResultMessage,
  buildRequestContextResultMessage,
  buildExecControlMessage,
  wrapInAgentClientMessage,
};
