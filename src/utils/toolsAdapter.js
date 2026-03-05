/**
 * Tools Adapter - Convert IDE tools to prompt and parse tool calls from response
 * 
 * This adapter enables Cursor to understand and use IDE-defined tools by:
 * 1. Converting tool definitions to a system prompt that LLM can understand
 * 2. Parsing LLM responses to extract tool call requests
 * 3. Formatting tool calls in Anthropic's tool_use format
 */

const { v4: uuidv4 } = require('uuid');

/**
 * Convert tools array to a system prompt section
 * @param {Array} tools - Array of tool definitions (Anthropic/OpenAI format)
 * @returns {string} - System prompt describing available tools
 */
function toolsToPrompt(tools, useMcpFormat = false) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  if (useMcpFormat) {
    // MCP format for custom tools
    let prompt = `\n\n<mcp_tools>
You have access to the following MCP (Model Context Protocol) tools. Use them when appropriate.

To use an MCP tool, output:
<mcp_tool_use>
<tool_name>TOOL_NAME</tool_name>
<arguments>{"param": "value"}</arguments>
</mcp_tool_use>

Available MCP Tools:\n`;

    for (const tool of tools) {
      const name = tool.name || tool.function?.name;
      const description = tool.description || tool.function?.description || '';
      const parameters = tool.input_schema || tool.function?.parameters || {};
      
      if (!name) continue;
      
      prompt += `\n- ${name}: ${description}\n`;
      if (parameters && Object.keys(parameters).length > 0) {
        prompt += `  Parameters: ${JSON.stringify(parameters, null, 2)}\n`;
      }
    }
    
    prompt += `</mcp_tools>\n`;
    return prompt;
  }

  // Standard function calling format
  let prompt = `\n\n[IMPORTANT INSTRUCTION]
You are an AI assistant with access to the following functions. When a user's request can be fulfilled by calling one of these functions, you MUST respond by outputting the function call in XML format.

OUTPUT FORMAT (you must use this exact format when calling functions):
\`\`\`
<function_calls>
<invoke name="FUNCTION_NAME">
<parameter name="PARAM_NAME">PARAM_VALUE</parameter>
</invoke>
</function_calls>
\`\`\`

When the user asks you to do something that matches a function below, output the function call XML. Do not explain how to do it manually. Do not say you don't have access to tools. Just output the XML.

AVAILABLE FUNCTIONS:\n`;

  for (const tool of tools) {
    // Handle both Anthropic format (name at top level) and OpenAI format (function.name)
    const name = tool.name || tool.function?.name;
    const description = tool.description || tool.function?.description || '';
    const parameters = tool.input_schema || tool.function?.parameters || {};

    if (!name) continue;

    prompt += `\n## ${name}\n`;
    if (description) {
      prompt += `Description: ${description}\n`;
    }
    if (parameters && Object.keys(parameters).length > 0) {
      prompt += `Parameters: ${JSON.stringify(parameters, null, 2)}\n`;
    }
  }

  prompt += `
REMEMBER: When the user's request matches any function above, respond with the <function_calls> XML block. This is mandatory.
[END INSTRUCTION]\n`;

  return prompt;
}

/**
 * Parse tool calls from LLM response text
 * @param {string} text - LLM response text
 * @param {Array} tools - Available tools (to match tool names)
 * @returns {Array} - Array of parsed tool calls
 */
