/**
 * 快捷键审校引擎
 * - 最近祖先规则：沿 contextId → parent 向上查找，最深层（最近祖先）的绑定生效
 * - 同层相同序列：重复绑定，双方均触发但标记 duplicate 冲突
 * - 前缀冲突：任一生效序列是另一生效序列的严格前缀时，双方标记 prefix 冲突
 * - 被更深层同序列覆盖的祖先绑定标记为 shadowed（不生效）
 */

const MAX_PRESSES = 3;

const MODIFIERS = new Set(['ctrl', 'alt', 'shift', 'meta']);

/**
 * 规范化单次按键（支持 Ctrl+K 这种组合键，算作“一次按键”）。
 * 返回 { ok, token, error }
 */
function canonicalPress(raw) {
  const segment = String(raw || '').trim().toLowerCase();
  if (!segment) return { ok: false, error: '空按键' };
  const parts = segment
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, error: '空按键' };

  const mods = [];
  const keys = [];
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      if (!mods.includes(p)) mods.push(p);
    } else {
      keys.push(p);
    }
  }
  if (keys.length !== 1) {
    return { ok: false, error: `按键 "${raw}" 必须恰好包含一个主键（修饰键：Ctrl/Alt/Shift/Meta）` };
  }
  const order = ['ctrl', 'alt', 'shift', 'meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  // 规范展示：Ctrl+K
  const pretty = [...mods, keys[0]]
    .map((p) => (MODIFIERS.has(p) ? p[0].toUpperCase() + p.slice(1) : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
  return { ok: true, token: [...mods, keys[0]].join('+'), pretty };
}

/**
 * 解析序列输入。接受空格或逗号分隔的 1~3 次按键，例如：
 *   "g l"  /  "ctrl+k, x"  /  "Ctrl+Shift+p"
 */
function parseSequence(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: '请输入 1~3 次按键' };
  const segments = text.split(/[\s,]+/).filter(Boolean);
  if (segments.length < 1 || segments.length > MAX_PRESSES) {
    return { ok: false, error: `序列必须由 1~${MAX_PRESSES} 次按键组成，当前 ${segments.length} 次` };
  }
  const tokens = [];
  const labels = [];
  for (const seg of segments) {
    const r = canonicalPress(seg);
    if (!r.ok) return { ok: false, error: r.error };
    tokens.push(r.token);
    labels.push(r.pretty);
  }
  return { ok: true, tokens, label: labels.join(' ') };
}

function seqKey(tokens) {
  return tokens.join('');
}

function isPrefix(shorter, longer) {
  if (shorter.length >= longer.length) return false;
  return shorter.every((t, i) => t === longer[i]);
}

function buildIndex(contexts) {
  const byId = new Map();
  const roots = [];
  for (const c of contexts) {
    byId.set(c.id, { ...c, children: [] });
  }
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).children.push(c);
    } else {
      roots.push(c);
    }
  }
  return { byId, roots };
}

/** 从某上下文向上到根的链（含自身），自身在前 */
function ancestorChain(index, contextId) {
  const chain = [];
  let cur = index.byId.get(contextId);
  const guard = new Set();
  while (cur) {
    if (guard.has(cur.id)) break;
    guard.add(cur.id);
    chain.push(cur);
    cur = cur.parentId ? index.byId.get(cur.parentId) : null;
  }
  return chain;
}

function contextPath(index, contextId) {
  const chain = ancestorChain(index, contextId).reverse(); // 根 → 当前
  return chain.map((c) => c.name).join(' / ');
}

/**
 * 计算指定上下文下生效的全部绑定。
 * 返回 {
 *   contextId, contextPath, chain: [{id,name,depth}],
 *   entries: 所有绑定（含 shadowed）,
 *   effectiveGroups: 按序列分组的生效绑定,
 *   conflicts: 冲突清单（duplicate / prefix）
 * }
 */
