#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const options = {
    rounds: 3,
    autoFix: true,
    e2e: false,
    strictE2E: false,
    withUnit: true,
    port: Number(process.env.TEST_PROXY_PORT || 3310),
    startupTimeoutMs: 15000,
    requestTimeoutMs: 30000,
    reportFile: path.join(process.cwd(), 'sessions', 'automation', 'latest-smoke-report.json'),
    claudeModel: process.env.CLAUDE_MODEL || 'sonnet',
    claudeRetries: 3,
    claudeRetryDelayMs: 12000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    }

    if (arg === '--no-auto-fix') {
      options.autoFix = false;
      continue;
    }
    if (arg === '--auto-fix') {
      options.autoFix = true;
      continue;
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

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === '--rounds') {
      options.rounds = toPositiveInt(value, '--rounds');
      i += 1;
      continue;
    }
    if (arg === '--port') {
      options.port = toPositiveInt(value, '--port');
      i += 1;
      continue;
    }
    if (arg === '--startup-timeout-ms') {
      options.startupTimeoutMs = toPositiveInt(value, '--startup-timeout-ms');
      i += 1;
      continue;
    }
    if (arg === '--request-timeout-ms') {
      options.requestTimeoutMs = toPositiveInt(value, '--request-timeout-ms');
      i += 1;
      continue;
    }
    if (arg === '--report-file') {
      options.reportFile = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (arg === '--claude-model') {
      options.claudeModel = value;
      i += 1;
      continue;
    }
    if (arg === '--claude-retries') {
      options.claudeRetries = toPositiveInt(value, '--claude-retries');
      i += 1;
      continue;
    }
    if (arg === '--claude-retry-delay-ms') {
      options.claudeRetryDelayMs = toPositiveInt(value, '--claude-retry-delay-ms');
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelpAndExit(code) {
  process.stdout.write(`Usage: node scripts/auto-heal-loop.js [options]\n\nOptions:\n  --rounds <number>               Max repair rounds (default: 3)\n  --no-auto-fix                   Disable Claude auto-fix\n  --auto-fix                      Enable Claude auto-fix (default)\n  --port <number>                 Proxy port used by smoke tests\n  --startup-timeout-ms <ms>       Startup timeout passed to smoke tests\n  --request-timeout-ms <ms>       Request timeout passed to smoke tests\n  --report-file <path>            Smoke report JSON path\n  --e2e                           Enable live upstream checks\n  --strict-e2e                    Enable live checks and require HTTP 200\n  --no-unit                       Skip unit checks in smoke tests\n  --unit                          Include unit checks in smoke tests (default)\n  --claude-model <model>          Claude model alias for auto-fix (default: sonnet)\n  --claude-retries <number>       Retry times for Claude API overload (default: 3)\n  --claude-retry-delay-ms <ms>    Retry delay in milliseconds (default: 12000)\n  -h, --help                      Show help\n`);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tail(text, maxLines = 80) {
  if (!text) {
    return '';
  }
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n').trim();
}

function runProcess(cmd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 600000;

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (options.streamOutput) {
        process.stdout.write(text);
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (options.streamOutput) {
        process.stderr.write(text);
      }
    });

    child.on('error', (error) => {
      stderr += `\n${error.message}`;
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

function buildSmokeArgs(options) {
  const args = ['scripts/run-smoke-tests.js'];
  args.push('--port', String(options.port));
  args.push('--startup-timeout-ms', String(options.startupTimeoutMs));
  args.push('--request-timeout-ms', String(options.requestTimeoutMs));
  args.push('--report-file', options.reportFile);

  if (options.e2e) {
    args.push('--e2e');
  }
  if (options.strictE2E) {
    args.push('--strict-e2e');
  }
  if (!options.withUnit) {
    args.push('--no-unit');
  }

  return args;
}

function extractFailures(report) {
  const failedHttp = (report.httpChecks || []).filter((check) => !check.ok);
  const failedCommands = (report.commandChecks || []).filter((check) => !check.ok);
  const severeLogs = report?.server?.severeLogs || [];
  const sessionIssues = report.sessionIssues || [];
  return { failedHttp, failedCommands, severeLogs, sessionIssues };
}

function truncate(line, max = 600) {
  if (!line) {
    return '';
  }
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

function buildClaudePrompt(report, round, options) {
  const failures = extractFailures(report);

  const failedHttpText = failures.failedHttp.length > 0
    ? failures.failedHttp.map((check) => `- ${check.name}: ${truncate(check.note || check.responsePreview || '')}`).join('\n')
    : '- none';

  const failedCommandText = failures.failedCommands.length > 0
    ? failures.failedCommands.map((check) => `- ${check.name}: code=${check.code}, timedOut=${check.timedOut}\n  stdout_tail: ${truncate(check.stdoutTail || '')}\n  stderr_tail: ${truncate(check.stderrTail || '')}`).join('\n')
    : '- none';

  const severeLogText = failures.severeLogs.length > 0
    ? failures.severeLogs.slice(-40).map((line) => `- ${truncate(line)}`).join('\n')
    : '- none';

  const sessionIssueText = failures.sessionIssues.length > 0
    ? failures.sessionIssues.map((item) => `- ${item.file}: status=${item.status}, error=${truncate(item.error || '')}`).join('\n')
    : '- none';

  const prompt = [
    '你是当前仓库的自动修复工程师。请直接修改代码，不要只给建议。',
    '',
    `当前轮次: ${round}`,
    `失败总数: ${report?.summary?.failedItems ?? 'unknown'}`,
    '',
    '失败的 HTTP 校验:',
    failedHttpText,
    '',
    '失败的命令校验:',
    failedCommandText,
    '',
    '服务严重日志:',
    severeLogText,
    '',
    '新产生的 session 异常:',
    sessionIssueText,
    '',
    '修复要求:',
    '1. 仅修改必要文件，修复真实根因，不做临时跳过。',
    '2. 修复后在仓库内运行以下命令并确保通过:',
    `   npm run test:tools`,
    `   npm run test:mcp`,
    `   node scripts/run-smoke-tests.js --port ${options.port} --startup-timeout-ms ${options.startupTimeoutMs} --request-timeout-ms ${options.requestTimeoutMs} --report-file ${options.reportFile} --no-unit${options.e2e ? ' --e2e' : ''}${options.strictE2E ? ' --strict-e2e' : ''}`,
    '3. 输出简短结果: 改了哪些文件、为什么、三条命令的结果。',
  ].join('\n');

  return prompt;
}

function isRetryableClaudeFailure(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (combined.includes('529') || combined.includes('overloaded')) {
    return true;
  }
  if (combined.includes('temporarily unavailable') || combined.includes('rate limit')) {
    return true;
  }
  return false;
}

async function runClaudeFix(prompt, options, artifactsDir, round) {
  let lastResult = null;

  for (let attempt = 1; attempt <= options.claudeRetries; attempt += 1) {
    console.log(`[AutoHeal] Round ${round}: calling Claude (attempt ${attempt}/${options.claudeRetries})`);

    const result = await runProcess(
      'claude',
      [
        '-p',
        '--permission-mode', 'bypassPermissions',
        '--model', options.claudeModel,
        prompt,
      ],
      {
        timeoutMs: 1200000,
        streamOutput: true,
      },
    );

    lastResult = result;

    const transcriptPath = path.join(artifactsDir, `${stampForFile()}_claude_round${round}_attempt${attempt}.log`);
    fs.writeFileSync(
      transcriptPath,
      [
        `timestamp=${timestamp()}`,
        `exit_code=${result.code}`,
        `timed_out=${result.timedOut}`,
        '',
        '--- stdout ---',
        result.stdout,
        '',
        '--- stderr ---',
        result.stderr,
      ].join('\n'),
      'utf8',
    );

    if (result.code === 0) {
      return { ok: true, result };
    }

    if (!isRetryableClaudeFailure(result) || attempt === options.claudeRetries) {
      return { ok: false, result };
    }

    console.error(`[AutoHeal] Claude retryable failure detected, waiting ${options.claudeRetryDelayMs}ms`);
    await sleep(options.claudeRetryDelayMs);
  }

  return { ok: false, result: lastResult };
}

function loadReport(reportFile) {
  try {
    return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read smoke report (${reportFile}): ${error.message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const artifactsDir = path.dirname(options.reportFile);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const smokeArgs = buildSmokeArgs(options);

  for (let round = 1; round <= options.rounds; round += 1) {
    console.log(`[AutoHeal] Round ${round}/${options.rounds}: running smoke suite`);

    const smokeResult = await runProcess('node', smokeArgs, {
      timeoutMs: 1200000,
      streamOutput: true,
    });

    const report = loadReport(options.reportFile);
    const failedItems = report?.summary?.failedItems ?? (smokeResult.code === 0 ? 0 : 1);

    if (smokeResult.code === 0 && failedItems === 0) {
      console.log('[AutoHeal] All checks passed.');
      process.exit(0);
      return;
    }

    console.error(`[AutoHeal] Round ${round} failed (exit=${smokeResult.code}, failed_items=${failedItems})`);

    if (!options.autoFix) {
      console.error('[AutoHeal] Auto-fix disabled, stopping.');
      process.exit(1);
      return;
    }

    if (round === options.rounds) {
      console.error('[AutoHeal] Max rounds reached, stopping.');
      process.exit(1);
      return;
    }

    const prompt = buildClaudePrompt(report, round, options);
    const fixResult = await runClaudeFix(prompt, options, artifactsDir, round);

    if (!fixResult.ok) {
      console.error('[AutoHeal] Claude fix failed.');
      console.error('[AutoHeal] Claude stderr tail:');
      console.error(tail(fixResult.result?.stderr || '', 40));
      process.exit(1);
      return;
    }

    console.log(`[AutoHeal] Round ${round}: Claude fix completed, re-running smoke suite.`);
  }

  console.error('[AutoHeal] Unexpected loop exit.');
  process.exit(1);
}

main().catch((error) => {
  console.error('[AutoHeal] Fatal error:', error);
  process.exit(1);
});
