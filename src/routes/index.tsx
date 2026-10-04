import { For, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  STATE_KEY,
  createAnnouncer,
  firstOpenAnchor,
  loadState,
  mergeRemoteState,
  recordWrite,
  resolveAnchor,
  type AuditEvent,
  type AuditIssue,
  type IssueStatus,
  type SessionAnchor,
  type Severity,
  type WorkbenchState
} from '../lib/audit-session';

const seedIssues: AuditIssue[] = [
  { id: 'issue-1', title: '结算弹窗关闭后焦点丢失', flow: '订单结算', steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点', impactGroup: '键盘与读屏用户', severity: 'serious', status: 'triaged', fixNote: '', retestNote: '', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
  { id: 'issue-2', title: '错误提示未与输入框关联', flow: '账户设置', steps: '输入无效手机号后使用读屏读取输入框', impactGroup: '读屏用户', severity: 'moderate', status: 'fixing', fixNote: '已增加 aria-describedby，等待构建', retestNote: '', updatedAt: new Date(Date.now() - 7200_000).toISOString() }
];
const seed: WorkbenchState = {
  version: 2,
  issues: seedIssues,
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ],
  session: firstOpenAnchor(seedIssues)
};

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const statusLabels: Record<IssueStatus, string> = {
  open: '待分诊', triaged: '已确认', fixing: '修复中', verifying: '待复测', closed: '已关闭', reopened: '重新打开'
};

