const fs = require('fs');
const path = require('path');

// Token 存储文件路径（项目根目录下的 .cursor-token）
const os = require('os');

const TOKEN_FILE = process.env.CURSOR_GATEWAY_TOKEN_FILE || path.join(process.cwd(), '.cursor-token');
const LEGACY_TOKEN_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'cursor-gateway', '.cursor-token');
const DESKTOP_TOKEN_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor Gateway Desktop', '.cursor-token');

/**
 * 保存 Token 到本地文件
 * @param {string} token - Cursor Token
 */
function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_FILE, token, 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to save token:', err.message);
    return false;
  }
}

/**
 * 从本地文件读取 Token
 * @returns {string|null} - 返回 Token 或 null
 */
function loadToken() {
  try {
    const candidates = [TOKEN_FILE, LEGACY_TOKEN_FILE, DESKTOP_TOKEN_FILE];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        const token = fs.readFileSync(f, 'utf-8').trim();
        if (token) return token;
      }
    }
  } catch (err) {
    console.error('Failed to load token:', err.message);
  }
  return null;
}

/**
 * 检查是否已保存 Token
 * @returns {boolean}
 */
function hasToken() {
  return loadToken() !== null;
}

/**
 * 删除保存的 Token
 * @returns {boolean}
 */
function clearToken() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
    }
    return true;
  } catch (err) {
    console.error('Failed to clear token:', err.message);
    return false;
  }
}

/**
 * 检查 Token 是否是有效的 Cursor Token 格式
 * Cursor Token 通常是 JWT 格式（eyJ 开头）或 userId::accessToken 格式
 * 无效格式包括：sk-xxx（OpenAI key）、key-xxx、URL 等
 * @param {string} token - Token 字符串
 * @returns {boolean} - 是否是有效的 Cursor Token 格式
 */
function isValidCursorTokenFormat(token) {
  if (!token) return false;
  
  // 无效格式：OpenAI API key（sk-xxx）或其他常见 API key 格式
  if (token.startsWith('sk-') || token.startsWith('key-') || token.startsWith('pk-')) {
    return false;
  }
  
  // 无效格式：URL（http:// 或 https:// 开头）
  if (token.startsWith('http://') || token.startsWith('https://')) {
    return false;
  }
  
  // 有效格式：JWT（eyJ 开头）或包含 :: 的 userId::accessToken 格式
  if (token.startsWith('eyJ') || token.includes('::') || token.includes('%3A%3A')) {
    return true;
  }
  
  // 有效格式：user_ 开头的用户 ID 格式（Cursor 用户 token）
  if (token.startsWith('user_')) {
    return true;
  }
  
  // 其他情况：不再使用宽松的兜底逻辑，只接受明确匹配的格式
  return false;
}

/**
 * 从请求中获取 Token（优先使用请求中的，否则使用本地保存的）
 * 支持多种认证方式：
 *   - Authorization: Bearer <token>
 *   - x-api-key: <token>
 * 
 * 注意：如果请求中提供的 Token 格式无效（如 OpenAI 的 sk-xxx 格式），
 * 会自动回退到使用本地保存的 Cursor Token
 * 
 * @param {object} req - Express 请求对象
 * @returns {string|null} - 返回 Token 或 null
 */
function getTokenFromRequest(req) {
  // 1. 先尝试从请求头获取
  let token = req.headers['x-api-key'] 
    || req.headers.authorization?.replace('Bearer ', '');
  
  // 2. 检查 Token 格式是否有效，无效则使用本地保存的
  if (!token || !isValidCursorTokenFormat(token)) {
    const savedToken = loadToken();
    if (savedToken) {
      if (token && !isValidCursorTokenFormat(token)) {
        // 请求提供了无效格式的 token，回退到本地 token
        const invalidReason = token.startsWith('http') ? 'URL format' : 
                              token.startsWith('sk-') ? 'OpenAI key format' :
                              token.startsWith('key-') ? 'API key format' : 'unknown format';
        console.log(`[Auth] Ignoring invalid token (${invalidReason}: ${token.substring(0, 15)}...), using saved Cursor token instead.`);
      }
      token = savedToken;
    }
  }
  
  return token || null;
}

/**
 * 处理 Token 格式，提取实际的 authToken
 * @param {string} token - 原始 Token
 * @returns {string} - 处理后的 authToken
 */
function parseToken(token) {
  if (!token) return null;
  
  // 支持多个 key 逗号分隔，随机选一个
  const keys = token.split(',').map((key) => key.trim());
  let authToken = keys[Math.floor(Math.random() * keys.length)];
  
  // 处理 URL 编码的 :: 分隔符
  if (authToken && authToken.includes('%3A%3A')) {
    authToken = authToken.split('%3A%3A')[1];
  } else if (authToken && authToken.includes('::')) {
    authToken = authToken.split('::')[1];
  }
  
  return authToken;
}

module.exports = {
  saveToken,
  loadToken,
  hasToken,
  clearToken,
  getTokenFromRequest,
  parseToken,
  TOKEN_FILE,
  LEGACY_TOKEN_FILE,
  DESKTOP_TOKEN_FILE,
};
