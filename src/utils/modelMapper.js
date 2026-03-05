/**
 * Model name mapping utility
 * Maps external model names (OpenAI, Anthropic, Google, etc.) to Cursor internal model names.
 *
 * NOTE: Cursor model availability changes over time.
 * Run `curl http://localhost:3010/v1/models` to see current available models.
 * If a model name is already a valid Cursor internal name, it passes through as-is.
 */

const MODEL_MAPPING = {
  // ============================================================
  // Anthropic Claude — official SDK names -> Cursor internal names
  // ============================================================

  // Claude 4.6 series
  'claude-opus-4-6': 'claude-4.6-opus-high',
  'claude-opus-4-6-20260210': 'claude-4.6-opus-high',
  'claude-sonnet-4-6': 'claude-4.6-sonnet-medium',
  'claude-sonnet-4-6-20260301': 'claude-4.6-sonnet-medium',
  'claude-haiku-4-6': 'claude-4.5-haiku',

  // Claude 4.5 series
  'claude-sonnet-4-5-20250929': 'claude-4.5-sonnet',
  'claude-haiku-4-5-20251001': 'claude-4.5-haiku',
  'claude-4-5-sonnet': 'claude-4.5-sonnet',
  'claude-4-5-haiku': 'claude-4.5-haiku',

  // Claude 4 series (Claude Code uses these)
  'claude-sonnet-4-20250514': 'claude-4-sonnet',
  'claude-opus-4-20250514': 'claude-4.5-opus-high',

  // Claude 3.7 series (map to closest available)
  'claude-3-7-sonnet-20250219': 'claude-4-sonnet',
  'claude-3.7-sonnet': 'claude-4-sonnet',

  // Claude 3.5 series (map to closest available)
  'claude-3-5-sonnet-20241022': 'claude-4.5-sonnet',
  'claude-3-5-sonnet-latest': 'claude-4.5-sonnet',
  'claude-3-5-haiku-20241022': 'claude-4.5-haiku',
  'claude-3-5-haiku-latest': 'claude-4.5-haiku',
  'claude-3.5-sonnet': 'claude-4.5-sonnet',
  'claude-3.5-haiku': 'claude-4.5-haiku',

  // Claude 3 series (map to closest available)
  'claude-3-opus-20240229': 'claude-4.5-opus-high',
  'claude-3-opus-latest': 'claude-4.5-opus-high',
  'claude-3-sonnet-20240229': 'claude-4-sonnet',
  'claude-3-haiku-20240307': 'claude-4.5-haiku',

  // Common short aliases
  'claude-opus': 'claude-4.6-opus-high',
  'claude-sonnet': 'claude-4.6-sonnet-medium',
  'claude-haiku': 'claude-4.5-haiku',

  // ============================================================
  // OpenAI GPT — old model names -> Cursor equivalents
  // ============================================================
  'gpt-4': 'gpt-5.2',
  'gpt-4-turbo': 'gpt-5.2',
  'gpt-4o': 'gpt-5.2',
  'gpt-4o-mini': 'gpt-5-mini',
  'gpt-3.5-turbo': 'gpt-5-mini',
  'o1': 'gpt-5.1-high',
  'o1-mini': 'gpt-5-mini',
  'o1-preview': 'gpt-5.1-high',
  'o3-mini': 'gpt-5-mini',

  // GPT-5.x short aliases
  'gpt-5': 'gpt-5.2',
  'gpt-5.1': 'gpt-5.1-high',
  'gpt-5.3': 'gpt-5.3-codex',

  // ============================================================
  // Google Gemini
  // ============================================================
  'gemini-pro': 'gemini-3-pro',
  'gemini-flash': 'gemini-3-flash',
  'gemini-2.5-pro': 'gemini-3-pro',
  'gemini-2.0-flash': 'gemini-2.5-flash',
  'gemini-1.5-pro': 'gemini-3-pro',
  'gemini-1.5-flash': 'gemini-2.5-flash',

  // ============================================================
  // Cursor identity mappings (pass-through for all known models)
  // ============================================================

  // Claude on Cursor
  'claude-4.6-opus-high': 'claude-4.6-opus-high',
  'claude-4.6-opus-high-thinking': 'claude-4.6-opus-high-thinking',
  'claude-4.6-opus-high-thinking-fast': 'claude-4.6-opus-high-thinking-fast',
  'claude-4.6-opus-max': 'claude-4.6-opus-max',
  'claude-4.6-opus-max-thinking': 'claude-4.6-opus-max-thinking',
  'claude-4.6-opus-max-thinking-fast': 'claude-4.6-opus-max-thinking-fast',
  'claude-4.6-sonnet-medium': 'claude-4.6-sonnet-medium',
  'claude-4.6-sonnet-medium-thinking': 'claude-4.6-sonnet-medium-thinking',
  'claude-4.5-opus-high': 'claude-4.5-opus-high',
  'claude-4.5-opus-high-thinking': 'claude-4.5-opus-high-thinking',
  'claude-4.5-sonnet': 'claude-4.5-sonnet',
  'claude-4.5-sonnet-thinking': 'claude-4.5-sonnet-thinking',
  'claude-4.5-haiku': 'claude-4.5-haiku',
  'claude-4.5-haiku-thinking': 'claude-4.5-haiku-thinking',
  'claude-4-sonnet': 'claude-4-sonnet',
  'claude-4-sonnet-1m': 'claude-4-sonnet-1m',
  'claude-4-sonnet-thinking': 'claude-4-sonnet-thinking',
  'claude-4-sonnet-1m-thinking': 'claude-4-sonnet-1m-thinking',

  // GPT on Cursor
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5.1-high': 'gpt-5.1-high',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.2-codex': 'gpt-5.2-codex',
  'gpt-5.3-codex': 'gpt-5.3-codex',

  // Gemini on Cursor
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-3-flash': 'gemini-3-flash',
  'gemini-3-pro': 'gemini-3-pro',
  'gemini-3.1-pro': 'gemini-3.1-pro',

  // Other on Cursor
  'grok-code-fast-1': 'grok-code-fast-1',
  'kimi-k2.5': 'kimi-k2.5',
};

