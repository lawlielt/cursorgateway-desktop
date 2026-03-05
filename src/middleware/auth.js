const { getTokenFromRequest, parseToken } = require('../utils/tokenManager');
const { detectClient } = require('../adapters/detector');

/**
 * Authentication middleware.
 * 1. Detects client type from API key / tools heuristic → req.clientType, req.adapter
 * 2. Resolves Cursor auth token → req.authToken
 */
function authMiddleware(req, res, next) {
  try {
    // Detect client type (side-effect-free, never throws).
    const { clientType, adapter } = detectClient(req);
    req.clientType = clientType;
    req.adapter = adapter;

    const token = getTokenFromRequest(req);
    if (!token) {
      const isAnthropicPath = req.path.includes('/messages');
      if (isAnthropicPath) {
        return res.status(401).json({
          type: 'error',
          error: { type: 'authentication_error', message: "Missing authentication. Please run 'npm run login' first or provide x-api-key/Authorization header." },
        });
      }
      return res.status(401).json({
        error: "Missing Authorization header. Please run 'npm run login' first or provide token in request.",
      });
    }

    const authToken = parseToken(token);
    if (!authToken) {
      return res.status(401).json({
        error: { message: 'Invalid token format', type: 'authentication_error', param: null, code: null },
      });
    }

    req.rawToken = token;
    req.authToken = authToken;
    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { authMiddleware };
