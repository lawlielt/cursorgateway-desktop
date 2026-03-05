/**
 * Cursor Agent Service Client
 * Implements bidirectional communication with Cursor's Agent API using RunSSE + BidiAppend
 * Based on yet-another-opencode-cursor-auth
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const zlib = require('zlib');
const http2 = require('http2');
const { Agent } = require('undici');
const {
  encodeStringField,
  encodeBytesField,
  encodeMessageField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeBoolField,
  concatBytes,
  addConnectEnvelope,
  encodeProtobufStruct,
  encodeProtobufValue,
  decodeProtobufStructFromRepeatedEntries,
  decodeProtobufStruct,
} = require('./protoEncoder');
const { parseProtoFields, generateCursorChecksum, decodeVarint } = require('./utils');
const { getRequestContext } = require('./toolExecutor');

const CURSOR_API_URL = 'https://api2.cursor.sh';
const AGENT_API_URL = 'https://agent.api5.cursor.sh';

// HTTP/2 agent for undici
const http2Agent = new Agent({ allowH2: true });

/**
 * HTTP/2 streaming fetch using native http2 module
 * Returns an async iterator for streaming
 */
function createHttp2Stream(url, options = {}) {
  const urlObj = new URL(url);
  
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${urlObj.host}`);
    
    client.on('error', reject);
    
    const headers = {
      ':method': options.method || 'POST',
      ':path': urlObj.pathname,
      ...options.headers,
    };
    
    const req = client.request(headers);
    
    if (options.body) {
      req.write(options.body);
    }
    req.end();
    
    let responseHeaders = {};
    let headersSent = false;
    
    req.on('response', (hdrs) => {
      responseHeaders = hdrs;
      headersSent = true;
      
      const status = responseHeaders[':status'];
      const ok = status >= 200 && status < 300;
      
      // Create async iterator for the stream
      const streamIterator = {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const chunk = await new Promise((res, rej) => {
              const onData = (data) => {
                cleanup();
                res({ done: false, value: data });
              };
              const onEnd = () => {
                cleanup();
                res({ done: true, value: undefined });
              };
              const onError = (err) => {
                cleanup();
                rej(err);
              };
              const cleanup = () => {
                req.removeListener('data', onData);
                req.removeListener('end', onEnd);
                req.removeListener('error', onError);
              };
              req.once('data', onData);
              req.once('end', onEnd);
              req.once('error', onError);
            });
            
            if (chunk.done) {
              client.close();
              return;
            }
            yield chunk.value;
          }
        },
        getReader() {
          const iterator = this[Symbol.asyncIterator]();
          return {
            async read() {
              const result = await iterator.next();
              return result.done 
                ? { done: true, value: undefined }
                : { done: false, value: result.value };
            },
            releaseLock() {
              client.close();
            },
          };
        },
      };
      
      resolve({
        ok,
        status,
        headers: {
          get: (name) => responseHeaders[name.toLowerCase()],
        },
        body: streamIterator,
        close: () => client.close(),
      });
    });
    
    req.on('error', reject);
    
    // Timeout for initial response
    setTimeout(() => {
      if (!headersSent) {
        client.close();
        reject(new Error('HTTP/2 request timeout'));
      }
    }, 30000);
  });
}

/**
 * Encode BidiRequestId
 */
function encodeBidiRequestId(requestId) {
  return encodeStringField(1, requestId);
}

/**
 * Encode BidiAppendRequest
 */
function encodeBidiAppendRequest(hexData, requestId, appendSeqno) {
  const requestIdMsg = encodeBidiRequestId(requestId);
  return concatBytes(
    encodeStringField(1, hexData),
    encodeMessageField(2, requestIdMsg),
    encodeInt64Field(3, BigInt(appendSeqno))
  );
}

/**
 * Cursor reserves certain tool names internally (TodoWrite, WebFetch, Task, EditNotebook, etc.).
 * Registering MCP tools with these exact names causes grpc-status 8 (Provider Error).
 * We prefix them with "mcp_" when registering, and strip the prefix when receiving callbacks.
 */
const CURSOR_RESERVED_TOOL_NAMES = new Set([
  'TodoWrite', 'WebFetch', 'Task', 'EditNotebook', 'FetchMcpResource',
  'Delete',
]);

function sanitizeMcpToolName(name) {
  if (CURSOR_RESERVED_TOOL_NAMES.has(name)) {
    return `mcp_${name}`;
  }
  return name;
}

function restoreMcpToolName(name) {
  if (name && name.startsWith('mcp_')) {
    const original = name.slice(4);
    if (CURSOR_RESERVED_TOOL_NAMES.has(original)) {
      return original;
    }
  }
  return name;
}

/**
 * Build RequestContext for Agent API
 * Proto: agent.v1.RequestContext (embedded in UserMessageAction.field 2)
 * - Field 4: env (RequestContextEnv)
 * - Field 7: tools (repeated McpToolDefinition — model-visible tool context)
 * - Field 14: mcp_instructions (repeated McpInstructions — tool usage guidance)
 *
 * NOTE: field 7 here provides tool definitions to the model's context.
 * The actual exec routing registration lives in AgentRunRequest.field 4 (McpTools).
 * Both are needed: field 7 tells the model what tools exist, AgentRunRequest.field 4
 * tells Cursor's server to route tool calls back via exec_server_message field 11.
 */
function buildRequestContext(workspacePath, tools) {
  const os = require('os');
  const parts = [];
  
  // Field 4: env (nested RequestContextEnv message)
  const envParts = [];
  envParts.push(encodeStringField(1, `${process.platform} ${os.release()}`)); // os_version
  envParts.push(encodeStringField(2, workspacePath || process.cwd())); // cwd
  envParts.push(encodeStringField(3, process.env.SHELL || '/bin/zsh')); // shell
  envParts.push(encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone)); // timezone
  envParts.push(encodeStringField(11, workspacePath || process.cwd())); // workspace_path
  parts.push(encodeMessageField(4, concatBytes(...envParts)));
  
  // Field 7: MCP tool definitions (tells model what tools exist)
  // Field 14: MCP instructions (usage hints)
  // Previously disabled because input_schema was encoded as Struct instead of Value,
  // which caused SSE stalls. Re-enabled after fixing to encodeProtobufValue.
  const MCP_PROVIDER = 'cursor-tools';
  if (tools && tools.length > 0) {
    for (const tool of tools) {
      const origName = tool.name || tool.function?.name || '';
      const safeName = sanitizeMcpToolName(origName);
      const toolDesc = tool.description || tool.function?.description || '';
      const inputSchema = tool.input_schema || tool.parameters || tool.function?.parameters || { type: 'object', properties: {} };

      const toolParts = [];
      toolParts.push(encodeStringField(1, safeName));
      toolParts.push(encodeStringField(2, toolDesc));
      toolParts.push(encodeMessageField(3, encodeProtobufValue(inputSchema))); // Value, not Struct
      toolParts.push(encodeStringField(4, MCP_PROVIDER));
      toolParts.push(encodeStringField(5, safeName));

      parts.push(encodeMessageField(7, concatBytes(...toolParts)));
    }

    const toolDescriptions = tools.map(t => {
      const origName = t.name || t.function?.name || '';
      const safeName = sanitizeMcpToolName(origName);
      const desc = t.description || t.function?.description || 'No description';
      return `- ${safeName}: ${desc}`;
    }).join('\n');
    const instructions = `Available MCP tools:\n${toolDescriptions}\n\nCall tools using their exact name and JSON arguments.`;

    const mcpInstrParts = [];
    mcpInstrParts.push(encodeStringField(1, MCP_PROVIDER));
    mcpInstrParts.push(encodeStringField(2, instructions));
    parts.push(encodeMessageField(14, concatBytes(...mcpInstrParts)));
  }

  return concatBytes(...parts);
}

/**
 * Parse ExecServerMessage
 */
function parseExecServerMessage(data) {
  const fields = parseProtoFields(data);
  let id = 0;
  let execId = undefined;
  let result = null;
  
  // First pass: get id and execId
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      id = typeof field.value === 'number' ? field.value : Number(field.value);
    } else if (field.fieldNumber === 15 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      execId = field.value.toString('utf-8');
    }
  }
  
  // Second pass: determine type
  for (const field of fields) {
    if (field.wireType !== 2 || !Buffer.isBuffer(field.value)) continue;
    
    const parseArgs = (data, fieldMap) => {
      const argFields = parseProtoFields(data);
      const args = {};
      for (const af of argFields) {
        const name = fieldMap[af.fieldNumber];
        if (name && af.wireType === 2 && Buffer.isBuffer(af.value)) {
          args[name] = af.value.toString('utf-8');
        } else if (name && af.wireType === 0) {
          args[name] = af.value;
        }
      }
      return args;
    };
    
    switch (field.fieldNumber) {
      case 2: // shell
      case 14: { // shell v2
        const args = parseArgs(field.value, { 1: 'command', 2: 'cwd' });
        result = { type: 'shell', id, execId, command: args.command || '', cwd: args.cwd };
        break;
      }
      case 3: { // write
        const args = parseArgs(field.value, { 1: 'path', 2: 'fileText', 3: 'toolCallId' });
        result = { type: 'write', id, execId, toolCallId: args.toolCallId, path: args.path || '', fileText: args.fileText || '' };
        break;
      }
      case 4: { // delete_file
        const args = parseArgs(field.value, { 1: 'path' });
        result = { type: 'delete', id, execId, path: args.path || '' };
        break;
      }
      case 5: { // grep
        const args = parseArgs(field.value, { 1: 'pattern', 2: 'path', 3: 'glob' });
        result = { type: 'grep', id, execId, pattern: args.pattern || '', path: args.path, glob: args.glob };
        break;
      }
      case 7: { // read
        const args = parseArgs(field.value, { 1: 'path' });
        result = { type: 'read', id, execId, path: args.path || '' };
        break;
      }
      case 8: { // ls
        const args = parseArgs(field.value, { 1: 'path' });
        result = { type: 'ls', id, execId, path: args.path || process.cwd() };
        break;
      }
      case 10: { // request_context
        result = { type: 'request_context', id, execId };
        break;
      }
      case 11: { // mcp — McpArgs { name=1, Struct args=2 (repeated), toolCallId=3, providerIdentifier=4, toolName=5 }
        const mcpFields = parseProtoFields(field.value);
        let mcpName = '';
        let mcpToolCallId = '';
        let mcpProvider = '';
        let mcpToolName = '';
        const argEntryBuffers = [];

        for (const mf of mcpFields) {
          if (mf.wireType === 2 && Buffer.isBuffer(mf.value)) {
            switch (mf.fieldNumber) {
              case 1: mcpName = mf.value.toString('utf-8'); break;
              case 2: argEntryBuffers.push(mf.value); break;
              case 3: mcpToolCallId = mf.value.toString('utf-8'); break;
              case 4: mcpProvider = mf.value.toString('utf-8'); break;
              case 5: mcpToolName = mf.value.toString('utf-8'); break;
            }
          }
        }

        let parsedArgs = {};
        if (argEntryBuffers.length === 1) {
          // Single field 2 = entire Struct message
          parsedArgs = decodeProtobufStruct(argEntryBuffers[0]);
          // If decodeProtobufStruct returned empty but buffer has data, try as single entry
          if (Object.keys(parsedArgs).length === 0 && argEntryBuffers[0].length > 0) {
            parsedArgs = decodeProtobufStructFromRepeatedEntries(argEntryBuffers);
          }
        } else if (argEntryBuffers.length > 1) {
          // Multiple field 2 = repeated map entries (each is a MapEntry)
          parsedArgs = decodeProtobufStructFromRepeatedEntries(argEntryBuffers);
        }

        // Restore original tool name if it was sanitized for Cursor registration
        const restoredName = restoreMcpToolName(mcpName);
        const restoredToolName = restoreMcpToolName(mcpToolName);
        console.log(`[AgentClient] MCP exec: name=${mcpName}${restoredName !== mcpName ? ` (restored: ${restoredName})` : ''}, toolName=${mcpToolName}, args=${JSON.stringify(parsedArgs)}`);

        result = {
          type: 'mcp',
          id,
          execId,
          name: restoredName,
          toolCallId: mcpToolCallId,
          providerIdentifier: mcpProvider,
          toolName: restoredToolName,
          args: parsedArgs
        };
        break;
      }
      default: {
        // Unknown field - log hex for analysis
        console.log(`[AgentClient] Unknown exec field ${field.fieldNumber}: hex=${field.value.toString('hex').substring(0, 100)}`);
        break;
      }
    }
    
    if (result) break;
  }
  
  return result;
}

/**
 * Build shell result message
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
 * Build write result message
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
    const errorPath = typeof result.error === 'object' ? (result.error.path || '') : '';
    const errorMsg = typeof result.error === 'object'
      ? (result.error.error || 'Write failed')
      : (typeof result.error === 'string' ? result.error : 'Write failed');
    const error = concatBytes(
      encodeStringField(1, errorPath),
      encodeStringField(2, errorMsg)
    );
    parts.push(encodeMessageField(3, encodeMessageField(5, error)));
  }
  
  return concatBytes(...parts);
}

/**
 * Build read result message
 */
function buildReadResultMessage(id, execId, content, path, totalLines, fileSize, responseFieldNumber = 7) {
  const readSuccess = concatBytes(
    encodeStringField(1, path),
    encodeStringField(2, content),
    totalLines ? encodeInt32Field(3, totalLines) : Buffer.alloc(0),
    fileSize ? encodeInt64Field(4, fileSize) : Buffer.alloc(0)
  );
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(responseFieldNumber, encodeMessageField(1, readSuccess)));
  
  return concatBytes(...parts);
}

/**
 * Build ls result message
 */
function buildLsResultMessage(id, execId, filesString) {
  const lsSuccess = encodeStringField(1, filesString);
  
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(8, encodeMessageField(1, lsSuccess)));
  
  return concatBytes(...parts);
}

/**
 * Build grep result message
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
 * Build delete result message
 */
function buildDeleteResultMessage(id, execId, result) {
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));

  if (result.success) {
    const success = encodeStringField(1, result.success.path || '');
    parts.push(encodeMessageField(4, encodeMessageField(1, success)));
  } else {
    const errorPath = typeof result.error === 'object' ? (result.error.path || '') : '';
    const errorMsg = typeof result.error === 'object'
      ? (result.error.error || 'Delete failed')
      : (typeof result.error === 'string' ? result.error : 'Delete failed');
    const error = concatBytes(
      encodeStringField(1, errorPath),
      encodeStringField(2, errorMsg)
    );
    parts.push(encodeMessageField(4, encodeMessageField(2, error)));
  }

  return concatBytes(...parts);
}

/**
 * Build request context result message
 * Structure: ExecClientMessage { id, [execId], request_context_result { success { request_context { env } } } }
 */
function buildRequestContextResultMessage(id, execId, workspacePath) {
  const os = require('os');
  const resolvedPath = workspacePath || process.cwd();

  // Build env (RequestContextEnv)
  const env = concatBytes(
    encodeStringField(1, `${process.platform} ${os.release()}`), // os_version
    encodeStringField(2, resolvedPath), // cwd
    encodeStringField(3, process.env.SHELL || '/bin/zsh'), // shell
    encodeStringField(10, Intl.DateTimeFormat().resolvedOptions().timeZone), // timezone
    encodeStringField(11, resolvedPath) // workspace_path
  );

  // Build nested structure: request_context (field 4 = env) -> success (field 1) -> result (field 1)
  const requestContext = encodeMessageField(4, env);
  const success = encodeMessageField(1, requestContext);
  const result = encodeMessageField(1, success);

  // Build ExecClientMessage
  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(10, result)); // field 10 = request_context_result

  return concatBytes(...parts);
}

/**
 * Build MCP tool result message
 * Structure: ExecClientMessage { id, [execId], mcp_result { success/error { content } } }
 */
function buildMcpResultMessage(id, execId, content, isError) {
  // McpResult proto structure (from Cursor source):
  //   McpResult { oneof: success(1)=McpSuccess, error(2)=McpError, rejected(3), ... }
  //   McpSuccess { repeated McpToolResultContentItem content = 1; bool is_error = 2; }
  //   McpToolResultContentItem { oneof: text(1)=McpTextContent, image(2)=McpImageContent }
  //   McpTextContent { string text = 1; }
  //   McpError { string error = 1; }
  let resultField;

  if (isError) {
    const mcpError = encodeStringField(1, content || 'MCP tool execution failed');
    resultField = encodeMessageField(2, mcpError);
  } else {
    // McpTextContent { text = content }
    const textContent = encodeStringField(1, content || '');
    // McpToolResultContentItem { text (field 1) = McpTextContent }
    const contentItem = encodeMessageField(1, textContent);
    // McpSuccess { content (field 1, repeated) = [contentItem], is_error (field 2) = false }
    const mcpSuccess = concatBytes(
      encodeMessageField(1, contentItem),
      encodeBoolField(2, false)
    );
    resultField = encodeMessageField(1, mcpSuccess);
  }

  const parts = [encodeUint32Field(1, id)];
  if (execId) parts.push(encodeStringField(15, execId));
  parts.push(encodeMessageField(11, resultField));

  return concatBytes(...parts);
}

/**
 * Build exec control message (stream close)
 */
function buildExecControlMessage(id) {
  const streamClose = encodeUint32Field(1, id);
  return encodeMessageField(1, streamClose);
}

/**
 * Wrap in AgentClientMessage
 */
function wrapExecClientMessage(execClientMessage) {
  return encodeMessageField(2, execClientMessage);
}

function wrapExecControlMessage(controlMessage) {
  return encodeMessageField(5, controlMessage);
}

/**
 * Build user message
 */
function buildUserMessage(text, messageId, mode) {
  // mode: 1 = ask, 3 = agent
  return concatBytes(
    encodeStringField(1, text),
    encodeStringField(2, messageId),
    encodeUint32Field(3, mode)
  );
}

/**
 * Build user message action
 */
function buildUserMessageAction(userMessage, requestContext) {
  return concatBytes(
    encodeMessageField(1, userMessage),
    encodeMessageField(2, requestContext)
  );
}

/**
 * Build conversation action
 */
function buildConversationAction(userMessageAction) {
  return encodeMessageField(1, userMessageAction);
}

/**
 * Build model details
 */
function buildModelDetails(modelName) {
  return encodeStringField(1, modelName);
}

/**
 * Build McpTools wrapper message for AgentRunRequest field 4.
 * This is what tells Cursor's server to route MCP tool calls back via exec_server_message field 11.
 *
 * Proto: agent.v1.McpTools { repeated McpToolDefinition mcp_tools = 1; }
 */
function buildMcpToolsWrapper(tools) {
  if (!tools || tools.length === 0) return null;
  const MCP_PROVIDER = 'cursor-tools';
  const toolMessages = [];
  for (const tool of tools) {
    const origName = tool.name || tool.function?.name || '';
    const safeName = sanitizeMcpToolName(origName);
    const toolDesc = tool.description || tool.function?.description || '';
    const inputSchema = tool.input_schema || tool.parameters || tool.function?.parameters || { type: 'object', properties: {} };
    const toolParts = [];
    toolParts.push(encodeStringField(1, safeName));
    toolParts.push(encodeStringField(2, toolDesc));
    toolParts.push(encodeMessageField(3, encodeProtobufValue(inputSchema))); // Value, not Struct
    toolParts.push(encodeStringField(4, MCP_PROVIDER));
    toolParts.push(encodeStringField(5, safeName));
    toolMessages.push(encodeMessageField(1, concatBytes(...toolParts)));
  }
  return concatBytes(...toolMessages);
}

/**
 * Build agent run request
 * Proto: agent.v1.AgentRunRequest
 * Field order (from Cursor.app reverse-engineering):
 * - Field 1: conversation_state (ConversationState)
 * - Field 2: action (ConversationAction)
 * - Field 3: model_details (ModelDetails)
 * - Field 4: mcp_tools (McpTools wrapper — triggers exec routing for MCP tools)
 * - Field 5: conversation_id (string)
 * - Field 6: mcp_file_system_options (McpFileSystemOptions)
 * - Field 7: skill_options
 * - Field 8: custom_system_prompt (string)
 * - Field 9: requested_model
 */
function buildAgentRunRequest(conversationAction, modelDetails, conversationId, tools) {
  const conversationState = Buffer.alloc(0);
  
  const parts = [
    encodeMessageField(1, conversationState),
    encodeMessageField(2, conversationAction),
    encodeMessageField(3, modelDetails),
  ];
  
  // Field 4: McpTools — triggers exec routing for MCP tools via exec_server_message field 11.
  // Previously disabled because input_schema was encoded as Struct instead of Value,
  // causing SSE stalls. Re-enabled after fixing to encodeProtobufValue.
  const mcpToolsWrapper = buildMcpToolsWrapper(tools);
  if (mcpToolsWrapper) {
    parts.push(encodeMessageField(4, mcpToolsWrapper));
  }

  // Field 5: Conversation ID
  if (conversationId) {
    parts.push(encodeStringField(5, conversationId));
  }
  
  return concatBytes(...parts);
}

/**
 * Build agent client message
 */
function buildAgentClientMessage(agentRunRequest) {
  return encodeMessageField(1, agentRunRequest);
}

/**
 * Build resume action
 */
function buildResumeAction() {
  const conversationAction = encodeMessageField(2, Buffer.alloc(0)); // resume_action
  return encodeMessageField(4, conversationAction);
}

/**
 * Parse KV server message
 */
function parseKvServerMessage(data) {
  const fields = parseProtoFields(data);
  const result = { id: 0, messageType: 'unknown', blobId: null, blobData: null };
  
  for (const field of fields) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      result.id = typeof field.value === 'number' ? field.value : Number(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      // get_blob_args
      result.messageType = 'get_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && Buffer.isBuffer(af.value)) {
          result.blobId = af.value;
        }
      }
    } else if (field.fieldNumber === 3 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      // set_blob_args
      result.messageType = 'set_blob_args';
      const argsFields = parseProtoFields(field.value);
      for (const af of argsFields) {
        if (af.fieldNumber === 1 && af.wireType === 2 && Buffer.isBuffer(af.value)) {
          result.blobId = af.value;
        } else if (af.fieldNumber === 2 && af.wireType === 2 && Buffer.isBuffer(af.value)) {
          result.blobData = af.value;
        }
      }
    }
  }
  
  return result;
}

/**
 * Build KV client message
 */
function buildKvClientMessage(id, resultType, result) {
  const fieldNumber = resultType === 'get_blob_result' ? 2 : 3;
  return concatBytes(
    encodeUint32Field(1, id),
    encodeMessageField(fieldNumber, result)
  );
}

/**
 * Build AgentClientMessage with KV client message
 */
function buildAgentClientMessageWithKv(kvClientMessage) {
  return encodeMessageField(3, kvClientMessage);
}

/**
 * Parse interaction update
 */
function parseInteractionUpdate(data) {
  const fields = parseProtoFields(data);
  let text = null;
  let isComplete = false;
  let isHeartbeat = false;
  let toolCall = null;
  
  for (const field of fields) {
    // field 1 = message
    if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
      const msgFields = parseProtoFields(field.value);
      for (const mf of msgFields) {
        // field 1 = text_delta
        if (mf.fieldNumber === 1 && mf.wireType === 2 && Buffer.isBuffer(mf.value)) {
          text = mf.value.toString('utf-8');
        }
        // field 13 = heartbeat
        if (mf.fieldNumber === 13 && mf.wireType === 2) {
          isHeartbeat = true;
        }
        // field 14 = turn_ended
        if (mf.fieldNumber === 14 && mf.wireType === 2) {
          isComplete = true;
        }
      }
    }
  }
  
  return { text, isComplete, isHeartbeat, toolCall };
}

function parseGrpcTrailer(trailerText) {
  if (!trailerText) return null;

  const statusMatch = trailerText.match(/grpc-status:\s*([0-9]+)/i);
  const messageMatch = trailerText.match(/grpc-message:\s*([^\r\n]+)/i);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const message = messageMatch ? messageMatch[1].trim() : '';

  if (status && status !== 0) {
    return {
      status,
      message: message || `gRPC status ${status}`,
    };
  }

  return null;
}

function parseKvToolCall(part) {
  if (!part || typeof part !== 'object') return null;

  // Cursor KV blobs aren't stable across versions/models. Accept common variants:
  // - { type: "tool-call", toolCallId, name, input }
  // - { type: "tool_use", id, name, input }
  // - { toolCallId, toolName, arguments }
  const type = typeof part.type === 'string' ? part.type : '';
  const normalizedType = type.toLowerCase().replace(/_/g, '-');
  const looksLikeToolCall = !!(part.toolCallId || part.id) && !!(part.name || part.toolName || part.tool_name);

  if (!(normalizedType === 'tool-call' || normalizedType === 'tool-use' || normalizedType === 'tool-use-kv' || looksLikeToolCall)) {
    return null;
  }

  const toolCallId = part.toolCallId || part.id;
  const name = part.name || part.toolName || part.tool_name;
  const input = part.input || part.arguments || part.args || {};

  if (!toolCallId || !name) return null;

  return {
    type: 'tool_use',
    id: toolCallId,
    name,
    input: typeof input === 'object' && input !== null ? input : { input: String(input) },
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Normalize a tool name to a stable Cursor exec type for dedup signatures.
 * When an adapter is provided, resolves client name → canonical → cursorExecType.
 * @param {string} name
 * @param {import('../adapters/base').ClientAdapter} [adapter]
 */
function normalizeToolName(name, adapter) {
  if (adapter) {
    const { CURSOR_EXEC_TO_CANONICAL, CANONICAL_TOOLS } = require('../adapters/canonical');
    const canon = adapter.toCanonical(name);
    if (canon) {
      const def = CANONICAL_TOOLS[canon];
      return def?.cursorExecType || canon;
    }
  }
  const n = String(name || '').toLowerCase();
  if (n === 'bash' || n === 'shell' || n === 'run_terminal_command' || n === 'run_terminal_cmd') return 'shell';
  if (n === 'read' || n === 'read_file') return 'read';
  if (n === 'write' || n === 'edit_file') return 'write';
  if (n === 'ls' || n === 'list_dir') return 'ls';
  if (n === 'grep' || n === 'ripgrep_search' || n === 'grep_search') return 'grep';
  if (n === 'delete' || n === 'delete_file') return 'delete';
  if (n === 'request_context') return 'request_context';
  return n;
}

function buildExecRequestSignature(execRequest) {
  if (!execRequest || typeof execRequest !== 'object') return null;
  const tool = normalizeToolName(execRequest.type);
  if (!tool) return null;

  if (tool === 'shell') {
    return stableStringify({ tool, command: execRequest.command || '', cwd: execRequest.cwd || '' });
  }
  if (tool === 'read') {
    return stableStringify({ tool, path: execRequest.path || '' });
  }
  if (tool === 'write') {
    return stableStringify({ tool, path: execRequest.path || '', fileText: execRequest.fileText || '' });
  }
  if (tool === 'ls') {
    return stableStringify({ tool, path: execRequest.path || '' });
  }
  if (tool === 'grep') {
    return stableStringify({
      tool,
      pattern: execRequest.pattern || '',
      path: execRequest.path || '',
      glob: execRequest.glob || '',
    });
  }
  if (tool === 'delete') {
    return stableStringify({ tool, path: execRequest.path || '' });
  }
  if (tool === 'request_context') {
    return stableStringify({ tool });
  }

  return null;
}

function buildToolUseSignature(toolUse, adapter) {
  if (!toolUse || typeof toolUse !== 'object') return null;
  const tool = normalizeToolName(toolUse.name, adapter);
  const input = (toolUse.input && typeof toolUse.input === 'object') ? toolUse.input : {};

  if (tool === 'shell') {
    return stableStringify({
      tool,
      command: input.command || input.cmd || '',
      cwd: input.cwd || '',
    });
  }
  if (tool === 'read') {
    return stableStringify({
      tool,
      path: input.path || input.file_path || '',
    });
  }
  if (tool === 'write') {
    return stableStringify({
      tool,
      path: input.path || input.file_path || '',
      fileText: input.fileText || input.file_text || input.content || input.contents || '',
    });
  }
  if (tool === 'ls') {
    return stableStringify({
      tool,
      path: input.path || '',
    });
  }
  if (tool === 'grep') {
    return stableStringify({
      tool,
      pattern: input.pattern || '',
      path: input.path || '',
      glob: input.glob || '',
    });
  }
  if (tool === 'delete') {
    return stableStringify({ tool, path: input.path || '' });
  }
  if (tool === 'request_context') {
    return stableStringify({ tool });
  }

  return null;
}

/**
 * Agent Client Class
 */
class AgentClient {
  constructor(accessToken, options = {}) {
    this.accessToken = accessToken;
    this.baseUrl = options.baseUrl || CURSOR_API_URL;
    this.workspacePath = options.workspacePath || process.cwd();
    this.privacyMode = options.privacyMode !== false;
    this.adapter = options.adapter || null;
    
    this.requestId = null;
    this.appendSeqno = 0n;
    this.blobStore = new Map(); // For KV blob storage
    // Persist dedup data across chatStream → continueStream so that
    // replayed KV FINAL tool calls from previous turns are recognized.
    this._handledExecIds = new Set();
    this._handledExecSignatures = new Set();

    const envContinueTimeout = Number(process.env.CURSOR_CONTINUE_IDLE_TIMEOUT_MS);
    this.continueIdleTimeoutMs = Number.isFinite(envContinueTimeout) && envContinueTimeout > 0
      ? envContinueTimeout
      : 60000;
    const envContinueFirstEventTimeout = Number(process.env.CURSOR_CONTINUE_FIRST_EVENT_TIMEOUT_MS);
    this.continueFirstEventTimeoutMs = Number.isFinite(envContinueFirstEventTimeout) && envContinueFirstEventTimeout > 0
      ? envContinueFirstEventTimeout
      : Math.max(this.continueIdleTimeoutMs * 2, 120000);
  }

  isRequestContext(execRequest) {
    return execRequest && execRequest.type === 'request_context';
  }
  
  /**
   * Convert blob ID to storage key
   */
  blobIdToKey(blobId) {
    return Buffer.from(blobId).toString('hex');
  }
  
  /**
   * Handle KV server message
   * Returns assistant content if found in blob
   */
  async handleKvMessage(kvMsg) {
    let assistantPayload = null;
    
    if (kvMsg.messageType === 'get_blob_args' && kvMsg.blobId) {
      const key = this.blobIdToKey(kvMsg.blobId);
      const data = this.blobStore.get(key);
      console.log(`[AgentClient] KV get_blob: key=${key.substring(0, 16)}..., found=${!!data}`);
      
      const result = data ? encodeMessageField(1, data) : Buffer.alloc(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'get_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      
      await this.bidiAppend(responseMsg);
    }
    
    if (kvMsg.messageType === 'set_blob_args' && kvMsg.blobId && kvMsg.blobData) {
      const key = this.blobIdToKey(kvMsg.blobId);
      this.blobStore.set(key, kvMsg.blobData);
      
      // Try to parse the blob data
      let analysis = 'binary';
      try {
        const text = kvMsg.blobData.toString('utf-8');
        try {
          const json = JSON.parse(text);
          analysis = `json (keys: ${Object.keys(json).join(', ')})`;
          // Check if it's an assistant message with content and id field
          // The 'id' field indicates this is the final response
          if (json.role) {
            const contentPreview = Array.isArray(json.content)
              ? `array[${json.content.length}] types=[${json.content.map(p => p?.type || typeof p).join(',')}]`
              : typeof json.content === 'string' ? `str(${json.content.length})` : String(json.content);
            console.log(`[AgentClient] KV blob role=${json.role}, content=${contentPreview}, hasId=${!!json.id}, keys=${Object.keys(json).join(',')}`);
            if (json.providerOptions) {
              console.log(`[AgentClient] KV blob providerOptions keys: ${Object.keys(json.providerOptions).join(',')}`);
            }
          }
          if (json.role === 'assistant' && json.content) {
            const isFinal = !!json.id;
            if (isFinal) {
              console.log(`[AgentClient] KV blob contains FINAL assistant response (id=${json.id}): ${JSON.stringify(json.content).substring(0, 200)}...`);
            } else {
              console.log(`[AgentClient] KV blob contains FINAL assistant response (id=${json.id}) with empty content (providerOptions=${!!json.providerOptions})`);
            }

            // Extract text and tool calls
            if (!json.content) {
              assistantPayload = { text: '', toolCalls: [], isFinal };
            } else if (typeof json.content === 'string') {
              assistantPayload = { text: json.content, toolCalls: [], isFinal };
            } else if (Array.isArray(json.content)) {
              const textParts = [];
              const toolCalls = [];
              for (const part of json.content) {
                if (typeof part === 'string') {
                  textParts.push(part);
                } else if (part?.type === 'text' && typeof part?.text === 'string') {
                  textParts.push(part.text);
                } else {
                  console.log(`[AgentClient] KV tool-call part raw:`, JSON.stringify(part));
                  const toolCall = parseKvToolCall(part);
                  if (toolCall) {
                    toolCalls.push(toolCall);
                  } else {
                    console.log(`[AgentClient] KV tool-call part failed to parse`);
                  }
                }
              }
              assistantPayload = {
                text: textParts.join(''),
                toolCalls,
                isFinal,
              };
            }
          } else if (json.role === 'assistant' && json.content) {
            console.log(`[AgentClient] KV blob assistant content (intermediate): ${JSON.stringify(json.content).substring(0, 50)}...`);
            if (typeof json.content === 'string') {
              assistantPayload = { text: json.content, toolCalls: [], isFinal: false };
            } else if (Array.isArray(json.content)) {
              const textParts = [];
              const toolCalls = [];
              for (const part of json.content) {
                if (typeof part === 'string') {
                  textParts.push(part);
                } else if (part?.type === 'text' && typeof part?.text === 'string') {
                  textParts.push(part.text);
                } else {
                  const toolCall = parseKvToolCall(part);
                  if (toolCall) toolCalls.push(toolCall);
                }
              }
              assistantPayload = { text: textParts.join(''), toolCalls, isFinal: false };
            }
          }
        } catch {
          analysis = `text (${text.substring(0, 50)}...)`;
        }
      } catch {
        analysis = 'binary';
      }
      
      
      console.log(`[AgentClient] KV set_blob: key=${key.substring(0, 16)}..., size=${kvMsg.blobData.length}b, type=${analysis}`);
      // Print hex for small non-JSON blobs to help diagnose tool call structures
      if (kvMsg.blobData.length <= 200 && !analysis.startsWith('json')) {
        console.log(`[AgentClient] KV set_blob hex: ${kvMsg.blobData.toString('hex')}`);
      }
      
      const result = Buffer.alloc(0);
      const kvClientMsg = buildKvClientMessage(kvMsg.id, 'set_blob_result', result);
      const responseMsg = buildAgentClientMessageWithKv(kvClientMsg);
      
      await this.bidiAppend(responseMsg);
    }
    
    return assistantPayload;
  }
  
  getHeaders(requestId) {
    const checksum = generateCursorChecksum(this.accessToken);
    return {
      'authorization': `Bearer ${this.accessToken}`,
      'content-type': 'application/grpc-web+proto',
      'user-agent': 'connect-es/1.4.0',
      'x-cursor-checksum': checksum,
      'x-cursor-client-version': 'cli-unknown',
      'x-cursor-client-type': 'cli',
      'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      'x-ghost-mode': this.privacyMode ? 'true' : 'false',
      'x-cursor-streaming': 'true',
      ...(requestId ? { 'x-request-id': requestId } : {}),
    };
  }
  
  /**
   * Send BidiAppend request via HTTP/1.1 to api2
   */
  async bidiAppend(data, { maxRetries = 3 } = {}) {
    const hexData = data.toString('hex');
    const appendRequest = encodeBidiAppendRequest(hexData, this.requestId, this.appendSeqno);
    const envelope = addConnectEnvelope(appendRequest);
    
    const bidiUrl = `${CURSOR_API_URL}/aiserver.v1.BidiService/BidiAppend`;
    const BIDI_TIMEOUT_MS = 15000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[AgentClient] BidiAppend seqno=${this.appendSeqno}, data=${data.length}bytes${attempt > 1 ? ` (retry ${attempt}/${maxRetries})` : ''}`);
      
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BIDI_TIMEOUT_MS);
      
      try {
        const response = await fetch(bidiUrl, {
          method: 'POST',
          headers: this.getHeaders(this.requestId),
          body: envelope,
          signal: controller.signal,
        });
        
        if (!response.ok) {
          const errorText = await response.text();
          const err = new Error(`BidiAppend failed: ${response.status} - ${errorText}`);
          err.statusCode = response.status;
          throw err;
        }
        
        console.log(`[AgentClient] BidiAppend success`);
        this.appendSeqno++;
        return;
      } catch (err) {
        clearTimeout(timer);
        
        const isTimeout = err.name === 'AbortError';
        const isNetworkError = err.message?.includes('fetch failed') || err.message?.includes('ECONNREFUSED') || err.message?.includes('ECONNRESET');
        const isRetryable = isTimeout || isNetworkError || err.statusCode >= 500;
        
        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[AgentClient] BidiAppend ${isTimeout ? 'timeout' : 'error'}: ${err.message}, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        
        if (isTimeout) {
          console.error(`[AgentClient] BidiAppend timeout after ${maxRetries} attempts`);
          throw new Error(`BidiAppend timeout after ${maxRetries} attempts (${BIDI_TIMEOUT_MS}ms each)`);
        }
        console.error(`[AgentClient] BidiAppend error after ${attempt} attempt(s):`, err.message);
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  
  /**
   * Send tool result back to Cursor
   */
  async sendToolResult(execRequest, result) {
    let execClientMessage;
    
    switch (execRequest.type) {
      case 'shell': {
        let stdout = result.stdout || '';
        let stderr = result.stderr || '';
        let exitCode = result.exitCode || 0;
        // Fallback: if result only has .error (old-style generic error), extract info
        if (!stdout && !stderr && exitCode === 0 && result.error) {
          const errMsg = typeof result.error === 'string' ? result.error : (result.error.error || 'Command failed');
          stderr = errMsg;
          const exitMatch = errMsg.match(/Exit code (\d+)/i);
          exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 1;
        }
        execClientMessage = buildShellResultMessage(
          execRequest.id,
          execRequest.execId,
          execRequest.command,
          execRequest.cwd || this.workspacePath || process.cwd(),
          stdout,
          stderr,
          exitCode
        );
        break;
      }
      
      case 'write':
        execClientMessage = buildWriteResultMessage(execRequest.id, execRequest.execId, result);
        break;
      
      case 'read':
        execClientMessage = buildReadResultMessage(
          execRequest.id,
          execRequest.execId,
          result.content || '',
          execRequest.path,
          result.totalLines,
          result.fileSize,
          7
        );
        break;
      
      case 'delete':
        execClientMessage = buildDeleteResultMessage(execRequest.id, execRequest.execId, result);
        break;
      
      case 'ls':
        execClientMessage = buildLsResultMessage(execRequest.id, execRequest.execId, result.files || '');
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
        execClientMessage = buildRequestContextResultMessage(execRequest.id, execRequest.execId, this.workspacePath);
        break;

      case 'mcp':
        // MCP tool result - build MCP result message
        execClientMessage = buildMcpResultMessage(
          execRequest.id,
          execRequest.execId,
          result.success ? result.success.content : result.content || '',
          !result.success && result.error
        );
        break;

      default:
        console.log(`[AgentClient] Unknown exec type: ${execRequest.type}`);
        return;
    }
    
    // Send result
    const agentMessage = wrapExecClientMessage(execClientMessage);
    await this.bidiAppend(agentMessage);
    
    // Send stream close
    const controlMessage = buildExecControlMessage(execRequest.id);
    const controlAgentMessage = wrapExecControlMessage(controlMessage);
    await this.bidiAppend(controlAgentMessage);
    
    console.log(`[AgentClient] Tool result sent for ${execRequest.type} id=${execRequest.id}`);
  }
  
  /**
   * Send resume action
   */
  async sendResumeAction() {
    const resumeAction = buildResumeAction();
    await this.bidiAppend(resumeAction);
    console.log(`[AgentClient] Resume action sent`);
  }
  
  /**
   * Stream chat with tool execution
   * @param {Object} request - Chat request
   * @param {string} request.message - User message
   * @param {string} request.model - Model name
   * @param {Array} request.tools - MCP tools
   * @param {Function} onText - Callback for text chunks
   * @param {Function} onToolCall - Callback for tool calls (optional, if not provided tools are executed automatically)
   */
  /**
   * Stream chat with external tool execution.
   * All tools except request_context are forwarded to the client.
   * 
   * @param {Object} request - Chat request
   * @returns {AsyncGenerator} - Yields: text, tool_call, done
   */
  async *chatStream(request) {
    this.requestId = uuidv4();
    this.appendSeqno = 0n;
    this.blobStore = new Map(); // Reset blob store
    
    console.log(`[AgentClient] Starting external tools stream, requestId=${this.requestId}`);
    
    const messageId = uuidv4();
    const conversationId = request.conversationId || uuidv4();
    const model = request.model || 'claude-4-sonnet';
    const mode = 3; // Agent mode
    
    // Build request context with tools
    const requestContext = buildRequestContext(this.workspacePath, request.tools);
    
    // Build message hierarchy
    const userMessage = buildUserMessage(request.message, messageId, mode);
    const userMessageAction = buildUserMessageAction(userMessage, requestContext);
    const conversationAction = buildConversationAction(userMessageAction);
    const modelDetails = buildModelDetails(model);
    const agentRunRequest = buildAgentRunRequest(conversationAction, modelDetails, conversationId, request.tools);
    const agentClientMessage = buildAgentClientMessage(agentRunRequest);
    
    // Build BidiRequestId for RunSSE
    const bidiRequestId = encodeBidiRequestId(this.requestId);
    const envelope = addConnectEnvelope(bidiRequestId);
    
    // Start SSE stream
    const sseUrl = `${CURSOR_API_URL}/agent.v1.AgentService/RunSSE`;
    
    const abortController = new AbortController();
    this.abortController = abortController;
    const timeoutId = setTimeout(() => {
      console.log('[AgentClient] SSE timeout, aborting...');
      abortController.abort();
    }, 300000); // 5 minutes timeout for external tool execution
    this.timeoutId = timeoutId;
    
    try {
      console.log('[AgentClient] Starting SSE connection (external tools mode)...');
      
      const ssePromise = fetch(sseUrl, {
        method: 'POST',
        headers: this.getHeaders(this.requestId),
        body: Buffer.from(envelope),
        signal: abortController.signal,
      });
      
      // Send initial message
      await this.bidiAppend(agentClientMessage);
      
      // Wait for SSE response
      const sseResponse = await ssePromise;
      console.log(`[AgentClient] SSE response status: ${sseResponse.status}`);
      
      if (!sseResponse.ok) {
        const errorText = await sseResponse.text();
        throw new Error(`SSE failed: ${sseResponse.status} - ${errorText}`);
      }
      
      if (!sseResponse.body) {
        throw new Error('No response body');
      }
      
      const reader = sseResponse.body.getReader();
      this.sseReader = reader;
      let buffer = new Uint8Array(0);
      let turnEnded = false;
      let streamError = null;
      let accumulatedText = '';
      let kvResponseText = null;
      let kvToolCalls = [];
      let lastActivityTime = Date.now();
      let checkpointReceived = false;
      let keepReaderForContinuation = false;
      let allSkippedFinalSeen = false;
      let allSkippedFinalTime = 0;
      const ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS = 30000;
      // Track tool calls already handled via exec_server_message (local or forwarded).
      // This avoids duplicated tool_use blocks when the same calls reappear in KV FINAL.
      const locallyExecutedToolIds = new Set();
      // Fallback dedupe when IDs differ but tool name+args are equivalent.
      const locallyExecutedToolSignatures = new Set();
      const trackHandledExecRequest = (execRequest) => {
        if (!execRequest) return;
        if (execRequest.execId) {
          locallyExecutedToolIds.add(execRequest.execId);
        }
        if (execRequest.toolCallId) {
          locallyExecutedToolIds.add(execRequest.toolCallId);
        }
        if (execRequest.id !== undefined && execRequest.id !== null) {
          locallyExecutedToolIds.add(String(execRequest.id));
        }
        const handledSig = buildExecRequestSignature(execRequest);
        if (handledSig) {
          locallyExecutedToolSignatures.add(handledSig);
        }
      };
      const IDLE_TIMEOUT = 180000; // 3 minutes
      const POST_CHECKPOINT_TIMEOUT = 15000; // 15s after checkpoint with no exec
      let checkpointTime = 0;
      
      try {
        while (!turnEnded) {
          const currentTimeout = (checkpointReceived && accumulatedText.length > 0)
            ? POST_CHECKPOINT_TIMEOUT
            : IDLE_TIMEOUT;
          
          // Check for idle timeout
          const timeSinceActivity = Date.now() - lastActivityTime;
          const timeSinceCheckpoint = checkpointReceived ? (Date.now() - checkpointTime) : 0;
          if (timeSinceActivity > currentTimeout) {
            console.log(`[AgentClient] Timeout after ${timeSinceActivity}ms (checkpoint=${checkpointReceived}, postCheckpoint=${timeSinceCheckpoint}ms), ending stream`);
            break;
          }
          if (allSkippedFinalSeen && Date.now() - allSkippedFinalTime > ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS) {
            console.log(`[AgentClient] No follow-up within ${ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS}ms after replayed FINAL (all tool calls already handled), ending chatStream`);
            break;
          }
          
          const readPromise = reader.read();
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Read timeout')), currentTimeout)
          );
          
          let readResult;
          try {
            readResult = await Promise.race([readPromise, timeoutPromise]);
          } catch (e) {
            console.log(`[AgentClient] Read timeout after ${currentTimeout}ms, ending stream`);
            try {
              if (typeof reader.cancel === 'function') {
                await reader.cancel('Read timeout');
              }
            } catch {}
            break;
          }
          
          const { done, value } = readResult;
          lastActivityTime = Date.now();
          
          if (done) {
            break;
          }
          
          // Accumulate buffer
          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;
          
          // Parse frames
          let offset = 0;
          while (offset + 5 <= buffer.length) {
            const flags = buffer[offset];
            const length = (buffer[offset + 1] << 24) | 
                          (buffer[offset + 2] << 16) | 
                          (buffer[offset + 3] << 8) | 
                          buffer[offset + 4];
            
            if (offset + 5 + length > buffer.length) break;
            
            const frameData = buffer.slice(offset + 5, offset + 5 + length);
            offset += 5 + length;
            
            // Check for trailer
            if (flags & 0x80) {
              const trailer = new TextDecoder().decode(frameData);
              console.log('[AgentClient] Trailer:', trailer.substring(0, 200));
              const parsedTrailerError = parseGrpcTrailer(trailer);
              if (parsedTrailerError) {
                streamError = new Error(`Cursor Agent error (${parsedTrailerError.status}): ${parsedTrailerError.message}`);
                turnEnded = true;
              }
              continue;
            }
            
            // Parse AgentServerMessage
            const serverFields = parseProtoFields(Buffer.from(frameData));
            
            for (const field of serverFields) {
              // field 1 = interaction_update
              if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
                const parsed = parseInteractionUpdate(field.value);
                
                if (parsed.text) {
                  accumulatedText += parsed.text;
                  allSkippedFinalSeen = false;
                  console.log(`[AgentClient] interaction_update text: "${parsed.text.substring(0, 50)}..."`);
                }
                
                if (parsed.isComplete) {
                  console.log('[AgentClient] interaction_update: turn_ended received!');
                  turnEnded = true;
                }
                
                if (parsed.isHeartbeat) {
                  console.log('[AgentClient] interaction_update: heartbeat');
                }
              }
              
              // field 2 = exec_server_message
              if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
                const execRequest = parseExecServerMessage(field.value);
                
                if (execRequest) {
                  allSkippedFinalSeen = false;
                  console.log(`[AgentClient] Exec request: ${execRequest.type}`, execRequest);
                  trackHandledExecRequest(execRequest);
                  
                  if (this.isRequestContext(execRequest)) {
                    await this.sendToolResult(execRequest, getRequestContext(this.workspacePath));
                    await this.sendResumeAction();
                  } else {
                    keepReaderForContinuation = true;
                    yield {
                      type: 'tool_call',
                      execRequest,
                      sendResult: async (result) => {
                        await this.sendToolResult(execRequest, result);
                        await this.sendResumeAction();
                      }
                    };
                    turnEnded = true;
                  }
                }
              }
              
              // field 3 = checkpoint
              if (field.fieldNumber === 3 && field.wireType === 2) {
                console.log('[AgentClient] Checkpoint received');
                checkpointReceived = true;
                checkpointTime = Date.now();
              }
              
              // field 4 = kv_server_message
              if (field.fieldNumber === 4 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
                const kvMsg = parseKvServerMessage(field.value);
                const assistantContent = await this.handleKvMessage(kvMsg);
                
                if (assistantContent) {
                  const candidateText = assistantContent.text || '';
                  const incomingToolCalls = assistantContent.toolCalls || [];
                  if (incomingToolCalls.length > 0) {
                    const deduped = [];
                    let skipped = 0;
                    for (const toolUse of incomingToolCalls) {
                      const matchedById = !!toolUse?.id && locallyExecutedToolIds.has(toolUse.id);
                      const signature = buildToolUseSignature(toolUse, this.adapter);
                      const matchedBySignature = !!signature && locallyExecutedToolSignatures.has(signature);
                      if (matchedById || matchedBySignature) {
                        skipped++;
                        continue;
                      }
                      deduped.push(toolUse);
                    }
                    if (skipped > 0) {
                      console.log(`[AgentClient] Skipped ${skipped}/${incomingToolCalls.length} KV tool call(s) already handled via exec_server_message`);
                    }
                    kvToolCalls = deduped;
                    if (kvToolCalls.length > 0) {
                      keepReaderForContinuation = true;
                    }
                  } else {
                    kvToolCalls = incomingToolCalls;
                  }
                  const allToolCallsSkipped = incomingToolCalls.length > 0 && kvToolCalls.length === 0;
                  const hasToolOutput = kvToolCalls.length > 0;
                  if (allToolCallsSkipped) {
                    if (!allSkippedFinalSeen) {
                      allSkippedFinalSeen = true;
                      allSkippedFinalTime = Date.now();
                    }
                    console.log(`[AgentClient] KV final: all ${incomingToolCalls.length} tool call(s) handled locally, waiting up to ${ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS}ms for follow-up`);
                  } else if (assistantContent.isFinal && candidateText.length === 0 && !hasToolOutput) {
                    if (allSkippedFinalSeen) {
                      console.log('[AgentClient] Empty FINAL after replayed FINAL — model is done');
                      turnEnded = true;
                    } else {
                      console.log('[AgentClient] KV final had no new output after dedupe, waiting for more frames');
                    }
                  } else if (assistantContent.isFinal || hasToolOutput) {
                    allSkippedFinalSeen = false;
                    kvResponseText = candidateText;
                    turnEnded = true;
                  }
                  if (!allToolCallsSkipped && !turnEnded && candidateText) {
                    kvResponseText = candidateText;
                  }
                }
              }
              
              // field 5 = exec_server_control_message (abort)
              if (field.fieldNumber === 5 && field.wireType === 2) {
                console.log('[AgentClient] Exec server control (abort) received');
              }
            }
          }
          
          buffer = buffer.slice(offset);
        }
        
        // Persist dedup tracking for continueStream to use
        for (const id of locallyExecutedToolIds) this._handledExecIds.add(id);
        for (const sig of locallyExecutedToolSignatures) this._handledExecSignatures.add(sig);

        // Yield final text response
        if (streamError) {
          yield { type: 'error', error: streamError.message };
          return;
        }

        const finalText = kvResponseText || accumulatedText;
        console.log(`[AgentClient] Stream ending. kvResponseText=${kvResponseText?.length || 0}b, accumulatedText=${accumulatedText?.length || 0}b, turnEnded=${turnEnded}`);
        if (finalText) {
          console.log(`[AgentClient] Yielding final text: "${finalText.substring(0, 100)}..."`);
          yield { type: 'text', content: finalText };
        } else {
          console.log('[AgentClient] No final text to yield');
        }
        for (const toolUse of kvToolCalls) {
          keepReaderForContinuation = true;
          yield { type: 'tool_call_kv', toolUse };
        }
        
        yield { type: 'done' };
        
      } finally {
        if (keepReaderForContinuation) {
          // Keep lock alive so continuation can keep reading the same stream.
          this.sseReader = reader;
          this.sseBuffer = buffer;
        } else {
          try {
            reader.releaseLock();
          } catch {}
          if (this.sseReader === reader) {
            this.sseReader = null;
          }
        }
      }
      
    } finally {
      clearTimeout(timeoutId);
    }
  }
  
  /**
   * Close the connection and clean up
   */
  close() {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }
    this.requestId = null;
    this.sseReader = null;
  }
  
  /**
   * Continue reading after tool result is sent
   * Call this after sending tool result to get more responses
   */
  async *continueStream() {
    if (!this.sseReader) {
      console.log('[AgentClient] No active stream to continue');
      return;
    }

    let buffer = this.sseBuffer || new Uint8Array(0);
    this.sseBuffer = null;
    if (buffer.length > 0) {
      console.log(`[AgentClient] continueStream: restored ${buffer.length}b from previous buffer`);
    }
    let turnEnded = false;
    let streamError = null;
    let accumulatedText = '';
    let kvResponseText = null;
    let kvToolCalls = [];
    let lastActivityTime = Date.now();
    let lastMeaningfulActivity = Date.now();
    let hasReceivedEvent = false;
    let allSkippedFinalSeen = false;
    let allSkippedFinalTime = 0;
    const ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS = 10000;
    const IDLE_TIMEOUT = this.continueIdleTimeoutMs;
    const ABSOLUTE_TIMEOUT = this.continueFirstEventTimeoutMs;
    // Inherit from previous chatStream/continueStream to dedup replayed KV FINALs
    const locallyExecutedToolIds = new Set(this._handledExecIds);
    const locallyExecutedToolSignatures = new Set(this._handledExecSignatures);
    console.log(`[AgentClient] continueStream: inherited ${locallyExecutedToolIds.size} exec IDs, ${locallyExecutedToolSignatures.size} signatures from previous turns`);
    const trackHandledExecRequest = (execRequest) => {
      if (!execRequest) return;
      if (execRequest.execId) {
        locallyExecutedToolIds.add(execRequest.execId);
      }
      if (execRequest.toolCallId) {
        locallyExecutedToolIds.add(execRequest.toolCallId);
      }
      if (execRequest.id !== undefined && execRequest.id !== null) {
        locallyExecutedToolIds.add(String(execRequest.id));
      }
      const handledSig = buildExecRequestSignature(execRequest);
      if (handledSig) {
        locallyExecutedToolSignatures.add(handledSig);
      }
    };

    let skipRead = buffer.length > 0;

    try {
      while (!turnEnded) {
        const currentTimeout = hasReceivedEvent ? IDLE_TIMEOUT : this.continueFirstEventTimeoutMs;
        if (Date.now() - lastActivityTime > currentTimeout) {
          console.log(`[AgentClient] Timeout after ${currentTimeout}ms (${hasReceivedEvent ? 'idle' : 'first-event'}), ending stream`);
          break;
        }
        if (Date.now() - lastMeaningfulActivity > ABSOLUTE_TIMEOUT) {
          console.log(`[AgentClient] Absolute timeout after ${ABSOLUTE_TIMEOUT}ms (no meaningful events, only heartbeats), ending continueStream`);
          break;
        }
        if (allSkippedFinalSeen && Date.now() - allSkippedFinalTime > ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS) {
          console.log(`[AgentClient] No follow-up within ${ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS}ms after replayed FINAL (all tool calls already handled), ending turn`);
          break;
        }

        if (!skipRead) {
          console.log(`[AgentClient] continueStream: calling reader.read()... (iter=${Date.now() - lastMeaningfulActivity}ms since start)`);
          const readPromise = this.sseReader.read();
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Read timeout')), currentTimeout)
          );

          let readResult;
          try {
            readResult = await Promise.race([readPromise, timeoutPromise]);
          } catch (e) {
            console.log(`[AgentClient] Read timeout after ${currentTimeout}ms (${hasReceivedEvent ? 'idle' : 'first-event'}), ending continueStream`);
            try {
              if (this.sseReader && typeof this.sseReader.cancel === 'function') {
                await this.sseReader.cancel('Read timeout');
              }
            } catch {}
            break;
          }

          const { done, value } = readResult;
          lastActivityTime = Date.now();

          if (done) {
            console.log('[AgentClient] continueStream: reader returned done');
            break;
          }
          hasReceivedEvent = true;
          console.log(`[AgentClient] continueStream: received ${value.length}b, buffer was ${buffer.length}b, hex=${Buffer.from(value.slice(0, 30)).toString('hex')}`);

          const newBuffer = new Uint8Array(buffer.length + value.length);
          newBuffer.set(buffer);
          newBuffer.set(value, buffer.length);
          buffer = newBuffer;
        } else {
          console.log(`[AgentClient] continueStream: parsing restored buffer (${buffer.length}b) before reading`);
          skipRead = false;
        }

        // Parse frames
        let offset = 0;
        while (offset + 5 <= buffer.length) {
          const flags = buffer[offset];
          const length = (buffer[offset + 1] << 24) |
                        (buffer[offset + 2] << 16) |
                        (buffer[offset + 3] << 8) |
                        buffer[offset + 4];

          if (offset + 5 + length > buffer.length) {
            console.log(`[AgentClient] continueStream: partial frame, need ${length + 5}b but have ${buffer.length - offset}b`);
            break;
          }

          const frameData = buffer.slice(offset + 5, offset + 5 + length);
          offset += 5 + length;

          if (flags & 0x80) {
            const trailer = new TextDecoder().decode(frameData);
            console.log(`[AgentClient] continueStream: trailer received: ${trailer.substring(0, 200)}`);
            const parsedTrailerError = parseGrpcTrailer(trailer);
            if (parsedTrailerError) {
              streamError = new Error(`Cursor Agent error (${parsedTrailerError.status}): ${parsedTrailerError.message}`);
              turnEnded = true;
            }
            continue;
          }

          const serverFields = parseProtoFields(Buffer.from(frameData));
          console.log(`[AgentClient] continueStream frame: ${serverFields.length} field(s), fields=[${serverFields.map(f => `${f.fieldNumber}(wt${f.wireType})`).join(',')}]`);

          for (const field of serverFields) {
            if (field.fieldNumber === 1 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
              const parsed = parseInteractionUpdate(field.value);
              if (parsed.isHeartbeat) {
                console.log('[AgentClient] continueStream: heartbeat');
              }
              if (parsed.text) {
                accumulatedText += parsed.text;
                lastMeaningfulActivity = Date.now();
                allSkippedFinalSeen = false;
                console.log(`[AgentClient] continueStream text: "${parsed.text.substring(0, 50)}..."`);
              }
              if (parsed.isComplete) {
                console.log('[AgentClient] continueStream: turn_ended received!');
                turnEnded = true;
              }
            }

            if (field.fieldNumber === 2 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
              const execRequest = parseExecServerMessage(field.value);
              if (execRequest) {
                lastMeaningfulActivity = Date.now();
                allSkippedFinalSeen = false;
                console.log(`[AgentClient] continueStream exec request: ${execRequest.type}`);
                trackHandledExecRequest(execRequest);

                if (this.isRequestContext(execRequest)) {
                  await this.sendToolResult(execRequest, getRequestContext(this.workspacePath));
                  await this.sendResumeAction();
                } else {
                  yield {
                    type: 'tool_call',
                    execRequest,
                    sendResult: async (result) => {
                      await this.sendToolResult(execRequest, result);
                      await this.sendResumeAction();
                    }
                  };
                  turnEnded = true;
                }
              }
            }

            if (field.fieldNumber === 4 && field.wireType === 2 && Buffer.isBuffer(field.value)) {
              const kvMsg = parseKvServerMessage(field.value);
              const assistantContent = await this.handleKvMessage(kvMsg);
              if (assistantContent) {
                const candidateText = assistantContent.text || '';
                const incomingToolCalls = assistantContent.toolCalls || [];
                if (incomingToolCalls.length > 0) {
                  const deduped = [];
                  let skipped = 0;
                  for (const toolUse of incomingToolCalls) {
                    const matchedById = !!toolUse?.id && locallyExecutedToolIds.has(toolUse.id);
                    const signature = buildToolUseSignature(toolUse, this.adapter);
                    const matchedBySignature = !!signature && locallyExecutedToolSignatures.has(signature);
                    if (matchedById || matchedBySignature) {
                      skipped++;
                      continue;
                    }
                    deduped.push(toolUse);
                  }
                  if (skipped > 0) {
                    console.log(`[AgentClient] continueStream skipped ${skipped}/${incomingToolCalls.length} KV tool call(s) already handled`);
                  }
                  kvToolCalls = deduped;
                } else {
                  kvToolCalls = incomingToolCalls;
                }
                const allToolCallsSkipped = incomingToolCalls.length > 0 && kvToolCalls.length === 0;
                const hasToolOutput = kvToolCalls.length > 0;
                if (allToolCallsSkipped) {
                  if (!allSkippedFinalSeen) {
                    allSkippedFinalSeen = true;
                    allSkippedFinalTime = Date.now();
                  }
                  console.log(`[AgentClient] continueStream: all ${incomingToolCalls.length} tool call(s) handled locally, waiting up to ${ALL_SKIPPED_FOLLOWUP_TIMEOUT_MS}ms for follow-up`);
                } else if (assistantContent.isFinal && candidateText.length === 0 && !hasToolOutput) {
                  if (allSkippedFinalSeen) {
                    console.log('[AgentClient] continueStream: empty FINAL after replayed FINAL — model is done');
                    turnEnded = true;
                  } else {
                    console.log('[AgentClient] continueStream KV final had no new output after dedupe, waiting for more frames');
                  }
                } else if (assistantContent.isFinal || hasToolOutput) {
                  lastMeaningfulActivity = Date.now();
                  allSkippedFinalSeen = false;
                  kvResponseText = candidateText;
                  turnEnded = true;
                }
                if (!allToolCallsSkipped && !turnEnded && candidateText) {
                  lastMeaningfulActivity = Date.now();
                  kvResponseText = candidateText;
                }
              }
            }
          }
        }

        buffer = buffer.slice(offset);
      }

      // Persist dedup tracking for next continueStream
      for (const id of locallyExecutedToolIds) this._handledExecIds.add(id);
      for (const sig of locallyExecutedToolSignatures) this._handledExecSignatures.add(sig);

      const finalText = kvResponseText || accumulatedText;
      if (streamError) {
        yield { type: 'error', error: streamError.message };
        return;
      }
      if (finalText) {
        console.log(`[AgentClient] continueStream yielding final text: "${finalText.substring(0, 100)}..."`);
        yield { type: 'text', content: finalText };
      }
      for (const toolUse of kvToolCalls) {
        yield { type: 'tool_call_kv', toolUse };
      }

      const staleContinuation = allSkippedFinalSeen && kvToolCalls.length === 0;
      if (staleContinuation) {
        console.log('[AgentClient] continueStream: stale continuation (no new content after replayed FINAL), signalling fallback');
        yield { type: 'stale_continuation' };
      }
      yield { type: 'done' };

    } catch (e) {
      console.log('[AgentClient] Continue stream error:', e.message);
      yield { type: 'error', error: e.message };
    } finally {
      this.sseBuffer = buffer;
    }
  }
}

