#!/usr/bin/env node
import crypto from 'node:crypto';

const token = process.env.GITLAB_TOKEN;
if (!token) {
  console.error('Missing GITLAB_TOKEN');
  process.exit(1);
}

const mrUrl = process.argv[2];
if (!mrUrl) {
  console.error('Usage: node review-mr.mjs <gitlab-mr-url>');
  process.exit(1);
}

function parseMrUrl(url) {
  // https://gitlab.example.com/group/proj/-/merge_requests/123
  const u = new URL(url);
  const m = u.pathname.match(/^(.*)\/-\/merge_requests\/(\d+)/);
  if (!m) throw new Error('Invalid GitLab MR URL');
  const projectPath = m[1].replace(/^\//, '');
  const iid = Number(m[2]);
  return { base: `${u.protocol}//${u.host}`, projectPath, iid };
}

async function gl(base, path, opts = {}) {
  const res = await fetch(`${base}/api/v4${path}`, {
    ...opts,
    headers: {
      'PRIVATE-TOKEN': token,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitLab API ${res.status}: ${txt.slice(0, 500)}`);
  }
  return res.json();
}

function addFinding(findings, f) {
  const key = `${f.file}|${f.severity}|${f.title}`;
  if (!findings.some(x => `${x.file}|${x.severity}|${x.title}` === key)) findings.push(f);
}

function analyzeDiff(filePath, diffText = '') {
  const findings = [];
  const added = diffText
    .split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1));

  // Generic checks
  for (const [idx, line] of added.entries()) {
    if (/console\.log\(|debugger\b/.test(line)) {
      addFinding(findings, {
        file: filePath,
        severity: 'medium',
        title: 'Debug 语句进入变更',
        detail: `检测到调试代码（console.log/debugger），建议移除或改为受控日志。`,
        hint: `新增行样例: ${line.slice(0, 120)}`,
        line: idx + 1
      });
    }
    if (/TODO|FIXME|HACK/.test(line)) {
      addFinding(findings, {
        file: filePath,
        severity: 'low',
        title: '遗留标记进入主分支风险',
        detail: '检测到 TODO/FIXME/HACK，建议补任务链接或明确后续计划。',
        hint: `新增行样例: ${line.slice(0, 120)}`,
        line: idx + 1
      });
    }
  }

  if (/auth|permission|billing|payment|token|secret|crypto|jwt/i.test(filePath)) {
    addFinding(findings, {
      file: filePath,
      severity: 'high',
      title: '高风险模块变更需补充验证说明',
      detail: '该文件属于认证/计费/安全相关路径，建议补充测试证据、回滚策略和边界案例。',
      hint: '建议在 MR 描述中附上测试命令与结果截图。'
    });
  }

  return findings;
}

function signature(f) {
  return 'mr-review-bot:' + crypto.createHash('sha1').update(`${f.file}|${f.severity}|${f.title}|${f.detail}`).digest('hex').slice(0, 12);
}

async function main() {
  const { base, projectPath, iid } = parseMrUrl(mrUrl);
  const projectId = encodeURIComponent(projectPath);

  const mr = await gl(base, `/projects/${projectId}/merge_requests/${iid}`);
  const changes = await gl(base, `/projects/${projectId}/merge_requests/${iid}/changes`);
  const existingNotes = await gl(base, `/projects/${projectId}/merge_requests/${iid}/notes?per_page=100`);

  const findings = [];
  for (const c of (changes.changes || [])) {
    const filePath = c.new_path || c.old_path;
    const diff = c.diff || '';
    const f = analyzeDiff(filePath, diff);
    findings.push(...f);
  }

  if (!findings.length) {
    const body = `✅ 自动 Review 未发现明显规则型问题\n\n范围: ${mr.references?.full || `!${iid}`}\n(Heuristic checks: debug statements / TODO markers / risky-path reminders)`;
    await gl(base, `/projects/${projectId}/merge_requests/${iid}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
    console.log('Posted: no-issues summary note');
    return;
  }

  let posted = 0;
  for (const f of findings) {
    const sig = signature(f);
    if (existingNotes.some(n => (n.body || '').includes(sig))) continue;

    const body = [
      `### [${f.severity.toUpperCase()}] ${f.title}`,
      `- 文件: \`${f.file}\``,
      f.line ? `- 参考: 变更新增行序号 ~ ${f.line}` : null,
      `- 问题: ${f.detail}`,
      f.hint ? `- 建议: ${f.hint}` : null,
      `\n\`${sig}\``
    ].filter(Boolean).join('\n');

    await gl(base, `/projects/${projectId}/merge_requests/${iid}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
    posted += 1;
  }

  const summary = `🤖 自动 Review 完成\n- MR: ${mr.web_url}\n- 发现问题数: ${findings.length}\n- 本次新发评论: ${posted}\n- 去重策略: signature hash`;
  await gl(base, `/projects/${projectId}/merge_requests/${iid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body: summary })
  });

  console.log(`Done. findings=${findings.length}, posted=${posted}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
