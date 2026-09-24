import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/i18n';
import { App } from './App';

/**
 * Render the whole shell.
 *
 * This is the cheapest guard against the failure mode that a build cannot catch:
 * a runtime exception during the first render leaves the window blank, and the
 * only place that shows up is a webview console nobody is watching.
 *
 * Tauri's IPC is unavailable here, so every bridge call rejects. That is fine —
 * the point is that the shell still renders and the rejections are handled.
 */
describe('App', () => {
  it('renders the shell without throwing', () => {
    render(<App />);

    // The three columns plus the chrome must all be present.
    expect(screen.getByRole('heading', { name: 'Ircuit' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('shows the empty state when no network is connected', () => {
    render(<App />);
    expect(screen.getByText(/还没有连接任何网络|Not connected to any network/)).toBeInTheDocument();
  });

  it('offers the composer but keeps it disabled while offline', () => {
    render(<App />);
    const composer = screen.getByRole('textbox');

    expect(composer).toBeDisabled();
    expect(composer.getAttribute('placeholder')).toMatch(
      /尚未连接任何网络|Not connected to any network/,
    );
  });
});
