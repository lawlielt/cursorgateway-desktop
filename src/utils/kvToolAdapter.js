/**
 * Adapter for KV "tool-call" blocks returned by Cursor final responses.
 * Converts tool name + input schema to IDE-compatible tool definitions.
 */

const TOOL_NAME_CANDIDATES = {
  shell: ['Bash', 'shell', 'run_terminal_command', 'run_command'],
  read: ['Read', 'read_file', 'read'],
  write: ['Write', 'write_file', 'edit_file', 'edit'],
  strreplace: ['StrReplace', 'Edit', 'edit_file'],
  str_replace: ['StrReplace', 'Edit', 'edit_file'],
  glob: ['Glob', 'glob_file_search', 'glob'],
};

function getToolNameLookup(tools = []) {
  const lookup = new Map();
  for (const tool of tools) {
    const name = tool?.name || tool?.function?.name;
    if (name && typeof name === 'string') {
      lookup.set(name.toLowerCase(), name);
    }
  }
  return lookup;
}

function getToolDefinitionLookup(tools = []) {
  const lookup = new Map();
  for (const tool of tools) {
    const name = tool?.name || tool?.function?.name;
    if (name && typeof name === 'string') {
      lookup.set(name.toLowerCase(), tool);
    }
  }
  return lookup;
}

function resolveMappedName(originalName, lookup) {
  const lowerName = String(originalName || '').toLowerCase();
  if (!lowerName) return originalName;

  if (lookup.has(lowerName)) return lookup.get(lowerName);

  const candidates = TOOL_NAME_CANDIDATES[lowerName] || [];
  for (const candidate of candidates) {
    const found = lookup.get(candidate.toLowerCase());
    if (found) return found;
  }

  return originalName;
}

function getAllowedPropertyNames(toolDef) {
  const schema = toolDef?.input_schema || toolDef?.parameters || toolDef?.function?.parameters;
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  return new Set(Object.keys(props));
}

function includesAny(set, keys) {
  for (const k of keys) {
    if (set.has(k)) return true;
  }
  return false;
}

function normalizeInputForTool(name, input, toolDef) {
  const lower = String(name || '').toLowerCase();
  const mappedInput = { ...(input || {}) };
  const allowed = getAllowedPropertyNames(toolDef);
  const hasSchema = allowed.size > 0;
  const result = {};

  const setIfAllowed = (key, value) => {
    if (value === undefined) return;
    if (!hasSchema || allowed.has(key)) {
      result[key] = value;
    }
  };

  if (lower === 'read' || lower === 'read_file') {
    const filePath = mappedInput.file_path || mappedInput.path;
    // Read tools vary by client:
    // - Claude Code: file_path
    // - Cursor/other bridges: path
    const usePathStyle = hasSchema && !allowed.has('file_path') && allowed.has('path');
    if (usePathStyle) {
      setIfAllowed('path', filePath);
    } else {
      setIfAllowed('file_path', filePath);
    }
    setIfAllowed('offset', mappedInput.offset);
    setIfAllowed('limit', mappedInput.limit);
    return result;
  }

  // StrReplace / Edit with old_string+new_string: must come BEFORE write handler
  if (lower === 'strreplace' || lower === 'str_replace' || lower === 'str_replace_editor' ||
      ((lower === 'edit' || lower === 'edit_file') && ('old_string' in mappedInput || 'new_string' in mappedInput))) {
    const filePath = mappedInput.file_path || mappedInput.path;
    const usePathStyle = hasSchema && !allowed.has('file_path') && allowed.has('path');
    if (usePathStyle) {
      setIfAllowed('path', filePath);
    } else {
      setIfAllowed('file_path', filePath);
    }
    setIfAllowed('old_string', mappedInput.old_string);
    setIfAllowed('new_string', mappedInput.new_string);
    setIfAllowed('replace_all', mappedInput.replace_all);
    return result;
  }

  if (lower === 'write' || lower === 'write_file' || lower === 'edit_file' || lower === 'edit') {
    const filePath = mappedInput.file_path || mappedInput.path;
    const content = mappedInput.content !== undefined ? mappedInput.content : mappedInput.contents;
    const usePathStyle = hasSchema && !allowed.has('file_path') && allowed.has('path');
    if (usePathStyle) {
      setIfAllowed('path', filePath);
    } else {
      setIfAllowed('file_path', filePath);
    }
    if (hasSchema && !allowed.has('content') && allowed.has('fileText')) {
      setIfAllowed('fileText', content);
    } else if (hasSchema && !allowed.has('content') && allowed.has('contents')) {
      setIfAllowed('contents', content);
    } else {
      setIfAllowed('content', content);
    }
    return result;
  }

  if (lower === 'glob' || lower === 'glob_file_search') {
    const pattern = mappedInput.pattern || mappedInput.glob_pattern;
    const path = mappedInput.path || mappedInput.target_directory;
    const requiresGlobPattern = hasSchema && includesAny(allowed, ['glob_pattern', 'target_directory']);

    if (requiresGlobPattern || (hasSchema && !allowed.has('pattern') && allowed.has('glob_pattern'))) {
      setIfAllowed('glob_pattern', pattern);
      setIfAllowed('target_directory', path);
      // Some schemas require `path` instead of `target_directory`.
      setIfAllowed('path', path);
    } else {
      setIfAllowed('pattern', pattern);
      setIfAllowed('path', path);
      setIfAllowed('target_directory', path);
      setIfAllowed('glob_pattern', pattern);
    }
    return result;
  }

  if (lower === 'bash' || lower === 'shell' || lower === 'run_terminal_command' || lower === 'run_command') {
    setIfAllowed('command', mappedInput.command);
    setIfAllowed('description', mappedInput.description);
    setIfAllowed('timeout', mappedInput.timeout);
    setIfAllowed('run_in_background', mappedInput.run_in_background);
    setIfAllowed('working_directory', mappedInput.working_directory || mappedInput.cwd);
    return result;
  }

  if (hasSchema) {
    for (const [k, v] of Object.entries(mappedInput)) {
      if (allowed.has(k)) {
        result[k] = v;
      }
    }
    return result;
  }
  return mappedInput;
}

