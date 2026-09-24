import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom 不会在用例之间自动卸载 React 树，必须显式清理。
afterEach(() => {
  cleanup();
});
