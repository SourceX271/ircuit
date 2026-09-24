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
