#!/usr/bin/env node
/**
 * Analyze captured Cursor IDE protobuf traffic.
 *
 * Usage:
 *   node scripts/analyze-capture.js [captures_dir]
 *
 * Recursively decodes protobuf fields from captured RunSSE/BidiAppend
 * request bodies and prints a human-readable tree with annotations for
 * known Cursor Agent Protocol fields.
 */

const fs = require('fs');
const path = require('path');

const CAPTURES_DIR = process.argv[2] || path.join(__dirname, '..', 'captures');

// ─── Protobuf decoder (self-contained, copied from utils.js) ───

function decodeVarint(buf, pos) {
  let result = BigInt(0);
  let shift = BigInt(0);
  while (pos < buf.length) {
    const b = buf[pos];
    result |= BigInt(b & 0x7F) << shift;
    pos++;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [result, pos];
}

function decodeField(buf, pos) {
  if (pos >= buf.length) return [null, null, null, pos];
  const [tag, newPos] = decodeVarint(buf, pos);
  pos = newPos;
  const fieldNum = Number(tag >> 3n);
  const wireType = Number(tag & 7n);

  let value;
  if (wireType === 0) {
    [value, pos] = decodeVarint(buf, pos);
  } else if (wireType === 2) {
    const [length, lenPos] = decodeVarint(buf, pos);
    pos = lenPos;
    value = buf.slice(pos, pos + Number(length));
    pos += Number(length);
  } else if (wireType === 1) {
    value = buf.slice(pos, pos + 8);
    pos += 8;
  } else if (wireType === 5) {
    value = buf.slice(pos, pos + 4);
    pos += 4;
  } else {
    return [null, null, null, buf.length]; // unknown wire type
  }
  return [fieldNum, wireType, value, pos];
}

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

// ─── gRPC-Web frame stripper ───

function stripGrpcWebEnvelope(buf) {
  if (buf.length < 5) return buf;
  const flags = buf[0];
  const length = buf.readUInt32BE(1);
  if (5 + length <= buf.length) {
    return buf.slice(5, 5 + length);
  }
  return buf;
}

function extractAllGrpcFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const flags = buf[pos];
    const length = buf.readUInt32BE(pos + 1);
    if (pos + 5 + length > buf.length) break;
    frames.push({
      flags,
      data: buf.slice(pos + 5, pos + 5 + length),
    });
    pos += 5 + length;
  }
  return frames;
}

// ─── Schema annotations ───

const AGENT_RUN_REQUEST_FIELDS = {
  1: 'conversation_state (ConversationState)',
  2: 'action (ConversationAction)',
  3: 'model_details (ModelDetails)',
  4: 'mcp_tools (McpTools)',
  5: 'conversation_id (string)',
  6: 'mcp_file_system_options (McpFileSystemOptions)',
  7: 'skill_options (SkillOptions)',
  8: 'custom_system_prompt (string)',
  9: 'requested_model (RequestedModel)',
  10: 'suggest_next_prompt (bool)',
  11: 'subagent_type_name (string)',
};

const REQUEST_CONTEXT_FIELDS = {
  2: 'rules (repeated string)',
  4: 'env (RequestContextEnv)',
  7: 'tools (repeated McpToolDefinition)',
  11: 'git_repos (repeated GitRepo)',
  14: 'mcp_instructions (repeated McpInstructions)',
};

const MCP_TOOL_DEFINITION_FIELDS = {
  1: 'name (string)',
  2: 'description (string)',
  3: 'input_schema (Struct)',
  4: 'provider_identifier (string)',
  5: 'tool_name (string)',
};

const MCP_INSTRUCTIONS_FIELDS = {
  1: 'server_name (string)',
  2: 'instructions (string)',
  3: 'server_identifier (string)',
};

const EXEC_SERVER_MESSAGE_FIELDS = {
  1: 'id (uint32)',
  2: 'shell_args (ShellArgs)',
  3: 'write_args (WriteArgs)',
  4: 'delete_args (DeleteArgs)',
  5: 'grep_args (GrepArgs)',
  7: 'read_args (ReadArgs)',
  8: 'ls_args (LsArgs)',
  10: 'request_context_args',
  11: 'mcp_args (McpArgs)',
  14: 'shell_v2_args (ShellArgs)',
  15: 'exec_id (string)',
  20: 'fetch_args (FetchArgs)',
  28: 'subagent_args (SubagentArgs)',
};

