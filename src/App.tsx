import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import "./styles.css";
import {
  ACTION_LABEL,
  CLEARANCE_LIMIT,
  CROSSWIND_LIMIT,
  clearanceOf,
  crosswindOf,
  describeChanges,
  evaluateSegment,
  formatMeters,
  loadState,
  makeId,
  saveState,
} from "./lib/clearance";
import type { ClearanceRecord, RecordAction, Segment } from "./lib/clearance";

interface FormState {
  name: string;
  windDirection: string;
  windSpeed: string;
  landingPoint: string;
  audienceEdge: string;
}

const emptyForm: FormState = {
  name: "",
  windDirection: "",
  windSpeed: "",
  landingPoint: "",
  audienceEdge: "",
};

function formatTime(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 冲突位置示意：发射点 — 落点 — 观众区边缘 的一维位置条 */
function ConflictStrip({ segment, reasons }: { segment: Segment; reasons: string[] }) {
  const scale =
    Math.max(segment.landingPoint, segment.audienceEdge, CLEARANCE_LIMIT, 1) * 1.15;
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / scale) * 100))}%`;
  const bufferStart = Math.max(0, segment.audienceEdge - CLEARANCE_LIMIT);
  return (
    <article className="conflict">
      <header>
        <h3>{segment.name}</h3>
        <p>{reasons.join("；")}</p>
      </header>
      <div
        className="strip"
        role="img"
        aria-label={`${segment.name}：落点 ${segment.landingPoint} 米，观众区边缘 ${segment.audienceEdge} 米`}
      >
        <div
          className="buffer"
          style={{
            left: pct(bufferStart),
            width: pct(segment.audienceEdge - bufferStart),
          }}
          title={`观众区前 ${CLEARANCE_LIMIT} m 禁入缓冲带`}
        />
        <div className="edge" style={{ left: pct(segment.audienceEdge) }}>
          <span>观众区边缘 {segment.audienceEdge} m</span>
        </div>
        <div className="landing" style={{ left: pct(segment.landingPoint) }}>
          <span>落点 {segment.landingPoint} m</span>
        </div>
        <div className="origin">
          <span>发射点 0 m</span>
        </div>
      </div>
      <footer>
        侧风 {crosswindOf(segment).toFixed(1)} m/s · 落点间距{" "}
        {formatMeters(clearanceOf(segment))}
      </footer>
    </article>
  );
}

function App() {
  const [initial] = useState(loadState);
  const [segments, setSegments] = useState<Segment[]>(initial.segments);
  const [records, setRecords] = useState<ClearanceRecord[]>(initial.records);

  const [form, setForm] = useState<FormState>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [globalEdge, setGlobalEdge] = useState("");
  const [globalEdgeError, setGlobalEdgeError] = useState("");

  // 放行表 / 冲突位置 / 历史记录 同源派生，任何变更即写回浏览器存储，刷新后保留
  useEffect(() => {
    saveState({ segments, records });
  }, [segments, records]);

  /** 每个段落的最新记录动作决定放行状态；记录只追加，旧记录永不覆盖 */
  const clearedIds = useMemo(() => {
    const latest = new Map<string, RecordAction>();
    for (const record of records) latest.set(record.segmentId, record.action);
    return new Set(
      [...latest.entries()].filter(([, action]) => action === "cleared").map(([id]) => id)
    );
  }, [records]);

  const reasonsById = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const s of segments) map.set(s.id, evaluateSegment(s));
    return map;
  }, [segments]);

  const conflicts = segments.filter((s) => (reasonsById.get(s.id) ?? []).length > 0);
  const clearedCount = segments.filter((s) => clearedIds.has(s.id)).length;

  const appendRecords = (entries: ClearanceRecord[]) => {
    if (entries.length > 0) setRecords((prev) => [...prev, ...entries]);
  };

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    const rawNumbers = [form.windDirection, form.windSpeed, form.landingPoint, form.audienceEdge];
    if (!name) {
      setFormError("请填写节目段名称。");
      return;
    }
    if (rawNumbers.some((v) => v.trim() === "")) {
      setFormError("请完整填写风向、风速、落点与观众区边缘。");
      return;
    }
    const [windDirection, windSpeed, landingPoint, audienceEdge] = rawNumbers.map(Number);
    if (![windDirection, windSpeed, landingPoint, audienceEdge].every(Number.isFinite)) {
      setFormError("数值格式不正确，请检查。");
      return;
    }
    if (windDirection < 0 || windDirection > 180) {
      setFormError("风向夹角需在 0–180° 之间。");
      return;
    }
    if (windSpeed < 0 || landingPoint < 0 || audienceEdge < 0) {
      setFormError("风速、落点与观众区边缘不能为负数。");
      return;
    }

    const next: Segment = {
      id: editingId ?? makeId(),
      name,
      windDirection,
      windSpeed,
      landingPoint,
      audienceEdge,
    };
    const now = Date.now();
    const newRecords: ClearanceRecord[] = [];

    if (editingId) {
      const prev = segments.find((s) => s.id === editingId);
      if (!prev) return;
      const wasFailing = evaluateSegment(prev).length > 0;
      // 已放行段落参数变更：原放行记录撤销（追加撤销记录，历史保留）
      if (clearedIds.has(editingId)) {
        newRecords.push({
          id: makeId(),
          segmentId: editingId,
          segmentName: name,
          action: "revoked",
          reason: `登记参数变更（${describeChanges(prev, next)}），原放行撤销，重新判定`,
          at: now,
        });
      }
      setSegments(segments.map((s) => (s.id === editingId ? next : s)));
      // 进入冲突状态时补一条退回记录，原因留痕
      const reasons = evaluateSegment(next);
      if (reasons.length > 0 && !wasFailing) {
        newRecords.push({
          id: makeId(),
          segmentId: editingId,
          segmentName: name,
          action: "returned",
          reason: reasons.join("；"),
          at: now,
        });
      }
    } else {
      setSegments([...segments, next]);
      const reasons = evaluateSegment(next);
      if (reasons.length > 0) {
        newRecords.push({
          id: makeId(),
          segmentId: next.id,
          segmentName: name,
          action: "returned",
          reason: reasons.join("；"),
          at: now,
        });
      }
    }

    appendRecords(newRecords);
    setForm(emptyForm);
    setEditingId(null);
    setFormError("");
  }

  function startEdit(s: Segment) {
    setEditingId(s.id);
    setForm({
      name: s.name,
      windDirection: String(s.windDirection),
      windSpeed: String(s.windSpeed),
      landingPoint: String(s.landingPoint),
      audienceEdge: String(s.audienceEdge),
    });
    setFormError("");
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(emptyForm);
    setFormError("");
  }

  function clearSegment(s: Segment) {
    if (clearedIds.has(s.id)) return;
    if ((reasonsById.get(s.id) ?? []).length > 0) return; // 有冲突不允许放行
    appendRecords([
      {
        id: makeId(),
        segmentId: s.id,
        segmentName: s.name,
        action: "cleared",
        reason: "判定通过，准予放行",
        at: Date.now(),
      },
    ]);
  }

  function revokeSegment(s: Segment) {
    if (!clearedIds.has(s.id)) return;
    appendRecords([
      {
        id: makeId(),
        segmentId: s.id,
        segmentName: s.name,
        action: "revoked",
        reason: "手动撤销，退回待确认",
        at: Date.now(),
      },
    ]);
  }

  function deleteSegment(s: Segment) {
    if (!window.confirm(`删除节目段「${s.name}」？其判定与放行历史会保留。`)) return;
    setSegments((prev) => prev.filter((x) => x.id !== s.id));
    if (editingId === s.id) cancelEdit();
  }

  /** 观众区整体调整：受影响段落重新判定，已放行的先撤销（留痕），新进入冲突的退回 */
  function applyAudienceEdge() {
    const edge = Number(globalEdge);
    if (globalEdge.trim() === "" || !Number.isFinite(edge) || edge <= 0) {
      setGlobalEdgeError("请输入大于 0 的观众区边缘距离（m）。");
      return;
    }
    const now = Date.now();
    const newRecords: ClearanceRecord[] = [];
    const nextSegments = segments.map((s) => {
      if (s.audienceEdge === edge) return s;
      const next = { ...s, audienceEdge: edge };
      if (clearedIds.has(s.id)) {
        newRecords.push({
          id: makeId(),
          segmentId: s.id,
          segmentName: s.name,
          action: "revoked",
          reason: `观众区整体调整至 ${edge} m，原放行撤销，重新判定`,
          at: now,
        });
      }
      const wasFailing = evaluateSegment(s).length > 0;
      const reasons = evaluateSegment(next);
      if (reasons.length > 0 && !wasFailing) {
        newRecords.push({
          id: makeId(),
          segmentId: s.id,
          segmentName: s.name,
          action: "returned",
          reason: `观众区调整至 ${edge} m 后：${reasons.join("；")}`,
          at: now,
        });
      }
      return next;
    });
    setSegments(nextSegments);
    appendRecords(newRecords);
    setGlobalEdge("");
    setGlobalEdgeError("");
  }

  const metrics = [
    { label: "节目段", value: segments.length },
    { label: "已放行", value: clearedCount },
    { label: "待确认", value: segments.length - clearedCount },
    { label: "冲突段落", value: conflicts.length },
  ];

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 源提示词10 · Port 62008</p>
        <h1>焰火彩排放行台</h1>
        <span>
          每个节目段登记风向、风速、最远落点与观众区边缘；侧风超过 {CROSSWIND_LIMIT} m/s
          或落点距观众区不足 {CLEARANCE_LIMIT} m 时，整段退回待确认并保留原因。观众区调整后，
          受影响段落自动重新判定，原放行记录撤销且历史不覆盖；放行表、冲突位置与浏览器存储同步，
          刷新后保留。
        </span>
      </section>

      <section className="metrics">
        {metrics.map((m) => (
          <article key={m.label}>
            <small>{m.label}</small>
            <strong>{m.value}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>判定规则</h2>
          <ul className="rules">
            <li>
              侧风分量 = 风速 × sin(风向夹角)，超过 {CROSSWIND_LIMIT} m/s 整段退回待确认
            </li>
            <li>
              落点距观众区不足 {CLEARANCE_LIMIT} m（含越过观众区），整段退回待确认
            </li>
            <li>退回原因随段落保留，并写入历史记录</li>
            <li>观众区变更后，受影响段落重新判定，原放行记录撤销且不覆盖历史</li>
          </ul>

          <div className="audience-adjust">
            <h3>观众区统一调整</h3>
            <p>将新的观众区边缘距离应用到全部节目段，受影响段落立即重新判定。</p>
            <label>
              <span>新观众区边缘（m）</span>
              <input
                type="number"
                min="1"
                step="1"
                value={globalEdge}
                onChange={(e) => setGlobalEdge(e.target.value)}
                placeholder="例如 150"
              />
            </label>
            {globalEdgeError && <p className="error">{globalEdgeError}</p>}
            <button className="primary" onClick={applyAudienceEdge}>
              应用并重新判定
            </button>
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>节目段登记</p>
              <h2>{editingId ? "编辑节目段" : "新增节目段"}</h2>
            </div>
            {editingId && <button onClick={cancelEdit}>取消编辑</button>}
          </div>
          <form onSubmit={handleSubmit}>
            <div className="field-grid">
              <label>
                <span>节目段名称</span>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="例如 合唱 Chorus B"
                />
              </label>
              <label>
                <span>风向（与发射轴夹角 °）</span>
                <input
                  type="number"
                  min="0"
                  max="180"
                  step="1"
                  value={form.windDirection}
                  onChange={(e) => setForm({ ...form, windDirection: e.target.value })}
                  placeholder="0–180"
                />
              </label>
              <label>
                <span>风速（m/s）</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={form.windSpeed}
                  onChange={(e) => setForm({ ...form, windSpeed: e.target.value })}
                  placeholder="例如 6.5"
                />
              </label>
              <label>
                <span>最远落点（m）</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.landingPoint}
                  onChange={(e) => setForm({ ...form, landingPoint: e.target.value })}
                  placeholder="距发射点"
                />
              </label>
              <label>
                <span>观众区边缘（m）</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={form.audienceEdge}
                  onChange={(e) => setForm({ ...form, audienceEdge: e.target.value })}
                  placeholder="距发射点"
                />
              </label>
            </div>
            {formError && <p className="error">{formError}</p>}
            <div className="form-actions">
              <button type="submit" className="primary">
                {editingId ? "保存并重新判定" : "登记并判定"}
              </button>
              {editingId && clearedIds.has(editingId) && (
                <span className="hint">该段已放行，保存后原放行记录将撤销并保留在历史中。</span>
              )}
            </div>
          </form>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>放行表</p>
            <h2>节目段判定状态</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>节目段</th>
                <th>风向 / 风速</th>
                <th>侧风</th>
                <th>最远落点</th>
                <th>观众区边缘</th>
                <th>落点间距</th>
                <th>状态</th>
                <th>退回原因</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {segments.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty">
                    暂无节目段，请在上方登记。
                  </td>
                </tr>
              )}
              {segments.map((s) => {
                const reasons = reasonsById.get(s.id) ?? [];
                const cleared = clearedIds.has(s.id);
                const crosswind = crosswindOf(s);
                const gap = clearanceOf(s);
                return (
                  <tr key={s.id} className={reasons.length > 0 ? "row-conflict" : ""}>
                    <td className="seg-name">{s.name}</td>
                    <td>
                      {s.windDirection}° / {s.windSpeed} m/s
                    </td>
                    <td className={crosswind > CROSSWIND_LIMIT ? "bad" : ""}>
                      {crosswind.toFixed(1)} m/s
                    </td>
                    <td>{formatMeters(s.landingPoint)}</td>
                    <td>{formatMeters(s.audienceEdge)}</td>
                    <td className={gap < CLEARANCE_LIMIT ? "bad" : ""}>{formatMeters(gap)}</td>
                    <td>
                      <span className={`pill ${cleared ? "pill-cleared" : "pill-pending"}`}>
                        {cleared ? "已放行" : "待确认"}
                      </span>
                    </td>
                    <td className="reason">{reasons.length > 0 ? reasons.join("；") : "—"}</td>
                    <td className="actions">
                      {cleared ? (
                        <button onClick={() => revokeSegment(s)}>撤销</button>
                      ) : (
                        <button
                          className="primary"
                          disabled={reasons.length > 0}
                          title={reasons.length > 0 ? "存在冲突，不能放行" : "判定通过，放行该段"}
                          onClick={() => clearSegment(s)}
                        >
                          放行
                        </button>
                      )}
                      <button onClick={() => startEdit(s)}>编辑</button>
                      <button className="danger" onClick={() => deleteSegment(s)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>冲突位置</p>
            <h2>落点与观众区示意</h2>
          </div>
        </div>
        {conflicts.length === 0 ? (
          <p className="empty">当前无冲突段落。</p>
        ) : (
          <div className="conflict-list">
            {conflicts.map((s) => (
              <ConflictStrip key={s.id} segment={s} reasons={reasonsById.get(s.id) ?? []} />
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>判定与放行留痕</h2>
          </div>
          <span className="hint">记录只追加，不覆盖</span>
        </div>
        {records.length === 0 ? (
          <p className="empty">暂无记录。</p>
        ) : (
          <div className="records">
            {[...records].reverse().map((r) => (
              <article key={r.id}>
                <b className={`badge badge-${r.action}`}>{ACTION_LABEL[r.action]}</b>
                <div>
                  <h3>{r.segmentName}</h3>
                  <p>{r.reason}</p>
                  <time>{formatTime(r.at)}</time>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
