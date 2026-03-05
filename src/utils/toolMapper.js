/**
 * Tool mapping utility
 * Maps OpenAI/Anthropic tool names to Cursor's ClientSideToolV2 enum values
 */

// Cursor's ClientSideToolV2 enum values
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
  GO_TO_DEFINITION: 31,
  GLOB_FILE_SEARCH: 42,
};

// Mapping from common tool names to Cursor enum values
// Supports various naming conventions used by different IDEs
const TOOL_NAME_MAPPING = {
  // Read file operations
  'read_file': ClientSideToolV2.READ_FILE,
  'readFile': ClientSideToolV2.READ_FILE,
  'read-file': ClientSideToolV2.READ_FILE,
  'file_read': ClientSideToolV2.READ_FILE,
  'get_file_contents': ClientSideToolV2.READ_FILE,
  'view_file': ClientSideToolV2.READ_FILE,
  'cat': ClientSideToolV2.READ_FILE,
  
  // List directory operations
  'list_dir': ClientSideToolV2.LIST_DIR,
  'listDir': ClientSideToolV2.LIST_DIR,
  'list-dir': ClientSideToolV2.LIST_DIR,
  'list_directory': ClientSideToolV2.LIST_DIR,
  'ls': ClientSideToolV2.LIST_DIR,
  'list_files': ClientSideToolV2.LIST_DIR,
  'directory_list': ClientSideToolV2.LIST_DIR,
  
  // Edit file operations
  'edit_file': ClientSideToolV2.EDIT_FILE,
  'editFile': ClientSideToolV2.EDIT_FILE,
  'edit-file': ClientSideToolV2.EDIT_FILE,
  'write_file': ClientSideToolV2.EDIT_FILE,
  'writeFile': ClientSideToolV2.EDIT_FILE,
  'write-file': ClientSideToolV2.EDIT_FILE,
  'modify_file': ClientSideToolV2.EDIT_FILE,
  'update_file': ClientSideToolV2.EDIT_FILE,
  'create_file': ClientSideToolV2.EDIT_FILE,
  'str_replace_editor': ClientSideToolV2.EDIT_FILE,
  'insert_code': ClientSideToolV2.EDIT_FILE,
  'replace_in_file': ClientSideToolV2.EDIT_FILE,
  
  // Search operations
  'ripgrep_search': ClientSideToolV2.RIPGREP_SEARCH,
  'grep': ClientSideToolV2.RIPGREP_SEARCH,
  'search': ClientSideToolV2.RIPGREP_SEARCH,
  'search_files': ClientSideToolV2.RIPGREP_SEARCH,
  'code_search': ClientSideToolV2.RIPGREP_SEARCH,
  'find_in_files': ClientSideToolV2.RIPGREP_SEARCH,
  'text_search': ClientSideToolV2.RIPGREP_SEARCH,
  
  // File search
  'file_search': ClientSideToolV2.FILE_SEARCH,
  'fileSearch': ClientSideToolV2.FILE_SEARCH,
  'find_file': ClientSideToolV2.FILE_SEARCH,
  'find_files': ClientSideToolV2.FILE_SEARCH,
  'locate_file': ClientSideToolV2.FILE_SEARCH,
  
  // Glob search
  'glob_search': ClientSideToolV2.GLOB_FILE_SEARCH,
  'glob': ClientSideToolV2.GLOB_FILE_SEARCH,
  'glob_file_search': ClientSideToolV2.GLOB_FILE_SEARCH,
  'pattern_search': ClientSideToolV2.GLOB_FILE_SEARCH,
  
  // Terminal/command execution
  'run_terminal_command': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'run_command': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'execute_command': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'shell': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'bash': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'terminal': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'exec': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'run': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  'execute_bash': ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
  
  // Delete file
  'delete_file': ClientSideToolV2.DELETE_FILE,
  'deleteFile': ClientSideToolV2.DELETE_FILE,
  'remove_file': ClientSideToolV2.DELETE_FILE,
  'rm': ClientSideToolV2.DELETE_FILE,
  
  // Web search
  'web_search': ClientSideToolV2.WEB_SEARCH,
  'webSearch': ClientSideToolV2.WEB_SEARCH,
  'search_web': ClientSideToolV2.WEB_SEARCH,
  'internet_search': ClientSideToolV2.WEB_SEARCH,
  'google': ClientSideToolV2.WEB_SEARCH,
  
  // Symbol search
  'search_symbols': ClientSideToolV2.SEARCH_SYMBOLS,
  'find_symbols': ClientSideToolV2.SEARCH_SYMBOLS,
  'symbol_search': ClientSideToolV2.SEARCH_SYMBOLS,
  
  // Go to definition
  'go_to_definition': ClientSideToolV2.GO_TO_DEFINITION,
  'goto_definition': ClientSideToolV2.GO_TO_DEFINITION,
  'definition': ClientSideToolV2.GO_TO_DEFINITION,
  'find_definition': ClientSideToolV2.GO_TO_DEFINITION,
  
  // Semantic search
  'semantic_search': ClientSideToolV2.SEMANTIC_SEARCH_FULL,
  'codebase_search': ClientSideToolV2.SEMANTIC_SEARCH_FULL,
};

