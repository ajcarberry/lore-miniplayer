import { act } from 'react';
import { screen } from '@testing-library/react';
import { bootstrapWindow } from '../../src/renderer/bootstrap';
import { installMockElectronAPI } from '../mocks/electron-api';

describe('bootstrapWindow', () => {
  it('mounts the surface under the shared provider chrome in #root', async () => {
    // Given: a window document carrying the #root element the entries expect
    installMockElectronAPI();
    const container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);

    // When: bootstrapping a surface (as mission-control.tsx / review.tsx do)
    await act(async () => {
      bootstrapWindow(<span>surface under test</span>);
    });

    // Then: the surface renders inside the provider tree
    expect(await screen.findByText('surface under test')).toBeInTheDocument();
    container.remove();
  });

  it('throws when the document has no #root element', () => {
    // When/Then: bootstrapping without the root container fails loudly
    expect(() => bootstrapWindow(<span>never mounted</span>)).toThrow('Root element not found');
  });
});
