/**
 * LiteTavern Cloud operator console.
 *
 * This page lives in the closed commercial service, not in the open `apps/web`
 * client. The open client is a connector that anyone may fork and point at any
 * backend; the console is the control surface for the hosted service, so shipping
 * it in the open bundle would publish the operator API surface, the seat model and
 * the wave-2 gating semantics to every fork.
 *
 * It is deliberately a single self-contained document served as a string: no build
 * step, no bundler entry, no static-file plugin, and nothing that could be picked up
 * by the web workspace's Vite build. It is registered only when CLOUD_ADMIN_TOKEN is
 * configured, alongside the rest of the admin surface.
 *
 * The page holds no authority. The token is entered by the operator and kept in
 * sessionStorage; every number shown comes from a token-authenticated request, and
 * the server re-derives and re-checks the entire wave-2 checklist inside the unlock
 * transaction. A disabled button here is a convenience, never a control.
 */
export const ADMIN_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>LiteTavern Cloud Alpha 名额管理</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 24px;
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1c1f23;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #14161a; color: #e6e8eb; }
    .card { background: #1c1f24; border-color: #2c3138; }
    th { background: #22262c; }
    input { background: #14161a; color: inherit; border-color: #2c3138; }
  }
  h1 { font-size: 20px; margin: 0 0 20px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  .card {
    background: #fff; border: 1px solid #e2e5ea; border-radius: 10px;
    padding: 16px; margin-bottom: 16px; max-width: 1100px;
  }
  label { display: block; margin-bottom: 6px; font-weight: 600; }
  input {
    padding: 7px 10px; border: 1px solid #cbd1d9; border-radius: 6px;
    min-width: 320px; font: inherit;
  }
  button {
    padding: 7px 14px; border: 1px solid #cbd1d9; border-radius: 6px;
    background: #fff; color: inherit; font: inherit; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: not-allowed; }
  button.danger { border-color: #c0392b; color: #c0392b; }
  .grid {
    display: grid; gap: 10px 20px;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); margin: 0;
  }
  .grid dt { font-size: 12px; opacity: .7; }
  .grid dd { margin: 2px 0 0; font-size: 17px; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #e2e5ea; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f2f4f7; font-weight: 600; }
  tr.pass td:nth-child(4) { color: #1e8449; font-weight: 600; }
  tr.fail td:nth-child(4) { color: #c0392b; font-weight: 600; }
  small { opacity: .72; }
  .reason { margin: 4px 0 0; color: #c0392b; }
  .note { font-size: 12px; opacity: .8; margin: 12px 0 0; }
  .error { color: #c0392b; font-weight: 600; }
  .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  .reasons { color: #c0392b; font-size: 13px; margin: 10px 0 0; padding-left: 20px; }
  code { font-size: 12px; }
  @media (max-width: 720px) { table { display: block; overflow-x: auto; } }
</style>
</head>
<body>
<h1>LiteTavern Cloud Alpha 名额管理</h1>

<section class="card">
  <label for="token">管理员令牌</label>
  <input id="token" type="password" placeholder="CLOUD_ADMIN_TOKEN" autocomplete="off" />
  <button id="load">加载</button>
</section>

<p id="error" class="error" role="alert" hidden></p>
<div id="body"></div>

<script>
(function () {
  var KEY = 'litetavern.alpha.admin.token';
  var HEADER = 'x-litetavern-admin-token';
  var tokenInput = document.getElementById('token');
  var errorBox = document.getElementById('error');
  var body = document.getElementById('body');
  var busy = false;

  tokenInput.value = sessionStorage.getItem(KEY) || '';
  tokenInput.addEventListener('input', function () {
    sessionStorage.setItem(KEY, tokenInput.value);
  });
  document.getElementById('load').addEventListener('click', load);

  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function fail(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function request(path, init) {
    var options = init || {};
    var headers = {};
    headers[HEADER] = tokenInput.value;
    if (options.body) headers['content-type'] = 'application/json';
    return fetch(path, {
      method: options.method || 'GET',
      body: options.body,
      credentials: 'include',
      headers: headers
    }).then(function (response) {
      return response.json().then(function (payload) {
        if (!response.ok) {
          throw new Error(
            (payload && payload.error && payload.error.message) ||
              '请求失败（' + response.status + '）'
          );
        }
        return payload;
      });
    });
  }

  function load() {
    if (!tokenInput.value) return;
    errorBox.hidden = true;
    return Promise.all([
      request('/v1/cloud/admin/alpha/overview'),
      request('/v1/cloud/admin/alpha/readiness'),
      request('/v1/cloud/admin/waitlist?limit=50')
    ])
      .then(function (results) {
        render(results[0].overview, results[1].readiness, results[2].waitlist || []);
      })
      .catch(function (reason) {
        body.innerHTML = '';
        fail(reason.message || '加载失败。');
      });
  }

  function act(path, confirmText) {
    if (busy || !window.confirm(confirmText)) return;
    busy = true;
    errorBox.hidden = true;
    request(path, { method: 'POST', body: '{}' })
      .then(load)
      .catch(function (reason) { fail(reason.message || '操作失败。'); })
      .then(function () { busy = false; });
  }

  function render(overview, readiness, waitlist) {
    var plan = overview.plan;
    var seats = overview.seats;
    var cost = overview.cost;

    var stats = [
      ['总席位', plan.total_capacity],
      ['已释放席位', plan.released_capacity],
      ['已分配有效席位', seats.assigned],
      ['剩余可分配', seats.remaining],
      ['当前批次', '第 ' + plan.current_batch_no + ' 批'],
      ['第一批 / 第二批',
        plan.batch_1_capacity + '（已释放） / ' + plan.batch_2_capacity +
        '（' + (plan.batch_2_unlocked ? '已解锁' : '未解锁') + '）'],
      ['候补人数', seats.waitlist],
      ['已获资格未激活', seats.granted_not_activated],
      ['已激活', seats.activated],
      ['暂停 / 结束', seats.suspended + ' / ' + seats.ended],
      ['有效测试者', overview.effective_testers],
      ['连续稳定核心会话', overview.stable_core_sessions],
      ['未解决阻断问题', overview.unresolved_blockers],
      ['未完成处置反馈', overview.outstanding_feedback],
      ['第一批累计成本', '$' + cost.batch_1_cost_usd],
      ['单个有效测试者平均成本', '$' + cost.average_cost_per_effective_tester_usd],
      ['近期模型失败率',
        (cost.recent_model_failure_rate * 100).toFixed(2) + '%（' +
        cost.recent_model_requests + ' 次调用）']
    ];

    var html = '<section class="card"><h2>Alpha 总览</h2><dl class="grid">';
    stats.forEach(function (row) {
      html += '<div><dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd></div>';
    });
    html += '</dl>';
    if (cost.provider_incidents && cost.provider_incidents.length) {
      html += '<p class="note">Provider 异常：' + cost.provider_incidents.map(function (i) {
        return esc(i.provider) + ' 失败 ' + i.failures + ' 次、限流 ' + i.rate_limited + ' 次';
      }).join('；') + '</p>';
    }
    html += '</section>';

    html += '<section class="card"><h2>第二批放量检查</h2><table><thead><tr>' +
      '<th>检查项</th><th>当前值</th><th>要求值</th><th>是否通过</th>' +
      '<th>证据 / 未通过原因</th></tr></thead><tbody>';
    readiness.checks.forEach(function (check) {
      html += '<tr class="' + (check.passed ? 'pass' : 'fail') + '">' +
        '<td>' + esc(check.label) +
        (check.automatable ? '' : ' <small>（无法自动验证，需人工确认）</small>') + '</td>' +
        '<td>' + esc(check.actual) + '</td>' +
        '<td>' + esc(check.required) + '</td>' +
        '<td>' + (check.passed ? '通过' : '未通过') + '</td>' +
        '<td><small>' + esc(check.evidence) + '</small>' +
        (check.reason ? '<p class="reason">' + esc(check.reason) + '</p>' : '') +
        '</td></tr>';
    });
    html += '</tbody></table><div class="actions">' +
      '<button id="confirm"' + (readiness.already_unlocked ? ' disabled' : '') + '>' +
      '确认成本与处理能力可控</button>' +
      '<button id="unlock" class="danger"' +
      (readiness.can_unlock && !readiness.already_unlocked ? '' : ' disabled') + '>' +
      (readiness.already_unlocked ? '第二批已解锁' : '解锁第二批') + '</button></div>';
    if (!readiness.can_unlock && !readiness.already_unlocked) {
      html += '<ul class="reasons">' + readiness.blocking_reasons.map(function (reason) {
        return '<li>' + esc(reason) + '</li>';
      }).join('') + '</ul>';
    }
    html += '<p class="note">解锁只提高席位上限，不会自动给候补用户发放资格；' +
      '发放仍由管理员按候补优先级确认。</p></section>';

    if (waitlist.length) {
      html += '<section class="card"><h2>候补队列（系统排序）</h2><table><thead><tr>' +
        '<th>#</th><th>用户</th><th>申请时间</th><th>优先标记</th>' +
        '</tr></thead><tbody>';
      waitlist.forEach(function (entry) {
        html += '<tr><td>' + esc(entry.rank) + '</td>' +
          '<td><code>' + esc(entry.userId) + '</code></td>' +
          '<td>' + (entry.joinedAt
            ? esc(new Date(entry.joinedAt).toLocaleString('zh-CN')) : '—') + '</td>' +
          '<td>' + (entry.foundingSupporter ? 'Founding Supporter' : '—') + '</td></tr>';
      });
      html += '</tbody></table></section>';
    }

    body.innerHTML = html;

    document.getElementById('confirm').addEventListener('click', function () {
      act('/v1/cloud/admin/alpha/readiness/confirm',
        '确认当前成本、Provider 状态与反馈积压可控？此确认会记录操作人、时间和当时的指标快照。');
    });
    document.getElementById('unlock').addEventListener('click', function () {
      act('/v1/cloud/admin/alpha/batch-2/unlock',
        '解锁第二批 20 个名额？已释放席位将从 10 变为 30。解锁后仍需按候补优先级手动发放资格。');
    });
  }

  if (tokenInput.value) load();
})();
</script>
</body>
</html>
`;
