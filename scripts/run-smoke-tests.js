#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fetch } = require('undici');

const ERR_PATTERN = /\b(error|failed|exception|fatal|econn|etimedout|unhandled)\b/i;

function parseArgs(argv) {
  const options = {
    port: Number(process.env.TEST_PROXY_PORT || 3310),
    startupTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    e2e: false,
    strictE2E: false,
    withUnit: true,
    reportFile: path.join(process.cwd(), 'sessions', 'automation', 'latest-smoke-report.json'),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }

    if (arg === '--e2e') {
      options.e2e = true;
      continue;
    }
    if (arg === '--strict-e2e') {
      options.e2e = true;
      options.strictE2E = true;
      continue;
    }
    if (arg === '--no-unit') {
      options.withUnit = false;
      continue;
    }
    if (arg === '--unit') {
      options.withUnit = true;
      continue;
    }

    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }

    if (key === '--port') {
      options.port = toPositiveInt(value, '--port');
      i += 1;
      continue;
    }
    if (key === '--startup-timeout-ms') {
      options.startupTimeoutMs = toPositiveInt(value, '--startup-timeout-ms');
      i += 1;
      continue;
    }
    if (key === '--request-timeout-ms') {
      options.requestTimeoutMs = toPositiveInt(value, '--request-timeout-ms');
      i += 1;
      continue;
    }
    if (key === '--report-file') {
      options.reportFile = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelpAndExit(code) {
  process.stdout.write(`Usage: node scripts/run-smoke-tests.js [options]\n\nOptions:\n  --port <number>                Proxy port (default: 3310)\n  --startup-timeout-ms <ms>      Server startup timeout (default: 15000)\n  --request-timeout-ms <ms>      HTTP request timeout (default: 30000)\n  --report-file <path>           JSON report output path\n  --e2e                          Add live upstream checks (allow non-2xx if <500)\n  --strict-e2e                   Add live checks and require 200\n  --no-unit                      Skip local unit tests\n  --unit                         Force-run local unit tests\n  -h, --help                     Show help\n`);
  process.exit(code);
}

function toPositiveInt(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${label} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function timestamp() {
  return new Date().toISOString();
}

function stampForFile() {
  return timestamp().replace(/[:.]/g, '-');
}

function tail(text, maxLines = 60) {
  if (!text) {
    return '';
  }
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
}

function summarizeBody(text, maxLength = 500) {
  if (!text) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function attachLineReader(stream, streamName, onLine) {
  let buffer = '';

  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const idx = buffer.indexOf('\n');
      if (idx === -1) {
        break;
      }
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(line, streamName);
    }
  });

  stream.on('end', () => {
    const line = buffer.replace(/\r$/, '').trim();
    if (line.length > 0) {
      onLine(line, streamName);
    }
  });
}

function runProcess(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 300000;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode == null) {
          child.kill('SIGKILL');
        }
      }, 1500);
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code == null ? -1 : code,
        signal: signal || null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

function isSevereLogLine(line) {
  if (!ERR_PATTERN.test(line)) {
    return false;
  }

  const ignore = [
    'invalid_request_error',
    'authentication_error',
    'Missing authentication',
    'Missing Authorization',
  ];
  for (const token of ignore) {
    if (line.includes(token)) {
      return false;
    }
  }
  return true;
}

async function startServer(options, logFilePath) {
  const child = spawn('node', ['src/app.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(options.port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const severeLogs = [];

  const writeLogLine = (line, streamName) => {
    const composed = `[${timestamp()}] [${streamName}] ${line}`;
    logs.push(composed);
    fs.appendFileSync(logFilePath, `${composed}\n`, 'utf8');
    if (isSevereLogLine(line)) {
      severeLogs.push(composed);
    }
  };

  attachLineReader(child.stdout, 'stdout', writeLogLine);
  attachLineReader(child.stderr, 'stderr', writeLogLine);

  const startup = await new Promise((resolve, reject) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      reject(new Error(`Server startup timeout after ${options.startupTimeoutMs}ms`));
    }, options.startupTimeoutMs);

    const onReady = (line) => {
      if (done) {
        return;
      }
      if (line.includes(`The server listens port: ${options.port}`)) {
        done = true;
        clearTimeout(timer);
        resolve({ child, logs, severeLogs });
      }
    };

    const readyListener = (line, _streamName) => {
      onReady(line);
    };

    attachLineReader(child.stdout, 'stdout', readyListener);
    attachLineReader(child.stderr, 'stderr', readyListener);

    child.once('exit', (code, signal) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      reject(new Error(`Server exited before ready (code=${code}, signal=${signal || 'none'})`));
    });
  });

  return startup;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) {
    return;
  }

  await new Promise((resolve) => {
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      resolve();
    };

    child.once('exit', finish);
    child.kill('SIGTERM');

    setTimeout(() => {
      if (child.exitCode == null) {
        child.kill('SIGKILL');
      }
      finish();
    }, 3000);
  });
}

