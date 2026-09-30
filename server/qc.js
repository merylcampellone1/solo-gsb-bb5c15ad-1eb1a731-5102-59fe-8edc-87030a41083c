'use strict';

// 放映质检引擎
//
// 规则（按秒为单位配置，内部按毫秒存储）：
//   min_duration 单条显示时长下限（秒）
//   max_duration 单条显示时长上限（秒）
//   max_cps      每秒可见字符数上限
//   min_gap      相邻片段最小间隔（秒）
//   banned_words 禁用词数组
//
// 计字：空白不计字符，中文字符与标点各算一字（即每个非空白 Unicode 码点算 1）。
//
// 报告基于「当前」文字与时码实时生成；拆分/合并后片段身份变化，旧命中不沿用。
// 豁免通过保存当时的片段内容/时码（gap 还含上一条终点）与规则版本快照生效，
// 之后任一字段变化即判定失效。

const { msToSrt, validateTimeline } = require('./srt');

const MAX_DURATION_S = 86400; // 一天，仅用于拦截明显无效的阈值
const MAX_CPS = 1000;
const MAX_GAP_S = 86400;
const RULE_CODES = ['duration_min', 'duration_max', 'cps', 'gap', 'banned'];

// ---------------- 规则校验与存取 ----------------

function secLabel(ms) {
  return `${(ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} 秒`;
}

/**
 * 校验并归一化规则入参。
 * @param {object} body {min_duration, max_duration, max_cps, min_gap, banned_words}
 * @returns {{min_duration_ms:number|null, max_duration_ms:number|null, max_cps:number|null, min_gap_ms:number|null, banned_words:string[]}}
 * 任何无效阈值/空词/重复词都抛 400。
 */
function normalizeRules(body) {
  const errors = [];
  const out = {
    min_duration_ms: null,
    max_duration_ms: null,
    max_cps: null,
    min_gap_ms: null,
    banned_words: []
  };

  const readSec = (key, label, msKey, maxS, allowZero) => {
    if (body[key] === undefined || body[key] === null) return;
    const v = body[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${label}必须是数字（单位：秒）`);
      return;
    }
    if (v < 0 || (!allowZero && v === 0)) {
      errors.push(`${label}必须${allowZero ? '不小于' : '大于'} 0`);
      return;
    }
    if (v > maxS) {
      errors.push(`${label}超出允许范围（≤ ${maxS}）`);
      return;
    }
    // 毫秒取整后至少 1ms
    out[msKey] = Math.round(v * 1000);
  };

  readSec('min_duration', '单条显示时长下限', 'min_duration_ms', MAX_DURATION_S, false);
  readSec('max_duration', '单条显示时长上限', 'max_duration_ms', MAX_DURATION_S, false);
  readSec('min_gap', '相邻片段最小间隔', 'min_gap_ms', MAX_GAP_S, true);

  if (body.max_cps !== undefined && body.max_cps !== null) {
    const v = body.max_cps;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push('每秒可见字符数上限必须是数字');
    } else if (v <= 0) {
      errors.push('每秒可见字符数上限必须大于 0');
    } else if (v > MAX_CPS) {
      errors.push(`每秒可见字符数上限超出允许范围（≤ ${MAX_CPS}）`);
    } else {
      out.max_cps = Math.round(v * 1000) / 1000;
    }
  }

  if (out.min_duration_ms != null && out.max_duration_ms != null
      && out.min_duration_ms > out.max_duration_ms) {
    errors.push('单条显示时长下限不能大于上限');
  }

  if (body.banned_words !== undefined && body.banned_words !== null) {
    const list = body.banned_words;
    if (!Array.isArray(list)) {
      errors.push('禁用词必须是字符串数组');
    } else {
      const seen = new Set();
      for (const w of list) {
        if (typeof w !== 'string') {
          errors.push('禁用词必须是字符串数组');
          break;
        }
        const word = w.trim();
        if (!word) {
          errors.push('禁用词不能为空词');
          continue;
        }
        if (seen.has(word)) {
          errors.push(`禁用词重复：「${word}」`);
          continue;
        }
        seen.add(word);
        out.banned_words.push(word);
      }
    }
  }

  const hasAny = out.min_duration_ms != null || out.max_duration_ms != null
    || out.max_cps != null || out.min_gap_ms != null || out.banned_words.length > 0;
  if (!hasAny) errors.push('请至少配置一项质检规则（阈值或禁用词）');

  if (errors.length) {
    const err = new Error(`质检规则校验失败：${errors.join('；')}`);
    err.statusCode = 400;
    err.errors = errors;
    throw err;
  }
  return out;
}

function getRules(db, scriptId) {
  const row = db.prepare('SELECT * FROM qc_rules WHERE script_id = ?').get(scriptId);
  if (!row) return null;
  const banned_words = db.prepare(
    'SELECT word FROM qc_banned_words WHERE script_id = ? ORDER BY pos'
  ).all(scriptId).map((r) => r.word);
  return {
    version: row.version,
    min_duration_ms: row.min_duration_ms,
    max_duration_ms: row.max_duration_ms,
    max_cps: row.max_cps,
    min_gap_ms: row.min_gap_ms,
    banned_words
  };
}

function rulesEqual(r, norm) {
  return r.min_duration_ms === norm.min_duration_ms
    && r.max_duration_ms === norm.max_duration_ms
    && (r.max_cps == null ? norm.max_cps == null : Math.abs(r.max_cps - norm.max_cps) < 1e-9)
    && r.min_gap_ms === norm.min_gap_ms
    && r.banned_words.length === norm.banned_words.length
    && r.banned_words.every((w, i) => w === norm.banned_words[i]);
}

/**
 * 保存规则。实际内容发生变化时版本号 +1（旧豁免随即失效）；原样重复保存不升版。
 */
function saveRules(db, scriptId, norm) {
  return db.transaction(() => {
    const existing = getRules(db, scriptId);
    let version = existing ? existing.version : 1;
    let changed = !existing || !rulesEqual(existing, norm);
    if (!existing) {
      db.prepare(`
        INSERT INTO qc_rules (script_id, min_duration_ms, max_duration_ms, max_cps, min_gap_ms, version)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(scriptId, norm.min_duration_ms, norm.max_duration_ms, norm.max_cps, norm.min_gap_ms);
    } else if (changed) {
      version = existing.version + 1;
      db.prepare(`
        UPDATE qc_rules SET min_duration_ms = ?, max_duration_ms = ?, max_cps = ?,
                            min_gap_ms = ?, version = ?, updated_at = datetime('now')
        WHERE script_id = ?
      `).run(norm.min_duration_ms, norm.max_duration_ms, norm.max_cps, norm.min_gap_ms, version, scriptId);
    }
    if (changed || !existing) {
      db.prepare('DELETE FROM qc_banned_words WHERE script_id = ?').run(scriptId);
      const ins = db.prepare(
        'INSERT INTO qc_banned_words (script_id, pos, word) VALUES (?, ?, ?)'
      );
      norm.banned_words.forEach((w, i) => ins.run(scriptId, i, w));
    }
    return { version, changed };
  })();
}