function computeEffective(state, contextId) {
  const index = buildIndex(state.contexts);
  if (!index.byId.has(contextId)) {
    throw Object.assign(new Error('上下文不存在'), { status: 404 });
  }
  const chain = ancestorChain(index, contextId); // [自身, 父, ..., 根]
  const pathStr = contextPath(index, contextId);

  // 仅收集链上上下文定义的命令；链上深度：自身 0。按由近到远的深度排序处理
  const chainIds = new Set(chain.map((c) => c.id));
  const depthOf = new Map(chain.map((c, i) => [c.id, i]));

  const owned = state.commands
    .filter((cmd) => chainIds.has(cmd.contextId))
    .map((cmd) => ({
      cmd,
      contextId: cmd.contextId,
      ownerDepth: depthOf.get(cmd.contextId),
      contextPath: contextPath(index, cmd.contextId),
    }))
    .sort((a, b) => a.ownerDepth - b.ownerDepth);

  const groupsMap = new Map(); // seqKey -> { tokens, label, commands:[record...] }
  const shadowed = []; // 被覆盖的祖先绑定

  for (const record of owned) {
    const { cmd } = record;
    const key = seqKey(cmd.sequenceTokens);
    const existing = groupsMap.get(key);
    if (!existing) {
      groupsMap.set(key, {
        seqKey: key,
        tokens: [...cmd.sequenceTokens],
        label: cmd.sequenceLabel,
        commands: [record],
      });
    } else if (record.ownerDepth === existing.commands[0].ownerDepth) {
      existing.commands.push(record); // 同层重复（duplicate 冲突，双方均生效）
    } else {
      // 更深祖先（更大 depth）的同序列绑定被最近祖先覆盖
      shadowed.push({ ...record, overriddenByDepth: existing.commands[0].ownerDepth });
    }
  }

  // 组状态：同层多命令 => duplicate
  const effectiveGroups = [...groupsMap.values()].map((g) => ({
    ...g,
    duplicate: g.commands.length > 1,
  }));

  // 前缀冲突：生效组两两比较（跨越不同层级也算）
  const prefixPairs = []; // [shortGroup, longGroup]
  for (let i = 0; i < effectiveGroups.length; i++) {
    for (let j = 0; j < effectiveGroups.length; j++) {
      if (i === j) continue;
      const a = effectiveGroups[i];
      const b = effectiveGroups[j];
      if (isPrefix(a.tokens, b.tokens)) {
        prefixPairs.push([a, b]);
      }
    }
  }
  const prefixShortKeys = new Set(prefixPairs.map(([a]) => a.seqKey));
  const prefixLongKeys = new Set(prefixPairs.map(([, b]) => b.seqKey));

  // 汇总 entries
  const entries = [];
  for (const g of effectiveGroups) {
    const prefixRole = prefixShortKeys.has(g.seqKey)
      ? 'prefix'
      : prefixLongKeys.has(g.seqKey)
        ? 'extension'
        : null;
    for (const rec of g.commands) {
      entries.push({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        description: rec.cmd.description || '',
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        ownerDepth: rec.ownerDepth,
        sequenceTokens: g.tokens,
        sequenceLabel: g.label,
        state: g.duplicate ? 'duplicate' : 'active',
        shadowedBy: null,
        duplicate: g.duplicate,
        prefix: prefixRole, // 'prefix' | 'extension' | null
      });
    }
  }
  for (const rec of shadowed) {
    entries.push({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      description: rec.cmd.description || '',
      contextId: rec.contextId,
      contextPath: rec.contextPath,
      ownerDepth: rec.ownerDepth,
      sequenceTokens: rec.cmd.sequenceTokens,
      sequenceLabel: rec.cmd.sequenceLabel,
      state: 'shadowed',
      shadowedBy: chain[rec.overriddenByDepth]?.id ?? null,
      duplicate: false,
      prefix: null,
    });
  }
  entries.sort((a, b) => a.sequenceLabel.localeCompare(b.sequenceLabel) || a.ownerDepth - b.ownerDepth);

  // 冲突清单
  const conflicts = [];
  for (const g of effectiveGroups.filter((g) => g.duplicate)) {
    conflicts.push({
      type: 'duplicate',
      kindLabel: '同层序列重复',
      sequenceLabel: g.label,
      sequenceTokens: g.tokens,
      parties: g.commands.map((rec) => ({
        commandId: rec.cmd.id,
        name: rec.cmd.name,
        contextId: rec.contextId,
        contextPath: rec.contextPath,
        sequenceLabel: g.label,
        shortestLabel: g.label,
      })),
    });
  }
  for (const [shortG, longG] of prefixPairs) {
    conflicts.push({
      type: 'prefix',
      kindLabel: '前缀冲突',
      prefixSequenceLabel: shortG.label,
      extensionSequenceLabel: longG.label,
      prefixTokens: shortG.tokens,
      extensionTokens: longG.tokens,
      parties: [
        ...shortG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: shortG.label,
          shortestLabel: shortG.label,
          role: 'prefix',
        })),
        ...longG.commands.map((rec) => ({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          contextId: rec.contextId,
          contextPath: rec.contextPath,
          sequenceLabel: longG.label,
          shortestLabel: longG.label,
          role: 'extension',
        })),
      ],
    });
  }

  return {
    contextId,
    contextPath: pathStr,
    chain: chain.map((c, i) => ({ id: c.id, name: c.name, depth: i })).reverse(),
    entries,
    effectiveGroups,
    conflicts,
  };
}