export default function AuditWorkbench() {
  const queryClient = useQueryClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));

  const loaded = loadState(seed);
  const [state, setState] = createStore<WorkbenchState>(loaded.state);
  /** 会话位置：锚定的问题 id + 在列表中的序号，随顺序/状态改动同步重算 */
  const [anchor, setAnchor] = createSignal<SessionAnchor>(loaded.state.session);
  const [mergeInto, setMergeInto] = createSignal('');
  const [conflict, setConflict] = createSignal('');
  const announcer = createAnnouncer();

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', state.issues.length],
    queryFn: async () => new Promise<AuditIssue[]>((resolve) => window.setTimeout(() => resolve(state.issues), 120))
  }));

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === anchor().anchorId) ?? state.issues[0]);

  /* 顺序或状态改动后，会话位置同步重算：同一问题优先，否则落到最近条目 */
  createEffect(() => {
    const resolved = resolveAnchor(state.issues, anchor());
    const current = anchor();
    if (resolved.anchorId !== current.anchorId || resolved.anchorIndex !== current.anchorIndex) {
      setAnchor(resolved);
    }
  });

  /* 焦点恢复：变更重渲染后若焦点丢失（落回 body），落回同一问题或最近条目 */
  let pendingFocus: { issueId: string | null; action?: string } | null = null;
  createEffect(() => {
    state.issues; // 依赖列表变化，渲染完成后尝试恢复焦点
    if (!pendingFocus) return;
    const target = pendingFocus;
    pendingFocus = null;
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.isConnected) return; // 焦点仍在有效控件上
      const fallback = target.action
        ? document.querySelector<HTMLElement>(`[data-action="${target.action}"]`)
        : null;
      const element = fallback
        ?? (target.issueId ? document.querySelector<HTMLElement>(`[data-issue-id="${target.issueId}"]`) : null)
        ?? document.querySelector<HTMLElement>('[data-issue-id]');
      element?.focus();
    });
  });

  /* 持久化：状态 + 会话位置一起写入 v2；内容未变时不重复写，避免标签页间回环 */
  let lastPersisted = '';
  createEffect(() => {
    if (typeof localStorage === 'undefined') return;
    const snapshot: WorkbenchState = {
      version: 2,
      issues: state.issues,
      events: state.events,
      session: anchor()
    };
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastPersisted) return;
    lastPersisted = serialized;
    localStorage.setItem(STATE_KEY, serialized);
  });

  const announcePosition = (message: string, issueId: string | null) => {
    const resolved = resolveAnchor(state.issues, { anchorId: issueId, anchorIndex: anchor().anchorIndex });
    const issue = resolved.anchorId ? state.issues.find((item) => item.id === resolved.anchorId) : undefined;
    announcer.announce(
      issue ? `${message}：「${issue.title}」，当前第 ${resolved.anchorIndex + 1} 项，共 ${state.issues.length} 项` : message,
      2,
      true
    );
  };

  const showConflict = (text: string) => {
    setConflict(text);
    announcer.announce(text, 3);
  };

  const addEvent = (issueId: string, message: string) => setState('events', (events) => [
    { id: crypto.randomUUID(), at: new Date().toISOString(), issueId, message },
    ...events
  ]);

  const updateIssue = (id: string, patch: Partial<AuditIssue>, message: string, action?: string) => {
    const { conflict: isLaterWriter } = recordWrite(id);
    setState('issues', (issue) => issue.id === id, produce((issue) => Object.assign(issue, patch, { updatedAt: new Date().toISOString() })));
    addEvent(id, message);
    setAnchor((current) => resolveAnchor(state.issues, { anchorId: id, anchorIndex: current.anchorIndex }));
    pendingFocus = { issueId: id, action };
    announcePosition(message, id);
    if (isLaterWriter) {
      const title = state.issues.find((issue) => issue.id === id)?.title ?? '';
      showConflict(`另一标签页也修改了「${title}」，你是后到方，已保留你的会话位置`);
    }
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = { id: crypto.randomUUID(), ...values, status: 'open', fixNote: '', retestNote: '', updatedAt: new Date().toISOString() };
    recordWrite(issue.id);
    setState('issues', (issues) => [issue, ...issues]);
    addEvent(issue.id, '审计员创建问题并保存证据');
    setAnchor({ anchorId: issue.id, anchorIndex: 0 });
    pendingFocus = { issueId: issue.id };
    announcePosition('已创建问题', issue.id);
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    recordWrite(duplicate.id);
    setState('issues', (issue) => issue.id === duplicate.id, produce((issue) => Object.assign(issue, { canonicalId: canonical.id, updatedAt: new Date().toISOString() })));
    addEvent(duplicate.id, `重复问题已合并到 ${canonical.title}`);
    setAnchor((current) => resolveAnchor(state.issues, { anchorId: canonical.id, anchorIndex: current.anchorIndex }));
    pendingFocus = { issueId: canonical.id };
    announcePosition(`重复问题已合并到「${canonical.title}」`, canonical.id);
    setMergeInto('');
    void queryClient.invalidateQueries({ queryKey: ['audit-issues'] });
  };

  onMount(() => {
    if (loaded.migrated) {
      const first = state.issues.find((issue) => issue.status !== 'closed') ?? state.issues[0];
      announcer.announce(first ? `数据已升级，从第一条未关闭问题继续：「${first.title}」` : '数据已升级', 2);
    }

    /* 另一标签页写入时合并数据；本标签页会话位置不动，冲突时提示 */
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STATE_KEY || !event.newValue) return;
      try {
        const remote = JSON.parse(event.newValue) as WorkbenchState;
        if (remote?.version !== 2 || !Array.isArray(remote.issues)) return;
        const merged = mergeRemoteState(state, remote);
        if (!merged.changed) return;
        batch(() => {
          setState('issues', merged.issues);
          setState('events', merged.events);
        });
        if (merged.conflicts.length) {
          showConflict(`另一标签页也修改了 ${merged.conflicts.map((title) => `「${title}」`).join('、')}，已保留你的会话位置`);
        } else {
          announcer.announce('已同步另一标签页的更改', 1, true);
        }
      } catch {
        /* 忽略无法解析的同步数据 */
      }
    };
    window.addEventListener('storage', onStorage);

    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('keydown', shortcut);
    });
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      {/* 唯一的读屏播报出口：队列化、同批压成汇总，避免连翻几十条 */}
      <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{announcer.message()}</div>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <Show when={conflict()}>
          <div class="conflict-banner">
            <span>{conflict()}</span>
            <button class="secondary" onClick={() => setConflict('')}>知道了</button>
          </div>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={state.issues}>{(issue, index) => (
              <article class="issue" style={anchor().anchorId === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3><button
                  class="secondary"
                  data-issue-id={issue.id}
                  onClick={() => setAnchor({ anchorId: issue.id, anchorIndex: index() })}
                  aria-current={anchor().anchorId === issue.id ? 'true' : undefined}
                  aria-label={`${issue.title}，第 ${index() + 1} 项，共 ${state.issues.length} 项，状态${statusLabels[issue.status]}`}
                >{issue.title}</button></h3>
                <div class="meta"><span class="badge">{issue.status}</span><span class="badge">{issue.severity}</span><span>{issue.flow}</span><span>{issue.impactGroup}</span><Show when={issue.canonicalId}><span class="badge">重复项</span></Show></div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <div role="group" aria-label="问题状态操作">
                  <button data-action="triaged" onClick={() => updateIssue(issue.id, { status: 'triaged' }, '审核员完成分诊', 'triaged')}>确认问题</button>{' '}
                  <button data-action="fixing" onClick={() => updateIssue(issue.id, { status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复', 'fixing')}>开始修复</button>{' '}
                  <button data-action="verifying" onClick={() => updateIssue(issue.id, { status: 'verifying' }, '开发人员提交修复，进入复测', 'verifying')}>提交复测</button>{' '}
                  <button data-action="closed" onClick={() => updateIssue(issue.id, { status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题', 'closed')}>复测通过</button>{' '}
                  <button data-action="reopened" class="danger" onClick={() => updateIssue(issue.id, { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开', 'reopened')}>复测失败</button>
                </div>
                <hr />
                <label>合并到主问题<select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}><option value="">选择问题</option><For each={state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For></select></label>
                <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并</button>
              </>;
            }}</Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => field.value = event.currentTarget.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => field.value = event.currentTarget.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => field.value = event.currentTarget.value as Severity}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              {/* 时间线不再直接 aria-live，播报统一走顶部队列，避免批量操作连翻几十条 */}
              <Tabs.Content value="activity"><div class="timeline"><For each={state.events.slice(0, 12)}>{(event: AuditEvent) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