// ---------------- 计字与命中评估 ----------------

/** 可见字符数：去掉所有空白后按 Unicode 码点计数（中文字符与标点各算一字）。 */
function visibleLength(text) {
  return Array.from(String(text).replace(/\s/g, '')).length;
}

/**
 * 对一条分支片段序列评估命中（不做豁免，只产生原始命中）。
 * @param segments getBranchSegments 结果（含 ord/start_ms/end_ms/text）
 * @param rules    getRules 结果
 * @param srcMap   Map<sourceId, seq> 用于标注原稿来源
 */
function evaluate(segments, rules, srcMap) {
  const hits = [];
  let prev = null;
  for (const seg of segments) {
    const dur = seg.end_ms - seg.start_ms;
    const source_seqs = (seg.source_ids || [])
      .map((id) => (srcMap ? srcMap.get(id) : null))
      .filter((s) => s != null)
      .sort((a, b) => a - b);
    const base = {
      branch_segment_id: seg.id,
      ord: seg.ord,
      start_ms: seg.start_ms,
      end_ms: seg.end_ms,
      text: seg.text,
      source_seqs,
      prev_end_ms: prev ? prev.end_ms : null
    };
    const push = (h) => hits.push({ ...base, ...h });

    // 时长上下限
    if (rules.min_duration_ms != null && dur < rules.min_duration_ms) {
      push({
        rule_code: 'duration_min',
        detail: 'duration',
        message: `显示时长仅 ${secLabel(dur)}，低于下限 ${secLabel(rules.min_duration_ms)}`
      });
    }
    if (rules.max_duration_ms != null && dur > rules.max_duration_ms) {
      push({
        rule_code: 'duration_max',
        detail: 'duration',
        message: `显示时长为 ${secLabel(dur)}，超过上限 ${secLabel(rules.max_duration_ms)}`
      });
    }

    // 每秒可见字符数（仅在时长为正时计算）
    if (rules.max_cps != null && dur > 0) {
      const n = visibleLength(seg.text);
      const cps = n / (dur / 1000);
      if (cps > rules.max_cps + 1e-9) {
        push({
          rule_code: 'cps',
          detail: 'cps',
          visible_chars: n,
          cps: Math.round(cps * 100) / 100,
          message: `每秒可见字符数约 ${cps.toFixed(2)}（${n} 字 / ${secLabel(dur)}），超过上限 ${rules.max_cps}`
        });
      }
    }

    // 相邻片段最小间隔（按 ord 相邻；间隔含负值，即重叠也必命中）
    if (rules.min_gap_ms != null && prev) {
      const gap = seg.start_ms - prev.end_ms;
      if (gap < rules.min_gap_ms) {
        const desc = gap < 0
          ? `与上一片段重叠 ${secLabel(-gap)}（上一条终点 ${msToSrt(prev.end_ms)}）`
          : `与上一条间隔仅 ${secLabel(gap)}（上一条终点 ${msToSrt(prev.end_ms)}）`;
        push({
          rule_code: 'gap',
          detail: 'gap',
          gap_ms: gap,
          prev_segment_id: prev.id,
          prev_ord: prev.ord,
          message: `${desc}，小于最小间隔 ${secLabel(rules.min_gap_ms)}`
        });
      }
    }

    // 禁用词
    for (const word of rules.banned_words) {
      if (seg.text.includes(word)) {
        push({
          rule_code: 'banned',
          detail: `word:${word}`,
          word,
          message: `包含禁用词「${word}」`
        });
      }
    }

    prev = seg;
  }
  return hits;
}