module.exports = {
  AgentClient,
  parseExecServerMessage,
  encodeBidiRequestId,
  encodeBidiAppendRequest,
  // Exported for integration testing (protobuf encoding verification)
  _buildShellResultMessage: buildShellResultMessage,
  _buildWriteResultMessage: buildWriteResultMessage,
  _buildReadResultMessage: buildReadResultMessage,
  _buildLsResultMessage: buildLsResultMessage,
  _buildGrepResultMessage: buildGrepResultMessage,
  _buildDeleteResultMessage: buildDeleteResultMessage,
  _buildMcpResultMessage: buildMcpResultMessage,
  _buildRequestContextResultMessage: buildRequestContextResultMessage,
  // Exported for cross-turn dedup testing
  _buildExecRequestSignature: buildExecRequestSignature,
  _buildToolUseSignature: buildToolUseSignature,
  _normalizeToolName: normalizeToolName,
  // Exported for MCP registration testing
  _buildMcpToolsWrapper: buildMcpToolsWrapper,
  _buildAgentRunRequest: buildAgentRunRequest,
  _buildRequestContext: buildRequestContext,
  // Exported for MCP tool name sanitization testing
  _sanitizeMcpToolName: sanitizeMcpToolName,
  _restoreMcpToolName: restoreMcpToolName,
  CURSOR_RESERVED_TOOL_NAMES,
};
