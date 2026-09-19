// 焰火彩排放行台 · 判定领域逻辑
// 规则：侧风分量 > 8 m/s，或最远落点距观众区边缘 < 30 m，整段退回待确认并保留原因。
// 判定记录（放行/退回/撤销）仅追加，历史永不覆盖。

export const CROSSWIND_LIMIT = 8; // m/s，侧风上限（超过即退回）
export const SAFETY_GAP = 30; // m，落点距观众区边缘最小间距（不足即退回）
export const STORAGE_KEY = "fireworks-clearance-v1";

export interface AudienceZone {
  x: number; // 观众区中心，平面坐标 m
  y: number;
  radius: number; // 观众区半径 m，边缘 = 圆周四至
}

export interface Segment {
  id: string;
  name: string;
  windDir: number; // 风向（来向）方位角，度
  windSpeed: number; // 风速 m/s
  axis: number; // 射向方位角，度
  fallout: number; // 最远落点距离（沿射向），m
  createdAt: number;
}

export type VerdictAction = "放行" | "退回" | "撤销";

export interface VerdictRecord {
  id: string;
  segmentId: string;
  segmentName: string;
  action: VerdictAction;
  reasons: string[]; // 退回/撤销原因，放行时为空
  crosswind: number; // 判定时侧风分量 m/s
  gap: number; // 判定时落点距观众区边缘 m（负值 = 落点进入观众区）
  audience: AudienceZone; // 判定所依据的观众区快照
  at: number;
  note: string;
}

export interface PersistedState {
  segments: Segment[];
  audience: AudienceZone;
  history: VerdictRecord[]; // 仅追加
}

export function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 最远落点平面坐标：发射点为原点，沿射向方位角量取 */
export function falloutPos(seg: Segment): { x: number; y: number } {
  const rad = (seg.axis * Math.PI) / 180;
  return { x: seg.fallout * Math.cos(rad), y: seg.fallout * Math.sin(rad) };
}

/** 侧风分量 = |风速 × sin(风向 − 射向)| */
export function crosswindOf(seg: Segment): number {
  const delta = ((seg.windDir - seg.axis) * Math.PI) / 180;
  return Math.abs(seg.windSpeed * Math.sin(delta));
}

/** 落点距观众区边缘的有符号间距 m，负值表示落点进入观众区 */
export function gapToAudience(seg: Segment, audience: AudienceZone): number {
  const p = falloutPos(seg);
  return Math.hypot(p.x - audience.x, p.y - audience.y) - audience.radius;
}

export interface Evaluation {
  crosswind: number;
  gap: number;
  reasons: string[];
  pass: boolean;
}

export function evaluateSegment(seg: Segment, audience: AudienceZone): Evaluation {
  const crosswind = crosswindOf(seg);
  const gap = gapToAudience(seg, audience);
  const reasons: string[] = [];
  if (crosswind > CROSSWIND_LIMIT) {
    reasons.push(`侧风 ${crosswind.toFixed(1)} m/s 超过 ${CROSSWIND_LIMIT} m/s 上限`);
  }
  if (gap < SAFETY_GAP) {
    reasons.push(
      gap < 0
        ? `落点进入观众区 ${Math.abs(gap).toFixed(0)} m`
        : `落点距观众区仅 ${gap.toFixed(0)} m，不足 ${SAFETY_GAP} m`
    );
  }
  return { crosswind, gap, reasons, pass: reasons.length === 0 };
}

/** 每个段落的最新一条判定记录 */
export function latestBySegment(history: VerdictRecord[]): Map<string, VerdictRecord> {
  const map = new Map<string, VerdictRecord>();
  for (const rec of history) map.set(rec.segmentId, rec);
  return map;
}

export function makeVerdict(
  seg: Segment,
  audience: AudienceZone,
  note: string,
  at: number
): VerdictRecord {
  const ev = evaluateSegment(seg, audience);
  return {
    id: uid(),
    segmentId: seg.id,
    segmentName: seg.name,
    action: ev.pass ? "放行" : "退回",
    reasons: ev.reasons,
    crosswind: ev.crosswind,
    gap: ev.gap,
    audience: { ...audience },
    at,
    note,
  };
}

/** 撤销不删除原记录，而是追加一条撤销记录，保留被撤销时的数值快照 */
export function makeRevocation(prev: VerdictRecord, note: string, at: number): VerdictRecord {
  return {
    id: uid(),
    segmentId: prev.segmentId,
    segmentName: prev.segmentName,
    action: "撤销",
    reasons: [note],
    crosswind: prev.crosswind,
    gap: prev.gap,
    audience: { ...prev.audience },
    at,
    note,
  };
}

/**
 * 重新判定一组段落：凡当前持有有效放行的段落先追加撤销记录，
 * 再按给定观众区追加新判定。返回待追加的记录序列。
 */
export function buildReevaluation(
  segs: Segment[],
  history: VerdictRecord[],
  audience: AudienceZone,
  note: string
): VerdictRecord[] {
  const latest = latestBySegment(history);
  const now = Date.now();
  const out: VerdictRecord[] = [];
  segs.forEach((seg, i) => {
    const cur = latest.get(seg.id);
    if (cur?.action === "放行") {
      out.push(makeRevocation(cur, "观众区调整，原放行记录撤销", now + i * 2));
    }
    out.push(makeVerdict(seg, audience, note, now + i * 2 + 1));
  });
  return out;
}

function isAudience(a: unknown): a is AudienceZone {
  const z = a as AudienceZone;
  return !!z && Number.isFinite(z.x) && Number.isFinite(z.y) && Number.isFinite(z.radius) && z.radius > 0;
}

function isSegment(s: unknown): s is Segment {
  const g = s as Segment;
  return (
    !!g &&
    typeof g.id === "string" &&
    typeof g.name === "string" &&
    Number.isFinite(g.windDir) &&
    Number.isFinite(g.windSpeed) &&
    Number.isFinite(g.axis) &&
    Number.isFinite(g.fallout)
  );
}

export function parseState(raw: string | null): PersistedState | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as PersistedState;
    if (!Array.isArray(data.segments) || !Array.isArray(data.history) || !isAudience(data.audience)) {
      return null;
    }
    if (!data.segments.every(isSegment)) return null;
    return data;
  } catch {
    return null;
  }
}

export function loadState(): PersistedState {
  try {
    return parseState(localStorage.getItem(STORAGE_KEY)) ?? seedState();
  } catch {
    return seedState();
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默降级，页面内状态仍可用
  }
}

/** 初始示例：两段放行、两段因不同原因退回，便于打开页面即看到完整流程 */
export function seedState(): PersistedState {
  const audience: AudienceZone = { x: 100, y: -80, radius: 40 };
  const base = Date.now();
  const seeds: Array<Omit<Segment, "id" | "createdAt">> = [
    { name: "开场·银尾柳", windDir: 270, windSpeed: 6, axis: 0, fallout: 60 },
    { name: "过渡·红牡丹", windDir: 0, windSpeed: 12, axis: 45, fallout: 90 },
    { name: "高潮·金冠", windDir: 180, windSpeed: 4, axis: 270, fallout: 70 },
    { name: "尾声·冷焰瀑布", windDir: 90, windSpeed: 3, axis: 315, fallout: 110 },
  ];
  const segments: Segment[] = seeds.map((s, i) => ({
    ...s,
    id: uid(),
    createdAt: base + i,
  }));
  const history = segments.map((seg, i) => makeVerdict(seg, audience, "初始登记判定", base + i));
  return { segments, audience, history };
}
