import { describe, expect, it } from 'vitest';

import {
  applyTheme,
  isThemeMode,
  persistTheme,
  readStoredTheme,
  resolveCurrentTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
} from './theme';

describe('isThemeMode', () => {
  it('只接受三种合法模式', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('system')).toBe(true);
  });

  it('拒绝其它值', () => {
    expect(isThemeMode('Dark')).toBe(false);
    expect(isThemeMode('auto')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
    expect(isThemeMode(undefined)).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('显式模式不受系统偏好影响', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('system 模式跟随系统偏好', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('readStoredTheme', () => {
  it('读取已保存的合法值', () => {
    const storage = { getItem: (key: string) => (key === THEME_STORAGE_KEY ? 'dark' : null) };
    expect(readStoredTheme(storage)).toBe('dark');
  });

  it('未保存时回退到跟随系统', () => {
    expect(readStoredTheme({ getItem: () => null })).toBe('system');
  });

  it('存了非法值时同样回退，而不是让界面处于未定义外观', () => {
    expect(readStoredTheme({ getItem: () => 'neon' })).toBe('system');
  });
});

describe('persistTheme', () => {
  it('把模式写进约定的键', () => {
    const written: Record<string, string> = {};
    persistTheme({ setItem: (key, value) => (written[key] = value) }, 'light');
    expect(written).toEqual({ [THEME_STORAGE_KEY]: 'light' });
  });
});

describe('applyTheme', () => {
  it('切到深色时挂上 dark class', () => {
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    expect(root.classList.contains('dark')).toBe(true);
  });

  it('切回浅色时移除 dark class', () => {
    const root = document.createElement('html');
    applyTheme(root, 'dark');
    applyTheme(root, 'light');
    expect(root.classList.contains('dark')).toBe(false);
  });
});

describe('resolveCurrentTheme', () => {
  it('把系统查询结果喂给 resolveTheme', () => {
    const prefersDark = () => ({ matches: true });
    const prefersLight = () => ({ matches: false });
    expect(resolveCurrentTheme('system', prefersDark)).toBe('dark');
    expect(resolveCurrentTheme('system', prefersLight)).toBe('light');
    expect(resolveCurrentTheme('light', prefersDark)).toBe('light');
  });
});
