import { FormEvent, useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  AudienceZone,
  CROSSWIND_LIMIT,
  SAFETY_GAP,
  STORAGE_KEY,
  Segment,
  VerdictRecord,
  buildReevaluation,
  evaluateSegment,
  falloutPos,
  latestBySegment,
  loadState,
  makeRevocation,
  makeVerdict,
  parseState,
  saveState,
  seedState,
  uid,
} from "./lib/clearance";

const project = {
  id: "hxyfront-62008",
  port: 62008,
  title: "焰火彩排放行台",
};

interface SegmentForm {
  name: string;
  windDir: string;
  windSpeed: string;
  axis: string;
  fallout: string;
}

const emptyForm: SegmentForm = {
  name: "",
  windDir: "270",
  windSpeed: "6",
  axis: "0",
  fallout: "80",
};

function fmtTime(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

function App() {
  const [state, setState] = useState(loadState);
  const { segments, audience, history } = state;

  const [form, setForm] = useState<SegmentForm>(emptyForm);
  const [formError, setFormError] = useState("");
  const [audienceDraft, setAudienceDraft] = useState(audience);
  const [lastReeval, setLastReeval] = useState("");

  // 放行表 / 冲突位置 / 浏览器存储同源：任何状态变化都写入 localStorage
  useEffect(() => {
    saveState(state);
  }, [state]);

  // 其他标签页改动存储时同步进来
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = parseState(e.newValue);
      if (next) {
        setState(next);
        setAudienceDraft(next.audience);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const latest = useMemo(() => latestBySegment(history), [history]);

  const rows = segments.map((seg) => ({
    seg,
    rec: latest.get(seg.id) ?? null,
    pos: falloutPos(seg),
  }));
  const clearedCount = rows.filter((r) => r.rec?.action === "放行").length;
  const pendingRows = rows.filter((r) => r.rec?.action === "退回");

  const audienceDirty =
    audienceDraft.x !== audience.x ||
    audienceDraft.y !== audience.y ||
    audienceDraft.radius !== audience.radius;

  function patchAudience(patch: Partial<AudienceZone>) {
    setAudienceDraft((d) => ({ ...d, ...patch }));
  }

  function commitAudience() {
    const next: AudienceZone = {
      x: Number(audienceDraft.x),
      y: Number(audienceDraft.y),
      radius: Number(audienceDraft.radius),
    };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.radius) || next.radius <= 0) {
      setLastReeval("观众区参数无效，未重新判定");
      return;
    }
    setState((prev) => {
      // 观众区变更影响全部段落：撤销有效放行 → 逐段重新判定，历史仅追加
      const additions = buildReevaluation(prev.segments, prev.history, next, "观众区调整后重新判定");
      const revoked = additions.filter((r) => r.action === "撤销").length;
      const rejected = additions.filter((r) => r.action === "退回").length;
      setLastReeval(
        `已重新判定 ${prev.segments.length} 段：撤销放行 ${revoked} 条，新放行 ${prev.segments.length - rejected} 段，退回待确认 ${rejected} 段`
      );
      return { ...prev, audience: next, history: [...prev.history, ...additions] };
    });
  }

  function addSegment(e: FormEvent) {
    e.preventDefault();
    const name = form.name.trim();
    const windDir = Number(form.windDir);
    const windSpeed = Number(form.windSpeed);
    const axis = Number(form.axis);
    const fallout = Number(form.fallout);
    if (!name) return setFormError("请填写段落名称");
    if (![windDir, windSpeed, axis, fallout].every(Number.isFinite)) return setFormError("风向、风速、射向、落点都必须是数字");
    if (windDir < 0 || windDir >= 360 || axis < 0 || axis >= 360) return setFormError("方位角需在 0–359° 之间");
    if (windSpeed < 0 || windSpeed > 60) return setFormError("风速需在 0–60 m/s 之间");
    if (fallout <= 0 || fallout > 600) return setFormError("最远落点需在 1–600 m 之间");

    const seg: Segment = { id: uid(), name, windDir, windSpeed, axis, fallout, createdAt: Date.now() };
    setState((prev) => ({
      ...prev,
      segments: [...prev.segments, seg],
      history: [...prev.history, makeVerdict(seg, prev.audience, "登记判定", Date.now())],
    }));
    setForm(emptyForm);
    setFormError("");
  }

  function reevaluateOne(seg: Segment) {
    setState((prev) => {
      const additions = buildReevaluation([seg], prev.history, prev.audience, "人工重新判定");
      return { ...prev, history: [...prev.history, ...additions] };
    });
  }

  function removeSegment(seg: Segment) {
    setState((prev) => {
      const cur = latestBySegment(prev.history).get(seg.id);
      const additions: VerdictRecord[] =
        cur?.action === "放行" ? [makeRevocation(cur, "段落已移除，原放行作废", Date.now())] : [];
      return {
        ...prev,
        segments: prev.segments.filter((s) => s.id !== seg.id),
        history: [...prev.history, ...additions],
      };
    });
  }

  function resetAll() {
    if (!window.confirm("确定清空全部段落与判定历史，并恢复示例数据？")) return;
    const fresh = seedState();
    setState(fresh);
    setAudienceDraft(fresh.audience);
    setLastReeval("");
  }

  // 平面图范围：容纳观众区（含 30 m 安全缓冲）与全部落点
  const mapExtent = useMemo(() => {
    let m = 130;
    m = Math.max(m, Math.hypot(audience.x, audience.y) + audience.radius + SAFETY_GAP + 20);
    for (const seg of segments) {
      const p = falloutPos(seg);
      m = Math.max(m, Math.hypot(p.x, p.y) + 25);
    }
    return Math.ceil(m / 10) * 10;
  }, [segments, audience]);

  const rings = useMemo(() => {
    const list: number[] = [];
    for (let r = 30; r < mapExtent; r += 30) list.push(r);
    return list;
  }, [mapExtent]);

  return (
    <main className="app">
      <section className="hero">
        <p>
          {project.id} · Port {project.port} · 彩排放行管控
        </p>
        <h1>{project.title}</h1>
        <span>
          每个节目段登记风向、风速、射向与最远落点，并按当前观众区边缘判定：侧风分量超过 {CROSSWIND_LIMIT} m/s
          或落点距观众区不足 {SAFETY_GAP} m 时，整段退回待确认并保留原因。调整观众区后全部段落重新判定，
          原放行记录逐条撤销，判定历史仅追加、不覆盖，数据写入浏览器存储，刷新后保留。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>节目段</small>
          <strong>{segments.length}</strong>
        </article>
        <article>
          <small>已放行</small>
          <strong>{clearedCount}</strong>
        </article>
        <article>
          <small>待确认</small>
          <strong>{pendingRows.length}</strong>
        </article>
        <article>
          <small>判定记录</small>
          <strong>{history.length}</strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="side">
          <div className="panel">
            <div className="heading">
              <div>
                <p>观众区</p>
                <h2>观众区设置</h2>
              </div>
            </div>
            <div className="field-grid single">
              <label>
                <span>中心 X（m）</span>
                <input
                  type="number"
                  value={audienceDraft.x}
                  onChange={(e) => patchAudience({ x: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>中心 Y（m）</span>
                <input
                  type="number"
                  value={audienceDraft.y}
                  onChange={(e) => patchAudience({ y: Number(e.target.value) })}
                />
              </label>
              <label>
                <span>半径（m，边缘即周界）</span>
                <input
                  type="number"
                  min={5}
                  value={audienceDraft.radius}
                  onChange={(e) => patchAudience({ radius: Number(e.target.value) })}
                />
              </label>
            </div>
            <button className="primary block" onClick={commitAudience} disabled={!audienceDirty}>
              更新观众区并重新判定全部段落
            </button>
            {lastReeval && <p className="note">{lastReeval}</p>}
            <p className="note dim">提交后受影响段落重新判定，原放行记录追加撤销，历史不覆盖。</p>
          </div>

          <div className="panel">
            <div className="heading">
              <div>
                <p>段落登记</p>
                <h2>新增节目段</h2>
              </div>
            </div>
            <form onSubmit={addSegment} className="field-grid single">
              <label>
                <span>段落名称</span>
                <input
                  value={form.name}
                  placeholder="如：高潮·金冠"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                <span>风向（来向方位角 °）</span>
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={form.windDir}
                  onChange={(e) => setForm({ ...form, windDir: e.target.value })}
                />
              </label>
              <label>
                <span>风速（m/s）</span>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={form.windSpeed}
                  onChange={(e) => setForm({ ...form, windSpeed: e.target.value })}
                />
              </label>
              <label>
                <span>射向方位角（°）</span>
                <input
                  type="number"
                  min={0}
                  max={359}
                  value={form.axis}
                  onChange={(e) => setForm({ ...form, axis: e.target.value })}
                />
              </label>
              <label>
                <span>最远落点（m，沿射向）</span>
                <input
                  type="number"
                  min={1}
                  value={form.fallout}
                  onChange={(e) => setForm({ ...form, fallout: e.target.value })}
                />
              </label>
              {formError && <p className="error">{formError}</p>}
              <button className="primary block" type="submit">
                登记并判定
              </button>
            </form>
          </div>
        </aside>

        <section className="panel">
          <div className="heading">
            <div>
              <p>冲突位置</p>
              <h2>燃放点位平面图</h2>
            </div>
            <button onClick={resetAll}>清空并重置</button>
          </div>
          <div className="map-wrap">
            <svg viewBox={`${-mapExtent} ${-mapExtent} ${mapExtent * 2} ${mapExtent * 2}`} role="img">
              {rings.map((r) => (
                <circle key={r} className="ring" cx={0} cy={0} r={r} />
              ))}
              <line className="axis-line" x1={-mapExtent} y1={0} x2={mapExtent} y2={0} />
              <line className="axis-line" x1={0} y1={-mapExtent} x2={0} y2={mapExtent} />

              {/* 观众区与 30 m 安全缓冲 */}
              <circle
                className="audience-buffer"
                cx={audience.x}
                cy={-audience.y}
                r={audience.radius + SAFETY_GAP}
              />
              <circle className="audience" cx={audience.x} cy={-audience.y} r={audience.radius} />
              <text className="map-label" x={audience.x} y={-audience.y} textAnchor="middle">
                观众区
              </text>

              {/* 发射点 */}
              <rect className="launch" x={-4} y={-4} width={8} height={8} />
              <text className="map-label" x={8} y={-8}>
                发射点
              </text>

              {rows.map(({ seg, rec, pos }) => {
                const ok = rec?.action === "放行";
                return (
                  <g key={seg.id}>
                    <line className={`shot ${ok ? "ok" : "bad"}`} x1={0} y1={0} x2={pos.x} y2={-pos.y} />
                    <circle className={`fallout ${ok ? "ok" : "bad"}`} cx={pos.x} cy={-pos.y} r={5} />
                    <text className="map-label" x={pos.x + 8} y={-pos.y + 4}>
                      {seg.name}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="legend">
              <span>
                <i className="dot ok" /> 放行落点
              </span>
              <span>
                <i className="dot bad" /> 退回落点（冲突）
              </span>
              <span>
                <i className="dot zone" /> 观众区
              </span>
              <span>
                <i className="dot buffer" /> {SAFETY_GAP} m 安全缓冲
              </span>
            </div>
          </div>

          <div className="conflicts">
            <h3>当前冲突位置（{pendingRows.length}）</h3>
            {pendingRows.length === 0 && <p className="note dim">当前无退回段落，全部落点满足安全间距与侧风限制。</p>}
            {pendingRows.map(({ seg, rec, pos }) => (
              <article key={seg.id} className="conflict-item">
                <b>{seg.name}</b>
                <span>
                  落点 ({pos.x.toFixed(0)}, {pos.y.toFixed(0)}) m · 距观众区边缘{" "}
                  {rec ? rec.gap.toFixed(0) : "-"} m · 侧风 {rec ? rec.crosswind.toFixed(1) : "-"} m/s
                </span>
                <span className="reasons">{rec?.reasons.join("；")}</span>
              </article>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>放行表</p>
            <h2>段落放行状态</h2>
          </div>
          <span className="note dim">
            阈值：侧风 ≤ {CROSSWIND_LIMIT} m/s · 落点距观众区 ≥ {SAFETY_GAP} m
          </span>
        </div>
        <div className="table-wrap">
          <table className="clearance-table">
            <thead>
              <tr>
                <th>段落</th>
                <th>风向/风速</th>
                <th>射向</th>
                <th>侧风分量</th>
                <th>落点坐标</th>
                <th>距观众区边缘</th>
                <th>状态</th>
                <th>原因 / 备注</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ seg, rec, pos }) => {
                const live = evaluateSegment(seg, audience);
                const ok = rec?.action === "放行";
                return (
                  <tr key={seg.id} className={ok ? "" : "pending"}>
                    <td>{seg.name}</td>
                    <td>
                      {seg.windDir}° / {seg.windSpeed} m/s
                    </td>
                    <td>{seg.axis}°</td>
                    <td className={live.crosswind > CROSSWIND_LIMIT ? "bad-num" : ""}>
                      {live.crosswind.toFixed(1)} m/s
                    </td>
                    <td>
                      ({pos.x.toFixed(0)}, {pos.y.toFixed(0)})
                    </td>
                    <td className={live.gap < SAFETY_GAP ? "bad-num" : ""}>
                      {live.gap < 0 ? `进入 ${Math.abs(live.gap).toFixed(0)} m` : `${live.gap.toFixed(0)} m`}
                    </td>
                    <td>
                      <span className={`badge ${ok ? "ok" : "warn"}`}>{ok ? "放行" : "待确认"}</span>
                    </td>
                    <td className="reasons">{ok ? rec?.note ?? "—" : rec?.reasons.join("；") || "—"}</td>
                    <td className="ops">
                      <button onClick={() => reevaluateOne(seg)}>重新判定</button>
                      <button className="danger" onClick={() => removeSegment(seg)}>
                        移除
                      </button>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="note dim">
                    暂无段落，请在左侧登记。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>判定历史</p>
            <h2>放行 / 退回 / 撤销记录</h2>
          </div>
          <span className="note dim">仅追加，不覆盖 · 共 {history.length} 条</span>
        </div>
        <div className="log">
          {[...history].reverse().map((rec) => (
            <article key={rec.id} className={`log-item ${rec.action}`}>
              <span className={`badge ${rec.action === "放行" ? "ok" : rec.action === "退回" ? "warn" : "muted"}`}>
                {rec.action}
              </span>
              <div>
                <b>{rec.segmentName}</b>
                <p>
                  {rec.reasons.length > 0 ? rec.reasons.join("；") : rec.note}
                  {rec.action !== "放行" && rec.note && rec.reasons[0] !== rec.note ? `（${rec.note}）` : ""}
                </p>
                <small>
                  {fmtTime(rec.at)} · 侧风 {rec.crosswind.toFixed(1)} m/s · 距观众区边缘 {rec.gap.toFixed(0)} m ·
                  观众区 ({rec.audience.x}, {rec.audience.y}) r={rec.audience.radius} m
                </small>
              </div>
            </article>
          ))}
          {history.length === 0 && <p className="note dim">暂无判定记录。</p>}
        </div>
      </section>
    </main>
  );
}

export default App;
