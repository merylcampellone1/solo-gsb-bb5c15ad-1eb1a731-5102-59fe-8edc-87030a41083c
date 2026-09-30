'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  scripts: [],
  script: null,        // 稿件详情
  branchId: null,
  branch: null,        // 当前分支数据
  sourceBySeq: new Map()
};

// ---------------- 工具 ----------------

async function api(url, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const resp = await fetch(url, opts);
  const ct = resp.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await resp.json() : await resp.text();
  if (!resp.ok) {
    const err = new Error((data && data.error) || `请求失败 (${resp.status})`);
    err.data = data;
    err.status = resp.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function msToTc(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const x = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${x}`;
}

function tcToMs(tc) {
  const m = /^(\d{1,2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(tc.trim());
  if (!m) return NaN;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + (+m[4]);
}

// ---------------- 稿件列表 ----------------

async function loadScripts(selectId) {
  state.scripts = await api('/api/scripts');
  const ul = $('#scriptList');
  ul.innerHTML = '';
  if (!state.scripts.length) {
    ul.innerHTML = '<li class="s-meta" style="cursor:default">暂无稿件</li>';
  }
  for (const s of state.scripts) {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    li.innerHTML = `<div class="s-name">${esc(s.name)}</div>
      <div class="s-meta">${s.segment_count} 片段 · ${s.branch_count} 分支</div>`;
    li.onclick = () => openScript(s.id);
    ul.appendChild(li);
  }
  if (selectId) highlightScript(selectId);
}

function highlightScript(id) {
  $$('#scriptList li').forEach((li) => li.classList.toggle('active', String(li.dataset.id) === String(id)));
}

async function openScript(id) {
  state.script = await api(`/api/scripts/${id}`);
  state.sourceBySeq = new Map(state.script.sources.map((s) => [s.seq, s]));
  $('#emptyHint').hidden = true;
  $('#workspace').hidden = false;
  $('#scriptTitle').textContent = state.script.name;
  $('#scriptMeta').textContent = `创建于 ${state.script.created_at} · ${state.script.sources.length} 个来源片段`;
  $('#btnDownloadOriginal').href = `/api/scripts/${id}/original.srt`;
  highlightScript(id);
  renderTabs();
  const first = state.script.branches[0];
  if (first) await selectBranch(first.id);
}

// ---------------- 分支 Tabs ----------------

function renderTabs() {
  const tabs = $('#branchTabs');
  tabs.innerHTML = '';
  state.script.branches.forEach((b) => {
    const btn = document.createElement('button');
    btn.dataset.id = b.id;
    btn.innerHTML = `${esc(b.name)}<span class="kind-tag">${b.kind === 'merged' ? '合并结果' : '修订'}</span>`;
    btn.onclick = () => selectBranch(b.id);
    tabs.appendChild(btn);
  });
  $$('#branchTabs button').forEach((b) =>
    b.classList.toggle('active', String(b.dataset.id) === String(state.branchId)));
}

async function selectBranch(id) {
  state.branchId = id;
  state.branch = await api(`/api/branches/${id}`);
  renderTabs();
  renderEditor();
}

// ---------------- 编辑器 ----------------

function isChanged(seg) {
  const seqs = seg.source_ids.map((sid) => sourceSeqOfId(sid)).filter((x) => x != null);
  if (!seqs.length) return true;
  if (seqs.length > 1) return true; // 合并产生
  const src = state.sourceBySeq.get(seqs[0]);
  if (!src) return true;
  if (seg.source_ids.length > 1) return true;
  return seg.start_ms !== src.start_ms || seg.end_ms !== src.end_ms || seg.text !== src.text;
}

function sourceSeqOfId(sourceId) {
  for (const [seq, s] of state.sourceBySeq) if (s.id === sourceId) return seq;
  return null;
}

function renderEditor() {
  const editor = $('#editor');
  const b = state.branch;
  let html = `
    <div class="branch-toolbar">
      <input type="text" id="branchName" value="${esc(b.name)}" style="width:200px">
      <button id="btnRename">重命名</button>
      <span class="spacer"></span>
      <button id="btnQcReport" class="primary">放映质检报告</button>
      <button id="btnQcDownload">质检专用下载</button>
      <button id="btnValidate">导出前检查</button>
      <button id="btnResetAll">整条重置为原稿</button>
      <a class="btn" id="btnExport" href="/api/branches/${b.id}/export" download>导出 SRT</a>
    </div>
    <div id="validateResult"></div>
    <div id="qcReport"></div>
    <table class="seg-table">
      <thead><tr>
        <th class="col-ord">#</th><th class="col-src">来源片段</th><th>文案</th><th class="col-time">起止时间</th><th class="col-ops">操作</th>
      </tr></thead>
      <tbody>`;

  b.segments.forEach((seg, idx) => {
    const seqs = seg.source_ids.map(sourceSeqOfId).filter((x) => x != null).sort((a, c) => a - c);
    const tags = seqs.length
      ? seqs.map((q) => `<span class="src-tag">原稿 #${q}</span>`).join('')
      : '<span class="src-tag">无来源</span>';
    const changed = isChanged(seg) ? '<span class="changed-dot">● 已改</span>' : '';
    html += `
      <tr data-id="${seg.id}">
        <td class="col-ord">${seg.ord}</td>
        <td class="col-src">${tags}${changed}</td>
        <td><textarea rows="2" data-field="text">${esc(seg.text)}</textarea></td>
        <td class="col-time">
          <div class="time-row">
            <input type="text" data-field="start_ms" value="${msToTc(seg.start_ms)}">
            <span class="arrow">→</span>
            <input type="text" data-field="end_ms" value="${msToTc(seg.end_ms)}">
          </div>
        </td>
        <td class="col-ops">
          <button data-act="save">保存</button>
          <button data-act="split">拆分</button>
          <button data-act="merge">与下条合并</button>
          <button data-act="reset" title="恢复为原稿">恢复原稿</button>
        </td>
      </tr>`;
  });
  html += '</tbody></table>';
  editor.innerHTML = html;

  $('#btnRename').onclick = renameBranch;
  $('#btnValidate').onclick = runValidate;
  $('#btnQcReport').onclick = loadQcReport;
  $('#btnQcDownload').onclick = qcDownload;
  $('#btnResetAll').onclick = resetAll;
  $('#btnExport').onclick = (e) => {
    // 导出失败时服务器返回 409 JSON，阻止浏览器直接打开错误页
    e.preventDefault();
    exportSrt();
  };

  $$('#editor tbody tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    tr.querySelector('[data-act=save]').onclick = () => saveSegment(tr, id);
    tr.querySelector('[data-act=split]').onclick = () => splitSegment(id);
    tr.querySelector('[data-act=merge]').onclick = () => mergeWithNext(id);
    tr.querySelector('[data-act=reset]').onclick = () => resetSegment(id);
  });
}

