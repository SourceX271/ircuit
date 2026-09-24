/**
 * 界面偏好项的持久化。
 *
 * 与主题一样，这里只放纯函数：读写都接受一个 `Storage`，测试传内存对象即可，
 * 不需要 jsdom 之外的任何东西。所有键都集中在这里，避免同一个偏好被两处
 * 各写一个字符串字面量、然后悄悄写歪。
 */

/** 按 Enter 直接发送，还是插入换行。 */
export const SEND_ON_ENTER_KEY = 'ircuit.sendOnEnter';

export function readStoredSendOnEnter(storage: Pick<Storage, 'getItem'>): boolean {
  const raw = storage.getItem(SEND_ON_ENTER_KEY);

  // 默认按 Enter 发送：这是绝大多数人的肌肉记忆，改变默认值才是意外。
  // 只有明确写入 'false' 才视为关闭，非法值一律回退到默认。
  return raw === null ? true : raw !== 'false';
}

export function persistSendOnEnter(storage: Pick<Storage, 'setItem'>, value: boolean): void {
  storage.setItem(SEND_ON_ENTER_KEY, value ? 'true' : 'false');
}

/** 左侧网络/频道栏是否展开。 */
export const SIDEBAR_OPEN_KEY = 'ircuit.sidebarOpen';

/** 右侧成员栏是否展开。 */
export const MEMBERS_OPEN_KEY = 'ircuit.membersOpen';

/**
 * 读取一个布尔偏好。
 *
 * 与 `sendOnEnter` 不同，这里必须显式给出默认值：折叠与展开都会持久化，
 * 所以「键不存在」和「存了 false」是两种不同的情况，不能互相代表。
 */
function readStoredFlag(
  storage: Pick<Storage, 'getItem'>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = storage.getItem(key);
  if (raw === null) return fallback;
  return raw !== 'false';
}

function persistFlag(storage: Pick<Storage, 'setItem'>, key: string, value: boolean): void {
  storage.setItem(key, value ? 'true' : 'false');
}

/** 两侧默认展开：新用户先看到完整布局，再自己决定收起来。 */
export function readStoredSidebarOpen(storage: Pick<Storage, 'getItem'>): boolean {
  return readStoredFlag(storage, SIDEBAR_OPEN_KEY, true);
}

export function persistSidebarOpen(storage: Pick<Storage, 'setItem'>, value: boolean): void {
  persistFlag(storage, SIDEBAR_OPEN_KEY, value);
}

export function readStoredMembersOpen(storage: Pick<Storage, 'getItem'>): boolean {
  return readStoredFlag(storage, MEMBERS_OPEN_KEY, true);
}

export function persistMembersOpen(storage: Pick<Storage, 'setItem'>, value: boolean): void {
  persistFlag(storage, MEMBERS_OPEN_KEY, value);
}
