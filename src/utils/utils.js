const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const $root = require('../proto/message.js');

// Get Cursor storage path based on platform
function getCursorStoragePath() {
  const homeDir = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default: // linux
      return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

// Read machine ID from Cursor's SQLite storage
let cachedMachineId = null;
function getMachineIdFromStorage() {
  if (cachedMachineId) return cachedMachineId;
  
  try {
    const Database = require('better-sqlite3');
    const dbPath = getCursorStoragePath();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId'").get();
    db.close();
    if (row && row.value) {
      cachedMachineId = row.value.toString();
      return cachedMachineId;
    }
  } catch (err) {
    console.error('Could not read machine ID from Cursor storage:', err.message);
  }
  return null;
}

// ClientSideToolV2 enum values - from cursor_api_reference TASK-110-tool-enum-mapping.md
const ClientSideToolV2 = {
  UNSPECIFIED: 0,
  READ_SEMSEARCH_FILES: 1,
  RIPGREP_SEARCH: 3,
  READ_FILE: 5,
  LIST_DIR: 6,
  EDIT_FILE: 7,
  FILE_SEARCH: 8,
  SEMANTIC_SEARCH_FULL: 9,
  DELETE_FILE: 11,
  REAPPLY: 12,
  RUN_TERMINAL_COMMAND_V2: 15,
  FETCH_RULES: 16,
  WEB_SEARCH: 18,
  MCP: 19,
  SEARCH_SYMBOLS: 23,
  BACKGROUND_COMPOSER_FOLLOWUP: 24,
  KNOWLEDGE_BASE: 25,
  FETCH_PULL_REQUEST: 26,
  DEEP_SEARCH: 27,
  CREATE_DIAGRAM: 28,
  FIX_LINTS: 29,
  READ_LINTS: 30,
  GO_TO_DEFINITION: 31,
  TASK: 32,
  AWAIT_TASK: 33,
  TODO_READ: 34,
  TODO_WRITE: 35,
  EDIT_FILE_V2: 38,  // This is what Cursor uses for "write"!
  LIST_DIR_V2: 39,
  READ_FILE_V2: 40,
  RIPGREP_RAW_SEARCH: 41,
  GLOB_FILE_SEARCH: 42,
  CREATE_PLAN: 43,
  LIST_MCP_RESOURCES: 44,
  READ_MCP_RESOURCE: 45,
  READ_PROJECT: 46,
  UPDATE_PROJECT: 47,
  TASK_V2: 48,
  CALL_MCP_TOOL: 49,
  APPLY_AGENT_DIFF: 50,
  ASK_QUESTION: 51,
  SWITCH_MODE: 52,
  GENERATE_IMAGE: 53,
  COMPUTER_USE: 54,
  WRITE_SHELL_STDIN: 55,
};

// Reverse mapping: enum ID -> tool name string
const ClientSideToolV2Names = {
  [ClientSideToolV2.READ_FILE]: 'read_file',
  [ClientSideToolV2.READ_FILE_V2]: 'read_file',
  [ClientSideToolV2.LIST_DIR]: 'list_dir',
  [ClientSideToolV2.LIST_DIR_V2]: 'list_dir',
  [ClientSideToolV2.EDIT_FILE]: 'edit_file',
  [ClientSideToolV2.EDIT_FILE_V2]: 'write',  // V2 is used for write operations
  [ClientSideToolV2.DELETE_FILE]: 'delete_file',
  [ClientSideToolV2.RIPGREP_SEARCH]: 'ripgrep_search',
  [ClientSideToolV2.RIPGREP_RAW_SEARCH]: 'ripgrep_search',
  [ClientSideToolV2.RUN_TERMINAL_COMMAND_V2]: 'run_terminal_command',
  [ClientSideToolV2.FILE_SEARCH]: 'file_search',
  [ClientSideToolV2.GLOB_FILE_SEARCH]: 'glob_file_search',
  [ClientSideToolV2.WEB_SEARCH]: 'web_search',
  [ClientSideToolV2.SEARCH_SYMBOLS]: 'search_symbols',
  [ClientSideToolV2.GO_TO_DEFINITION]: 'go_to_definition',
  [ClientSideToolV2.FETCH_RULES]: 'fetch_rules',
  [ClientSideToolV2.TODO_READ]: 'todo_read',
  [ClientSideToolV2.TODO_WRITE]: 'todo_write',
  [ClientSideToolV2.TASK]: 'task',
  [ClientSideToolV2.TASK_V2]: 'task',
  [ClientSideToolV2.MCP]: 'mcp',
  [ClientSideToolV2.CALL_MCP_TOOL]: 'call_mcp_tool',
};

// Default tools for agent mode - includes both V1 and V2 versions per TASK-110
const DEFAULT_AGENT_TOOLS = [
  ClientSideToolV2.READ_FILE,
  ClientSideToolV2.READ_FILE_V2,
  ClientSideToolV2.LIST_DIR,
  ClientSideToolV2.LIST_DIR_V2,
  ClientSideToolV2.EDIT_FILE,
  ClientSideToolV2.EDIT_FILE_V2,  // This is used for "write" operations
  ClientSideToolV2.DELETE_FILE,
  ClientSideToolV2.RIPGREP_SEARCH,
  ClientSideToolV2.RIPGREP_RAW_SEARCH,
  ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  ClientSideToolV2.FILE_SEARCH,
  ClientSideToolV2.GLOB_FILE_SEARCH,
  ClientSideToolV2.WEB_SEARCH,
  ClientSideToolV2.SEARCH_SYMBOLS,
  ClientSideToolV2.GO_TO_DEFINITION,
];

// MCP only tools for custom tool support
const MCP_ONLY_TOOLS = [
  ClientSideToolV2.MCP,
];

function generateCursorBody(messages, modelName, options = {}) {
  const { agentMode = false, tools = DEFAULT_AGENT_TOOLS } = options;

  const instruction = messages
    .filter(msg => msg.role === 'system')
    .map(msg => msg.content)
    .join('\n')

  // chatModeEnum: 1 = Ask, 3 = Agent (see TASK-110-tool-enum-mapping.md)
  const chatModeEnum = agentMode ? 3 : 1;
  const chatMode = agentMode ? "Agent" : "Ask";

  const formattedMessages = messages
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      content: msg.content,
      role: msg.role === 'user' ? 1 : 2,
      messageId: uuidv4(),
      ...(msg.role === 'user' ? { chatModeEnum: chatModeEnum } : {})
    }));

  const messageIds = formattedMessages.map(msg => {
    const { role, messageId, summaryId } = msg;
    return summaryId ? { role, messageId, summaryId } : { role, messageId };
  });

  // Build supported tools array for agent mode - TASK-7 says field 29 is repeated ClientSideToolV2
  const supportedTools = agentMode ? tools : [];

  const body = {
    request:{
      messages: formattedMessages,
      unknown2: 1,
      instruction: {
        instruction: instruction
      },
      unknown4: 1,
      model: {
        name: modelName,
        empty: '',
      },
      webTool: "",
      unknown13: 1,
      cursorSetting: {
        name: "cursor\\aisettings",
        unknown3: "",
        unknown6: {
          unknwon1: "",
          unknown2: ""
        },
        unknown8: 1,
        unknown9: 1
      },
      unknown19: 1,
      //unknown22: 1,
      conversationId: uuidv4(),
      metadata: {
        os: process.platform,
        arch: process.arch,
        version: "10.0.22631",
        path: process.execPath,
        timestamp: new Date().toISOString(),
      },
      // Agent mode fields - see TASK-7-protobuf-schemas.md
      ...(agentMode ? { isAgentic: true, supportedTools } : {}),
      messageIds: messageIds,
      largeContext: 0,
      unknown38: 0,
    }
  };

  
  const errMsg = $root.StreamUnifiedChatWithToolsRequest.verify(body);
  if (errMsg) throw Error(errMsg);
  const instance = $root.StreamUnifiedChatWithToolsRequest.create(body);
  let buffer = $root.StreamUnifiedChatWithToolsRequest.encode(instance).finish();
  let magicNumber = 0x00
  if (formattedMessages.length >= 3){
    buffer = zlib.gzipSync(buffer)
    magicNumber = 0x01
  }

  const finalBody = Buffer.concat([
    Buffer.from([magicNumber]),
    Buffer.from(buffer.length.toString(16).padStart(8, '0'), 'hex'),
    buffer
  ])

  return finalBody
}

