/**
 * 回归套件生成
 * - 候选：所有叶子上下文（无子级的上下文）
 * - 目标：每条「可触发」命令 + 每个（跨叶子去重后的）同层重复 / 前缀冲突
 * - 选择：精确集合覆盖，叶子上下文数量最少；同解时按上下文路径字典序取稳定解
 * - 任何叶子都无法触发的命令不计入目标，单列原因
 */

const { buildIndex, computeEffective, contextPath } = require('./engine');

/** 确定性字符串比较（不依赖 locale，保证「字典序稳定选择」可复现） */
function compareStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 冲突目标身份：类型 + 涉及命令集合（同一组命令在不同叶子中构成的同一冲突只算一个目标） */
function conflictKey(conflict) {
  const ids = conflict.parties.map((p) => p.commandId).sort(compareStr);
  return `${conflict.type}:${ids.join(',')}`;
}

/** 收集所有叶子上下文（无子级） */
function collectLeaves(index) {
  const leaves = [];
  const walk = (node) => {
    if (node.children.length === 0) {
      leaves.push(node);
      return;
    }
    for (const ch of node.children) walk(ch);
  };
  for (const root of index.roots) walk(root);
  return leaves;
}

/** 某上下文子树内的全部叶子（命令仅在这些叶子中可见） */
function subtreeLeaves(index, contextId) {
  const node = index.byId.get(contextId);
  if (!node) return [];
  const out = [];
  const walk = (n) => {
    if (n.children.length === 0) {
      out.push(n);
      return;
    }
    for (const ch of n.children) walk(ch);
  };
  walk(node);
  return out;
}

/**
 * 精确最小集合覆盖。
 * candidates: [{ id, path, covers:Set<targetKey> }]（函数内部会按 (path, id) 排序）。
 * 返回入选候选 id 列表（数量最少；同数量时按路径字典序最小的稳定解）。
 */
function exactMinCover(candidates, universe) {
  if (universe.size === 0) return [];

  // 覆盖为空的候选永远不会进入最优解；按 (path, id) 升序保证字典序与稳定性
  let pool = candidates
    .filter((c) => c.covers.size > 0)
    .sort((a, b) => compareStr(a.path, b.path) || compareStr(a.id, b.id));

  // 等覆盖去重：保留路径字典序最小者（候选已排序，先到先得）。
  // 覆盖完全相同的候选可互换，保留字典序最小者不丢失最优解与稳定解。
  const bySignature = new Map();
  for (const c of pool) {
    const sig = [...c.covers].sort(compareStr).join('\n');
    if (!bySignature.has(sig)) bySignature.set(sig, c);
  }
  pool = [...bySignature.values()];

  // 必备候选：某目标仅被唯一候选覆盖时，该候选必在一切解中
  const forced = [];
  const remaining = new Set(universe);
  for (;;) {
    const coverCount = new Map();
    for (const t of remaining) coverCount.set(t, 0);
    for (const c of pool) {
      for (const t of c.covers) {
        if (remaining.has(t)) coverCount.set(t, coverCount.get(t) + 1);
      }
    }
    const forcedIds = new Set(forced);
    const newly = pool.filter(
      (c) => !forcedIds.has(c.id) && [...c.covers].some((t) => remaining.has(t) && coverCount.get(t) === 1),
    );
    if (newly.length === 0) break;
    for (const c of newly) {
      forced.push(c.id);
      for (const t of c.covers) remaining.delete(t);
    }
    if (remaining.size === 0) return forced;
  }

  // 剩余候选：只保留与剩余目标有交集的，按 (path, id) 升序参与枚举
  const forcedSet = new Set(forced);
  const rest = pool
    .filter((c) => !forcedSet.has(c.id))
    .map((c) => ({ id: c.id, path: c.path, covers: new Set([...c.covers].filter((t) => remaining.has(t))) }))
    .filter((c) => c.covers.size > 0)
    .sort((a, b) => compareStr(a.path, b.path) || compareStr(a.id, b.id));

  // 后缀并集：suffixUnion[i] = rest[i..] 的覆盖并集，用于可行性剪枝
  const suffixUnion = new Array(rest.length + 1);
  suffixUnion[rest.length] = new Set();
  for (let i = rest.length - 1; i >= 0; i--) {
    suffixUnion[i] = new Set(suffixUnion[i + 1]);
    for (const t of rest[i].covers) suffixUnion[i].add(t);
  }
  const maxCover = rest.reduce((m, c) => Math.max(m, c.covers.size), 0);

  let answer = null;
  const dfs = (start, slotsLeft, covered, chosen) => {
    if (answer) return;
    if (slotsLeft === 0) {
      if (covered.size === remaining.size) answer = [...chosen];
      return;
    }
    // 剪枝：剩余槽位即便都选最大覆盖也不够
    if (remaining.size - covered.size > slotsLeft * maxCover) return;
    for (let i = start; i < rest.length; i++) {
      // 剪枝：已覆盖 ∪ rest[i..] 仍无法覆盖全部剩余目标（i 增大并集只会更小，直接停）
      let feasible = true;
      for (const t of remaining) {
        if (!covered.has(t) && !suffixUnion[i].has(t)) {
          feasible = false;
          break;
        }
      }
      if (!feasible) return;
      const c = rest[i];
      const nextCovered = new Set(covered);
      for (const t of c.covers) nextCovered.add(t);
      chosen.push(c.id);
      dfs(i + 1, slotsLeft - 1, nextCovered, chosen);
      chosen.pop();
      if (answer) return;
    }
  };

  // 迭代加深：从下界开始逐级放大，首个可行 k 即最优；同 k 内按字典序枚举，首解即稳定解
  const lower = Math.max(1, Math.ceil(remaining.size / Math.max(1, maxCover)));
  for (let k = lower; k <= rest.length && !answer; k++) {
    dfs(0, k, new Set(), []);
  }
  return answer ? [...forced, ...answer] : null;
}

