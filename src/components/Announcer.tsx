import type { Announcement } from '../lib/workbench';

/**
 * 读屏播报出口：普通播报走 polite 队列，冲突等紧急播报走 assertive 立即打断。
 * 视觉隐藏但对读屏可见；aria-atomic 保证整条消息一次读完。
 */
export function Announcer(props: { queue: Announcement[] }) {
  const head = () => props.queue[0];
  const politeMessage = () => (head()?.priority === 'critical' ? '' : head()?.message ?? '');
  const assertiveMessage = () => (head()?.priority === 'critical' ? head()?.message ?? '' : '');

  return (
    <>
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">{politeMessage()}</div>
      <div class="visually-hidden" aria-live="assertive" aria-atomic="true">{assertiveMessage()}</div>
    </>
  );
}