/**
 * Map external model name to Cursor internal model name
 * @param {string} modelName - The model name from request
 * @returns {string} - The mapped Cursor model name (or original if no mapping found)
 */
function mapModelName(modelName) {
  if (!modelName) return modelName;

  // Check direct mapping first
  const mapped = MODEL_MAPPING[modelName];
  if (mapped) {
    if (mapped !== modelName) {
      console.log(`[Model Mapper] Mapped "${modelName}" -> "${mapped}"`);
    }
    return mapped;
  }

  // Try case-insensitive matching
  const lowerModel = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_MAPPING)) {
    if (key.toLowerCase() === lowerModel) {
      console.log(`[Model Mapper] Mapped "${modelName}" -> "${value}"`);
      return value;
    }
  }

  // Pattern matching for Anthropic date-versioned models
  // Format: claude-{variant}-{major}-{minor}-{date}
  const anthropicPattern = /^claude-(\w+)-(\d+)-(\d+)-(\d{8})$/i;
  const match = modelName.match(anthropicPattern);
  if (match) {
    const [, variant, major, minor] = match;
    const v = variant.toLowerCase();
    if (major === '4' && minor === '6') {
      if (v === 'opus') return 'claude-4.6-opus-high';
      if (v === 'sonnet') return 'claude-4.6-sonnet-medium';
      if (v === 'haiku') return 'claude-4.5-haiku';
    }
    const cursorName = `claude-${major}.${minor}-${variant}`;
    console.log(`[Model Mapper] Pattern matched "${modelName}" -> "${cursorName}"`);
    return cursorName;
  }

  // No mapping found, return original (Cursor will validate)
  return modelName;
}

/**
 * Get all supported model mappings
 * @returns {Object} - The model mapping object
 */
function getModelMappings() {
  return { ...MODEL_MAPPING };
}

module.exports = {
  mapModelName,
  getModelMappings,
  MODEL_MAPPING,
};