/**
 * 逐键模拟：给定已经按下的按键缓冲，返回当前状态。
 * status:
 *   idle       尚未输入
 *   triggered  精确命中，命令已触发
 *   waiting    已构成某些命令序列的前缀，等待后续按键
 *   no-match   无任何匹配（含缓冲到 3 键仍未命中）
 */
function evaluateKey(state, contextId, bufferTokens) {
  const eff = computeEffective(state, contextId);
  const buffer = bufferTokens || [];

  if (buffer.length === 0) {
    return { status: 'idle', buffer, bufferLabel: '', triggered: [], candidates: [], effective: eff };
  }

  const bufferLabel = buffer.map((t) => pressToPretty(t)).join(' ');
  const groups = eff.effectiveGroups;

  const exact = groups.filter((g) => g.tokens.length === buffer.length && g.tokens.every((t, i) => t === buffer[i]));
  const prefixed = groups.filter((g) => isPrefix(buffer, g.tokens));

  const toCandidate = (g) => ({
    sequenceLabel: g.label,
    sequenceTokens: g.tokens,
    commands: g.commands.map((rec) => ({
      commandId: rec.cmd.id,
      name: rec.cmd.name,
      contextPath: rec.contextPath,
      contextId: rec.contextId,
    })),
    remaining: g.tokens.length - buffer.length,
  });

  if (exact.length > 0) {
    const triggered = [];
    for (const g of exact) {
      for (const rec of g.commands) {
        triggered.push({
          commandId: rec.cmd.id,
          name: rec.cmd.name,
          description: rec.cmd.description || '',
          contextPath: rec.contextPath,
          sequenceLabel: g.label,
          duplicate: g.duplicate,
        });
      }
    }
    // 精确命中的同时若仍是更长序列前缀，给出提示候选
    return {
      status: 'triggered',
      buffer,
      bufferLabel,
      triggered,
      candidates: prefixed.map(toCandidate),
      effective: eff,
    };
  }

  if (prefixed.length > 0 && buffer.length < MAX_PRESSES) {
    return {
      status: 'waiting',
      buffer,
      bufferLabel,
      triggered: [],
      candidates: prefixed.map(toCandidate).sort((a, b) => a.remaining - b.remaining),
      effective: eff,
    };
  }

  return { status: 'no-match', buffer, bufferLabel, triggered: [], candidates: [], effective: eff };
}

function pressToPretty(token) {
  const MOD_PRETTY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' };
  return token
    .split('+')
    .map((p) => (MOD_PRETTY[p] ? MOD_PRETTY[p] : p.length === 1 ? p.toUpperCase() : p))
    .join('+');
}

module.exports = {
  MAX_PRESSES,
  canonicalPress,
  parseSequence,
  seqKey,
  isPrefix,
  buildIndex,
  ancestorChain,
  contextPath,
  computeEffective,
  evaluateKey,
};