async function requestJson(baseUrl, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const headers = {
      ...options.headers,
    };

    let body;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(`${baseUrl}${options.path}`, {
      method: options.method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_e) {
      json = null;
    }

    return {
      ok: true,
      status: response.status,
      text,
      json,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      text: '',
      json: null,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runHttpChecks(baseUrl, options) {
  const checks = [];

  const runCheck = async (spec) => {
    const startedAt = Date.now();
    const response = await requestJson(baseUrl, {
      method: spec.method,
      path: spec.path,
      body: spec.body,
      timeoutMs: options.requestTimeoutMs,
      headers: spec.headers || {},
    });

    let passed = false;
    let note = '';
    if (!response.ok) {
      note = `request error: ${response.error}`;
    } else {
      try {
        passed = spec.validate(response);
      } catch (error) {
        passed = false;
        note = `validator error: ${error.message}`;
      }
      if (!passed && note.length === 0) {
        note = `status=${response.status}, body=${summarizeBody(response.text)}`;
      }
    }

    checks.push({
      name: spec.name,
      ok: passed,
      durationMs: Date.now() - startedAt,
      note,
      status: response.status,
      responsePreview: summarizeBody(response.text),
    });
  };

  await runCheck({
    name: 'chat_requires_non_empty_messages',
    method: 'POST',
    path: '/v1/chat/completions',
    body: {
      model: 'claude-3.5-sonnet',
      messages: [],
    },
    validate: (res) => res.status === 400 && /Messages should be a non-empty array/i.test(res.text),
  });

  await runCheck({
    name: 'messages_requires_non_empty_messages',
    method: 'POST',
    path: '/v1/messages',
    body: {
      model: 'claude-3.5-sonnet',
      max_tokens: 64,
      messages: [],
    },
    validate: (res) => res.status === 400 && /messages is required/i.test(res.text),
  });

  await runCheck({
    name: 'messages_requires_max_tokens',
    method: 'POST',
    path: '/v1/messages',
    body: {
      model: 'claude-3.5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
    },
    validate: (res) => res.status === 400 && /max_tokens is required/i.test(res.text),
  });

  await runCheck({
    name: 'completions_requires_prompt',
    method: 'POST',
    path: '/v1/completions',
    body: {
      model: 'claude-3.5-sonnet',
    },
    validate: (res) => res.status === 400 && /prompt is required/i.test(res.text),
  });

  await runCheck({
    name: 'responses_requires_input',
    method: 'POST',
    path: '/v1/responses',
    body: {
      model: 'claude-3.5-sonnet',
    },
    validate: (res) => res.status === 400 && /input is required/i.test(res.text),
  });

  await runCheck({
    name: 'unknown_route_404',
    method: 'GET',
    path: '/v1/not-a-real-route',
    validate: (res) => res.status === 404,
  });

  if (options.e2e) {
    const liveValidator = options.strictE2E
      ? (res) => res.status === 200
      : (res) => res.status > 0 && res.status < 500;

    await runCheck({
      name: 'live_models_check',
      method: 'GET',
      path: '/v1/models',
      validate: liveValidator,
    });

    await runCheck({
      name: 'live_chat_check',
      method: 'POST',
      path: '/v1/chat/completions',
      body: {
        model: 'claude-3.5-sonnet',
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
      },
      validate: liveValidator,
    });

    await runCheck({
      name: 'live_messages_check',
      method: 'POST',
      path: '/v1/messages',
      body: {
        model: 'claude-3.5-sonnet',
        max_tokens: 64,
        stream: false,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
      },
      validate: liveValidator,
    });
  }

  return checks;
}

function collectSessionIssues(runStartedMs) {
  const issues = [];
  const sessionsDir = path.join(process.cwd(), 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    return issues;
  }

  const files = fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({
      name,
      path: path.join(sessionsDir, name),
      mtimeMs: fs.statSync(path.join(sessionsDir, name)).mtimeMs,
    }))
    .filter((entry) => entry.mtimeMs >= runStartedMs)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file.path, 'utf8'));
      const status = parsed?.response?.status;
      if (typeof status === 'number' && status >= 500) {
        issues.push({
          file: file.name,
          status,
          error: parsed?.response?.error || null,
        });
      }
    } catch (error) {
      issues.push({
        file: file.name,
        status: null,
        error: `Invalid JSON: ${error.message}`,
      });
    }
  }

  return issues;
}