function exemptionStillValid(ex, hit) {
  return ex.rule_version === hit.rule_version
    && ex.snap_ord === hit.ord
    && ex.snap_start_ms === hit.start_ms
    && ex.snap_end_ms === hit.end_ms
    && ex.snap_text === hit.text
    && (ex.rule_code !== 'gap' || ex.snap_prev_end_ms === hit.prev_end_ms);
}

/**
 * 生成一份完整质检报告（当前文字与时码 + 最新规则）。
 * 同时回填豁免：命中槽位上若存在豁免，标注 active / invalidated；
 * 失效或无对应命中的豁免列入 orphan_exemptions，供界面展示与撤销。
 */
function buildReport(db, branch, srcMap) {
  const rules = getRules(db, branch.script_id);
  if (!rules) {
    return {
      configured: false,
      rule_version: null,
      rules: null,
      hits: [],
      timeline_issues: validateTimeline(branch.segments),
      orphan_exemptions: []
    };
  }

  const timelineIssues = validateTimeline(branch.segments);
  const rawHits = evaluate(branch.segments, rules, srcMap);

  const exRows = db.prepare(`
    SELECT * FROM qc_exemptions WHERE branch_id = ? ORDER BY id
  `).all(branch.id);
  const exBySlot = new Map();
  for (const ex of exRows) {
    const key = `${ex.branch_segment_id}|${ex.rule_code}|${ex.detail}`;
    exBySlot.set(key, ex);
  }

  const matchedIds = new Set();
  const hits = rawHits.map((h) => {
    h.rule_version = rules.version;
    const key = `${h.branch_segment_id}|${h.rule_code}|${h.detail}`;
    const ex = exBySlot.get(key);
    if (!ex) return { ...h, exemption: null };
    matchedIds.add(ex.id);
    if (exemptionStillValid(ex, h)) {
      return {
        ...h,
        exemption: {
          id: ex.id, reason: ex.reason, rule_version: ex.rule_version,
          created_at: ex.created_at, status: 'active'
        }
      };
    }
    return {
      ...h,
      exemption: {
        id: ex.id, reason: ex.reason, rule_version: ex.rule_version,
        created_at: ex.created_at, status: 'invalidated'
      }
    };
  });

  const orphanExemptions = exRows
    .filter((ex) => !matchedIds.has(ex.id))
    .map((ex) => ({
      id: ex.id, branch_segment_id: ex.branch_segment_id, rule_code: ex.rule_code,
      detail: ex.detail, word: ex.rule_code === 'banned' ? ex.detail.slice('word:'.length) : null,
      reason: ex.reason, rule_version: ex.rule_version, created_at: ex.created_at
    }));

  const activeCount = hits.filter((h) => h.exemption && h.exemption.status === 'active').length;
  return {
    configured: true,
    rule_version: rules.version,
    rules,
    hits,
    timeline_issues: timelineIssues,
    orphan_exemptions: orphanExemptions,
    summary: {
      hit_count: hits.length,
      active_exemptions: activeCount,
      unresolved: hits.length - activeCount,
      timeline_errors: timelineIssues.length,
      exportable: hits.length - activeCount === 0 && timelineIssues.length === 0
    }
  };
}

module.exports = {
  RULE_CODES,
  normalizeRules,
  getRules,
  saveRules,
  visibleLength,
  evaluate,
  buildReport,
  secLabel
};
