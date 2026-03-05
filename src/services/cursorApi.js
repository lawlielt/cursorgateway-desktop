/**
 * Cursor API service - centralises header construction and HTTP calls to api2.cursor.sh.
 * All route files should call this service instead of building headers themselves.
 */

const { fetch, ProxyAgent, Agent } = require('undici');
const { v4: uuidv4, v5: uuidv5 } = require('uuid');
const config = require('../config/config');
const {
  CURSOR_API_URL,
  CURSOR_MODELS_ENDPOINT,
  CURSOR_CHAT_ENDPOINT,
  CURSOR_CLIENT_VERSION,
  USER_AGENT,
} = require('../config/constants');
const { generateHashed64Hex, generateCursorChecksum } = require('../utils/utils');

function buildCommonHeaders(authToken, req) {
  const cursorChecksum = req?.headers?.['x-cursor-checksum']
    ?? generateCursorChecksum(authToken.trim());
  const sessionid = uuidv5(authToken, uuidv5.DNS);
  const clientKey = generateHashed64Hex(authToken);

  return {
    'authorization': `Bearer ${authToken}`,
    'connect-protocol-version': '1',
    'user-agent': USER_AGENT,
    'x-amzn-trace-id': `Root=${uuidv4()}`,
    'x-client-key': clientKey,
    'x-cursor-checksum': cursorChecksum,
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': process.platform,
    'x-cursor-client-arch': process.arch,
    'x-cursor-client-device-type': 'desktop',
    'x-cursor-config-version': uuidv4(),
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    'x-ghost-mode': 'true',
    'x-request-id': uuidv4(),
    'x-session-id': sessionid,
    'Host': 'api2.cursor.sh',
  };
}

function getDispatcher() {
  return config.proxy.enabled
    ? new ProxyAgent(config.proxy.url, { allowH2: true })
    : new Agent({ allowH2: true });
}

async function fetchAvailableModels(authToken, req) {
  const headers = {
    ...buildCommonHeaders(authToken, req),
    'accept-encoding': 'gzip',
    'content-type': 'application/proto',
  };

  return fetch(`${CURSOR_API_URL}${CURSOR_MODELS_ENDPOINT}`, {
    method: 'POST',
    headers,
  });
}

async function fetchChatStream(authToken, cursorBody, req) {
  const headers = {
    ...buildCommonHeaders(authToken, req),
    'connect-accept-encoding': 'gzip',
    'connect-content-encoding': 'gzip',
    'content-type': 'application/connect+proto',
  };

  return fetch(`${CURSOR_API_URL}${CURSOR_CHAT_ENDPOINT}`, {
    method: 'POST',
    headers,
    body: cursorBody,
    dispatcher: getDispatcher(),
  });
}

/**
 * Check if a Cursor response is a JSON error (Cursor sometimes returns 200 with JSON error body).
 * Returns the error message string if it is, null otherwise.
 */
async function extractJsonError(cursorResponse) {
  const contentType = cursorResponse.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return null;

  const errorBody = await cursorResponse.json();
  return errorBody.error?.details?.[0]?.debug?.details?.detail
    || errorBody.error?.message
    || 'Authentication failed';
}

module.exports = {
  buildCommonHeaders,
  getDispatcher,
  fetchAvailableModels,
  fetchChatStream,
  extractJsonError,
};