const CONVERSATION_ACTION_FIELDS = {
  1: 'user_message_action (UserMessageAction)',
};

const USER_MESSAGE_ACTION_FIELDS = {
  1: 'user_message (UserMessage)',
  2: 'request_context (RequestContext)',
};

const USER_MESSAGE_FIELDS = {
  2: 'text (string)',
  4: 'message_id (string)',
  5: 'attached_code_chunks (repeated)',
  6: 'mode (varint)',
};

const MODEL_DETAILS_FIELDS = {
  1: 'model_name (string)',
  2: 'requested_max_tokens (int32)',
};

const MCP_FILE_SYSTEM_OPTIONS_FIELDS = {
  1: 'descriptor_path (string)',
  2: 'unknown_field_2',
};

// ─── Display helpers ───

function isLikelyMessage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return false;
  try {
    const fields = parseProtoFields(buf);
    if (fields.length === 0) return false;
    for (const f of fields) {
      if (f.fieldNumber > 200 || f.fieldNumber < 1) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isLikelyUtf8(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const str = buf.toString('utf-8');
  let nonPrintable = 0;
  for (let i = 0; i < Math.min(str.length, 200); i++) {
    const c = str.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 13 && c !== 9) nonPrintable++;
  }
  return nonPrintable / Math.min(str.length, 200) < 0.1;
}

function wireTypeName(wt) {
  switch (wt) {
    case 0: return 'varint';
    case 1: return 'fixed64';
    case 2: return 'length-delimited';
    case 5: return 'fixed32';
    default: return `wire${wt}`;
  }
}

function truncate(str, maxLen = 200) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + `... (${str.length} chars total)`;
}

// ─── Recursive decoder ───

function decodeRecursive(buf, depth = 0, contextName = '', fieldAnnotations = null) {
  const indent = '  '.repeat(depth);
  const fields = parseProtoFields(buf);
  const lines = [];

  for (const f of fields) {
    const ann = fieldAnnotations ? fieldAnnotations[f.fieldNumber] : null;
    const label = ann ? ` [${ann}]` : '';
    const wtName = wireTypeName(f.wireType);

    if (f.wireType === 0) {
      lines.push(`${indent}field ${f.fieldNumber} (${wtName})${label}: ${f.value}`);
    } else if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      if (f.value.length === 0) {
        lines.push(`${indent}field ${f.fieldNumber} (${wtName}, empty)${label}`);
        continue;
      }

      // Try recursive message decode
      if (isLikelyMessage(f.value)) {
        const childAnnotations = getChildAnnotations(contextName, f.fieldNumber, fieldAnnotations);
        const childContextName = getChildContext(contextName, f.fieldNumber);
        lines.push(`${indent}field ${f.fieldNumber} (message, ${f.value.length} bytes)${label} {`);
        lines.push(...decodeRecursive(f.value, depth + 1, childContextName, childAnnotations));
        lines.push(`${indent}}`);
      } else if (isLikelyUtf8(f.value)) {
        const str = f.value.toString('utf-8');
        // Try JSON parse for schema etc.
        try {
          const obj = JSON.parse(str);
          lines.push(`${indent}field ${f.fieldNumber} (string/json, ${str.length} chars)${label}:`);
          lines.push(`${indent}  ${truncate(JSON.stringify(obj, null, 2).replace(/\n/g, `\n${indent}  `), 2000)}`);
        } catch {
          lines.push(`${indent}field ${f.fieldNumber} (string, ${str.length} chars)${label}: ${truncate(str)}`);
        }
      } else {
        lines.push(`${indent}field ${f.fieldNumber} (bytes, ${f.value.length} bytes)${label}: ${f.value.slice(0, 32).toString('hex')}${f.value.length > 32 ? '...' : ''}`);
      }
    } else if (Buffer.isBuffer(f.value)) {
      lines.push(`${indent}field ${f.fieldNumber} (${wtName}, ${f.value.length} bytes)${label}: ${f.value.toString('hex')}`);
    } else {
      lines.push(`${indent}field ${f.fieldNumber} (${wtName})${label}: ${f.value}`);
    }
  }
  return lines;
}