/** 不可触发命令的原因说明 */
function untriggerableReason(index, cmd, effByLeaf) {
  if (!index.byId.has(cmd.contextId)) {
    return '所属上下文不存在，任何叶子上下文都无法继承到该命令';
  }
  const visible = subtreeLeaves(index, cmd.contextId);
  const overriders = new Set();
  for (const leaf of visible) {
    const eff = effByLeaf.get(leaf.id);
    const entry = eff && eff.entries.find((e) => e.commandId === cmd.id);
    if (entry && entry.state === 'shadowed' && entry.shadowedBy && index.byId.has(entry.shadowedBy)) {
      overriders.add(contextPath(index, entry.shadowedBy));
    }
  }
  const list = [...overriders].sort(compareStr);
  const examples = list.slice(0, 3).join('；');
  return (
    `序列「${cmd.sequenceLabel}」在全部 ${visible.length} 个可达叶子上下文中均被更深层的同序列绑定覆盖` +
    (examples ? `（覆盖者：${examples}${list.length > 3 ? ' 等' : ''}）` : '')
  );
}

/**
 * 生成回归套件。
 * 返回 {
 *   stats: 覆盖统计,
 *   suite: [{ contextId, contextPath, sequences, expectedTriggeredCommands, expectedConflictTypes, expectedConflicts, coveredTargets }],
 *   untriggerable: [{ commandId, name, contextId, contextPath, sequenceLabel, reason }]
 * }
 */
