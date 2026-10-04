import { createSignal } from 'solid-js';

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}
export interface AuditEvent { id: string; at: string; issueId: string; message: string }
export interface SessionAnchor { anchorId: string | null; anchorIndex: number }
export interface WorkbenchState {
  version: 2;
  issues: AuditIssue[];
  events: AuditEvent[];
  session: SessionAnchor;
}

export const STATE_KEY = 'a11y-audit-v2';
export const LEGACY_STATE_KEY = 'a11y-audit-v1';
export const WRITES_KEY = 'a11y-audit-v2-writes';
/** 两个标签页写入同一问题的时间差小于该窗口即视为并发冲突 */
export const CONFLICT_WINDOW_MS = 10_000;
export const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `tab-${Math.random().toString(36).slice(2)}`;

/** 升级兜底：从第一条未关闭问题继续；全都已关闭则停在第一条 */
export function firstOpenAnchor(issues: AuditIssue[]): SessionAnchor {
  if (!issues.length) return { anchorId: null, anchorIndex: -1 };
  const open = issues.findIndex((issue) => issue.status !== 'closed');
  const index = open >= 0 ? open : 0;
  return { anchorId: issues[index].id, anchorIndex: index };
}

/** 顺序或状态改动后重算会话位置：同一问题优先，否则落到最近的条目 */
export function resolveAnchor(issues: AuditIssue[], anchor: SessionAnchor): SessionAnchor {
  if (!issues.length) return { anchorId: null, anchorIndex: -1 };
  const index = issues.findIndex((issue) => issue.id === anchor.anchorId);
  if (index >= 0) return { anchorId: anchor.anchorId, anchorIndex: index };
  const nearest = Math.min(Math.max(anchor.anchorIndex, 0), issues.length - 1);
  return { anchorId: issues[nearest].id, anchorIndex: nearest };
}

export interface LoadedState { state: WorkbenchState; migrated: boolean }

export function loadState(seed: WorkbenchState): LoadedState {
  if (typeof localStorage === 'undefined') return { state: seed, migrated: false };
  try {
    const rawV2 = localStorage.getItem(STATE_KEY);
    if (rawV2) {
      const parsed = JSON.parse(rawV2) as WorkbenchState;
      if (parsed?.version === 2 && Array.isArray(parsed.issues)) {
        return {
          state: {
            version: 2,
            issues: parsed.issues,
            events: Array.isArray(parsed.events) ? parsed.events : [],
            session: parsed.session?.anchorId !== undefined
              ? resolveAnchor(parsed.issues, parsed.session)
              : firstOpenAnchor(parsed.issues)
          },
          migrated: false
        };
      }
    }
    const rawV1 = localStorage.getItem(LEGACY_STATE_KEY);
    if (rawV1) {
      const legacy = JSON.parse(rawV1) as { issues?: AuditIssue[]; events?: AuditEvent[] };
      if (legacy && Array.isArray(legacy.issues)) {
        const migrated: WorkbenchState = {
          version: 2,
          issues: legacy.issues,
          events: Array.isArray(legacy.events) ? legacy.events : [],
          session: firstOpenAnchor(legacy.issues)
        };
        localStorage.setItem(STATE_KEY, JSON.stringify(migrated));
        localStorage.removeItem(LEGACY_STATE_KEY);
        return { state: migrated, migrated: true };
      }
    }
  } catch {
    /* 数据损坏时回退到种子数据 */
  }
  return { state: seed, migrated: false };
}

/* ------------------------------------------------------------------ */
/* 读屏播报队列：同批动作压成汇总，容量到顶时淘汰最不要紧的一条          */
/* ------------------------------------------------------------------ */

export type AnnouncePriority = 1 | 2 | 3; // 1 一般信息，2 状态/汇总，3 冲突
const QUEUE_CAPACITY = 3;
const BATCH_WINDOW_MS = 900;
const DRAIN_INTERVAL_MS = 1200;

interface QueuedAnnouncement { text: string; priority: AnnouncePriority }