function getChildAnnotations(contextName, fieldNumber) {
  if (contextName === 'AgentRunRequest') {
    if (fieldNumber === 2) return CONVERSATION_ACTION_FIELDS;
    if (fieldNumber === 3) return MODEL_DETAILS_FIELDS;
    if (fieldNumber === 4) return null; // McpTools wrapper
    if (fieldNumber === 6) return MCP_FILE_SYSTEM_OPTIONS_FIELDS;
  }
  if (contextName === 'ConversationAction') {
    if (fieldNumber === 1) return USER_MESSAGE_ACTION_FIELDS;
  }
  if (contextName === 'UserMessageAction') {
    if (fieldNumber === 1) return USER_MESSAGE_FIELDS;
    if (fieldNumber === 2) return REQUEST_CONTEXT_FIELDS;
  }
  if (contextName === 'RequestContext') {
    if (fieldNumber === 7) return MCP_TOOL_DEFINITION_FIELDS;
    if (fieldNumber === 14) return MCP_INSTRUCTIONS_FIELDS;
  }
  if (contextName === 'McpTools') {
    return MCP_TOOL_DEFINITION_FIELDS;
  }
  return null;
}

function getChildContext(contextName, fieldNumber) {
  if (contextName === 'AgentRunRequest') {
    if (fieldNumber === 2) return 'ConversationAction';
    if (fieldNumber === 3) return 'ModelDetails';
    if (fieldNumber === 4) return 'McpTools';
    if (fieldNumber === 6) return 'McpFileSystemOptions';
  }
  if (contextName === 'ConversationAction') {
    if (fieldNumber === 1) return 'UserMessageAction';
  }
  if (contextName === 'UserMessageAction') {
    if (fieldNumber === 1) return 'UserMessage';
    if (fieldNumber === 2) return 'RequestContext';
  }
  if (contextName === 'RequestContext') {
    if (fieldNumber === 7) return 'McpToolDefinition';
    if (fieldNumber === 14) return 'McpInstructions';
  }
  if (contextName === 'McpTools') {
    return 'McpToolDefinition';
  }
  return '';
}

// ─── MCP-focused summary ───

