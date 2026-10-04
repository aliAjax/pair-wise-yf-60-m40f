/**
 * 工作台纯逻辑：数据迁移、会话位置重算、播报队列、跨标签页三路合并。
 * 不依赖 Solid 与 DOM，便于单独验证。
 */

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

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

export interface WorkbenchState {
  version: number;
  issues: AuditIssue[];
  events: AuditEvent[];
}

export interface SessionState {
  /** 会话焦点所在问题 id；为空表示列表无条目 */
  focusedIssueId: string | null;
}

export const STORAGE_KEY = 'a11y-audit-v1';
export const SESSION_KEY = 'a11y-audit-session-v1';
export const STATE_VERSION = 2;
export const ANNOUNCE_QUEUE_CAPACITY = 5;

/** 状态流转顺序：未关闭的问题排在前面，已关闭沉底 */
export const STATUS_FLOW: IssueStatus[] = ['open', 'reopened', 'triaged', 'fixing', 'verifying', 'closed'];

export function statusRank(status: IssueStatus): number {
  const index = STATUS_FLOW.indexOf(status);
  return index === -1 ? STATUS_FLOW.length : index;
}

export function sortIssues(issues: AuditIssue[]): AuditIssue[] {
  return [...issues].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function seedState(): WorkbenchState {
  return {
    version: STATE_VERSION,
    issues: [
      {
        id: 'issue-1',
        title: '结算弹窗关闭后焦点丢失',
        flow: '订单结算',
        steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
        impactGroup: '键盘与读屏用户',
        severity: 'serious',
        status: 'triaged',
        fixNote: '',
        retestNote: '',
        updatedAt: new Date(Date.now() - 3600_000).toISOString()
      },
      {
        id: 'issue-2',
        title: '错误提示未与输入框关联',
        flow: '账户设置',
        steps: '输入无效手机号后使用读屏读取输入框',
        impactGroup: '读屏用户',
        severity: 'moderate',
        status: 'fixing',
        fixNote: '已增加 aria-describedby，等待构建',
        retestNote: '',
        updatedAt: new Date(Date.now() - 7200_000).toISOString()
      }
    ],
    events: [
      { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ]
  };
}

/** 旧数据迁移：v1 数据没有 version 字段，结构兼容，升级版本号即可；损坏数据回退种子 */
export function migrate(raw: unknown): WorkbenchState {
  if (raw && typeof raw === 'object' && Array.isArray((raw as { issues?: unknown }).issues)) {
    const v = raw as { issues: AuditIssue[]; events?: AuditEvent[] };
    return { version: STATE_VERSION, issues: v.issues, events: Array.isArray(v.events) ? v.events : [] };
  }
  return seedState();
}

/** 旧数据缺会话位置：升级后从第一条未关闭问题继续 */
export function initialSession(state: WorkbenchState): SessionState {
  const firstOpen = state.issues.find((issue) => issue.status !== 'closed');
  return { focusedIssueId: firstOpen?.id ?? state.issues[0]?.id ?? null };
}

export function isValidSession(value: unknown): value is SessionState {
  return !!value && typeof value === 'object' && ('focusedIssueId' in value) &&
    (typeof (value as SessionState).focusedIssueId === 'string' || (value as SessionState).focusedIssueId === null);
}

/**
 * 顺序或状态改动后重算会话位置：
 * 焦点问题仍在列表中则落回同一问题，否则落到同索引或最近条目。
 */
export function recomputePosition(issues: AuditIssue[], prevId: string | null, prevOrder: string[]): string | null {
  if (issues.length === 0) return null;
  if (prevId && issues.some((issue) => issue.id === prevId)) return prevId;
  const index = prevOrder.indexOf(prevId ?? '');
  const safe = Math.min(index < 0 ? 0 : index, issues.length - 1);
  return issues[safe].id;
}

export type AnnouncePriority = 'critical' | 'summary' | 'normal';

export interface Announcement {
  id: string;
  message: string;
  priority: AnnouncePriority;
  at: number;
}

const PRIORITY_RANK: Record<AnnouncePriority, number> = { critical: 3, summary: 2, normal: 1 };

/**
 * 播报队列：容量到顶时淘汰最不要紧的一条（同优先级去最旧），
 * 保证最要紧的播报不被挤出。
 */
export function enqueueAnnouncement(
  queue: Announcement[],
  input: { message: string; priority: AnnouncePriority },
  now: number = Date.now()
): Announcement[] {
  const next = [...queue, { id: crypto.randomUUID(), at: now, ...input }];
  if (next.length <= ANNOUNCE_QUEUE_CAPACITY) return next;
  let drop = 0;
  for (let i = 1; i < next.length; i++) {
    const victim = next[drop];
    const candidate = next[i];
    if (
      PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[victim.priority] ||
      (PRIORITY_RANK[candidate.priority] === PRIORITY_RANK[victim.priority] && candidate.at < victim.at)
    ) {
      drop = i;
    }
  }
  next.splice(drop, 1);
  return next;
}

export interface MergeResult {
  state: WorkbenchState;
  /** 两边都改过同一问题的 id 列表（后到方获胜） */
  conflicts: string[];
}

/**
 * 三路合并：base 为上次同步基线，local 为本标签页状态，remote 为他标签页状态。
 * 仅当某问题相对基线被两边都修改时才算冲突，比较 updatedAt 保留较新修改；
 * 只有一边修改时直接采纳，避免把他标签页的过期回显当成新状态。
 */
export function mergeStates(base: WorkbenchState, local: WorkbenchState, remote: WorkbenchState): MergeResult {
  const conflicts: string[] = [];
  const mergedIssues: AuditIssue[] = [];

  for (const remoteIssue of remote.issues) {
    const localIssue = local.issues.find((issue) => issue.id === remoteIssue.id);
    const baseIssue = base.issues.find((issue) => issue.id === remoteIssue.id);
    const localChanged = !!localIssue && !!baseIssue && localIssue.updatedAt !== baseIssue.updatedAt;
    const remoteChanged = !baseIssue || remoteIssue.updatedAt !== baseIssue.updatedAt;

    if (localChanged && remoteChanged) {
      conflicts.push(remoteIssue.id);
      mergedIssues.push(remoteIssue.updatedAt >= localIssue!.updatedAt ? remoteIssue : localIssue!);
    } else if (remoteChanged) {
      // 远端有改动但比本地旧，说明是过期回显，保留本地
      mergedIssues.push(remoteIssue.updatedAt >= (localIssue?.updatedAt ?? '') ? remoteIssue : localIssue!);
    } else if (localIssue) {
      mergedIssues.push(localIssue);
    }
  }

  for (const localIssue of local.issues) {
    if (!remote.issues.some((issue) => issue.id === localIssue.id)) mergedIssues.push(localIssue);
  }
  for (const remoteIssue of remote.issues) {
    if (!local.issues.some((issue) => issue.id === remoteIssue.id)) mergedIssues.push(remoteIssue);
  }

  const eventMap = new Map<string, AuditEvent>();
  for (const event of [...remote.events, ...local.events]) eventMap.set(event.id, event);
  const events = [...eventMap.values()].sort((a, b) => b.at.localeCompare(a.at));

  return { state: { version: STATE_VERSION, issues: mergedIssues, events }, conflicts };
}
