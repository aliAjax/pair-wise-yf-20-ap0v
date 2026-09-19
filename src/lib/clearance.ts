/**
 * 焰火彩排放行台 —— 判定规则与留痕模型
 *
 * 规则：
 *  - 侧风分量 > 8 m/s，整段退回待确认并保留原因
 *  - 落点距观众区 < 30 m，整段退回待确认并保留原因
 *  - 观众区变更后受影响段落重新判定，原放行记录撤销；记录只追加、不覆盖
 */

export const CROSSWIND_LIMIT = 8; // m/s，侧风上限（超过即退回）
export const CLEARANCE_LIMIT = 30; // m，落点距观众区最小间距（不足即退回）

export interface Segment {
  id: string;
  name: string;
  /** 风向与发射轴线（发射点指向观众区）的夹角，0–180° */
  windDirection: number;
  /** 风速 m/s */
  windSpeed: number;
  /** 最远落点距发射点 m */
  landingPoint: number;
  /** 观众区边缘距发射点 m */
  audienceEdge: number;
}

export type RecordAction = "cleared" | "revoked" | "returned";

export interface ClearanceRecord {
  id: string;
  segmentId: string;
  /** 段落名快照：段落被删除后历史仍可读 */
  segmentName: string;
  action: RecordAction;
  reason: string;
  at: number;
}

export const ACTION_LABEL: Record<RecordAction, string> = {
  cleared: "放行",
  revoked: "撤销",
  returned: "退回",
};

/** 侧风分量 = 风速 × sin(风向夹角) */
export function crosswindOf(s: Pick<Segment, "windDirection" | "windSpeed">): number {
  const rad = (s.windDirection * Math.PI) / 180;
  return s.windSpeed * Math.abs(Math.sin(rad));
}

/** 落点距观众区边缘的间距（负值表示落点越过观众区边缘） */
export function clearanceOf(s: Pick<Segment, "landingPoint" | "audienceEdge">): number {
  return s.audienceEdge - s.landingPoint;
}

/** 判定一个节目段，返回违规原因列表；空数组表示判定通过 */
export function evaluateSegment(s: Segment): string[] {
  const reasons: string[] = [];
  const crosswind = crosswindOf(s);
  if (crosswind > CROSSWIND_LIMIT) {
    reasons.push(`侧风 ${crosswind.toFixed(1)} m/s 超过 ${CROSSWIND_LIMIT} m/s 上限`);
  }
  const gap = clearanceOf(s);
  if (gap < CLEARANCE_LIMIT) {
    reasons.push(
      gap >= 0
        ? `落点距观众区 ${formatMeters(gap)}，不足 ${CLEARANCE_LIMIT} m`
        : `落点越过观众区边缘 ${formatMeters(-gap)}`
    );
  }
  return reasons;
}

/** 描述两次登记之间的字段变化，用于撤销原因留痕 */
export function describeChanges(prev: Segment, next: Segment): string {
  const parts: string[] = [];
  if (prev.windDirection !== next.windDirection) {
    parts.push(`风向 ${prev.windDirection}°→${next.windDirection}°`);
  }
  if (prev.windSpeed !== next.windSpeed) {
    parts.push(`风速 ${prev.windSpeed}→${next.windSpeed} m/s`);
  }
  if (prev.landingPoint !== next.landingPoint) {
    parts.push(`落点 ${prev.landingPoint}→${next.landingPoint} m`);
  }
  if (prev.audienceEdge !== next.audienceEdge) {
    parts.push(`观众区边缘 ${prev.audienceEdge}→${next.audienceEdge} m`);
  }
  return parts.length > 0 ? parts.join("，") : "参数无变化";
}

export function formatMeters(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} m`;
}

export function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- 浏览器存储 ----------

const STORAGE_KEY = "hxyfront-62008:firework-clearance:v1";

export interface PersistedState {
  segments: Segment[];
  records: ClearanceRecord[];
}

function seedState(): PersistedState {
  const intro: Segment = {
    id: makeId(),
    name: "开场 Intro",
    windDirection: 20,
    windSpeed: 4,
    landingPoint: 60,
    audienceEdge: 120,
  };
  const chorus: Segment = {
    id: makeId(),
    name: "合唱 Chorus A",
    windDirection: 65,
    windSpeed: 9.5,
    landingPoint: 70,
    audienceEdge: 130,
  };
  const interlude: Segment = {
    id: makeId(),
    name: "间奏 Interlude",
    windDirection: 0,
    windSpeed: 6,
    landingPoint: 50,
    audienceEdge: 110,
  };
  const finale: Segment = {
    id: makeId(),
    name: "终场 Finale",
    windDirection: 10,
    windSpeed: 3,
    landingPoint: 95,
    audienceEdge: 120,
  };
  return {
    segments: [intro, chorus, interlude, finale],
    records: [
      {
        id: makeId(),
        segmentId: interlude.id,
        segmentName: interlude.name,
        action: "cleared",
        reason: "判定通过，彩排前放行",
        at: Date.now() - 1000 * 60 * 12,
      },
    ],
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSegment(value: unknown): value is Segment {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === "string" &&
    typeof s.name === "string" &&
    isFiniteNumber(s.windDirection) &&
    isFiniteNumber(s.windSpeed) &&
    isFiniteNumber(s.landingPoint) &&
    isFiniteNumber(s.audienceEdge)
  );
}

function isRecord(value: unknown): value is ClearanceRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.segmentId === "string" &&
    typeof r.segmentName === "string" &&
    (r.action === "cleared" || r.action === "revoked" || r.action === "returned") &&
    typeof r.reason === "string" &&
    isFiniteNumber(r.at)
  );
}

/** 从 localStorage 恢复；数据缺失或损坏时回退到示例数据 */
export function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      segments: Array.isArray(parsed.segments) ? parsed.segments.filter(isSegment) : [],
      records: Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [],
    };
  } catch {
    return seedState();
  }
}

export function saveState(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用（如隐私模式）时静默失败，页面功能不受影响
  }
}