function extractMcpSummary(buf) {
  const summary = {
    hasField4_McpTools: false,
    mcpToolCount: 0,
    mcpToolNames: [],
    hasField6_McpFileSystemOptions: false,
    mcpFileSystemOptions: null,
    hasField7_SkillOptions: false,
    hasField8_CustomSystemPrompt: false,
    customSystemPromptLength: 0,
    requestContext: {
      hasField7_Tools: false,
      toolCount: 0,
      toolNames: [],
      hasField14_Instructions: false,
      instructionServers: [],
    },
    modelDetails: null,
    conversationId: null,
  };

  const topFields = parseProtoFields(buf);

  for (const f of topFields) {
    if (f.fieldNumber === 4 && f.wireType === 2) {
      summary.hasField4_McpTools = true;
      const innerFields = parseProtoFields(f.value);
      for (const inner of innerFields) {
        if (inner.fieldNumber === 1 && inner.wireType === 2) {
          summary.mcpToolCount++;
          const toolFields = parseProtoFields(inner.value);
          for (const tf of toolFields) {
            if (tf.fieldNumber === 1 && isLikelyUtf8(tf.value)) {
              summary.mcpToolNames.push(tf.value.toString('utf-8'));
            }
          }
        }
      }
    }

    if (f.fieldNumber === 5 && f.wireType === 2 && isLikelyUtf8(f.value)) {
      summary.conversationId = f.value.toString('utf-8');
    }

    if (f.fieldNumber === 6 && f.wireType === 2) {
      summary.hasField6_McpFileSystemOptions = true;
      try {
        const opts = parseProtoFields(f.value);
        summary.mcpFileSystemOptions = opts.map(o => ({
          field: o.fieldNumber,
          wireType: o.wireType,
          value: Buffer.isBuffer(o.value) ? (isLikelyUtf8(o.value) ? o.value.toString('utf-8') : o.value.toString('hex').substring(0, 64)) : String(o.value),
        }));
      } catch {}
    }

    if (f.fieldNumber === 7 && f.wireType === 2) {
      summary.hasField7_SkillOptions = true;
    }

    if (f.fieldNumber === 8 && f.wireType === 2) {
      summary.hasField8_CustomSystemPrompt = true;
      summary.customSystemPromptLength = f.value.length;
    }

    if (f.fieldNumber === 3 && f.wireType === 2) {
      try {
        const mf = parseProtoFields(f.value);
        for (const m of mf) {
          if (m.fieldNumber === 1 && isLikelyUtf8(m.value)) {
            summary.modelDetails = m.value.toString('utf-8');
          }
        }
      } catch {}
    }

    // Dig into action → userMessageAction → requestContext
    if (f.fieldNumber === 2 && f.wireType === 2) {
      try {
        const actionFields = parseProtoFields(f.value);
        for (const af of actionFields) {
          if (af.fieldNumber === 1 && af.wireType === 2) {
            const umaFields = parseProtoFields(af.value);
            for (const umaf of umaFields) {
              if (umaf.fieldNumber === 2 && umaf.wireType === 2) {
                // RequestContext
                const rcFields = parseProtoFields(umaf.value);
                for (const rcf of rcFields) {
                  if (rcf.fieldNumber === 7 && rcf.wireType === 2) {
                    summary.requestContext.hasField7_Tools = true;
                    summary.requestContext.toolCount++;
                    try {
                      const tdFields = parseProtoFields(rcf.value);
                      for (const tdf of tdFields) {
                        if (tdf.fieldNumber === 1 && isLikelyUtf8(tdf.value)) {
                          summary.requestContext.toolNames.push(tdf.value.toString('utf-8'));
                        }
                      }
                    } catch {}
                  }
                  if (rcf.fieldNumber === 14 && rcf.wireType === 2) {
                    summary.requestContext.hasField14_Instructions = true;
                    try {
                      const instrFields = parseProtoFields(rcf.value);
                      for (const inf of instrFields) {
                        if (inf.fieldNumber === 1 && isLikelyUtf8(inf.value)) {
                          summary.requestContext.instructionServers.push(inf.value.toString('utf-8'));
                        }
                      }
                    } catch {}
                  }
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  return summary;
}

// ─── Main ───

function analyzeFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const basename = path.basename(filePath);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`FILE: ${basename} (${buf.length} bytes)`);
  console.log(`${'='.repeat(80)}`);

  // Load companion meta file if exists
  const metaPath = filePath.replace('body.bin', 'meta.json');
  if (fs.existsSync(metaPath) && metaPath !== filePath) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      console.log(`\n--- Headers ---`);
      if (meta.headers) {
        for (const [k, v] of Object.entries(meta.headers)) {
          if (k.startsWith('x-cursor') || k === 'authorization' || k === 'content-type' || k === 'connect-protocol-version') {
            console.log(`  ${k}: ${v}`);
          }
        }
      }
      if (meta.url) console.log(`  URL: ${meta.url}`);
    } catch {}
  }

  // Extract gRPC-Web frames
  const frames = extractAllGrpcFrames(buf);
  if (frames.length === 0) {
    console.log('\n[!] No valid gRPC-Web frames found, trying raw decode...');
    const payload = stripGrpcWebEnvelope(buf);
    console.log(`\n--- Raw Protobuf Fields ---`);
    const lines = decodeRecursive(payload, 1, 'AgentRunRequest', AGENT_RUN_REQUEST_FIELDS);
    lines.forEach(l => console.log(l));
    return;
  }

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const isTrailer = (frame.flags & 0x80) !== 0;

    console.log(`\n--- Frame ${i + 1}/${frames.length} (flags=0x${frame.flags.toString(16)}, ${frame.data.length} bytes${isTrailer ? ', TRAILER' : ''}) ---`);

    if (isTrailer) {
      console.log(`  Trailer: ${frame.data.toString('utf-8')}`);
      continue;
    }

    const isRunSSE = basename.includes('RunSSE');
    const isBidiAppend = basename.includes('BidiAppend');
    const isRequest = basename.startsWith('req_');
    const isResponse = basename.startsWith('resp_');

    let contextName = '';
    let annotations = null;

    if (isRequest && isRunSSE) {
      contextName = 'AgentRunRequest';
      annotations = AGENT_RUN_REQUEST_FIELDS;
    }

    console.log(`\n  Protobuf Fields (context: ${contextName || 'unknown'}):`);
    const lines = decodeRecursive(frame.data, 2, contextName, annotations);
    lines.forEach(l => console.log(l));

    // MCP summary for RunSSE requests
    if (isRequest && isRunSSE) {
      console.log(`\n  --- MCP Summary ---`);
      const summary = extractMcpSummary(frame.data);
      console.log(`  AgentRunRequest.field 4 (McpTools): ${summary.hasField4_McpTools ? `YES (${summary.mcpToolCount} tools: ${summary.mcpToolNames.join(', ')})` : 'NO'}`);
      console.log(`  AgentRunRequest.field 6 (McpFileSystemOptions): ${summary.hasField6_McpFileSystemOptions ? 'YES' : 'NO'}`);
      if (summary.mcpFileSystemOptions) {
        summary.mcpFileSystemOptions.forEach(o => console.log(`    field ${o.field}: ${o.value}`));
      }
      console.log(`  AgentRunRequest.field 7 (SkillOptions): ${summary.hasField7_SkillOptions ? 'YES' : 'NO'}`);
      console.log(`  AgentRunRequest.field 8 (custom_system_prompt): ${summary.hasField8_CustomSystemPrompt ? `YES (${summary.customSystemPromptLength} bytes)` : 'NO'}`);
      console.log(`  RequestContext.field 7 (McpToolDefinition): ${summary.requestContext.hasField7_Tools ? `YES (${summary.requestContext.toolCount} tools: ${summary.requestContext.toolNames.join(', ')})` : 'NO'}`);
      console.log(`  RequestContext.field 14 (McpInstructions): ${summary.requestContext.hasField14_Instructions ? `YES (servers: ${summary.requestContext.instructionServers.join(', ')})` : 'NO'}`);
      console.log(`  Model: ${summary.modelDetails || 'unknown'}`);
      console.log(`  ConversationId: ${summary.conversationId || 'none'}`);
    }
  }
}

function main() {
  if (!fs.existsSync(CAPTURES_DIR)) {
    console.error(`Captures directory not found: ${CAPTURES_DIR}`);
    console.error('Run the capture first, then re-run this script.');
    process.exit(1);
  }

  const files = fs.readdirSync(CAPTURES_DIR)
    .filter(f => f.endsWith('body.bin'))
    .sort();

  if (files.length === 0) {
    console.error('No capture files found (*.body.bin)');
    process.exit(1);
  }

  console.log(`Found ${files.length} capture file(s) in ${CAPTURES_DIR}`);
  console.log('Analyzing RunSSE request bodies for MCP tool registration...\n');

  // Prioritize RunSSE requests
  const runSseReqs = files.filter(f => f.includes('RunSSE') && f.startsWith('req_'));
  const others = files.filter(f => !runSseReqs.includes(f));

  for (const f of [...runSseReqs, ...others]) {
    analyzeFile(path.join(CAPTURES_DIR, f));
  }

  // Final comparison hint
  if (runSseReqs.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('COMPARISON CHECKLIST:');
    console.log('='.repeat(80));
    console.log('1. Does Cursor send AgentRunRequest.field 4 (McpTools)?');
    console.log('2. Does Cursor send RequestContext.field 7 (McpToolDefinition)?');
    console.log('3. Does Cursor send RequestContext.field 14 (McpInstructions)?');
    console.log('4. Does Cursor send AgentRunRequest.field 6 (McpFileSystemOptions)?');
    console.log('5. What provider_identifier format does Cursor use?');
    console.log('6. How is input_schema encoded (Struct vs JSON string)?');
    console.log('7. Are there extra x-cursor-* headers?');
    console.log('8. What is the connect-protocol-version?');
  }
}

main();