/**
 * Decode a protobuf varint at position
 * Based on cursor_api_reference/cursor_chat_proto.py
 */
function decodeVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos];
    result |= (b & 0x7F) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

/**
 * Decode a protobuf field
 * Returns [fieldNum, wireType, value, newPos]
 */
function decodeField(buf, pos) {
  if (pos >= buf.length) return [null, null, null, pos];
  
  const [tag, newPos] = decodeVarint(buf, pos);
  pos = newPos;
  const fieldNum = tag >> 3;
  const wireType = tag & 0x07;
  
  let value;
  if (wireType === 0) {  // Varint
    [value, pos] = decodeVarint(buf, pos);
  } else if (wireType === 2) {  // Length-delimited
    const [length, lenPos] = decodeVarint(buf, pos);
    pos = lenPos;
    value = buf.slice(pos, pos + length);
    pos += length;
  } else if (wireType === 1) {  // Fixed64
    value = buf.slice(pos, pos + 8);
    pos += 8;
  } else if (wireType === 5) {  // Fixed32
    value = buf.slice(pos, pos + 4);
    pos += 4;
  }
  
  return [fieldNum, wireType, value, pos];
}

/**
 * Try to parse a binary buffer as a ClientSideToolV2Call message
 * Based on cursor_api_reference TASK-26-tool-schemas.md:
 * - field 1: tool (enum/varint)
 * - field 3: tool_call_id (string)
 * - field 9: name (string)
 * - field 10: raw_args (string JSON)
 */