function generateRegressionSuite(state) {
  const index = buildIndex(state.contexts);
  const leafNodes = collectLeaves(index);
  const leaves = leafNodes
    .map((node) => ({ id: node.id, name: node.name, path: contextPath(index, node.id) }))
    .sort((a, b) => compareStr(a.path, b.path) || compareStr(a.id, b.id));

  // 每个叶子：复用现有生效规则计算覆盖目标
  const effByLeaf = new Map();
  const leafCovers = new Map(); // leafId -> Set<targetKey>
  const triggerableCmdIds = new Set();
  const conflictInfo = new Map(); // conflictKey -> 冲突描述（首次出现）

  for (const leaf of leaves) {
    const eff = computeEffective(state, leaf.id);
    effByLeaf.set(leaf.id, eff);
    const covers = new Set();
    for (const e of eff.entries) {
      if (e.state === 'shadowed') continue;
      covers.add(`cmd:${e.commandId}`);
      triggerableCmdIds.add(e.commandId);
    }
    for (const c of eff.conflicts) {
      const key = conflictKey(c);
      covers.add(`conflict:${key}`);
      if (!conflictInfo.has(key)) conflictInfo.set(key, c);
    }
    leafCovers.set(leaf.id, covers);
  }

  // 任何叶子均无法触发的命令：单列原因，不计入目标
  const untriggerable = state.commands
    .filter((cmd) => !triggerableCmdIds.has(cmd.id))
    .map((cmd) => ({
      commandId: cmd.id,
      name: cmd.name,
      contextId: cmd.contextId,
      contextPath: index.byId.has(cmd.contextId) ? contextPath(index, cmd.contextId) : '(上下文不存在)',
      sequenceLabel: cmd.sequenceLabel,
      reason: untriggerableReason(index, cmd, effByLeaf),
    }))
    .sort((a, b) => compareStr(a.contextPath, b.contextPath) || compareStr(a.name, b.name));

  // 目标全集（仅含可覆盖目标）
  const universe = new Set();
  for (const covers of leafCovers.values()) {
    for (const t of covers) universe.add(t);
  }

  // 精确最小集合覆盖
  const candidates = leaves.map((l) => ({ id: l.id, path: l.path, covers: leafCovers.get(l.id) }));
  const selectedIds = exactMinCover(candidates, universe) || [];
  const selectedSet = new Set(selectedIds);

  // 组装套件：每个入选上下文列出需输入的序列、预期触发命令集合与预期冲突
  const suite = leaves
    .filter((l) => selectedSet.has(l.id))
    .map((leaf) => {
      const eff = effByLeaf.get(leaf.id);
      const sequences = eff.effectiveGroups
        .map((g) => ({
          sequenceLabel: g.label,
          sequenceTokens: [...g.tokens],
          duplicate: g.duplicate,
          expectedTriggered: g.commands
            .map((rec) => ({
              commandId: rec.cmd.id,
              name: rec.cmd.name,
              contextPath: rec.contextPath,
            }))
            .sort((a, b) => compareStr(a.name, b.name) || compareStr(a.commandId, b.commandId)),
        }))
        .sort((a, b) => compareStr(a.sequenceLabel, b.sequenceLabel));

      const triggeredMap = new Map();
      for (const s of sequences) {
        for (const t of s.expectedTriggered) {
          if (!triggeredMap.has(t.commandId)) triggeredMap.set(t.commandId, t);
        }
      }
      const expectedTriggeredCommands = [...triggeredMap.values()].sort(
        (a, b) => compareStr(a.name, b.name) || compareStr(a.commandId, b.commandId),
      );

      const expectedConflictTypes = [...new Set(eff.conflicts.map((c) => c.type))].sort(compareStr);
      const covers = leafCovers.get(leaf.id);

      return {
        contextId: leaf.id,
        contextPath: leaf.path,
        sequences,
        expectedTriggeredCommands,
        expectedConflictTypes,
        expectedConflicts: eff.conflicts,
        coveredTargets: {
          commands: [...covers].filter((t) => t.startsWith('cmd:')).length,
          conflicts: [...covers].filter((t) => t.startsWith('conflict:')).length,
        },
      };
    });

  const covered = new Set();
  for (const id of selectedIds) {
    for (const t of leafCovers.get(id)) covered.add(t);
  }
  const conflictTargets = [...universe].filter((t) => t.startsWith('conflict:')).length;

  return {
    stats: {
      totalContexts: state.contexts.length,
      leafContexts: leaves.length,
      commands: state.commands.length,
      triggerableCommands: triggerableCmdIds.size,
      untriggerableCommands: untriggerable.length,
      conflictTargets,
      targets: universe.size,
      coveredTargets: covered.size,
      coverage: universe.size === 0 ? 1 : covered.size / universe.size,
      selectedContexts: selectedIds.length,
    },
    suite,
    untriggerable,
  };
}

module.exports = { generateRegressionSuite, exactMinCover, conflictKey };