async function runUnitChecks(withUnit) {
  if (!withUnit) {
    return [];
  }

  const checks = [];
  const commands = [
    { name: 'test_tools', cmd: 'npm', args: ['run', 'test:tools'] },
    { name: 'test_mcp', cmd: 'npm', args: ['run', 'test:mcp'] },
  ];

  for (const command of commands) {
    const startedAt = Date.now();
    const result = await runProcess(command.cmd, command.args, { timeoutMs: 180000 });
    checks.push({
      name: command.name,
      ok: result.code === 0,
      durationMs: Date.now() - startedAt,
      code: result.code,
      timedOut: result.timedOut,
      stdoutTail: tail(result.stdout, 80),
      stderrTail: tail(result.stderr, 80),
    });
  }

  return checks;
}

function printSummary(report) {
  const lines = [];
  lines.push(`Smoke checks: ${report.summary.passedHttpChecks}/${report.httpChecks.length} passed`);
  if (report.commandChecks.length > 0) {
    lines.push(`Command checks: ${report.summary.passedCommandChecks}/${report.commandChecks.length} passed`);
  }
  lines.push(`Severe log lines: ${report.server.severeLogs.length}`);
  lines.push(`Session issues: ${report.sessionIssues.length}`);
  lines.push(`Report: ${report.reportFile}`);

  for (const line of lines) {
    console.log(`[Smoke] ${line}`);
  }

  if (report.summary.failedItems > 0) {
    console.error(`[Smoke] FAILED (${report.summary.failedItems} issue(s))`);
  } else {
    console.log('[Smoke] PASSED');
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const runStartedAt = Date.now();
  const reportDir = path.dirname(options.reportFile);
  fs.mkdirSync(reportDir, { recursive: true });
  const logFile = path.join(reportDir, `${stampForFile()}_proxy.log`);

  const report = {
    startedAt: new Date(runStartedAt).toISOString(),
    finishedAt: null,
    options,
    reportFile: options.reportFile,
    server: {
      logFile,
      port: options.port,
      severeLogs: [],
      startupError: null,
    },
    httpChecks: [],
    commandChecks: [],
    sessionIssues: [],
    summary: {
      passedHttpChecks: 0,
      passedCommandChecks: 0,
      failedItems: 0,
    },
  };

  let server = null;

  try {
    server = await startServer(options, logFile);
    report.server.severeLogs = server.severeLogs;

    const baseUrl = `http://127.0.0.1:${options.port}`;
    report.httpChecks = await runHttpChecks(baseUrl, options);
  } catch (error) {
    report.server.startupError = error.message;
  } finally {
    if (server && server.child) {
      await stopServer(server.child);
      report.server.severeLogs = server.severeLogs;
    }
  }

  report.commandChecks = await runUnitChecks(options.withUnit);
  report.sessionIssues = collectSessionIssues(runStartedAt);

  report.finishedAt = timestamp();
  report.summary.passedHttpChecks = report.httpChecks.filter((c) => c.ok).length;
  report.summary.passedCommandChecks = report.commandChecks.filter((c) => c.ok).length;

  const failedHttp = report.httpChecks.filter((c) => !c.ok).length;
  const failedCommands = report.commandChecks.filter((c) => !c.ok).length;
  const startupFailure = report.server.startupError ? 1 : 0;
  const severeLogFailures = report.server.severeLogs.length;
  const sessionFailures = report.sessionIssues.length;

  report.summary.failedItems = failedHttp + failedCommands + startupFailure + severeLogFailures + sessionFailures;

  fs.writeFileSync(options.reportFile, JSON.stringify(report, null, 2), 'utf8');
  printSummary(report);

  process.exit(report.summary.failedItems > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('[Smoke] Unexpected failure:', error);
  process.exit(1);
});
