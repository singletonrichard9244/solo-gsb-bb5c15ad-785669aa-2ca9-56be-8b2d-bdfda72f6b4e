const assert = require('node:assert/strict');
const { generateRegressionSuite, exactMinCover } = require('../src/suite');
const seed = require('../src/seed');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const ctx = (id, parentId, name) => ({ id, parentId, name, description: '' });
const cmd = (id, contextId, name, seq, label) => ({
  id,
  contextId,
  name,
  sequenceTokens: seq,
  sequenceLabel: label,
  description: '',
});

// ---------- 基础场景：R → A、B 两个叶子 ----------
const twoLeaves = {
  contexts: [ctx('R', null, 'R'), ctx('A', 'R', 'A'), ctx('B', 'R', 'B')],
  commands: [
    cmd('r1', 'R', 'root-x', ['x'], 'X'),
    cmd('a1', 'A', 'a-y', ['y'], 'Y'),
    cmd('b1', 'B', 'b-z', ['z'], 'Z'),
  ],
};

test('叶子上下文作为候选：两个叶子各自持有独有命令时全部入选', () => {
  const r = generateRegressionSuite(twoLeaves);
  assert.equal(r.stats.leafContexts, 2);
  assert.equal(r.stats.selectedContexts, 2);
  assert.deepEqual(
    r.suite.map((s) => s.contextId).sort(),
    ['A', 'B'],
  );
  assert.equal(r.stats.coveredTargets, r.stats.targets);
  assert.equal(r.stats.coverage, 1);
});

test('同解时按上下文路径字典序稳定选择', () => {
  // 唯一目标（root-x）在 A、B 两个叶子中都生效 → 最小套件大小为 1，应选路径字典序更小的 A
  const state = {
    contexts: twoLeaves.contexts,
    commands: [cmd('r1', 'R', 'root-x', ['x'], 'X')],
  };
  const r1 = generateRegressionSuite(state);
  const r2 = generateRegressionSuite(state);
  assert.equal(r1.stats.selectedContexts, 1);
  assert.equal(r1.suite[0].contextId, 'A'); // "R / A" < "R / B"
  assert.deepEqual(r1, r2); // 结果稳定可复现
});

test('入选上下文列出需输入的序列、预期触发命令集合与预期冲突类型', () => {
  const r = generateRegressionSuite(twoLeaves);
  const a = r.suite.find((s) => s.contextId === 'A');
  const labels = a.sequences.map((s) => s.sequenceLabel).sort();
  assert.deepEqual(labels, ['X', 'Y']);
  const yCase = a.sequences.find((s) => s.sequenceLabel === 'Y');
  assert.deepEqual(
    yCase.expectedTriggered.map((t) => t.commandId),
    ['a1'],
  );
  assert.deepEqual(
    a.expectedTriggeredCommands.map((t) => t.commandId).sort(),
    ['a1', 'r1'],
  );
  assert.deepEqual(a.expectedConflictTypes, []);
});

test('任何叶子均无法触发的命令单列原因，且不计入覆盖目标', () => {
  const state = {
    contexts: twoLeaves.contexts,
    commands: [
      cmd('r1', 'R', 'root-x', ['x'], 'X'),
      cmd('a1', 'A', 'a-x', ['x'], 'X'), // 在 A 覆盖 r1
      cmd('b1', 'B', 'b-x', ['x'], 'X'), // 在 B 覆盖 r1
    ],
  };
  const r = generateRegressionSuite(state);
  assert.equal(r.untriggerable.length, 1);
  assert.equal(r.untriggerable[0].commandId, 'r1');
  assert.ok(r.untriggerable[0].reason.includes('覆盖'));
  // 不计入目标：目标仅含 a1、b1 两条可触发命令
  assert.equal(r.stats.commands, 3);
  assert.equal(r.stats.triggerableCommands, 2);
  assert.equal(r.stats.untriggerableCommands, 1);
  assert.equal(r.stats.targets, 2);
  assert.equal(r.stats.coveredTargets, 2);
});

test('同层重复与前缀冲突均成为测试目标并被覆盖', () => {
  const state = {
    contexts: [ctx('R', null, 'R')],
    commands: [
      cmd('c1', 'R', 'go', ['g'], 'G'),
      cmd('c2', 'R', 'go-def', ['g', 'd'], 'G D'),
      cmd('c3', 'R', 'dup-1', ['y'], 'Y'),
      cmd('c4', 'R', 'dup-2', ['y'], 'Y'),
    ],
  };
  const r = generateRegressionSuite(state);
  assert.equal(r.stats.conflictTargets, 2); // 1 前缀 + 1 重复
  assert.equal(r.stats.targets, 6); // 4 命令 + 2 冲突
  assert.equal(r.stats.selectedContexts, 1);
  const entry = r.suite[0];
  assert.deepEqual(entry.expectedConflictTypes, ['duplicate', 'prefix']);
  // 重复组：一次输入同时触发双方
  const yCase = entry.sequences.find((s) => s.sequenceLabel === 'Y');
  assert.equal(yCase.duplicate, true);
  assert.deepEqual(
    yCase.expectedTriggered.map((t) => t.commandId).sort(),
    ['c3', 'c4'],
  );
  assert.equal(entry.coveredTargets.commands, 4);
  assert.equal(entry.coveredTargets.conflicts, 2);
});

