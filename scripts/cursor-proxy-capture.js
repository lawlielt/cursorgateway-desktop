#!/usr/bin/env node
/**
 * Transparent HTTPS proxy that captures Cursor IDE traffic to api2.cursor.sh.
 *
 * Usage:
 *   node scripts/cursor-proxy-capture.js
 *
 * Then launch Cursor with:
 *   /Applications/Cursor.app/Contents/MacOS/Cursor --proxy-server="http://127.0.0.1:9090"
 *
 * Captures agent.v1.AgentService/RunSSE and BidiAppend request/response bodies
 * to the captures/ directory for protobuf analysis.
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROXY_PORT = 9090;
const CAPTURES_DIR = path.join(__dirname, '..', 'captures');
const CA_CERT_PATH = path.join(process.env.HOME, '.mitmproxy', 'mitmproxy-ca-cert.pem');
const CA_KEY_PATH = path.join(process.env.HOME, '.mitmproxy', 'mitmproxy-ca.pem');

const INTERCEPT_HOST = 'api2.cursor.sh';
const AGENT_PATHS = new Set([
  '/agent.v1.AgentService/RunSSE',
  '/agent.v1.AgentService/BidiAppend',
]);

let counter = 0;
const certCache = new Map();

const caCert = fs.readFileSync(CA_CERT_PATH);
const caKey = fs.readFileSync(CA_KEY_PATH);

fs.mkdirSync(CAPTURES_DIR, { recursive: true });

function log(msg) {
  console.log(`[${new Date().toISOString().substring(11, 23)}] ${msg}`);
}

function saveCapture(prefix, seq, suffix, data) {
  const fname = `${prefix}_${String(seq).padStart(4, '0')}_${suffix}`;
  const fpath = path.join(CAPTURES_DIR, fname);
  fs.writeFileSync(fpath, data);
  log(`Saved ${fname} (${data.length} bytes)`);
}

function generateCertForHost(hostname) {
  if (certCache.has(hostname)) return certCache.get(hostname);

  const keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privKey = keyPair.privateKey.export({ type: 'pkcs1', format: 'pem' });

  const tmpDir = fs.mkdtempSync('/tmp/proxy-cert-');
  const keyFile = path.join(tmpDir, 'key.pem');
  const csrFile = path.join(tmpDir, 'csr.pem');
  const certFile = path.join(tmpDir, 'cert.pem');
  const extFile = path.join(tmpDir, 'ext.cnf');

  fs.writeFileSync(keyFile, privKey);
  fs.writeFileSync(extFile, [
    'basicConstraints=CA:FALSE',
    `subjectAltName=DNS:${hostname}`,
    'keyUsage=digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
  ].join('\n'));

  execSync(`openssl req -new -key ${keyFile} -subj "/CN=${hostname}" -out ${csrFile} 2>/dev/null`);
  execSync(`openssl x509 -req -in ${csrFile} -CA ${CA_CERT_PATH} -CAkey ${CA_KEY_PATH} -CAcreateserial -out ${certFile} -days 1 -extfile ${extFile} 2>/dev/null`);

  const cert = fs.readFileSync(certFile, 'utf-8');

  // cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  const result = { key: privKey, cert };
  certCache.set(hostname, result);
  return result;
}

function createInterceptServer(hostname) {
  const { key, cert } = generateCertForHost(hostname);

  const server = https.createServer({ key, cert }, (req, res) => {
    const isAgentPath = AGENT_PATHS.has(req.url);
    const seq = ++counter;

    if (isAgentPath) {
      log(`#${seq} INTERCEPT ${req.method} ${hostname}${req.url}`);
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const pathTag = req.url.split('/').pop();

      if (isAgentPath && body.length > 0) {
        const headers = { ...req.headers };
        const auth = headers['authorization'] || '';
        if (auth.length > 60) {
          const parts = auth.split(' ');
          if (parts.length === 2) {
            headers['authorization'] = `${parts[0]} ${parts[1].substring(0, 20)}...(${parts[1].length} chars)`;
          }
        }

        saveCapture(`req_${pathTag}`, seq, 'meta.json', JSON.stringify({
          timestamp: Date.now(),
          method: req.method,
          url: `https://${hostname}${req.url}`,
          path: req.url,
          headers,
          content_length: body.length,
        }, null, 2));
        saveCapture(`req_${pathTag}`, seq, 'body.bin', body);
      }

      // Forward to real server
      const proxyReq = https.request({
        hostname,
        port: 443,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: hostname,
        },
      }, (proxyRes) => {
        const respChunks = [];
        proxyRes.on('data', chunk => {
          respChunks.push(chunk);
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          const respBody = Buffer.concat(respChunks);
          if (isAgentPath) {
            saveCapture(`resp_${pathTag}`, seq, 'meta.json', JSON.stringify({
              status_code: proxyRes.statusCode,
              headers: proxyRes.headers,
              content_length: respBody.length,
            }, null, 2));
            if (respBody.length > 0) {
              saveCapture(`resp_${pathTag}`, seq, 'body.bin', respBody);
            }
            log(`#${seq} RESPONSE ${pathTag} status=${proxyRes.statusCode} body=${respBody.length}b`);
          }
          res.end();
        });

        res.writeHead(proxyRes.statusCode, proxyRes.headers);
      });

      proxyReq.on('error', (err) => {
        log(`#${seq} Proxy error: ${err.message}`);
        res.writeHead(502);
        res.end('Bad Gateway');
      });

      proxyReq.write(body);
      proxyReq.end();
    });
  });

  return server;
}

// HTTP CONNECT proxy
const proxy = http.createServer((req, res) => {
  // Regular HTTP requests (non-CONNECT)
  res.writeHead(400);
  res.end('This is a CONNECT proxy only');
});

proxy.on('connect', (req, clientSocket, head) => {
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port || '443');

  if (hostname === INTERCEPT_HOST) {
    // MITM: create local TLS server, pipe client to it
    log(`CONNECT (MITM) -> ${hostname}:${targetPort}`);

    const interceptServer = createInterceptServer(hostname);
    interceptServer.listen(0, '127.0.0.1', () => {
      const localPort = interceptServer.address().port;

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      const localSocket = net.connect(localPort, '127.0.0.1', () => {
        if (head.length > 0) localSocket.write(head);
        clientSocket.pipe(localSocket);
        localSocket.pipe(clientSocket);
      });

      localSocket.on('error', (err) => {
        log(`Local socket error: ${err.message}`);
        clientSocket.destroy();
      });

      clientSocket.on('error', () => localSocket.destroy());
      clientSocket.on('close', () => {
        localSocket.destroy();
        interceptServer.close();
      });
    });
  } else {
    // Pass-through: tunnel directly
    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) serverSocket.write(head);
      clientSocket.pipe(serverSocket);
      serverSocket.pipe(clientSocket);
    });

    serverSocket.on('error', (err) => {
      log(`Tunnel error to ${hostname}: ${err.message}`);
      clientSocket.destroy();
    });

    clientSocket.on('error', () => serverSocket.destroy());
  }
});

proxy.listen(PROXY_PORT, '0.0.0.0', () => {
  log(`=== Cursor Capture Proxy listening on port ${PROXY_PORT} ===`);
  log(`Intercepting: ${INTERCEPT_HOST} (agent.v1 endpoints)`);
  log(`Captures dir: ${CAPTURES_DIR}`);
  log('');
  log('Launch Cursor with:');
  log(`  /Applications/Cursor.app/Contents/MacOS/Cursor --proxy-server="http://127.0.0.1:${PROXY_PORT}"`);
  log('');
  log('Or set NODE_TLS_REJECT_UNAUTHORIZED=0 if cert issues arise.');
});

proxy.on('error', (err) => {
  log(`Proxy error: ${err.message}`);
});