async function renameBranch() {
  const name = $('#branchName').value.trim();
  if (!name) return toast('分支名称不能为空', 'error');
  await api(`/api/branches/${state.branchId}`, { method: 'PATCH', body: { name } });
  toast('已重命名', 'ok');
  await loadScripts(state.script.id);
  state.script = await api(`/api/scripts/${state.script.id}`);
  renderTabs();
}

async function saveSegment(tr, id) {
  const start = tcToMs(tr.querySelector('[data-field=start_ms]').value);
  const end = tcToMs(tr.querySelector('[data-field=end_ms]').value);
  const text = tr.querySelector('[data-field=text]').value;
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return toast('时间码格式应为 HH:MM:SS,mmm', 'error');
  }
  if (start < 0 || end < 0) return toast('时间不能为负', 'error');
  if (start >= end) return toast('起点必须早于终点', 'error');
  try {
    await api(`/api/branches/${state.branchId}/segments/${id}`, {
      method: 'PATCH', body: { start_ms: start, end_ms: end, text }
    });
    toast('片段已保存', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function splitSegment(id) {
  const seg = state.branch.segments.find((s) => s.id === id);
  const input = prompt(
    `在何处拆分？输入切点时间码（严格位于 ${msToTc(seg.start_ms)} 与 ${msToTc(seg.end_ms)} 之间）`,
    msToTc(Math.floor((seg.start_ms + seg.end_ms) / 2))
  );
  if (input === null) return;
  const cut = tcToMs(input);
  if (Number.isNaN(cut)) return toast('时间码格式应为 HH:MM:SS,mmm', 'error');
  try {
    await api(`/api/branches/${state.branchId}/segments/${id}/split`, {
      method: 'POST', body: { cut_ms: cut }
    });
    toast('已拆分', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function mergeWithNext(id) {
  if (!confirm('确定与下一片段合并？时间取外边界，文案用空格连接（之后可再编辑）。')) return;
  try {
    await api(`/api/branches/${state.branchId}/segments/${id}/merge-with-next`, {
      method: 'POST', body: {}
    });
    toast('已合并', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function resetSegment(id) {
  if (!confirm('将该片段恢复为原稿内容与时间？')) return;
  try {
    await api(`/api/branches/${state.branchId}/segments/${id}/reset`, { method: 'POST' });
    toast('已恢复原稿', 'ok');
    await selectBranch(state.branchId);
  } catch (e) { toast(e.message, 'error'); }
}

async function resetAll() {
  if (state.branch.kind === 'merged') return toast('合并结果分支不可整体重置', 'error');
  if (!confirm('整条分支重置回原稿？当前分支的全部修改将丢失。')) return;
  await api(`/api/branches/${state.branchId}/reset-all`, { method: 'POST' });
  toast('已重置为原稿', 'ok');
  await selectBranch(state.branchId);
}

// ---------------- 导出检查 ----------------

async function runValidate() {
  const result = await api(`/api/branches/${state.branchId}/validate`);
  const box = $('#validateResult');
  if (result.ok) {
    box.innerHTML = '<div class="validate-ok">✓ 检查通过：时间非负、起点均早于终点、片段互不重叠，可以导出。</div>';
  } else {
    box.innerHTML = `<div class="validate-bad">✗ 发现 ${result.issues.length} 处问题（修复前无法导出）：</div>
      <ul class="issue-list">${result.issues.map((i) =>
        `<li>${i.ord ? `片段 #${i.ord}：` : ''}${esc(i.message)}</li>`).join('')}</ul>`;
  }
}

async function exportSrt() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/export`);
    if (!resp.ok) {
      const data = await resp.json();
      const list = (data.issues || []).map((i) => `${i.ord ? `片段 #${i.ord}：` : ''}${i.message}`).join('\n');
      return toast(`导出被阻止：${data.error}${list ? '\n' + list : ''}`, 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'export.srt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已导出 SRT', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 导入 ----------------

$('#btnImport').onclick = () => {
  $('#formImport').reset();
  $('#importErrors').hidden = true;
  $('#dlgImport').showModal();
};
$('#importCancel').onclick = () => $('#dlgImport').close();

$('#importSubmit').onclick = async () => {
  const fileInput = $('#importFile');
  if (!fileInput.files.length) return toast('请选择 .srt 文件', 'error');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  if ($('#importName').value.trim()) fd.append('name', $('#importName').value.trim());
  try {
    const created = await api('/api/scripts', { method: 'POST', body: fd });
    $('#dlgImport').close();
    toast(`导入成功：${created.segment_count} 个片段，已建立两条修订分支`, 'ok');
    await loadScripts(created.id);
    await openScript(created.id);
  } catch (e) {
    const box = $('#importErrors');
    const errs = (e.data && e.data.errors) || [];
    box.innerHTML = `<div><b>${esc(e.message)}</b></div>` +
      (errs.length ? `<ul class="issue-list">${errs.map((x) =>
        `<li><span class="e-line">第 ${x.line} 行</span>：${esc(x.message)}</li>`).join('')}</ul>` : '');
    box.hidden = false;
  }
};

// ---------------- 原稿查看 ----------------

$('#btnViewOriginal').onclick = async () => {
  const text = await api(`/api/scripts/${state.script.id}/original`);
  $('#originalText').textContent = text;
  $('#dlgOriginal').showModal();
};
$('#originalClose').onclick = () => $('#dlgOriginal').close();

// ---------------- 删除稿件 ----------------

$('#btnDeleteScript').onclick = async () => {
  if (!confirm(`确定删除稿件「${state.script.name}」及其所有分支？此操作不可恢复。`)) return;
  await api(`/api/scripts/${state.script.id}`, { method: 'DELETE' });
  state.script = null;
  state.branch = null;
  $('#workspace').hidden = true;
  $('#emptyHint').hidden = false;
  await loadScripts();
  toast('已删除', 'ok');
};

// ---------------- 合并 ----------------

let mergeState = null; // { entries, choices: Map }

$('#btnMerge').onclick = async () => {
  const revisions = state.script.branches;
  if (revisions.length < 2) return toast('至少需要两条分支', 'error');
  const aId = revisions[0].id;
  const bId = revisions[1].id;
  try {
    const preview = await api('/api/merge/preview', {
      method: 'POST', body: { branch_a_id: aId, branch_b_id: bId }
    });
    mergeState = preview;
    renderMergeDialog();
    $('#dlgMerge').showModal();
  } catch (e) { toast(e.message, 'error'); }
};
$('#mergeCancel').onclick = () => $('#dlgMerge').close();

function renderMergeDialog() {
  const p = mergeState;
  const conflicts = p.entries.filter((e) => e.type === 'conflict');
  p.choices = new Map();

  $('#mergeSummary').innerHTML = `合并 <b>${esc(p.branch_a.name)}</b> 与 <b>${esc(p.branch_b.name)}</b>：
    共 ${p.entries.length} 组来源区间，其中
    <span style="color:var(--conflict)">${p.conflictCount} 处冲突</span>
    需要你逐处选择，其余改动自动保留。`;

  const wrap = $('#mergeEntries');
  wrap.innerHTML = '';
  p.entries.forEach((e) => wrap.appendChild(renderMergeEntry(e)));
  updateMergeSubmit();
}

function renderSegMini(seg) {
  return `<div class="cc-seg">
    <div class="t">${msToTc(seg.start_ms)} → ${msToTc(seg.end_ms)}</div>
    <div>${esc(seg.text).replace(/\n/g, '<br>')}</div>
  </div>`;
}

function renderMergeEntry(e) {
  const div = document.createElement('div');
  const srcLabel = e.source_start === e.source_end
    ? `来源片段 #${e.source_start}`
    : `来源片段 #${e.source_start}–#${e.source_end}`;

  if (e.type === 'conflict') {
    div.className = 'merge-entry conflict';
    div.innerHTML = `
      <div class="me-head"><span>${srcLabel}</span><span class="badge conflict">冲突：双方都修改，必须选择</span></div>
      <div class="me-body">
        <div class="conflict-choice">
          <div class="choice-card" data-side="A">
            <div class="cc-title">采用 A：${esc(e.side_a.branch_name)}（${e.side_a.segments.length} 片段）</div>
            ${e.side_a.segments.map(renderSegMini).join('')}
          </div>
          <div class="choice-card" data-side="B">
            <div class="cc-title">采用 B：${esc(e.side_b.branch_name)}（${e.side_b.segments.length} 片段）</div>
            ${e.side_b.segments.map(renderSegMini).join('')}
          </div>
        </div>
      </div>`;
    div.querySelectorAll('.choice-card').forEach((card) => {
      card.onclick = () => {
        mergeState.choices.set(e.conflict_index, card.dataset.side);
        div.querySelectorAll('.choice-card').forEach((c) =>
          c.classList.toggle('selected', c === card));
        updateMergeSubmit();
      };
    });
  } else {
    const map = {
      unchanged: ['未改动，保留原稿', 'keep'],
      a_only: [`仅 A 修改，自动保留（${esc(mergeState.branch_a.name)}）`, 'a'],
      b_only: [`仅 B 修改，自动保留（${esc(mergeState.branch_b.name)}）`, 'b']
    };
    const [label, cls] = map[e.type];
    div.className = 'merge-entry';
    div.innerHTML = `
      <div class="me-head"><span>${srcLabel}</span><span class="badge ${cls}">${label}</span></div>
      <div class="me-body">${e.segments.map(renderSegMini).join('')}</div>`;
  }
  return div;
}

function updateMergeSubmit() {
  const total = mergeState.conflictCount;
  const chosen = mergeState.choices.size;
  const btn = $('#mergeSubmit');
  btn.disabled = chosen !== total;
  btn.textContent = total === 0
    ? '无冲突，生成合并分支'
    : `已选择 ${chosen}/${total} 处冲突，生成合并分支`;
}

$('#mergeSubmit').onclick = async () => {
  const resolutions = {};
  for (const [k, v] of mergeState.choices) resolutions[k] = v;
  try {
    const result = await api('/api/merge/apply', {
      method: 'POST',
      body: {
        branch_a_id: mergeState.branch_a.id,
        branch_b_id: mergeState.branch_b.id,
        resolutions,
        merged_name: `合并（${mergeState.branch_a.name} × ${mergeState.branch_b.name}）`
      }
    });
    $('#dlgMerge').close();
    toast(`合并分支「${result.name}」已生成`, 'ok');
    await loadScripts(state.script.id);
    await openScript(state.script.id);
    await selectBranch(result.id);
  } catch (e) { toast(e.message, 'error'); }
};

// ---------------- 放映质检 ----------------

const RULE_LABELS = {
  duration_min: '显示时长低于下限',
  duration_max: '显示时长超过上限',
  cps: '每秒字符数超限',
  gap: '相邻片段间隔不足',
  banned: '禁用词'
};

let qcReportData = null;
let exemptTarget = null; // {branch_segment_id, rule_code, detail}

function secFromMs(ms) {
  return `${(ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}s`;
}

function rulesSummary(r) {
  if (!r) return '尚未配置';
  const parts = [];
  if (r.min_duration_ms != null) parts.push(`时长≥${secFromMs(r.min_duration_ms)}`);
  if (r.max_duration_ms != null) parts.push(`时长≤${secFromMs(r.max_duration_ms)}`);
  if (r.max_cps != null) parts.push(`CPS≤${r.max_cps}`);
  if (r.min_gap_ms != null) parts.push(`间隔≥${secFromMs(r.min_gap_ms)}`);
  if (r.banned_words && r.banned_words.length) parts.push(`禁用词 ${r.banned_words.length} 个`);
  return parts.join(' · ') || '空配置';
}

// --- 质检规则对话框 ---

$('#btnQcRules').onclick = async () => {
  $('#qcRuleErrors').hidden = true;
  $('#dlgQcRules').showModal();
  try {
    const data = await api(`/api/scripts/${state.script.id}/qc-rules`);
    const r = data.rules;
    $('#qcMinDur').value = r && r.min_duration_ms != null ? r.min_duration_ms / 1000 : '';
    $('#qcMaxDur').value = r && r.max_duration_ms != null ? r.max_duration_ms / 1000 : '';
    $('#qcMaxCps').value = r && r.max_cps != null ? r.max_cps : '';
    $('#qcMinGap').value = r && r.min_gap_ms != null ? r.min_gap_ms / 1000 : '';
    $('#qcBanned').value = r && r.banned_words ? r.banned_words.join('，') : '';
    $('#qcRuleMeta').textContent = r
      ? `当前为规则版本 v${r.version}。仅当规则内容真正改变时才会升版本。`
      : '该稿件尚未配置质检规则。';
  } catch (e) { toast(e.message, 'error'); }
};
$('#qcRulesCancel').onclick = () => $('#dlgQcRules').close();

$('#qcRulesSave').onclick = async () => {
  const numOrNull = (el) => {
    const v = el.value.trim();
    return v === '' ? null : Number(v);
  };
  const words = $('#qcBanned').value
    .split(/[,，、\n]/)
    .map((w) => w.trim())
    .filter((w) => w !== '');
  const body = {
    min_duration: numOrNull($('#qcMinDur')),
    max_duration: numOrNull($('#qcMaxDur')),
    max_cps: numOrNull($('#qcMaxCps')),
    min_gap: numOrNull($('#qcMinGap')),
    banned_words: words
  };
  const box = $('#qcRuleErrors');
  try {
    const result = await api(`/api/scripts/${state.script.id}/qc-rules`, { method: 'PUT', body });
    $('#dlgQcRules').close();
    toast(`质检规则已保存（v${result.version}${result.changed ? '，已升版本，旧豁免失效' : '，内容未变'}）`, 'ok');
    if (qcReportData) loadQcReport();
  } catch (e) {
    const errs = (e.data && e.data.errors) || [];
    box.innerHTML = `<div><b>${esc(e.message)}</b></div>` +
      (errs.length ? `<ul class="issue-list">${errs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
    box.hidden = false;
  }
};

// --- 质检报告 ---

async function loadQcReport() {
  try {
    qcReportData = await api(`/api/branches/${state.branchId}/qc-report`);
    renderQcReport();
  } catch (e) { toast(e.message, 'error'); }
}

function renderQcReport() {
  const box = $('#qcReport');
  const r = qcReportData;
  if (!r.configured) {
    box.innerHTML = `<div class="qc-panel">
      <div class="qc-head">放映质检报告</div>
      <div class="validate-bad">✗ 该稿件尚未配置质检规则，请先点击右上角「质检规则」。</div>
    </div>`;
    return;
  }

  const s = r.summary;
  const statusCls = s.exportable ? 'qc-ok' : 'qc-bad';
  const statusText = s.exportable
    ? '✓ 质检通过：无未豁免命中、时间线无错误，可以使用「质检专用下载」。'
    : `✗ 尚不能质检下载：${s.unresolved} 条未豁免命中，${s.timeline_errors} 处时间线错误。`;

  const hits = r.hits.length
    ? `<table class="qc-table">
        <thead><tr><th>片段 #</th><th>原稿来源</th><th>规则</th><th>时间码</th><th>命中原因</th><th class="col-ex">豁免状态</th></tr></thead>
        <tbody>${r.hits.map(renderQcHitRow).join('')}</tbody>
      </table>`
    : '<div class="validate-ok">未命中任何质检规则。</div>';

  const timeline = r.timeline_issues.length
    ? `<div class="qc-sub qc-bad">时间线错误（${r.timeline_issues.length}）：</div>
       <ul class="issue-list">${r.timeline_issues.map((i) =>
         `<li>${i.ord ? `片段 #${i.ord}：` : ''}${esc(i.message)}</li>`).join('')}</ul>`
    : '<div class="qc-sub validate-ok">时间线检查通过。</div>';

  const orphans = r.orphan_exemptions.length
    ? `<div class="qc-sub">失效/无对应命中的历史豁免（${r.orphan_exemptions.length}）：</div>
       <ul class="qc-orphan-list">${r.orphan_exemptions.map(renderOrphan).join('')}</ul>`
    : '';

  box.innerHTML = `<div class="qc-panel">
    <div class="qc-head">
      <span>放映质检报告（规则版本 v${r.rule_version}，按当前文字与时码实时生成）</span>
      <span class="qc-rules">${esc(rulesSummary(r.rules))}</span>
    </div>
    <div class="${statusCls}">${statusText}</div>
    <div class="qc-sub ${s.hit_count ? 'qc-bad' : 'validate-ok'}">规则命中（${s.hit_count}，其中 ${s.active_exemptions} 条已豁免）：</div>
    ${hits}
    ${timeline}
    ${orphans}
    <div class="qc-tip">提示：片段被编辑、拆分或合并后报告会重新评估，旧豁免对变化后的片段自动失效；合并产生的新分支需重新质检与豁免。</div>
  </div>`;

  box.querySelectorAll('[data-exempt]').forEach((btn) => {
    btn.onclick = () => {
      const hit = qcReportData.hits[Number(btn.dataset.exempt)];
      exemptTarget = {
        branch_segment_id: hit.branch_segment_id,
        rule_code: hit.rule_code,
        detail: hit.detail
      };
      $('#exemptHitInfo').innerHTML =
        `<div><b>${esc(RULE_LABELS[hit.rule_code])}</b> · 片段 #${hit.ord} · ${msToTc(hit.start_ms)} → ${msToTc(hit.end_ms)}</div>
         <div class="qc-hit-msg">${esc(hit.message)}</div>`;
      $('#exemptReason').value = '';
      $('#dlgExempt').showModal();
    };
  });
  box.querySelectorAll('[data-revoke]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('撤销该豁免？撤销后此条命中将重新计入未豁免项。')) return;
      try {
        await api(`/api/qc-exemptions/${Number(btn.dataset.revoke)}/revoke`, { method: 'POST' });
        toast('已撤销豁免', 'ok');
        await loadQcReport();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

function renderQcHitRow(h, idx) {
  const src = h.source_seqs.length
    ? h.source_seqs.map((q) => `#${q}`).join(',')
    : '无';
  let exCell;
  if (h.exemption && h.exemption.status === 'active') {
    exCell = `<div class="ex-badge active">✓ 已豁免（v${h.exemption.rule_version}）</div>
      <div class="ex-reason">${esc(h.exemption.reason)}</div>
      <button data-revoke="${h.exemption.id}" class="ex-btn">撤销豁免</button>`;
  } else if (h.exemption) {
    exCell = `<div class="ex-badge dead">豁免已失效（内容/时码或规则版本已变）</div>
      <div class="ex-reason">原理由：${esc(h.exemption.reason)}</div>
      <button data-exempt="${idx}" class="ex-btn">重新豁免</button>
      <button data-revoke="${h.exemption.id}" class="ex-btn">删除旧豁免</button>`;
  } else {
    exCell = `<button data-exempt="${idx}" class="ex-btn">填写理由豁免</button>`;
  }
  return `<tr${h.exemption && h.exemption.status === 'active' ? ' class="row-exempted"' : ''}>
    <td>${h.ord}</td>
    <td>${src}</td>
    <td>${esc(RULE_LABELS[h.rule_code])}</td>
    <td class="qc-tc">${msToTc(h.start_ms)}<br>→ ${msToTc(h.end_ms)}</td>
    <td>${esc(h.message)}</td>
    <td class="col-ex">${exCell}</td>
  </tr>`;
}

function renderOrphan(ex) {
  const ruleLabel = RULE_LABELS[ex.rule_code] || ex.rule_code;
  const detail = ex.word ? `「${esc(ex.word)}」` : '';
  return `<li>片段 id ${ex.branch_segment_id} · ${ruleLabel}${detail}
    · 原理由：${esc(ex.reason)} · 豁免于 v${ex.rule_version}
    <button data-revoke="${ex.id}" class="ex-btn">删除</button></li>`;
}

$('#exemptCancel').onclick = () => $('#dlgExempt').close();
$('#exemptSubmit').onclick = async () => {
  const reason = $('#exemptReason').value.trim();
  if (!reason) return toast('请填写豁免理由', 'error');
  try {
    await api(`/api/branches/${state.branchId}/qc-exemptions`, {
      method: 'POST',
      body: { ...exemptTarget, reason }
    });
    $('#dlgExempt').close();
    toast('已豁免：仅对当前片段内容、时码与规则版本有效', 'ok');
    await loadQcReport();
  } catch (e) { toast(e.message, 'error'); }
};

// --- 质检专用下载（服务器重新核验：分支/规则/豁免/时间线） ---

async function qcDownload() {
  try {
    const resp = await fetch(`/api/branches/${state.branchId}/qc-download`);
    if (!resp.ok) {
      const data = await resp.json();
      let detail = '';
      const un = (data.unresolved || []).map((h) =>
        `片段 #${h.ord}（${RULE_LABELS[h.rule_code] || h.rule_code}）：${h.message}`);
      const is = (data.issues || []).map((i) => `${i.ord ? `片段 #${i.ord}：` : ''}${i.message}`);
      if (un.length) detail += `\n未豁免命中：\n${un.join('\n')}`;
      if (is.length) detail += `\n时间线错误：\n${is.join('\n')}`;
      return toast(`质检下载被阻止：${data.error}${detail}`, 'error');
    }
    const blob = await resp.blob();
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = /filename\*=UTF-8''(.+)$/.exec(cd);
    const fname = m ? decodeURIComponent(m[1]) : 'qc-export.srt';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('质检通过，已下载 SRT', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------------- 启动 ----------------

loadScripts();
