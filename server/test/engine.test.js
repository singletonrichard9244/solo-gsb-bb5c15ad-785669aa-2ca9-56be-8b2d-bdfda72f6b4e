const assert = require('node:assert/strict');
const { computeEffective, evaluateKey, parseSequence } = require('../src/engine');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

// 构造可控数据
const state = {
  contexts: [
    { id: 'root', parentId: null, name: 'Root' },
    { id: 'a', parentId: 'root', name: 'A' },
    { id: 'b', parentId: 'a', name: 'B' },
    { id: 'sibling', parentId: 'root', name: 'Sibling' },
  ],
  commands: [
    { id: 'c1', contextId: 'root', name: 'root-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c2', contextId: 'root', name: 'root-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c3', contextId: 'root', name: 'root-gd', sequenceTokens: ['g', 'd'], sequenceLabel: 'G D', description: '' },
    { id: 'c4', contextId: 'a', name: 'a-x', sequenceTokens: ['x'], sequenceLabel: 'X', description: '' },
    { id: 'c5', contextId: 'a', name: 'a-y1', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c6', contextId: 'a', name: 'a-y2', sequenceTokens: ['y'], sequenceLabel: 'Y', description: '' },
    { id: 'c7', contextId: 'b', name: 'b-g', sequenceTokens: ['g'], sequenceLabel: 'G', description: '' },
    { id: 'c8', contextId: 'sibling', name: 'sib-k', sequenceTokens: ['k'], sequenceLabel: 'K', description: '' },
  ],
};

test('序列解析：空格/逗号分隔，1~3 次', () => {
  assert.deepEqual(parseSequence('g l').tokens, ['g', 'l']);
  assert.deepEqual(parseSequence('Ctrl+K, x').tokens, ['ctrl+k', 'x']);
  assert.ok(parseSequence('a b c d').ok === false);
  assert.ok(parseSequence('').ok === false);
  assert.ok(parseSequence('ctrl+alt').ok === false); // 没有主键
  assert.equal(parseSequence('shift+k').tokens[0], 'shift+k');
});

test('最近祖先：B 的 X 被 A 覆盖，root X 标记 shadowed', () => {
  const eff = computeEffective(state, 'b');
  const active = eff.entries.filter((e) => e.state !== 'shadowed');
  assert.ok(active.some((e) => e.commandId === 'c4')); // a-x 生效
  assert.ok(!active.some((e) => e.commandId === 'c1')); // root-x 不生效
  const shadow = eff.entries.find((e) => e.commandId === 'c1');
  assert.equal(shadow.state, 'shadowed');
});

test('同层相同序列：duplicate 冲突且双方都在生效列表', () => {
  const eff = computeEffective(state, 'a');
  const c5 = eff.entries.find((e) => e.commandId === 'c5');
  const c6 = eff.entries.find((e) => e.commandId === 'c6');
  assert.equal(c5.state, 'duplicate');
  assert.equal(c6.state, 'duplicate');
  assert.ok(eff.conflicts.some((c) => c.type === 'duplicate' && c.parties.length === 2));
});

test('前缀冲突：根的 G 与 G D 双方标记，且包含跨层情况', () => {
  const effRoot = computeEffective(state, 'root');
  assert.ok(effRoot.conflicts.some((c) => c.type === 'prefix'));
  const g = effRoot.entries.find((e) => e.commandId === 'c2');
  const gd = effRoot.entries.find((e) => e.commandId === 'c3');
  assert.equal(g.prefix, 'prefix');
  assert.equal(gd.prefix, 'extension');

  // B 层：B 的 G（c7）与 root 的 G D（c3）构成跨层前缀冲突
  const effB = computeEffective(state, 'b');
  assert.ok(
    effB.conflicts.some(
      (c) => c.type === 'prefix' && c.parties.some((p) => p.commandId === 'c7') && c.parties.some((p) => p.commandId === 'c3'),
    ),
  );
  // root 的 G（c2）在 B 下被覆盖，不参与前缀冲突
  assert.ok(!effB.conflicts.some((c) => c.parties.some((p) => p.commandId === 'c2')));
});

test('生效绑定只包含当前上下文链上的命令，兄弟上下文不串入', () => {
  const eff = computeEffective(state, 'b');
  assert.ok(!eff.entries.some((e) => e.commandId === 'c8'));
});

test('逐键模拟：idle → waiting → triggered', () => {
  let r = evaluateKey(state, 'root', []);
  assert.equal(r.status, 'idle');
  r = evaluateKey(state, 'root', ['g']);
  assert.equal(r.status, 'triggered'); // G 自身是命令
  assert.ok(r.candidates.length >= 1); // 同时是 G D 的前缀
  assert.ok(r.candidates.some((c) => c.sequenceLabel === 'G D'));
  r = evaluateKey(state, 'root', ['g', 'd']);
  assert.equal(r.status, 'triggered');
  assert.equal(r.triggered[0].commandId, 'c3');
});

test('逐键模拟：等待态与无匹配', () => {
  // A 层没有 G 单独命令，只有 root 的 G（在 A 下仍生效）。构造更独立的场景：
  const st2 = {
    contexts: [{ id: 'r', parentId: null, name: 'R' }],
    commands: [{ id: 'z1', contextId: 'r', name: 'zab', sequenceTokens: ['z', 'a', 'b'], sequenceLabel: 'Z A B', description: '' }],
  };
  assert.equal(evaluateKey(st2, 'r', ['z']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a']).status, 'waiting');
  assert.equal(evaluateKey(st2, 'r', ['z', 'a', 'b']).status, 'triggered');
  assert.equal(evaluateKey(st2, 'r', ['x']).status, 'no-match');
  assert.equal(evaluateKey(st2, 'r', ['z', 'q']).status, 'no-match');
});

test('逐键模拟：duplicate 命中时 triggered 含双方', () => {
  const r = evaluateKey(state, 'a', ['y']);
  assert.equal(r.status, 'triggered');
  const ids = r.triggered.map((t) => t.commandId).sort();
  assert.deepEqual(ids, ['c5', 'c6']);
});

test('上下文路径展示双方来源', () => {
  const eff = computeEffective(state, 'b');
  const conflict = eff.conflicts.find((c) => c.type === 'prefix');
  assert.ok(conflict.parties.every((p) => typeof p.contextPath === 'string' && p.contextPath.length > 0));
  const labels = conflict.parties.map((p) => p.shortestLabel);
  assert.ok(labels.includes('G') && labels.includes('G D'));
});

console.log(`\n引擎测试全部通过：${passed} 项`);