test('冲突目标跨叶子去重：同一组命令的同一冲突只算一个目标', () => {
  const state = {
    contexts: [ctx('R', null, 'R'), ctx('A', 'R', 'A'), ctx('B', 'R', 'B')],
    commands: [
      cmd('c1', 'R', 'go', ['g'], 'G'),
      cmd('c2', 'R', 'go-def', ['g', 'd'], 'G D'),
      cmd('a1', 'A', 'a-only', ['a'], 'A'),
      cmd('b1', 'B', 'b-only', ['b'], 'B'),
    ],
  };
  const r = generateRegressionSuite(state);
  // 同一前缀冲突（c1 ⊂ c2）在 A、B 中都出现，只算 1 个目标
  assert.equal(r.stats.conflictTargets, 1);
  assert.equal(r.stats.targets, 5); // 4 命令 + 1 冲突
});

test('精确集合覆盖：优于贪心（贪心 3 个，最优 2 个）', () => {
  const mk = (id, path, covers) => ({ id, path, covers: new Set(covers) });
  const candidates = [
    mk('s1', 'a', [1, 2, 3, 4]),
    mk('s2', 'b', [1, 2, 5]),
    mk('s3', 'c', [3, 4, 6]),
    mk('s4', 'd', [5, 6]),
  ];
  const universe = new Set([1, 2, 3, 4, 5, 6]);
  const selected = exactMinCover(candidates, universe);
  assert.equal(selected.length, 2); // 贪心会先拿 s1 导致 3 个
});

test('精确集合覆盖：同数量解取路径字典序最小者', () => {
  const mk = (id, path, covers) => ({ id, path, covers: new Set(covers) });
  const candidates = [
    mk('c1', 'a', [1]),
    mk('c2', 'z', [2]),
    mk('c3', 'b', [1]),
    mk('c4', 'y', [2]),
  ];
  const universe = new Set([1, 2]);
  const selected = exactMinCover(candidates, universe);
  const paths = selected
    .map((id) => candidates.find((c) => c.id === id).path)
    .sort();
  assert.deepEqual(paths, ['a', 'y']); // 所有大小为 2 的解中字典序最小
});

test('等覆盖候选去重：保留路径字典序最小者', () => {
  const mk = (id, path, covers) => ({ id, path, covers: new Set(covers) });
  const candidates = [mk('c1', 'a', [1]), mk('c2', 'b', [1])];
  const selected = exactMinCover(candidates, new Set([1]));
  assert.deepEqual(selected, ['c1']);
});

test('空状态：无上下文时套件为空', () => {
  const r = generateRegressionSuite({ contexts: [], commands: [] });
  assert.equal(r.stats.targets, 0);
  assert.equal(r.stats.selectedContexts, 0);
  assert.deepEqual(r.suite, []);
  assert.deepEqual(r.untriggerable, []);
});

test('种子数据：两个叶子均入选，祖先被覆盖命令单列', () => {
  const r = generateRegressionSuite({ contexts: seed.contexts, commands: seed.commands });
  // 叶子：Code Editor 与 Terminal，各自持有独有命令 → 都必选
  assert.equal(r.stats.leafContexts, 2);
  assert.equal(r.stats.selectedContexts, 2);
  // Editor 的「跳转…」(g) 在两个叶子中分别被 Code Editor / Terminal 的同序列绑定覆盖
  assert.equal(r.untriggerable.length, 1);
  assert.equal(r.untriggerable[0].name, '跳转…');
  assert.ok(r.untriggerable[0].reason.includes('覆盖'));
  // 冲突目标：Code Editor 3 个前缀 + Terminal 2 个前缀 + 1 个同层重复
  assert.equal(r.stats.conflictTargets, 6);
  assert.equal(r.stats.coverage, 1);
  assert.equal(r.stats.coveredTargets, r.stats.targets);
  // Terminal 叶子的 G H 同层重复：预期一次输入触发两条命令
  const term = r.suite.find((s) => s.contextPath.endsWith('Terminal'));
  const gh = term.sequences.find((s) => s.sequenceLabel === 'g h');
  assert.equal(gh.duplicate, true);
  assert.equal(gh.expectedTriggered.length, 2);
});

console.log(`\n回归套件测试全部通过：${passed} 项`);