function parseToolCalls(text, tools = []) {
  const toolCalls = [];
  const toolNames = tools.map(t => t.name || t.function?.name).filter(Boolean);
  
  // Pattern 1: Our defined format <tool_call>...</tool_call>
  const xmlPattern = /<tool_call>\s*<tool_name>([^<]+)<\/tool_name>\s*<tool_input>\s*([\s\S]*?)\s*<\/tool_input>\s*<\/tool_call>/gi;
  let match;
  
  while ((match = xmlPattern.exec(text)) !== null) {
    const toolName = match[1].trim();
    let toolInput = match[2].trim();
    
    try {
      toolInput = JSON.parse(toolInput);
    } catch (e) {
      toolInput = { raw: toolInput };
    }
    
    toolCalls.push({
      id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
      type: 'tool_use',
      name: toolName,
      input: toolInput,
    });
  }

  // Pattern 2: Direct tool name tags like <read_file>...</read_file> or <Read>...</Read>
  // Build a map of variations to original tool names
  const toolVariations = {};
  for (const toolName of toolNames) {
    const variations = [
      toolName,
      toolName.toLowerCase(),
      toolName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''), // CamelCase to snake_case
      toolName.toLowerCase() + '_file', // Read -> read_file
      toolName.toLowerCase() + '_dir',  // List -> list_dir
      toolName.toLowerCase() + '_command', // Run -> run_command
    ];
    for (const v of variations) {
      toolVariations[v.toLowerCase()] = toolName;
    }
  }
  
  // Find all XML-like tags and check if they match any tool
  const tagPattern = /<(\w+)>([\s\S]*?)<\/\1>/gi;
  while ((match = tagPattern.exec(text)) !== null) {
    const tagName = match[1].toLowerCase();
    const originalToolName = toolVariations[tagName];
    
    if (!originalToolName) continue;
    
    const content = match[2].trim();
    let toolInput = {};
    
    // Try to extract parameters from inner XML tags
    const paramPattern = /<(\w+)>([^<]*)<\/\1>/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(content)) !== null) {
      toolInput[paramMatch[1]] = paramMatch[2].trim();
    }
    
    // If no params found, try JSON
    if (Object.keys(toolInput).length === 0) {
      try {
        toolInput = JSON.parse(content);
      } catch (e) {
        // Use raw content as single param
        if (content) {
          toolInput = { input: content };
        }
      }
    }
    
    // Avoid duplicates
    const existingCall = toolCalls.find(tc => 
      tc.name === originalToolName && JSON.stringify(tc.input) === JSON.stringify(toolInput)
    );
    if (!existingCall) {
      toolCalls.push({
        id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        type: 'tool_use',
        name: originalToolName,
        input: toolInput,
      });
    }
  }

  // Pattern 3: Invoke format - <invoke name="...">...</invoke>
  // Also handles <function_calls><invoke>...</invoke></function_calls>
  const invokePattern = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi;
  while ((match = invokePattern.exec(text)) !== null) {
    const toolName = match[1].trim();
    const content = match[2].trim();
    let toolInput = {};
    
    // Extract parameters
    const paramPattern = /<parameter\s+name="([^"]+)">([^<]*)<\/parameter>/g;
    let paramMatch;
    while ((paramMatch = paramPattern.exec(content)) !== null) {
      toolInput[paramMatch[1]] = paramMatch[2].trim();
    }
    
    // Avoid duplicates
    const existingCall = toolCalls.find(tc => 
      tc.name === toolName && JSON.stringify(tc.input) === JSON.stringify(toolInput)
    );
    if (!existingCall && Object.keys(toolInput).length > 0) {
      toolCalls.push({
        id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        type: 'tool_use',
        name: toolName,
        input: toolInput,
      });
    }
  }

  // Pattern 4: MCP tool use format - <mcp_tool_use>...</mcp_tool_use>
  const mcpPattern = /<mcp_tool_use>\s*<tool_name>([^<]+)<\/tool_name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/mcp_tool_use>/gi;
  while ((match = mcpPattern.exec(text)) !== null) {
    const toolName = match[1].trim();
    let toolInput = {};
    
    try {
      toolInput = JSON.parse(match[2].trim());
    } catch (e) {
      toolInput = { raw: match[2].trim() };
    }
    
    // Avoid duplicates
    const existingCall = toolCalls.find(tc => 
      tc.name === toolName && JSON.stringify(tc.input) === JSON.stringify(toolInput)
    );
    if (!existingCall) {
      toolCalls.push({
        id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
        type: 'tool_use',
        name: toolName,
        input: toolInput,
      });
    }
  }

  // Pattern 5: Claude Code style "tool lines" in plain text (fallback mode)
  // Examples:
  //   ⬢ WebFetch https://example.com
  //   $ mkdir -p ./out
  //
  // This helps when Cursor returns tool-like UI text but doesn't emit tool_call/tool_call_kv.
  const hasTool = (name) => toolNames.some(tn => (tn || '').toLowerCase() === (name || '').toLowerCase());
  const bashToolName = toolNames.find(tn => (tn || '').toLowerCase() === 'bash') ? 'Bash' : null;
  const webLineRe = /^\s*(?:[\u2B22\u25CF\u2022\u25AA\u25AB\u25A0\u25A1\u25B6\u25C6\u25C7\u25CB\u25CE\u25C9\u25CF\-\*]\s*)?(WebFetch|WebSearch)\s+(https?:\/\/[^\s)]+)\s*$/i;
  const bashLineRe = /^\s*\$\s+(.+?)\s*$/i;

  // Preserve order of appearance by scanning line-by-line.
  for (const line of String(text || '').split(/\r?\n/)) {
    const webm = line.match(webLineRe);
    if (webm) {
      const toolName = webm[1].trim();
      const url = webm[2].trim();
      if (!hasTool(toolName)) continue;

      const toolInput = { url };
      const existingCall = toolCalls.find(tc => tc.name === toolName && JSON.stringify(tc.input) === JSON.stringify(toolInput));
      if (!existingCall) {
        toolCalls.push({
          id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
          type: 'tool_use',
          name: toolName,
          input: toolInput,
        });
      }
      continue;
    }

    if (bashToolName) {
      const bashm = line.match(bashLineRe);
      if (bashm) {
        const command = bashm[1].trim();
        if (!command) continue;

        const toolInput = { command };
        const existingCall = toolCalls.find(tc => tc.name === bashToolName && JSON.stringify(tc.input) === JSON.stringify(toolInput));
        if (!existingCall) {
          toolCalls.push({
            id: `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
            type: 'tool_use',
            name: bashToolName,
            input: toolInput,
          });
        }
      }
    }
  }

  return toolCalls;
}

/**
 * Remove tool call blocks from text (to get the regular text content)
 * @param {string} text - Full response text
 * @param {Array} tools - Available tools
 * @returns {string} - Text without tool call blocks
 */
function removeToolCallsFromText(text, tools = []) {
  let cleaned = text;
  const toolNamesLower = tools.map(t => t.name || t.function?.name).filter(Boolean).map(n => n.toLowerCase());
  const hasWebFetch = toolNamesLower.includes('webfetch') || toolNamesLower.includes('websearch');
  const hasBash = toolNamesLower.includes('bash');
  
  // Remove our defined format
  cleaned = cleaned.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  
  // Remove function_calls format
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  
  // Remove standalone invoke format
  cleaned = cleaned.replace(/<invoke\s+name="[^"]+">[\s\S]*?<\/invoke>/gi, '');
  
  // Build tool variations map
  const toolNames = tools.map(t => t.name || t.function?.name).filter(Boolean);
  const toolVariations = new Set();
  for (const toolName of toolNames) {
    toolVariations.add(toolName.toLowerCase());
    toolVariations.add(toolName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, ''));
    toolVariations.add(toolName.toLowerCase() + '_file');
    toolVariations.add(toolName.toLowerCase() + '_dir');
    toolVariations.add(toolName.toLowerCase() + '_command');
  }
  
  // Remove matching tool tags
  for (const variant of toolVariations) {
    const pattern = new RegExp(`<${variant}>[\\s\\S]*?<\\/${variant}>`, 'gi');
    cleaned = cleaned.replace(pattern, '');
  }
  
  // Remove antml invoke format
  cleaned = cleaned.replace(/<invoke\s+name="[^"]+">[\s\S]*?<\/antml:invoke>/gi, '');

  // Remove Claude Code style tool lines if those tools exist.
  if (hasWebFetch) {
    cleaned = cleaned.replace(/^\s*(?:[\u2B22\u25CF\u2022\u25AA\u25AB\u25A0\u25A1\u25B6\u25C6\u25C7\u25CB\u25CE\u25C9\u25CF\-\*]\s*)?(?:WebFetch|WebSearch)\s+https?:\/\/[^\s)]+\s*$/gmi, '');
  }
  if (hasBash) {
    cleaned = cleaned.replace(/^\s*\$\s+.+?\s*$/gmi, '');
  }
  
  // Clean up extra whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  
  return cleaned;
}

/**
 * Format response with tool calls for Anthropic Messages API
 * @param {string} text - LLM response text
 * @param {Array} tools - Original tools array (to validate tool names)
 * @returns {Object} - { content: Array, hasToolCalls: boolean }
 */
function formatResponseWithToolCalls(text, tools) {
  const toolCalls = parseToolCalls(text, tools);
  const cleanText = removeToolCallsFromText(text, tools);
  
  const content = [];
  
  // Add text content if present
  if (cleanText) {
    content.push({
      type: 'text',
      text: cleanText,
    });
  }
  
  // Add tool use blocks
  for (const tc of toolCalls) {
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }
  
  // If no content at all, add empty text
  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    });
  }
  
  return {
    content,
    hasToolCalls: toolCalls.length > 0,
    toolCalls,
  };
}

/**
 * Determine stop reason based on response content
 * @param {boolean} hasToolCalls - Whether response contains tool calls
 * @returns {string} - Stop reason
 */
function getStopReason(hasToolCalls) {
  return hasToolCalls ? 'tool_use' : 'end_turn';
}

/**
 * Cursor tool name to common action mapping
 * Based on cursor_api_reference ClientSideToolV2 enum analysis
 * 
 * Key insight: Cursor's "write" tool is actually EDIT_FILE_V2 (enum 38)
 * The tool name "write" is just a UI display name
 */
const CURSOR_TOOL_ACTIONS = {
  // File operations - Cursor names -> common IDE action words
  'write': ['write', 'create', 'save', 'apply_patch', 'patch', 'Write'],
  'edit_file': ['edit', 'modify', 'update', 'patch', 'apply_patch', 'str_replace', 'StrReplace'],
  'edit_file_v2': ['edit', 'write', 'modify', 'update', 'patch', 'apply_patch', 'Write'],
  'read_file': ['read', 'get', 'load', 'fetch', 'view_image', 'view', 'Read'],
  'read_file_v2': ['read', 'get', 'load', 'view', 'Read'],
  'list_dir': ['Glob', 'glob', 'list', 'ls', 'dir', 'browse', 'LS'],
  'list_dir_v2': ['Glob', 'glob', 'list', 'ls', 'dir', 'browse', 'LS'],
  'delete_file': ['delete', 'remove', 'rm', 'Delete'],
  
  // Terminal/command - note: Claude Code uses 'Bash', other IDEs may use 'exec_command' or 'Shell'
  'run_terminal_command': ['Bash', 'bash', 'run', 'exec', 'execute', 'shell', 'command', 'terminal', 'exec_command', 'Shell'],
  'run_terminal_command_v2': ['Bash', 'bash', 'run', 'exec', 'execute', 'shell', 'command', 'terminal', 'exec_command', 'Shell'],
  'run_terminal_cmd': ['Bash', 'bash', 'run', 'exec', 'execute', 'shell', 'command', 'terminal', 'exec_command', 'Shell'],
  
  // Search operations
  'ripgrep_search': ['search', 'grep', 'find', 'query', 'Grep'],
  'ripgrep_raw_search': ['search', 'grep', 'find', 'query', 'Grep'],
  'file_search': ['search', 'find', 'glob', 'Glob'],
  'glob_file_search': ['glob', 'pattern', 'match', 'Glob'],
  'search_symbols': ['symbol', 'definition', 'reference'],
  'go_to_definition': ['definition', 'goto', 'jump'],
  
  // Web search
  'web_search': ['web', 'search', 'internet', 'browse', 'query', 'lookup', 'google', 'bing', 'WebFetch', 'WebSearch'],
  'fetch': ['fetch', 'http', 'request', 'url', 'download', 'web', 'WebFetch'],
  
  // Todo/task
  'todo_read': ['todo', 'task', 'list', 'TodoRead'],
  'todo_write': ['todo', 'task', 'update', 'TodoWrite'],
};

// IDE tools that should be handled by IDE itself, not forwarded to Cursor
const IDE_ONLY_TOOLS = [
  'update_plan',
  'request_user_input',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'write_stdin',  // Interactive terminal - Cursor doesn't support
];

// Claude Code tools that Cursor's native agent tools already cover.
// These should NOT be registered as MCP or injected into the prompt,
// because the model will use its native exec tools (read/write/shell/grep/ls/delete)
// and the proxy maps them back to Claude Code tool format via execRequestToToolUse.
const NATIVE_COVERED_TOOLS_LOWER = new Set([
  'read',        // → Cursor native read (field 7)
  'write',       // → Cursor native write (field 3)
  'strreplace',  // → model uses read + write natively to achieve the same effect
  'bash',        // → Cursor native shell (field 2/14)
  'shell',       // → Cursor native shell (field 2/14)
  'grep',        // → Cursor native grep (field 5)
  'glob',        // → Cursor native ls (field 8)
  'ls',          // → Cursor native ls (field 8)
  'delete',      // → Cursor native delete (field 4)
]);

/**
 * Check if a tool is covered by Cursor's native agent tools.
 * When an adapter is provided, uses canonical-based lookup.
 * @param {string} toolName - Client tool name
 * @param {import('../adapters/base').ClientAdapter} [adapter]
 */
function isNativeCoveredTool(toolName, adapter) {
  if (adapter) {
    const canon = adapter.toCanonical(toolName);
    if (canon) return adapter.isNativeCovered(canon);
    return false;
  }
  return NATIVE_COVERED_TOOLS_LOWER.has((toolName || '').toLowerCase());
}

/**
 * Filter out tools that Cursor's native agent handles,
 * keeping only tools that need MCP registration / prompt injection.
 * @param {Array} tools
 * @param {import('../adapters/base').ClientAdapter} [adapter]
 */
function filterNonNativeTools(tools, adapter) {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.filter(t => {
    const name = t.name || t.function?.name || '';
    return !isNativeCoveredTool(name, adapter);
  });
}

/**
 * Map Cursor's tool call to IDE's custom tool
 * @param {Object} cursorToolCall - Cursor's tool call {tool, toolCallId, name, rawArgs}
 * @param {Array} ideTools - IDE's custom tools array
 * @param {string} workingDirectory - Current working directory for path resolution
 * @returns {Object} - Mapped tool call with IDE tool name and transformed input
 */
function mapCursorToolToIde(cursorToolCall, ideTools, workingDirectory = '') {
  if (!ideTools || ideTools.length === 0) {
    return cursorToolCall;
  }

  const cursorName = (cursorToolCall.name || '').toLowerCase();
  let rawArgs = {};
  
  if (cursorToolCall.rawArgs) {
    // First, clean the rawArgs string by removing binary/non-printable data
    // This often appears after the JSON object ends
    let cleanedArgs = cursorToolCall.rawArgs;
    
    // Find the first complete JSON object by tracking brace depth
    let depth = 0;
    let jsonEnd = -1;
    let inString = false;
    let escape = false;
    
    for (let i = 0; i < cleanedArgs.length; i++) {
      const char = cleanedArgs[i];
      
      if (escape) {
        escape = false;
        continue;
      }
      
      if (char === '\\' && inString) {
        escape = true;
        continue;
      }
      
      if (char === '"' && !escape) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') {
          depth++;
        } else if (char === '}') {
          depth--;
          if (depth === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }
    
    // If we found a complete JSON object, use only that part
    if (jsonEnd > 0) {
      cleanedArgs = cleanedArgs.substring(0, jsonEnd);
    }
    
    try {
      rawArgs = JSON.parse(cleanedArgs);
    } catch (e) {
      // Try to fix truncated JSON by adding missing closing characters
      let fixedJson = cleanedArgs;
      
      // Count open/close braces and brackets
      let openBraces = (fixedJson.match(/\{/g) || []).length;
      let closeBraces = (fixedJson.match(/\}/g) || []).length;
      let openBrackets = (fixedJson.match(/\[/g) || []).length;
      let closeBrackets = (fixedJson.match(/\]/g) || []).length;
      
      // Check if we're inside an unclosed string
      const lastQuoteIdx = fixedJson.lastIndexOf('"');
      const beforeQuote = fixedJson.substring(0, lastQuoteIdx);
      const quoteCount = (beforeQuote.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 === 0 && fixedJson.endsWith('"') === false) {
        // Odd number of quotes after removing last one = unclosed string
        fixedJson += '"';
      }
      
      // Add missing closing brackets and braces
      while (closeBrackets < openBrackets) {
        fixedJson += ']';
        closeBrackets++;
      }
      while (closeBraces < openBraces) {
        fixedJson += '}';
        closeBraces++;
      }
      
      try {
        rawArgs = JSON.parse(fixedJson);
      } catch (e2) {
        // Last resort: extract key-value pairs manually
        const params = {};
        // Match both string and boolean/number values
        const kvRegex = /"([^"]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(\w+))/g;
        let match;
        while ((match = kvRegex.exec(cursorToolCall.rawArgs)) !== null) {
          const key = match[1];
          // Use string value if present, otherwise use the non-string value
          let value = match[2] !== undefined ? match[2] : match[3];
          // Unescape the string value
          if (typeof value === 'string') {
            value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
          // Convert boolean strings
          if (value === 'true') value = true;
          else if (value === 'false') value = false;
          params[key] = value;
        }
        if (Object.keys(params).length > 0) {
          rawArgs = params;
        } else {
          rawArgs = { raw: cursorToolCall.rawArgs };
        }
      }
    }
  }

  // Find matching IDE tool by:
  // 1. Exact name match (case-insensitive)
  // 2. Action-based match with NAME (higher priority)
  // 3. Action-based match with description (lower priority)
  // 4. Partial name match
  
  let matchedTool = null;
  let matchScore = 0;
  
  const actions = CURSOR_TOOL_ACTIONS[cursorName] || [];
  
  for (const tool of ideTools) {
    const ideName = (tool.name || tool.function?.name || '').toLowerCase();
    const ideDesc = (tool.description || tool.function?.description || '').toLowerCase();
    
    // Score 100: Exact name match
    if (ideName === cursorName || ideName === cursorName.replace(/_/g, '')) {
      matchedTool = tool;
      matchScore = 100;
      break;
    }
    
    // Score 90: IDE tool name exactly matches one of the actions
    for (const action of actions) {
      const actionLower = action.toLowerCase();
      if (ideName === actionLower) {
        if (matchScore < 90) {
          matchedTool = tool;
          matchScore = 90;
        }
        break;
      }
    }
    
    // Score 70: IDE tool name contains action
    if (matchScore < 70) {
      for (const action of actions) {
        const actionLower = action.toLowerCase();
        if (ideName.includes(actionLower)) {
          matchedTool = tool;
          matchScore = 70;
          break;
        }
      }
    }
    
    // Score 30: Description contains action (lowest priority, easily overridden)
    if (matchScore < 30) {
      for (const action of actions) {
        const actionLower = action.toLowerCase();
        if (ideDesc.includes(actionLower)) {
          matchedTool = tool;
          matchScore = 30;
          break;
        }
      }
    }
    
    // Score 20: Partial match - tool name contains cursor action word
    if (matchScore < 20) {
      const cursorWords = cursorName.split('_');
      for (const word of cursorWords) {
        if (word.length > 2 && ideName.includes(word)) {
          matchedTool = tool;
          matchScore = 20;
          break;
        }
      }
    }
  }
  
  if (!matchedTool) {
    // No match found, return with original Cursor name
    return {
      ...cursorToolCall,
      input: rawArgs,
    };
  }
  
  const ideToolName = matchedTool.name || matchedTool.function?.name;
  // Handle different tool schema formats:
  // - Anthropic: input_schema
  // - OpenAI function: parameters (directly on tool) or function.parameters
  const ideSchema = matchedTool.input_schema || matchedTool.parameters || matchedTool.function?.parameters || {};
  
  // Transform parameters based on IDE tool schema
  const transformedInput = transformParameters(rawArgs, cursorName, ideSchema, workingDirectory);
  
  return {
    tool: cursorToolCall.tool,
    toolCallId: cursorToolCall.toolCallId,
    name: ideToolName,
    input: transformedInput,
    rawArgs: JSON.stringify(transformedInput),
  };
}

/**
 * Transform Cursor tool parameters to IDE tool parameters
 * Based on cursor_api_reference TASK-126-toolv2-params.md
 * 
 * Cursor parameter naming conventions:
 * - relative_workspace_path -> file path
 * - directory_path -> directory
 * - contents, contents_after_edit -> file content
 * - command -> shell command
 * - cwd -> working directory
 * - search_term -> search query
 * 
 * @param {Object} cursorParams - Cursor's tool parameters
 * @param {string} cursorToolName - Cursor tool name
 * @param {Object} ideSchema - IDE tool schema
 * @param {string} workingDirectory - Current working directory for path resolution
 */
function transformParameters(cursorParams, cursorToolName, ideSchema, workingDirectory = '') {
  const result = {};
  const ideProps = ideSchema.properties || {};
  const idePropNames = Object.keys(ideProps);
  
  // Common parameter mappings (Cursor param -> possible IDE params)
  // Based on TASK-126 tool parameter analysis
  // NOTE: Order matters! Put more specific mappings first.
  const paramMappings = {
    // File paths - Cursor uses relative_workspace_path, file_path
    // Claude Code expects file_path, so prioritize that
    'relative_workspace_path': ['file_path', 'path', 'filePath', 'file', 'filename'],
    'file_path': ['file_path', 'path', 'filePath', 'file', 'filename'],
    'filePath': ['file_path', 'path', 'filePath', 'file', 'filename'],
    'path': ['path', 'file_path', 'filePath', 'directory', 'dir'],
    
    // Content - Cursor uses contents, contents_after_edit
    // Claude Code expects content (singular), so prioritize that
    'contents': ['content', 'contents', 'text', 'data', 'body'],
    'contents_after_edit': ['content', 'contents', 'text', 'data', 'body'],
    'content': ['content', 'contents', 'text', 'data', 'body'],
    
    // Terminal/command - Cursor uses command, cwd
    'command': ['command', 'cmd', 'script', 'shell'],
    'cmd': ['cmd', 'command', 'script', 'shell'],
    'cwd': ['workdir', 'working_directory', 'cwd', 'directory', 'dir'],
    'working_directory': ['workdir', 'working_directory', 'cwd', 'directory', 'dir'],
    'workdir': ['workdir', 'working_directory', 'cwd', 'directory', 'dir'],
    
    // Search - Cursor uses search_term, query, pattern_info
    'search_term': ['query', 'search_query', 'pattern', 'term', 'keyword', 'search_term'],
    'query': ['query', 'pattern', 'search', 'term', 'keyword'],
    'search_query': ['query', 'search_query', 'pattern', 'term'],
    'pattern': ['pattern', 'query', 'regex', 'glob'],
    
    // Directory - Cursor uses directory_path, target_directory
    'directory_path': ['path', 'directory', 'dir', 'folder', 'target_directory'],
    'target_directory': ['path', 'directory', 'dir', 'folder', 'target_directory'],
    'directory': ['path', 'directory', 'dir', 'folder'],
    'dir': ['path', 'dir', 'directory', 'folder'],
    
    // Line numbers - Cursor uses start_line_one_indexed, end_line_one_indexed_inclusive
    'start_line_one_indexed': ['start_line', 'offset', 'from_line'],
    'end_line_one_indexed_inclusive': ['end_line', 'limit', 'to_line'],
    'start_line': ['start_line', 'offset', 'from_line'],
    'end_line': ['end_line', 'limit', 'to_line'],
  };
  
  // Path-related parameter keys (these may need absolute path conversion)
  const pathParamKeys = new Set([
    'relative_workspace_path', 'file_path', 'filePath', 'path',
    'directory_path', 'directory', 'dir', 'folder', 'target_directory',
  ]);
  
  for (const [cursorKey, cursorValue] of Object.entries(cursorParams)) {
    // Try to find matching IDE parameter
    const mappings = paramMappings[cursorKey] || [cursorKey];
    let matched = false;
    
    for (const mapping of mappings) {
      const matchedProp = idePropNames.find(p => p.toLowerCase() === mapping.toLowerCase());
      if (matchedProp) {
        let value = cursorValue;
        
        // Convert relative paths to absolute paths for file/directory parameters
        // Check if:
        // 1. This is a path-related parameter
        // 2. We have a working directory
        // 3. The value is a relative path (doesn't start with /)
        if (pathParamKeys.has(cursorKey) && workingDirectory && 
            typeof value === 'string' && value && !value.startsWith('/')) {
          // Check if IDE expects absolute path (based on parameter description)
          const propSchema = ideProps[matchedProp];
          const desc = (propSchema?.description || '').toLowerCase();
          if (desc.includes('absolute') || matchedProp === 'file_path' || matchedProp === 'path') {
            // Convert to absolute path
            value = workingDirectory.endsWith('/') 
              ? workingDirectory + value 
              : workingDirectory + '/' + value;
          }
        }
        
        result[matchedProp] = value;
        matched = true;
        break;
      }
    }
    
    // If no match, keep original key if it exists in schema
    if (!matched) {
      if (idePropNames.includes(cursorKey)) {
        result[cursorKey] = cursorValue;
      } else {
        // Last resort: use the first required property or first property
        const required = ideSchema.required || [];
        const targetProp = required[0] || idePropNames[0];
        if (targetProp && !result[targetProp]) {
          result[targetProp] = cursorValue;
        }
      }
    }
  }
  
  // Special handling: list_dir -> Glob needs default pattern
  if ((cursorToolName === 'list_dir' || cursorToolName === 'list_dir_v2') && 
      idePropNames.includes('pattern') && !result.pattern) {
    result.pattern = '*';
  }
  
  return result;
}

/**
 * Map array of Cursor tool calls to IDE tools
 * @param {Array} cursorToolCalls - Array of Cursor tool calls
 * @param {Array} ideTools - IDE's custom tools
 * @param {string} workingDirectory - Current working directory for path resolution
 * @returns {Array} - Mapped tool calls
 */
function mapCursorToolsToIde(cursorToolCalls, ideTools, workingDirectory = '') {
  return cursorToolCalls.map(tc => mapCursorToolToIde(tc, ideTools, workingDirectory));
}

/**
 * Extract working directory from system message
 * Claude Code includes this in format: Working directory: /path/to/dir
 * @param {string|Array} system - System message (string or array of content blocks)
 * @param {import('../adapters/base').ClientAdapter} [adapter] - optional adapter for pattern matching
 * @returns {string} - Working directory path or empty string
 */
function extractWorkingDirectory(system, adapter) {
  if (adapter) {
    return adapter.extractWorkspacePath(system);
  }
  let text = '';
  
  if (typeof system === 'string') {
    text = system;
  } else if (Array.isArray(system)) {
    text = system
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  
  // Claude Code uses "Workspace Path:" in its system prompt
  // Cursor IDE uses "Working directory:" in its system prompt
  // Match both formats
  const patterns = [
    /Workspace Path:\s*([^\n]+)/i,
    /Working directory:\s*([^\n]+)/i,
    /Workspace Root:\s*([^\n]+)/i,
    /CWD:\s*([^\n]+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  
  return '';
}

module.exports = {
  toolsToPrompt,
  parseToolCalls,
  removeToolCallsFromText,
  formatResponseWithToolCalls,
  getStopReason,
  mapCursorToolToIde,
  mapCursorToolsToIde,
  transformParameters,
  extractWorkingDirectory,
  filterNonNativeTools,
  isNativeCoveredTool,
  IDE_ONLY_TOOLS,
  CURSOR_TOOL_ACTIONS,
};
