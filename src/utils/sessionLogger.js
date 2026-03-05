const fs = require('fs');
const path = require('path');

// 会话日志目录
const SESSIONS_DIR = path.join(__dirname, '../..', 'sessions');

// 确保目录存在
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * 生成会话文件名
 * @param {string} endpoint - API 端点名称
 * @returns {string} - 文件路径
 */
function getSessionFilePath(endpoint) {
  const date = new Date();
  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = date.toISOString().split('T')[1].replace(/:/g, '-').split('.')[0]; // HH-MM-SS
  const filename = `${dateStr}_${timeStr}_${endpoint}.json`;
  return path.join(SESSIONS_DIR, filename);
}

/**
 * 保存会话日志
 * @param {string} endpoint - API 端点 (messages, chat, completions, responses)
 * @param {object} request - 请求信息
 * @param {object} response - 响应信息
 * @param {object} options - 额外选项
 */
function saveSession(endpoint, request, response, options = {}) {
  try {
    const session = {
      timestamp: new Date().toISOString(),
      endpoint: endpoint,
      request: {
        method: request.method || 'POST',
        path: request.path || `/${endpoint}`,
        headers: sanitizeHeaders(request.headers || {}),
        body: request.body || {},
      },
      response: {
        status: response.status || 200,
        body: response.body || {},
        error: response.error || null,
      },
      metadata: {
        model: options.model || null,
        modelMapped: options.modelMapped || null,
        agentMode: options.agentMode || false,
        stream: options.stream || false,
        duration: options.duration || null,
      }
    };

    const filePath = getSessionFilePath(endpoint);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    console.log(`[Session] Saved to ${path.basename(filePath)}`);
    return filePath;
  } catch (err) {
    console.error('[Session] Failed to save:', err.message);
    return null;
  }
}

/**
 * 清理敏感 headers
 * @param {object} headers - 原始 headers
 * @returns {object} - 清理后的 headers
 */
function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  
  // 掩码敏感信息
  if (sanitized.authorization) {
    const token = sanitized.authorization.replace('Bearer ', '');
    sanitized.authorization = `Bearer ${maskToken(token)}`;
  }
  if (sanitized['x-api-key']) {
    sanitized['x-api-key'] = maskToken(sanitized['x-api-key']);
  }
  
  return sanitized;
}

/**
 * 掩码 token
 * @param {string} token - 原始 token
 * @returns {string} - 掩码后的 token
 */
function maskToken(token) {
  if (!token || token.length < 15) return '***';
  return `${token.substring(0, 10)}...${token.substring(token.length - 5)}`;
}

/**
 * 获取最近的会话文件列表
 * @param {number} limit - 返回数量限制
 * @returns {string[]} - 文件路径列表
 */
function getRecentSessions(limit = 10) {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(SESSIONS_DIR, f),
        time: fs.statSync(path.join(SESSIONS_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map(f => f.path);
    return files;
  } catch (err) {
    return [];
  }
}

/**
 * 清理旧的会话文件（保留最近 N 个）
 * @param {number} keepCount - 保留数量
 */
function cleanOldSessions(keepCount = 100) {
  try {
    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(SESSIONS_DIR, f),
        time: fs.statSync(path.join(SESSIONS_DIR, f)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);
    
    if (files.length > keepCount) {
      const toDelete = files.slice(keepCount);
      for (const file of toDelete) {
        fs.unlinkSync(file.path);
      }
      console.log(`[Session] Cleaned ${toDelete.length} old session files`);
    }
  } catch (err) {
    console.error('[Session] Failed to clean:', err.message);
  }
}

module.exports = {
  saveSession,
  getRecentSessions,
  cleanOldSessions,
  SESSIONS_DIR,
};