/**
 * Adapt a KV tool_use to IDE format.
 * When an adapter is provided, uses canonical-based name/param resolution.
 * @param {object} toolUse - { name, input, id, ... }
 * @param {Array}  tools   - IDE tool definitions
 * @param {import('../adapters/base').ClientAdapter} [adapter]
 */
function adaptKvToolUseToIde(toolUse, tools = [], adapter) {
  if (!toolUse || !toolUse.name) return toolUse;

  if (adapter) {
    const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
    // Resolve to canonical using input-aware disambiguation
    const canon = adapter.toCanonicalWithInput(toolUse.name, input)
                || adapter.toCanonical(toolUse.name);

    if (canon) {
      const clientName = adapter.fromCanonical(canon);
      const clientInput = adapter.denormalizeParams(canon, adapter.normalizeParams(canon, input));
      return { ...toolUse, name: clientName || toolUse.name, input: clientInput };
    }
    // Unknown tool — fall through to legacy resolution
  }

  const lookup = getToolNameLookup(tools);
  const toolDefLookup = getToolDefinitionLookup(tools);

  // Input-aware routing: Edit/edit_file with old_string/new_string is StrReplace,
  // not a full-file Write. Resolve BEFORE generic name mapping.
  let nameToResolve = toolUse.name;
  const lowerOriginal = (nameToResolve || '').toLowerCase();
  const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
  if ((lowerOriginal === 'edit' || lowerOriginal === 'edit_file') &&
      ('old_string' in input || 'new_string' in input) &&
      lookup.has('strreplace')) {
    nameToResolve = lookup.get('strreplace');
  }

  const mappedName = resolveMappedName(nameToResolve, lookup);
  const mappedToolDef = toolDefLookup.get(String(mappedName || '').toLowerCase());
  const mappedInput = normalizeInputForTool(mappedName, toolUse.input, mappedToolDef);

  return {
    ...toolUse,
    name: mappedName,
    input: mappedInput,
  };
}

module.exports = {
  adaptKvToolUseToIde,
  getToolNameLookup,
  getToolDefinitionLookup,
  normalizeInputForTool,
};

