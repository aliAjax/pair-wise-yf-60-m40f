/**
 * 纯逻辑验证：会话位置重算、播报队列、三路合并、迁移。
 * 运行：node --experimental-strip-types 不可用时用 esbuild 打包后执行。
 */
import assert from 'node:assert/strict';
import {
  ANNOUNCE_QUEUE_CAPACITY,
  enqueueAnnouncement,
  initialSession,
  mergeStates,
  migrate,
  recomputePosition,
  seedState,
  sortIssues,
  type WorkbenchState
} from './workbench';

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log('会话位置重算');
test('焦点问题仍在列表中时落回同一问题', () => {
  const state = seedState();
  const result = recomputePosition(state.issues, 'issue-1', ['issue-1', 'issue-2']);
  assert.equal(result, 'issue-1');
});

test('焦点问题被关闭沉底后仍落回同一问题', () => {
  const state = seedState();
  state.issues[0].status = 'closed';
  const sorted = sortIssues(state.issues);
  const result = recomputePosition(sorted, 'issue-1', ['issue-1', 'issue-2']);
  assert.equal(result, 'issue-1');
});

test('焦点问题消失时落到同索引位置', () => {
  const state = seedState();
  const rest = state.issues.filter((issue) => issue.id !== 'issue-1');
  const result = recomputePosition(rest, 'issue-1', ['issue-1', 'issue-2']);
  assert.equal(result, 'issue-2');
});

test('列表为空时返回 null', () => {
  assert.equal(recomputePosition([], 'issue-1', ['issue-1']), null);
});

test('无历史位置时从第一条未关闭问题继续', () => {
  const state = seedState();
  state.issues[0].status = 'closed';
  state.issues[1].status = 'fixing';
  const session = initialSession(state);
  assert.equal(session.focusedIssueId, 'issue-2');
});

test('旧数据缺会话位置时从第一条未关闭问题继续', () => {
  const state = seedState();
  state.issues[0].status = 'closed';
  const session = initialSession(state);
  assert.equal(session.focusedIssueId, 'issue-2');
});

console.log('播报队列');
test('容量内正常入队', () => {
  let queue = enqueueAnnouncement([], { message: 'a', priority: 'normal' }, 1);
  queue = enqueueAnnouncement(queue, { message: 'b', priority: 'normal' }, 2);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].message, 'a');
});

test('容量到顶时淘汰最不要紧的一条', () => {
  let queue = [] as ReturnType<typeof enqueueAnnouncement>;
  for (let i = 0; i < ANNOUNCE_QUEUE_CAPACITY; i++) {
    queue = enqueueAnnouncement(queue, { message: `n${i}`, priority: 'normal' }, i);
  }
  queue = enqueueAnnouncement(queue, { message: 'summary', priority: 'summary' }, 10);
  assert.equal(queue.length, ANNOUNCE_QUEUE_CAPACITY);
  assert.ok(queue.some((a) => a.message === 'summary'), '汇总播报必须保留');
  assert.ok(!queue.some((a) => a.message === 'n0'), '最旧的普通播报被淘汰');
});

test('紧急播报不会被淘汰', () => {
  let queue = [] as ReturnType<typeof enqueueAnnouncement>;
  for (let i = 0; i < ANNOUNCE_QUEUE_CAPACITY; i++) {
    queue = enqueueAnnouncement(queue, { message: `n${i}`, priority: 'normal' }, i);
  }
  queue = enqueueAnnouncement(queue, { message: '危险', priority: 'critical' }, 10);
  assert.ok(queue.some((a) => a.message === '危险'));
  assert.ok(!queue.some((a) => a.message === 'n0'));
});

test('同优先级淘汰最旧的', () => {
  let queue = [] as ReturnType<typeof enqueueAnnouncement>;
  for (let i = 0; i < ANNOUNCE_QUEUE_CAPACITY; i++) {
    queue = enqueueAnnouncement(queue, { message: `n${i}`, priority: 'normal' }, i);
  }
  queue = enqueueAnnouncement(queue, { message: 'n-new', priority: 'normal' }, 10);
  assert.ok(!queue.some((a) => a.message === 'n0'));
  assert.ok(queue.some((a) => a.message === 'n-new'));
});

console.log('三路合并');
test('两边修改同一问题时后到方获胜并报告冲突', () => {
  const base = seedState();
  const local: WorkbenchState = {
    ...base,
    issues: base.issues.map((issue) => issue.id === 'issue-1' ? { ...issue, status: 'fixing' as const, updatedAt: '2026-01-01T00:00:01.000Z' } : issue)
  };
  const remote: WorkbenchState = {
    ...base,
    issues: base.issues.map((issue) => issue.id === 'issue-1' ? { ...issue, status: 'closed' as const, updatedAt: '2026-01-01T00:00:02.000Z' } : issue)
  };
  const result = mergeStates(base, local, remote);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0], 'issue-1');
  const merged = result.state.issues.find((issue) => issue.id === 'issue-1');
  assert.equal(merged?.status, 'closed');
});

test('只有一边修改时直接采纳，不误报冲突', () => {
  const base: WorkbenchState = {
    version: 2,
    issues: [
      { ...seedState().issues[0], updatedAt: '2026-01-01T00:00:00.000Z' },
      { ...seedState().issues[1], updatedAt: '2026-01-01T00:00:00.000Z' }
    ],
    events: []
  };
  const remote: WorkbenchState = {
    ...base,
    issues: base.issues.map((issue) => issue.id === 'issue-2' ? { ...issue, status: 'verifying' as const, updatedAt: '2026-01-01T00:00:02.000Z' } : issue)
  };
  const result = mergeStates(base, base, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.issues.find((issue) => issue.id === 'issue-2')?.status, 'verifying');
});

test('远端过期回显不会覆盖本地较新修改', () => {
  const base: WorkbenchState = {
    version: 2,
    issues: [
      { ...seedState().issues[0], updatedAt: '2026-01-01T00:00:05.000Z' },
      { ...seedState().issues[1], updatedAt: '2026-01-01T00:00:00.000Z' }
    ],
    events: []
  };
  // 本地未动，远端却回传了比基线更旧的修改（过期回显）
  const staleRemote: WorkbenchState = {
    ...base,
    issues: base.issues.map((issue) => issue.id === 'issue-1' ? { ...issue, status: 'fixing' as const, updatedAt: '2026-01-01T00:00:01.000Z' } : issue)
  };
  const result = mergeStates(base, base, staleRemote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.state.issues.find((issue) => issue.id === 'issue-1')?.status, 'triaged');
});

test('本地新建问题在合并后保留', () => {
  const base = seedState();
  const newIssue = { ...base.issues[0], id: 'issue-new', title: '本地新建', updatedAt: '2026-01-01T00:00:03.000Z' };
  const local: WorkbenchState = { ...base, issues: [newIssue, ...base.issues] };
  const result = mergeStates(base, local, base);
  assert.ok(result.state.issues.some((issue) => issue.id === 'issue-new'));
});

console.log('迁移');
test('损坏数据回退种子', () => {
  assert.equal(migrate(null).issues.length, 2);
  assert.equal(migrate('garbage').issues.length, 2);
});

test('v1 旧数据升级版本号并保留内容', () => {
  const old = { issues: [{ ...seedState().issues[0] }], events: [] };
  const result = migrate(old);
  assert.equal(result.version, 2);
  assert.equal(result.issues.length, 1);
});

console.log(`\n全部通过：${passed} 项`);
