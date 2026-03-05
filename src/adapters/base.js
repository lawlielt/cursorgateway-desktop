/**
 * ClientAdapter base class.
 *
 * Each client (Claude Code, opencode, openclaw …) gets a concrete instance
 * built from a declarative config object.  The adapter translates between
 * the client's tool names / param names and the canonical internal format.
 */

class ClientAdapter {
  /**
   * @param {object} config
   * @param {string}       config.clientType            - e.g. 'claude-code'
   * @param {object}       config.toolNameMap           - { canonical: clientName }
   * @param {object}       config.paramMap              - { canonical: { canonParam: clientParam } }
   * @param {Set<string>}  config.nativeCoveredTools    - Set of canonical names covered by Cursor native exec
   * @param {RegExp[]}     config.workspacePathPatterns - patterns to extract workspace path from system prompt
   * @param {object}       [config.behaviorFlags]       - client-specific behavioral quirks
   */
  constructor(config) {
    this.clientType = config.clientType;

    // canonical → clientName
    this.toolNameMap = Object.freeze({ ...config.toolNameMap });

    // clientNameLower → canonical  (auto-generated reverse map)
    this._reverseToolNameMap = new Map();
    for (const [canon, clientName] of Object.entries(this.toolNameMap)) {
      this._reverseToolNameMap.set(clientName.toLowerCase(), canon);
    }

    // canonical → { canonParam: clientParam }
    this.paramMap = {};
    for (const [canon, mapping] of Object.entries(config.paramMap || {})) {
      this.paramMap[canon] = Object.freeze({ ...mapping });
    }

    // canonical → { clientParam: canonParam }  (auto-generated reverse)
    this._reverseParamMap = {};
    for (const [canon, mapping] of Object.entries(this.paramMap)) {
      const rev = {};
      for (const [canonP, clientP] of Object.entries(mapping)) {
        rev[clientP] = canonP;
      }
      this._reverseParamMap[canon] = Object.freeze(rev);
    }

    this.nativeCoveredTools = config.nativeCoveredTools instanceof Set
      ? config.nativeCoveredTools
      : new Set(config.nativeCoveredTools || []);

    this.workspacePathPatterns = config.workspacePathPatterns || [];
    this.behaviorFlags = Object.freeze({ ...config.behaviorFlags });
  }

  // ─── Name translation ─────────────────────────────────────────────

  /**
   * Client tool name → canonical name.
   * Returns null if the tool is unknown to this adapter.
   */
  toCanonical(clientToolName) {
    if (!clientToolName) return null;
    const canon = this._reverseToolNameMap.get(clientToolName.toLowerCase());
    return canon || null;
  }

  /**
   * Canonical name → client tool name.
   * Returns null if the canonical name has no mapping in this adapter.
   */
  fromCanonical(canonicalName) {
    if (!canonicalName) return null;
    return this.toolNameMap[canonicalName] || null;
  }

  // ─── Param translation ────────────────────────────────────────────

  /**
   * Client params → canonical params.
   * Translates param keys from client naming to canonical naming.
   */
  normalizeParams(canonicalName, clientInput) {
    if (!clientInput || typeof clientInput !== 'object') return {};
    const reverseMap = this._reverseParamMap[canonicalName];
    if (!reverseMap) return { ...clientInput };

    const result = {};
    for (const [key, value] of Object.entries(clientInput)) {
      const canonKey = reverseMap[key] || key;
      result[canonKey] = value;
    }
    return result;
  }

  /**
   * Canonical params → client params.
   * Translates param keys from canonical naming to client naming.
   */
  denormalizeParams(canonicalName, canonicalInput) {
    if (!canonicalInput || typeof canonicalInput !== 'object') return {};
    const mapping = this.paramMap[canonicalName];
    if (!mapping) return { ...canonicalInput };

    const result = {};
    for (const [key, value] of Object.entries(canonicalInput)) {
      const clientKey = mapping[key] || key;
      result[clientKey] = value;
    }
    return result;
  }

  // ─── Queries ──────────────────────────────────────────────────────

  /**
   * Is this canonical tool covered by Cursor's native exec system?
   */
  isNativeCovered(canonicalName) {
    return this.nativeCoveredTools.has(canonicalName);
  }

  /**
   * Extract workspace path from system prompt text.
   */
  extractWorkspacePath(systemText) {
    if (!systemText) return '';
    const text = typeof systemText === 'string'
      ? systemText
      : Array.isArray(systemText)
        ? systemText.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : '';
    for (const pattern of this.workspacePathPatterns) {
      const match = text.match(pattern);
      if (match) return match[1].trim();
    }
    return '';
  }

  /**
   * Get all canonical names this adapter supports.
   */
  supportedCanonicalTools() {
    return Object.keys(this.toolNameMap);
  }

  /**
   * Get all client tool names this adapter maps.
   */
  supportedClientTools() {
    return Object.values(this.toolNameMap);
  }

  /**
   * Smart canonical resolution with input-based disambiguation.
   * Also handles Cursor model tool names (Edit, Shell, etc.) that aren't
   * direct client tool names but appear in KV FINAL responses.
   */
  toCanonicalWithInput(clientToolName, input) {
    let canon = this.toCanonical(clientToolName);

    // Cursor model tool names that aren't in any client's map
    if (!canon) {
      const lower = (clientToolName || '').toLowerCase();
      if (lower === 'edit' || lower === 'edit_file') {
        canon = (input && ('old_string' in input || 'new_string' in input)) ? 'file_edit' : 'file_write';
      } else if (lower === 'shell') {
        canon = 'shell_exec';
      }
    }

    if (canon === 'file_write' && input && ('old_string' in input || 'new_string' in input)) {
      return 'file_edit';
    }

    if (canon === 'dir_list' && input && input.pattern && input.pattern !== '*') {
      return 'file_search';
    }

    return canon;
  }
}

module.exports = { ClientAdapter };
