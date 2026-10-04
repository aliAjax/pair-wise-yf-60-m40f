/**
 * 工作台会话：问题列表、状态操作与读屏播报的稳定会话层。
 * - 状态改动后重算会话位置，焦点落回同一问题或最近条目
 * - 播报走优先级队列，同批动作压成汇总，容量到顶只留最要紧一条
 * - 两个标签页同时修改同一问题时三路合并，后到方保留位置并提示冲突
 * - 旧数据缺会话位置，升级后从第一条未关闭问题继续
 */
import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import {
  ANNOUNCE_QUEUE_CAPACITY,
  STORAGE_KEY,
  SESSION_KEY,
  enqueueAnnouncement,
  initialSession,
  isValidSession,
  mergeStates,
  migrate,
  recomputePosition,
  seedState,
  type Announcement,
  type AnnouncePriority,
  type SessionState,
  type WorkbenchState
} from './workbench';

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seedState();
  try {
    return migrate(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return seedState();
  }
}

function loadSession(state: WorkbenchState): SessionState {
  if (typeof localStorage === 'undefined') return initialSession(state);
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    return isValidSession(raw) ? raw : initialSession(state);
  } catch {
    return initialSession(state);
  }
}

export function useWorkbench() {
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [session, setSession] = createSignal<SessionState>(loadSession(state));
  const [announcements, setAnnouncements] = createSignal<Announcement[]>([]);
  const [syncing, setSyncing] = createSignal(false);

  /** 上次同步基线，用于跨标签页三路合并 */
  let lastSynced: WorkbenchState = state;
  let applyingRemote = false;

  const persist = (s: WorkbenchState) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
      /* 隐私模式等场景下忽略持久化失败 */
    }
  };
  const persistSession = (s: SessionState) => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch {
      /* 忽略会话位置写入失败 */
    }
  };

  const announce = (message: string, priority: AnnouncePriority = 'normal') =>
    setAnnouncements((queue) => enqueueAnnouncement(queue, { message, priority }));

  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('a11y-audit-v1') : null;

  const applyRemote = (remote: WorkbenchState) => {
    if (applyingRemote) return;
    applyingRemote = true;
    setSyncing(true);
    const prevOrder = state.issues.map((issue) => issue.id);
    const { state: merged, conflicts } = mergeStates(lastSynced, state, remote);
    for (const id of conflicts) {
      const remoteIssue = remote.issues.find((issue) => issue.id === id);
      const localIssue = state.issues.find((issue) => issue.id === id);
      // 本标签页落败（远端较新）时才提示冲突，避免两边重复播报
      if (remoteIssue && localIssue && remoteIssue.updatedAt > localIssue.updatedAt) {
        announce(`冲突：另一标签页也修改了《${remoteIssue.title}》，已保留较新修改`, 'critical');
      }
    }
    setState(merged);
    lastSynced = merged;
    const pos = recomputePosition(merged.issues, session().focusedIssueId, prevOrder);
    setSession({ focusedIssueId: pos });
    persist(merged);
    window.setTimeout(() => setSyncing(false), 300);
    applyingRemote = false;
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      applyRemote(JSON.parse(event.newValue) as WorkbenchState);
    } catch {
      /* 忽略损坏的远端数据 */
    }
  };

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'state-sync') applyRemote(event.data.state as WorkbenchState);
    };
  }

  /**
   * 执行一次本地状态变更：重算会话位置、持久化、广播，并把播报压入队列。
   * 批量动作只传一条汇总播报，不逐条播报。
   */
  const mutate = (recipe: (draft: WorkbenchState) => void, message?: string, priority: AnnouncePriority = 'normal') => {
    const prevOrder = state.issues.map((issue) => issue.id);
    setState(produce(recipe));
    const pos = recomputePosition(state.issues, session().focusedIssueId, prevOrder);
    setSession({ focusedIssueId: pos });
    persist(state);
    try {
      channel?.postMessage({ type: 'state-sync', state });
    } catch {
      /* 广播失败不影响本地操作 */
    }
    if (message) announce(message, priority);
  };

  // 会话位置持久化：重载后从同一问题继续
  createEffect(() => persistSession(session()));

  // 播报轮换：每条停留 4 秒后出队；队列空时 live region 清空。
  // 仅在浏览器端运行（SSR 时 window 不存在）。
  createEffect(() => {
    if (typeof window === 'undefined' || announcements().length === 0) return;
    const timer = window.setTimeout(() => setAnnouncements((queue) => queue.slice(1)), 4000);
    onCleanup(() => window.clearTimeout(timer));
  });

  // 跨标签页监听只在客户端挂载后启用
  onMount(() => {
    window.addEventListener('storage', onStorage);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
      channel?.close();
    });
  });

  return { state, session, setSession, announcements, syncing, mutate, announce, queueCapacity: ANNOUNCE_QUEUE_CAPACITY };
}
