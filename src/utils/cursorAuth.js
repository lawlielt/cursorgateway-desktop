const os = require('os');
const path = require('path');
const crypto = require('crypto');

function getCursorStoragePath() {
  const homeDir = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

let cachedMachineId = null;
function getMachineIdFromStorage() {
  if (cachedMachineId) return cachedMachineId;
  try {
    const Database = require('better-sqlite3');
    const db = new Database(getCursorStoragePath(), { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'storage.serviceMachineId'").get();
    db.close();
    if (row && row.value) {
      cachedMachineId = row.value.toString();
      return cachedMachineId;
    }
  } catch (err) {
    console.error('Could not read machine ID from Cursor storage:', err.message);
  }
  return null;
}

function generateHashed64Hex(input, salt = '') {
  const hash = crypto.createHash('sha256');
  hash.update(input + salt);
  return hash.digest('hex');
}

function obfuscateBytes(byteArray) {
  let t = 165;
  for (let r = 0; r < byteArray.length; r++) {
    byteArray[r] = (byteArray[r] ^ t) + (r % 256);
    t = byteArray[r];
  }
  return byteArray;
}

function generateCursorChecksum(token) {
  let machineId = getMachineIdFromStorage();
  if (!machineId) {
    machineId = generateHashed64Hex(token, 'machineId');
  }

  const timestamp = Math.floor(Date.now() / 1e6);
  const byteArray = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    255 & timestamp,
  ]);

  const obfuscatedBytes = obfuscateBytes(byteArray);
  const encodedChecksum = Buffer.from(obfuscatedBytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${encodedChecksum}${machineId}`;
}

function generateChecksum(accessToken) {
  return generateCursorChecksum(accessToken);
}

module.exports = {
  getCursorStoragePath,
  getMachineIdFromStorage,
  generateHashed64Hex,
  generateCursorChecksum,
  generateChecksum,
};
