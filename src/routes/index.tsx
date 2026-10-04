import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import { Announcer } from '../components/Announcer';
import { useWorkbench } from '../lib/useWorkbench';
import {
  sortIssues,
  type AuditIssue,
  type IssueStatus,
  type Severity
} from '../lib/workbench';

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

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};
const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '阻断',
  serious: '严重',
  moderate: '中等',
  minor: '轻微'
};

const STATUS_ACTIONS: {
  status: IssueStatus;
  label: string;
  event: string;
  announce: (title: string) => string;
}[] = [
  { status: 'triaged', label: '确认问题', event: '审核员完成分诊', announce: (title) => `《${title}》已确认分诊` },
  { status: 'fixing', label: '开始修复', event: '开发人员开始修复', announce: (title) => `《${title}》开始修复` },
  { status: 'verifying', label: '提交复测', event: '开发人员提交修复，进入复测', announce: (title) => `《${title}》已提交复测` },
  { status: 'closed', label: '复测通过', event: '复测通过并关闭问题', announce: (title) => `《${title}》复测通过，已关闭` },
  { status: 'reopened', label: '复测失败', event: '复测失败并重新打开', announce: (title) => `《${title}》复测失败，已重新打开` }
];

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const { state, session, setSession, announcements, syncing, mutate } = useWorkbench();
  const [mergeInto, setMergeInto] = createSignal('');
  const [selectedIds, setSelectedIds] = createSignal<ReadonlySet<string>>(new Set());

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  /** 会话焦点所在问题；为空时回退到第一条，保证详情面板不空白 */
  const current = createMemo(() => state.issues.find((issue) => issue.id === session().focusedIssueId) ?? state.issues[0]);

  // 会话位置驱动焦点：状态或顺序改动后，焦点落回同一问题；
  // 仅当焦点丢失到页面（body）时才拉回，不打断表单内输入。
  const issueRefs = new Map<string, HTMLButtonElement>();
  createEffect(() => {
    if (typeof document === 'undefined') return;
    const id = session().focusedIssueId;
    if (!id) return;
    requestAnimationFrame(() => {
      const el = issueRefs.get(id);
      if (el && (document.activeElement === document.body || document.activeElement === null)) el.focus();
    });
  });

  const createIssue = (values: IssueForm) => {
    const issue: AuditIssue = {
      id: crypto.randomUUID(),
      ...values,
      status: 'open',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date().toISOString()
    };
    mutate((draft) => {
      draft.issues.unshift(issue);
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, message: '审计员创建问题并保存证据' });
    }, `已创建问题《${values.title}》`);
    setSession({ focusedIssueId: issue.id });
  };

  const changeStatus = (issue: AuditIssue, status: IssueStatus, eventMessage: string, announceMessage: string) => {
    mutate((draft) => {
      const target = draft.issues.find((item) => item.id === issue.id);
      if (!target) return;
      target.status = status;
      target.updatedAt = new Date().toISOString();
      if (status === 'fixing') target.fixNote = '修复进行中，等待提交复测版本';
      if (status === 'closed') target.retestNote = '键盘、读屏和错误提示均已通过';
      if (status === 'reopened') target.retestNote = '焦点顺序仍不正确';
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: issue.id, message: eventMessage });
    }, announceMessage);
  };

  const mergeDuplicate = () => {
    const duplicate = current();
    const canonical = state.issues.find((issue) => issue.id === mergeInto());
    if (!duplicate || !canonical || duplicate.id === canonical.id) return;
    mutate((draft) => {
      const target = draft.issues.find((issue) => issue.id === duplicate.id);
      if (target) {
        target.canonicalId = canonical.id;
        target.updatedAt = new Date().toISOString();
      }
      draft.events.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), issueId: duplicate.id, message: `重复问题已合并到 ${canonical.title}` });
    }, `已将《${duplicate.title}》合并到《${canonical.title}》`);
    setMergeInto('');
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 批量合并：同批动作只压成一条汇总播报，不逐条播报 */
  const batchMerge = () => {
    const canonicalId = mergeInto();
    const canonical = state.issues.find((issue) => issue.id === canonicalId);
    const duplicates = [...selectedIds()].filter((id) => id !== canonicalId);
    if (!canonical || duplicates.length === 0) return;
    mutate((draft) => {
      for (const id of duplicates) {
        const target = draft.issues.find((issue) => issue.id === id);
        if (target && !target.canonicalId) {
          target.canonicalId = canonicalId;
          target.updatedAt = new Date().toISOString();
        }
      }
      draft.events.unshift({
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        issueId: canonicalId,
        message: `批量合并：${duplicates.length} 个重复问题合并到本问题`
      });
    }, `已将 ${duplicates.length} 个重复问题合并到《${canonical.title}》`, 'summary');
    setSelectedIds(new Set<string>());
    setMergeInto('');
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{state.issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{state.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{state.issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{state.issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{syncing() ? '同步中…' : '已同步'}</small></h2>
            <Show when={selectedIds().size > 0}>
              <div class="batch-bar" role="group" aria-label="批量合并操作">
                <span>已选 {selectedIds().size} 项</span>
                <select aria-label="合并到主问题" value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                  <option value="">选择主问题</option>
                  <For each={state.issues.filter((item) => !item.canonicalId && !selectedIds().has(item.id))}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                </select>
                <button disabled={!mergeInto()} onClick={batchMerge}>批量合并到主问题</button>
              </div>
            </Show>
            <For each={sortIssues(state.issues)}>{(issue) => (
              <article class="issue" classList={{ 'issue-current': session().focusedIssueId === issue.id }}>
                <div class="issue-row">
                  <input
                    type="checkbox"
                    class="issue-check"
                    checked={selectedIds().has(issue.id)}
                    onChange={() => toggleSelect(issue.id)}
                    aria-label={`选择问题《${issue.title}》用于批量合并`}
                  />
                  <h3>
                    <button
                      ref={(el) => issueRefs.set(issue.id, el)}
                      class="secondary"
                      onClick={() => setSession({ focusedIssueId: issue.id })}
                      aria-current={session().focusedIssueId === issue.id ? 'true' : undefined}
                    >{issue.title}</button>
                  </h3>
                </div>
                <div class="meta">
                  <span class="badge">{STATUS_LABELS[issue.status]}</span>
                  <span class="badge">{SEVERITY_LABELS[issue.severity]}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={current()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = current()!;
              return <>
                <h3>{issue.title}</h3>
                <p><strong>复现步骤：</strong>{issue.steps}</p>
                <p><strong>修复记录：</strong>{issue.fixNote || '尚未填写'}</p>
                <p><strong>复测记录：</strong>{issue.retestNote || '尚未填写'}</p>
                <div role="group" aria-label="问题状态操作">
                  <For each={STATUS_ACTIONS}>{(action) => (
                    <button
                      class={action.status === 'reopened' ? 'danger' : undefined}
                      onClick={() => changeStatus(issue, action.status, action.event, action.announce(issue.title))}
                    >{action.label}</button>
                  )}</For>
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
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value ?? ''} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value ?? ''} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value ?? ''}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value ?? ''}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
      <Announcer queue={announcements()} />
    </>
  );
}