/**
 * Extract tool name from OpenAI/Anthropic tool definition
 * @param {object} tool - Tool definition object
 * @returns {string|null} - Tool name or null
 */
function extractToolName(tool) {
  if (!tool) return null;
  
  // OpenAI format: { type: "function", function: { name: "xxx" } }
  if (tool.type === 'function' && tool.function?.name) {
    return tool.function.name;
  }
  
  // Anthropic format: { name: "xxx", ... }
  if (tool.name) {
    return tool.name;
  }
  
  // Direct name
  if (typeof tool === 'string') {
    return tool;
  }
  
  return null;
}

/**
 * Map a single tool name to Cursor's ClientSideToolV2 enum value
 * @param {string} toolName - Tool name from IDE
 * @returns {number|null} - Cursor enum value or null if not found
 */
function mapToolNameToEnum(toolName) {
  if (!toolName) return null;
  
  const normalized = toolName.toLowerCase().trim();
  
  // Direct match
  if (TOOL_NAME_MAPPING[normalized] !== undefined) {
    return TOOL_NAME_MAPPING[normalized];
  }
  
  // Try original case
  if (TOOL_NAME_MAPPING[toolName] !== undefined) {
    return TOOL_NAME_MAPPING[toolName];
  }
  
  // Fuzzy match: check if any key is contained in the tool name
  for (const [key, value] of Object.entries(TOOL_NAME_MAPPING)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return value;
    }
  }
  
  return null;
}

/**
 * Map OpenAI/Anthropic tools array to Cursor's supportedTools array
 * @param {array} tools - Array of tool definitions from IDE
 * @returns {number[]} - Array of Cursor ClientSideToolV2 enum values
 */
function mapToolsToCursor(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return [];
  }
  
  const cursorTools = new Set();
  
  for (const tool of tools) {
    const toolName = extractToolName(tool);
    if (toolName) {
      const enumValue = mapToolNameToEnum(toolName);
      if (enumValue !== null) {
        cursorTools.add(enumValue);
        console.log(`[Tool Mapper] Mapped "${toolName}" -> ${enumValue}`);
      } else {
        console.log(`[Tool Mapper] Unknown tool: "${toolName}"`);
      }
    }
  }
  
  return Array.from(cursorTools);
}

/**
 * Get default agent tools
 * @returns {number[]} - Default Cursor tools for agent mode
 */
function getDefaultAgentTools() {
  return [
    ClientSideToolV2.READ_FILE,
    ClientSideToolV2.LIST_DIR,
    ClientSideToolV2.RIPGREP_SEARCH,
    ClientSideToolV2.RUN_TERMINAL_COMMAND_V2,
    ClientSideToolV2.EDIT_FILE,
    ClientSideToolV2.FILE_SEARCH,
    ClientSideToolV2.GLOB_FILE_SEARCH,
  ];
}

module.exports = {
  ClientSideToolV2,
  TOOL_NAME_MAPPING,
  extractToolName,
  mapToolNameToEnum,
  mapToolsToCursor,
  getDefaultAgentTools,
};
