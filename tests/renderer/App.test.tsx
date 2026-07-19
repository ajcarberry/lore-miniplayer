import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { App } from '../../src/renderer/App';
import { installMockElectronAPI } from '../mocks/electron-api';

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    installMockElectronAPI();
  });

  it('should render the title bar and connect page on first launch', () => {
    // When: rendering the whole app with no stored server
    render((<App />) as ReactElement);

    // Then: the shell and the connect page are shown
    expect(screen.getByText('Lore MiniPlayer')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('lores://lore.example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });
});