function tryParseToolCall(buf) {
  try {
    const fields = {};
    let pos = 0;
    
    // First pass: decode all fields using proper protobuf parsing
    while (pos < buf.length) {
      const [fieldNum, wireType, value, newPos] = decodeField(buf, pos);
      if (fieldNum === null) break;
      pos = newPos;
      
      if (!fields[fieldNum]) fields[fieldNum] = [];
      fields[fieldNum].push({ wireType, value });
    }
    
    // Extract known fields per TASK-26 schema
    let tool = null;
    let toolCallId = null;
    let name = null;
    let rawArgs = null;
    
    // Field 1: tool enum (varint)
    if (fields[1] && fields[1][0].wireType === 0) {
      tool = fields[1][0].value;
    }
    
    // Field 3: tool_call_id (string)
    if (fields[3] && fields[3][0].wireType === 2) {
      try {
        toolCallId = fields[3][0].value.toString('utf-8');
      } catch (e) {}
    }
    
    // Field 9: name (string)
    if (fields[9] && fields[9][0].wireType === 2) {
      try {
        name = fields[9][0].value.toString('utf-8');
      } catch (e) {}
    }
    
    // Field 10: raw_args (string JSON)
    if (fields[10] && fields[10][0].wireType === 2) {
      try {
        rawArgs = fields[10][0].value.toString('utf-8');
      } catch (e) {}
    }
    
    // For write operations, try to extract content from field 5 (embedded path/content)
    if (tool === ClientSideToolV2.EDIT_FILE_V2 && fields[5] && fields[5].length >= 2) {
      try {
        const pathField = fields[5][0]?.value?.toString('utf-8');
        const contentField = fields[5][1]?.value?.toString('utf-8');
        if (pathField && contentField) {
          rawArgs = JSON.stringify({ file_path: pathField, contents: contentField });
        }
      } catch (e) {}
    }
    
    // Field 14: is_streaming (bool/varint)
    let isStreaming = false;
    if (fields[14] && fields[14][0].wireType === 0) {
      isStreaming = Boolean(fields[14][0].value);
    }
    
    // Field 15: is_last_message (bool/varint) 
    let isLastMessage = false;
    if (fields[15] && fields[15][0].wireType === 0) {
      isLastMessage = Boolean(fields[15][0].value);
    }
    
    // Check typed params fields for complete data (when raw_args is truncated)
    // Field 50: edit_file_v2_params
    if (fields[50] && fields[50][0].wireType === 2) {
      try {
        const paramsData = fields[50][0].value;
        const paramsFields = {};
        let pPos = 0;
        while (pPos < paramsData.length) {
          const [fNum, wType, val, nPos] = decodeField(paramsData, pPos);
          if (fNum === null) break;
          pPos = nPos;
          paramsFields[fNum] = { wireType: wType, value: val };
        }
        // Extract EditFileV2Params: relative_workspace_path=1, contents_after_edit=2
        const params = {};
        if (paramsFields[1] && paramsFields[1].wireType === 2) {
          params.file_path = paramsFields[1].value.toString('utf-8');
        }
        if (paramsFields[2] && paramsFields[2].wireType === 2) {
          params.contents = paramsFields[2].value.toString('utf-8');
        }
        if (paramsFields[9] && paramsFields[9].wireType === 2) {
          params.streaming_content = paramsFields[9].value.toString('utf-8');
        }
        if (Object.keys(params).length > 0) {
          rawArgs = JSON.stringify(params);
        }
      } catch (e) {}
    }
    
    // Field 23: run_terminal_command_v2_params
    if (fields[23] && fields[23][0].wireType === 2) {
      try {
        const paramsData = fields[23][0].value;
        const paramsFields = {};
        let pPos = 0;
        while (pPos < paramsData.length) {
          const [fNum, wType, val, nPos] = decodeField(paramsData, pPos);
          if (fNum === null) break;
          pPos = nPos;
          paramsFields[fNum] = { wireType: wType, value: val };
        }
        // RunTerminalCommandV2Params: command=1, cwd=2, is_background=3
        const params = {};
        if (paramsFields[1] && paramsFields[1].wireType === 2) {
          params.command = paramsFields[1].value.toString('utf-8');
        }
        if (paramsFields[2] && paramsFields[2].wireType === 2) {
          params.cwd = paramsFields[2].value.toString('utf-8');
        }
        if (paramsFields[3] && paramsFields[3].wireType === 0) {
          params.is_background = Boolean(paramsFields[3].value);
        }
        if (Object.keys(params).length > 0) {
          rawArgs = JSON.stringify(params);
        }
      } catch (e) {}
    }
    
    // Field 52: list_dir_v2_params
    if (fields[52] && fields[52][0].wireType === 2) {
      try {
        const paramsData = fields[52][0].value;
        const paramsFields = {};
        let pPos = 0;
        while (pPos < paramsData.length) {
          const [fNum, wType, val, nPos] = decodeField(paramsData, pPos);
          if (fNum === null) break;
          pPos = nPos;
          paramsFields[fNum] = { wireType: wType, value: val };
        }
        // ListDirV2Params: directory_path=1
        const params = {};
        if (paramsFields[1] && paramsFields[1].wireType === 2) {
          params.target_directory = paramsFields[1].value.toString('utf-8');
        }
        if (Object.keys(params).length > 0) {
          rawArgs = JSON.stringify(params);
          console.log('[Debug] Extracted params from list_dir_v2_params:', Object.keys(params));
        }
      } catch (e) {}
    }
    
    // Field 53: read_file_v2_params
    if (fields[53] && fields[53][0].wireType === 2) {
      try {
        const paramsData = fields[53][0].value;
        const paramsFields = {};
        let pPos = 0;
        while (pPos < paramsData.length) {
          const [fNum, wType, val, nPos] = decodeField(paramsData, pPos);
          if (fNum === null) break;
          pPos = nPos;
          paramsFields[fNum] = { wireType: wType, value: val };
        }
        // ReadFileV2Params: relative_workspace_path=1, start_line=2, end_line=3
        const params = {};
        if (paramsFields[1] && paramsFields[1].wireType === 2) {
          params.target_file = paramsFields[1].value.toString('utf-8');
        }
        if (paramsFields[2] && paramsFields[2].wireType === 0) {
          params.start_line_one_indexed = paramsFields[2].value;
        }
        if (paramsFields[3] && paramsFields[3].wireType === 0) {
          params.end_line_one_indexed_inclusive = paramsFields[3].value;
        }
        if (Object.keys(params).length > 0) {
          rawArgs = JSON.stringify(params);
        }
      } catch (e) {}
    }
    
    // Fallback: try to extract from string representation if protobuf parsing incomplete
    const str = buf.toString('utf-8');
    
    // Extract tool_call_id from string if not found
    if (!toolCallId) {
      const toolIdMatch = str.match(/toolu_[a-zA-Z0-9_]+/);
      if (toolIdMatch) toolCallId = toolIdMatch[0];
    }
    
    // Extract raw_args from JSON patterns if not found or incomplete
    if (!rawArgs || rawArgs === '{}') {
      const params = {};
      
      // Pattern 1: Standard "key": "value"
      const kvMatches1 = str.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g);
      for (const m of kvMatches1) {
        params[m[1]] = m[2];
      }
      
      // Pattern 2: Truncated JSON - "key": "value followed by binary
      const kvMatches2 = str.matchAll(/"([a-z_]+)"\s*:\s*"([^"\x00-\x1f\x80-\xff]+)/gi);
      for (const m of kvMatches2) {
        if (!params[m[1]]) {
          let value = m[2];
          // Remove trailing protobuf field markers
          const fieldMarkerMatch = value.match(/^(.+[\s\w])([a-z])$/);
          if (fieldMarkerMatch && fieldMarkerMatch[2].charCodeAt(0) >= 0x70) {
            value = fieldMarkerMatch[1];
          }
          value = value.replace(/[^\x20-\x7E]+$/, '').trim();
          params[m[1]] = value;
        }
      }
      
      if (Object.keys(params).length > 0) {
        rawArgs = JSON.stringify(params);
      }
    }
    
    // Try to extract complete content from embedded protobuf structure
    // Cursor embeds complete file_path and contents in binary after truncated rawArgs
    // Pattern: 0x0a (field 1 tag) + length + file_path, 0x2a (field 5 tag) + length + nested content
    if (rawArgs && !rawArgs.endsWith('}')) {
      for (let i = 50; i < buf.length - 10; i++) {
        if (buf[i] === 0x0a) { // potential field 1 tag
          const len1 = buf[i + 1];
          if (len1 > 0 && len1 < 200 && i + 2 + len1 < buf.length) {
            const potentialPath = buf.subarray(i + 2, i + 2 + len1).toString('utf-8');
            // Check if it looks like a filename
            if (/^[a-zA-Z0-9_\-\.\/]+$/.test(potentialPath) && potentialPath.length > 2) {
              const afterPath = i + 2 + len1;
              if (afterPath < buf.length && buf[afterPath] === 0x2a) { // field 5 tag
                const len2 = buf[afterPath + 1];
                if (len2 > 0 && afterPath + 2 + len2 <= buf.length) {
                  const contentData = buf.subarray(afterPath + 2, afterPath + 2 + len2);
                  // Content has nested structure: 0x0a + length + actual content
                  if (contentData[0] === 0x0a) {
                    const contentLen = contentData[1];
                    if (contentLen > 0 && 2 + contentLen <= contentData.length) {
                      const actualContent = contentData.subarray(2, 2 + contentLen).toString('utf-8');
                      rawArgs = JSON.stringify({ file_path: potentialPath, contents: actualContent });
                      break;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    
    // Extract name from string if not found
    if (!name) {
      const toolNames = ['write', 'read_file', 'list_dir', 'edit_file', 'delete_file', 
                         'run_terminal_command', 'ripgrep_search', 'file_search',
                         'web_search', 'fetch_rules', 'glob_file_search'];
      for (const tn of toolNames) {
        if (str.toLowerCase().includes(tn)) {
          name = tn;
          break;
        }
      }
    }
    
    // Use ClientSideToolV2Names to get standard name from tool enum
    if (tool && !name && ClientSideToolV2Names[tool]) {
      name = ClientSideToolV2Names[tool];
    }
    
    if (toolCallId && (name || rawArgs || tool)) {
      return { tool, toolCallId, name, rawArgs, isStreaming, isLastMessage };
    }
  } catch (e) {
    // Parsing failed
  }
  return null;
}

/**
 * Cursor Stream Decoder with accumulation buffer
 * Based on cursor_api_reference/cursor_streaming_decoder.py
 * Handles partial messages that span multiple chunks
 * Also handles streaming tool calls (is_streaming = true)
 */
class CursorStreamDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
    // Accumulator for streaming tool calls (keyed by tool_call_id)
    this.streamingToolCalls = {};
  }
  
  /**
   * Feed data and return parsed results
   * Frame format: [msg_type:1byte][msg_len:4bytes][msg_data:msg_len_bytes]
   */
  feedData(chunk) {
    const thinkingOutput = [];
    const textOutput = [];
    const toolCalls = [];
    
    // Accumulate data
    const newData = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, newData]);
    
    try {
      let i = 0;
      while (i + 5 <= this.buffer.length) {
        const magicNumber = this.buffer[i];
        const dataLength = this.buffer.readUInt32BE(i + 1);
        
        // Check if we have the complete message
        if (i + 5 + dataLength > this.buffer.length) {
          // Incomplete message, wait for more data
          break;
        }
        
        const data = this.buffer.subarray(i + 5, i + 5 + dataLength);
        
        if (dataLength === 0) {
          i += 5;
          continue;
        }
        
        const result = this._processMessage(magicNumber, data);
        if (result.thinking) thinkingOutput.push(result.thinking);
        if (result.text) textOutput.push(result.text);
        if (result.toolCall) toolCalls.push(result.toolCall);
        
        i += 5 + dataLength;
      }
      
      // Remove processed data from buffer
      if (i > 0) {
        this.buffer = this.buffer.subarray(i);
      }
    } catch (err) {
      console.log('Error in CursorStreamDecoder:', err);
    }
    
    return {
      thinking: thinkingOutput.join(''),
      text: textOutput.join(''),
      toolCalls,
    };
  }
  
  _processMessage(magicNumber, data) {
    const result = { thinking: null, text: null, toolCall: null };
    
    try {
      if (magicNumber === 0 || magicNumber === 1) {
        const gunzipData = magicNumber === 0 ? data : zlib.gunzipSync(data);
        const response = $root.StreamUnifiedChatWithToolsResponse.decode(gunzipData);
        
        // Extract thinking
        if (response?.thinking?.content) {
          result.thinking = response.thinking.content;
        }
        
        // Extract text content
        if (response?.message?.content) {
          result.text = response.message.content;
        }
        
        // Check for tool calls
        if (response?.toolCallV2?.toolCallId) {
          result.toolCall = {
            tool: response.toolCallV2.tool,
            toolCallId: response.toolCallV2.toolCallId,
            name: response.toolCallV2.name,
            rawArgs: response.toolCallV2.rawArgs,
          };
        } else if (response?.toolCall?.toolCallId) {
          result.toolCall = {
            tool: null,
            toolCallId: response.toolCall.toolCallId,
            name: response.toolCall.name,
            rawArgs: response.toolCall.arguments,
          };
        }
        
        // Check if text field contains binary tool call
        const textField = response?.text;
        if (textField && typeof textField === 'string') {
          const textBuf = Buffer.from(textField, 'binary');
          if (textBuf.length > 0 && textBuf[0] === 0x08) {
            const toolCall = tryParseToolCall(textBuf);
            if (toolCall) {
              // Handle streaming tool calls
              if (toolCall.isStreaming) {
                const id = toolCall.toolCallId;
                if (!this.streamingToolCalls[id]) {
                  this.streamingToolCalls[id] = {
                    tool: toolCall.tool,
                    toolCallId: id,
                    name: toolCall.name,
                    rawArgsChunks: [],
                  };
                }
                // Accumulate content from rawArgs
                if (toolCall.rawArgs) {
                  this.streamingToolCalls[id].rawArgsChunks.push(toolCall.rawArgs);
                }
                
                // If this is the last message, finalize and return
                if (toolCall.isLastMessage) {
                  const accumulated = this.streamingToolCalls[id];
                  delete this.streamingToolCalls[id];
                  let finalArgs = this._mergeStreamingArgs(accumulated.rawArgsChunks);
                  result.toolCall = {
                    tool: accumulated.tool,
                    toolCallId: accumulated.toolCallId,
                    name: accumulated.name,
                    rawArgs: finalArgs,
                  };
                }
              } else {
                // Non-streaming tool call
                result.toolCall = toolCall;
              }
            }
          }
        }
      } else if (magicNumber === 2 || magicNumber === 3) {
        const gunzipData = magicNumber === 2 ? data : zlib.gunzipSync(data);
        const utf8 = gunzipData.toString('utf-8');
        try {
          const message = JSON.parse(utf8);
          if (message?.error) {
            console.error('[Stream Error]', utf8);
          }
        } catch (e) {}
      }
    } catch (err) {
      console.log('Error processing message:', err);
    }
    
    return result;
  }
  
  /**
   * Merge streaming tool call argument chunks
   */
  _mergeStreamingArgs(chunks) {
    if (!chunks || chunks.length === 0) return '{}';
    if (chunks.length === 1) return chunks[0];
    
    // Try to merge as JSON objects
    const merged = {};
    for (const chunk of chunks) {
      try {
        const obj = JSON.parse(chunk);
        for (const [key, value] of Object.entries(obj)) {
          // For string values, concatenate if key already exists
          if (typeof value === 'string' && typeof merged[key] === 'string') {
            merged[key] += value;
          } else {
            merged[key] = value;
          }
        }
      } catch (e) {
        // If not valid JSON, try to extract key-value pairs
        const kvMatches = chunk.matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g);
        for (const m of kvMatches) {
          if (typeof merged[m[1]] === 'string') {
            merged[m[1]] += m[2];
          } else {
            merged[m[1]] = m[2];
          }
        }
      }
    }
    
    return JSON.stringify(merged);
  }
  
  /**
   * Get any pending streaming tool calls (for end-of-stream finalization)
   */
  getPendingStreamingToolCalls() {
    const pending = [];
    for (const [id, accumulated] of Object.entries(this.streamingToolCalls)) {
      let finalArgs = this._mergeStreamingArgs(accumulated.rawArgsChunks);
      pending.push({
        tool: accumulated.tool,
        toolCallId: accumulated.toolCallId,
        name: accumulated.name,
        rawArgs: finalArgs,
      });
    }
    // Clear after retrieving
    this.streamingToolCalls = {};
    return pending;
  }
  
  /**
   * Get any remaining buffered data (for debugging)
   */
  getRemainingBuffer() {
    return this.buffer;
  }
}

/**
 * Parse chunk from Cursor API response (legacy function for compatibility)
 * Returns { thinking, text, toolCalls }
 * 
 * Tool call detection based on TASK-26-tool-schemas.md
 */
function chunkToUtf8String(chunk) {
  const thinkingOutput = []
  const textOutput = []
  const toolCalls = []
  
  // chunk is already a Buffer/Uint8Array from fetch stream, no need for hex encoding
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  
  try {
    for(let i = 0; i < buffer.length; ){
      if (i + 5 > buffer.length) break; // Not enough data for header
      
      const magicNumber = buffer[i];
      const dataLength = buffer.readUInt32BE(i + 1);
      
      // Check if we have the complete message
      if (i + 5 + dataLength > buffer.length) {
        console.log('[Warning] Incomplete message in chunk, dataLength:', dataLength, 'available:', buffer.length - i - 5);
        break;
      }
      
      const data = buffer.subarray(i + 5, i + 5 + dataLength)

      if (magicNumber == 0 || magicNumber == 1) {
        const gunzipData = magicNumber == 0 ? data : zlib.gunzipSync(data)
        const response = $root.StreamUnifiedChatWithToolsResponse.decode(gunzipData);

        // thinking is at response.thinking.content
        const thinking = response?.thinking?.content
        if (thinking !== undefined && thinking !== ''){
          thinkingOutput.push(thinking)
        }

        // text content is now at response.message.content (field 2 is a nested message)
        const content = response?.message?.content
        if (content !== undefined && content !== ''){
          textOutput.push(content)
        }

        // Check for tool calls (agent mode) - toolCallV2 is the newer format
        const toolCallV2 = response?.toolCallV2;
        if (toolCallV2 && toolCallV2.toolCallId) {
          toolCalls.push({
            tool: toolCallV2.tool,
            toolCallId: toolCallV2.toolCallId,
            name: toolCallV2.name,
            rawArgs: toolCallV2.rawArgs,
          });
        }
        
        // Also check legacy toolCall (field 13)
        const toolCallV1 = response?.toolCall;
        if (toolCallV1 && toolCallV1.toolCallId) {
          toolCalls.push({
            tool: null,
            toolCallId: toolCallV1.toolCallId,
            name: toolCallV1.name,
            rawArgs: toolCallV1.arguments,
          });
        }
        
        // Check if text field contains binary tool call data
        const textField = response?.text;
        if (textField && typeof textField === 'string') {
          const textBuf = Buffer.from(textField, 'binary');
          if (textBuf.length > 0 && textBuf[0] === 0x08) {
            const toolCall = tryParseToolCall(textBuf);
            if (toolCall) {
              toolCalls.push(toolCall);
            }
          }
        }
        
        
      }
      else if (magicNumber == 2 || magicNumber == 3) { 
        // Json message
        const gunzipData = magicNumber == 2 ? data : zlib.gunzipSync(data)
        const utf8 = gunzipData.toString('utf-8')
        const message = JSON.parse(utf8)

        if (message != null && (typeof message !== 'object' || 
          (Array.isArray(message) ? message.length > 0 : Object.keys(message).length > 0))){
            console.error(utf8)
        }

      }

      i += 5 + dataLength;
    }
  } catch (err) {
    console.log('Error parsing chunk response:', err)
  }

  return {
    thinking: thinkingOutput.join(''), 
    text: textOutput.join(''),
    toolCalls: toolCalls
  }
}

/**
 * Parse tool calls from raw response data using regex fallback
 * Used when protobuf decoding doesn't catch tool calls
 * 
 * Based on TASK-26-tool-schemas.md tool call patterns
 */
function parseToolCallsFromText(text) {
  const toolCalls = [];
  
  // Look for tool call ID pattern: toolu_bdrk_XXXXXXXXXXXXXXXXXXXXXXXX
  const toolIdRegex = /toolu_bdrk_[a-zA-Z0-9]{24,28}/g;
  const ids = text.match(toolIdRegex) || [];
  
  // Map of tool names to enum values
  const nameToTool = {
    'list_dir': ClientSideToolV2.LIST_DIR,
    'read_file': ClientSideToolV2.READ_FILE,
    'edit_file': ClientSideToolV2.EDIT_FILE,
    'grep_search': ClientSideToolV2.RIPGREP_SEARCH,
    'run_terminal_cmd': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
    'run_terminal_command': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
    'file_search': ClientSideToolV2.FILE_SEARCH,
    'delete_file': ClientSideToolV2.DELETE_FILE,
    'web_search': ClientSideToolV2.WEB_SEARCH,
  };
  
  for (const toolCallId of [...new Set(ids)]) {
    // Find the tool name near this ID
    const idPos = text.indexOf(toolCallId);
    const context = text.substring(idPos, idPos + 500);
    
    let toolName = null;
    let tool = ClientSideToolV2.UNSPECIFIED;
    
    for (const [name, toolEnum] of Object.entries(nameToTool)) {
      if (context.toLowerCase().includes(name)) {
        toolName = name;
        tool = toolEnum;
        break;
      }
    }
    
    // Extract JSON params
    let rawArgs = '';
    const jsonMatch = context.match(/\{[^{}]*"[a-z_]+":\s*[^{}]+\}/i);
    if (jsonMatch) {
      rawArgs = jsonMatch[0];
    }
    
    if (toolName && rawArgs) {
      toolCalls.push({
        tool,
        toolCallId,
        name: toolName,
        rawArgs,
      });
    }
  }
  
  return toolCalls;
}

function generateHashed64Hex(input, salt = '') {
  const hash = crypto.createHash('sha256');
  hash.update(input + salt);
  return hash.digest('hex');
}

function obfuscateBytes(byteArray) {
  let t = 165;
  for (let r = 0; r < byteArray.length; r++) {
    byteArray[r] = (byteArray[r] ^ t) + (r % 256);
    t = byteArray[r];
  }
  return byteArray;
}

function generateCursorChecksum(token) {
  // Try to get real machine ID from Cursor's storage
  let machineId = getMachineIdFromStorage();
  if (!machineId) {
    // Fallback to derived ID if storage not accessible
    machineId = generateHashed64Hex(token, 'machineId');
  }

  const timestamp = Math.floor(Date.now() / 1e6);
  const byteArray = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    255 & timestamp,
  ]);

  const obfuscatedBytes = obfuscateBytes(byteArray);
  // Use URL-safe base64 encoding (replace + with -, / with _)
  const encodedChecksum = Buffer.from(obfuscatedBytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${encodedChecksum}${machineId}`;
}

/**
 * Parse protobuf fields from binary buffer
 * Returns array of { fieldNumber, wireType, value }
 */
function parseProtoFields(buf) {
  const fields = [];
  let pos = 0;
  
  while (pos < buf.length) {
    const [fieldNum, wireType, value, newPos] = decodeField(buf, pos);
    if (fieldNum === null) break;
    pos = newPos;
    fields.push({ fieldNumber: fieldNum, wireType, value });
  }
  
  return fields;
}

/**
 * Generate checksum for Cursor API authentication
 */
function generateChecksum(accessToken) {
  return generateCursorChecksum(accessToken);
}

module.exports = {
  generateCursorBody,
  chunkToUtf8String,
  CursorStreamDecoder,
  parseToolCallsFromText,
  tryParseToolCall,
  generateHashed64Hex,
  generateCursorChecksum,
  generateChecksum,
  getMachineIdFromStorage,
  getCursorStoragePath,
  ClientSideToolV2,
  ClientSideToolV2Names,
  DEFAULT_AGENT_TOOLS,
  MCP_ONLY_TOOLS,
  parseProtoFields,
  decodeVarint,
  decodeField,
};
