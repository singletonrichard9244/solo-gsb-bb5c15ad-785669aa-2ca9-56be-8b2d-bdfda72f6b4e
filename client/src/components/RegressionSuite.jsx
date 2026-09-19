import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

const CONFLICT_TYPE_LABEL = { duplicate: '同层重复', prefix: '前缀冲突' };

function StatCard({ label, value, sub, tone }) {
  return (
    <div className={`stat-card ${tone || ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function ConflictLine({ conflict }) {
  return (
    <li className={`suite-conflict ${conflict.type}`}>
      <span className={`badge ${conflict.type === 'duplicate' ? 'duplicate' : 'prefix'}`}>
        {CONFLICT_TYPE_LABEL[conflict.type] || conflict.type}
      </span>
      {conflict.type === 'prefix' ? (
        <span className="conflict-seqs">
          <kbd>{conflict.prefixSequenceLabel}</kbd>
          <em> ⊂ </em>
          <kbd>{conflict.extensionSequenceLabel}</kbd>
        </span>
      ) : (
        <span className="conflict-seqs">
          <kbd>{conflict.sequenceLabel}</kbd>
        </span>
      )}
      <span className="suite-conflict-parties">
        {conflict.parties.map((p) => `${p.name}（${p.contextPath}）`).join('、')}
      </span>
    </li>
  );
}

function SuiteEntry({ entry }) {
  return (
    <div className="panel suite-entry">
      <div className="panel-header">
        <h2>
          {entry.contextPath}{' '}
          <span className="sub">
            覆盖 {entry.coveredTargets.commands} 条命令目标 · {entry.coveredTargets.conflicts} 个冲突目标
          </span>
        </h2>
        <span className="badges">
          {entry.expectedConflictTypes.length === 0 && <span className="badge active">无冲突</span>}
          {entry.expectedConflictTypes.map((t) => (
            <span key={t} className={`badge ${t === 'duplicate' ? 'duplicate' : 'prefix'}`}>
              预期{CONFLICT_TYPE_LABEL[t] || t}
            </span>
          ))}
        </span>
      </div>

      <table className="bind-table">
        <thead>
          <tr>
            <th>需输入的序列</th>
            <th>预期触发命令</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {entry.sequences.map((s) => (
            <tr key={s.sequenceLabel} className={s.duplicate ? 'row-conflict' : ''}>
              <td>
                <kbd className="seq">{s.sequenceLabel}</kbd>
              </td>
              <td>
                {s.expectedTriggered.map((t) => (
                  <div key={t.commandId}>
                    <strong>{t.name}</strong>{' '}
                    <span className="party-source">（{t.contextPath}）</span>
                  </div>
                ))}
              </td>
              <td>{s.duplicate && <span className="badge duplicate">同层重复，同时触发</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {entry.expectedConflicts.length > 0 && (
        <div className="suite-conflicts">
          <h4>预期冲突（{entry.expectedConflicts.length}）</h4>
          <ul className="suite-conflict-list">
            {entry.expectedConflicts.map((c, i) => (
              <ConflictLine key={c.type + i} conflict={c} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function RegressionSuite() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.suite());
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const download = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'regression-suite.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading && !data) return <div className="loading">正在生成回归套件…</div>;

  const stats = data?.stats;
  const pct = stats ? Math.round(stats.coverage * 100) : 0;

  return (
    <div className="suite-page">
      <div className="panel">
        <div className="panel-header">
          <h2>
            回归套件生成 <span className="sub">叶子上下文最小集合覆盖 · 同解按路径字典序稳定选择</span>
          </h2>
          <div className="suite-actions">
            <button onClick={load} disabled={loading}>
              {loading ? '生成中…' : '重新生成'}
            </button>
            <button className="primary" onClick={download} disabled={!data}>
              下载 JSON
            </button>
          </div>
        </div>

        {error && <p className="error">⚠ {error}</p>}

        {stats && (
          <div className="stats-grid">
            <StatCard label="目标覆盖率" value={`${pct}%`} sub={`${stats.coveredTargets} / ${stats.targets} 个目标`} tone="ok" />
            <StatCard label="入选叶子上下文" value={stats.selectedContexts} sub={`共 ${stats.leafContexts} 个叶子 / ${stats.totalContexts} 个上下文`} />
            <StatCard label="可触发命令" value={stats.triggerableCommands} sub={`共 ${stats.commands} 条命令`} />
            <StatCard label="冲突目标" value={stats.conflictTargets} sub="同层重复 + 前缀冲突（跨叶子去重）" />
            <StatCard
              label="不可触发命令"
              value={stats.untriggerableCommands}
              sub="任何叶子都无法触发，不计入覆盖"
              tone={stats.untriggerableCommands > 0 ? 'warn' : ''}
            />
          </div>
        )}
      </div>

      {data && data.suite.length === 0 && (
        <div className="panel">
          <p className="hint">当前没有可覆盖的测试目标（尚无叶子上下文或命令）。</p>
        </div>
      )}

      {data &&
        data.suite.map((entry) => <SuiteEntry key={entry.contextId} entry={entry} />)}

      {data && data.untriggerable.length > 0 && (
        <div className="panel">
          <div className="panel-header">
            <h2>
              不可触发命令 <span className="sub">任何叶子上下文均无法触发，不计入已覆盖</span>
            </h2>
          </div>
          <table className="bind-table">
            <thead>
              <tr>
                <th>命令</th>
                <th>序列</th>
                <th>定义位置</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {data.untriggerable.map((u) => (
                <tr key={u.commandId}>
                  <td>{u.name}</td>
                  <td>
                    <kbd className="seq">{u.sequenceLabel}</kbd>
                  </td>
                  <td className="source">{u.contextPath}</td>
                  <td className="desc">{u.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