export function createAnnouncer() {
  const [message, setMessage] = createSignal('');
  let queue: QueuedAnnouncement[] = [];
  let cooling = false;
  let batch: { count: number; lastText: string; priority: AnnouncePriority; timer: number } | null = null;

  const speak = (text: string) => {
    // 先清空再写入，保证相同文本也会被读屏重新播报
    setMessage('');
    window.setTimeout(() => setMessage(text), 40);
  };

  const tryDrain = () => {
    if (cooling || !queue.length) return;
    const next = queue.shift()!;
    speak(next.text);
    cooling = true;
    window.setTimeout(() => { cooling = false; tryDrain(); }, DRAIN_INTERVAL_MS);
  };

  const push = (text: string, priority: AnnouncePriority) => {
    if (queue.length >= QUEUE_CAPACITY) {
      const lowest = Math.min(...queue.map((item) => item.priority));
      if (priority < lowest) return; // 新来的最不要紧，直接丢弃
      // 淘汰队列里最旧的一条低优先级消息，把位置留给更要紧的
      queue.splice(queue.findIndex((item) => item.priority === lowest), 1);
    }
    queue.push({ text, priority });
    tryDrain();
  };

  const flushBatch = () => {
    if (!batch) return;
    window.clearTimeout(batch.timer);
    const { count, lastText, priority } = batch;
    batch = null;
    push(count > 1 ? `同批 ${count} 项操作已合并播报，最后一项：${lastText}` : lastText, priority);
  };

  /**
   * batchable 的消息在 BATCH_WINDOW_MS 内连续到达时压成一条汇总；
   * 非 batchable（如冲突）立即冲刷同批汇总并插队播报。
   */
  const announce = (text: string, priority: AnnouncePriority = 1, batchable = false) => {
    if (!batchable) {
      flushBatch();
      push(text, priority);
      return;
    }
    if (batch) {
      window.clearTimeout(batch.timer);
      batch.count += 1;
      batch.lastText = text;
      batch.priority = Math.max(batch.priority, priority) as AnnouncePriority;
      batch.timer = window.setTimeout(flushBatch, BATCH_WINDOW_MS);
    } else {
      batch = { count: 1, lastText: text, priority, timer: window.setTimeout(flushBatch, BATCH_WINDOW_MS) };
    }
  };

  return { message, announce };
}

/* ------------------------------------------------------------------ */
/* 跨标签页写入记录与冲突检测                                          */
/* ------------------------------------------------------------------ */

type WritesLog = Record<string, { tabId: string; at: number }>;

/** 本标签页最近写入的问题，用于识别“对方后到覆盖了我的修改” */
const myRecentWrites = new Map<string, number>();

function readWrites(): WritesLog {
  try { return JSON.parse(localStorage.getItem(WRITES_KEY) ?? '{}') as WritesLog; } catch { return {}; }
}

/** 本地写入前调用；若另一标签页刚写过同一问题，则本标签页是后到方，返回 conflict=true */
export function recordWrite(issueId: string): { conflict: boolean } {
  if (typeof localStorage === 'undefined') return { conflict: false };
  const now = Date.now();
  const log = readWrites();
  const previous = log[issueId];
  const conflict = !!previous && previous.tabId !== TAB_ID && now - previous.at < CONFLICT_WINDOW_MS;
  log[issueId] = { tabId: TAB_ID, at: now };
  for (const [id, entry] of Object.entries(log)) {
    if (now - entry.at > CONFLICT_WINDOW_MS * 6) delete log[id];
  }
  localStorage.setItem(WRITES_KEY, JSON.stringify(log));
  myRecentWrites.set(issueId, now);
  return { conflict };
}

export interface RemoteMerge {
  issues: AuditIssue[];
  events: AuditEvent[];
  changed: boolean;
  /** 本标签页最近也改过、却被对方后到覆盖的问题标题 */
  conflicts: string[];
}

/** 按问题逐条最后写入获胜合并；本标签页独有的问题保留，事件按 id 去重 */
export function mergeRemoteState(local: WorkbenchState, remote: WorkbenchState): RemoteMerge {
  const localById = new Map(local.issues.map((issue) => [issue.id, issue]));
  const conflicts: string[] = [];
  const now = Date.now();
  const merged: AuditIssue[] = [];
  const seen = new Set<string>();

  for (const remoteIssue of remote.issues) {
    seen.add(remoteIssue.id);
    const localIssue = localById.get(remoteIssue.id);
    if (!localIssue) { merged.push(remoteIssue); continue; }
    if (remoteIssue.updatedAt > localIssue.updatedAt) {
      const myWrite = myRecentWrites.get(remoteIssue.id);
      if (myWrite && now - myWrite < CONFLICT_WINDOW_MS) conflicts.push(remoteIssue.title);
      merged.push(remoteIssue);
    } else {
      merged.push(localIssue);
    }
  }
  for (const localIssue of local.issues) {
    if (!seen.has(localIssue.id)) merged.push(localIssue);
  }

  const eventIds = new Set<string>();
  const events = [...remote.events, ...local.events]
    .filter((event) => (eventIds.has(event.id) ? false : (eventIds.add(event.id), true)))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 50);

  const changed = JSON.stringify(merged) !== JSON.stringify(local.issues)
    || events.length !== local.events.length
    || events.some((event, index) => event.id !== local.events[index]?.id);

  return { issues: merged, events, changed, conflicts };
}
