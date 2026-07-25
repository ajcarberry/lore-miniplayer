import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttributionToast } from '../../src/renderer/components/AttributionToast';
import { renderWithMantine } from './test-utils';

function renderToast(overrides: Partial<Parameters<typeof AttributionToast>[0]> = {}): {
  onDismiss: jest.Mock;
} {
  const onDismiss = overrides.onDismiss ?? jest.fn();
  renderWithMantine(
    <AttributionToast
      message='Mara Voss pushed r128 to feature/act-two'
      {...overrides}
      onDismiss={onDismiss}
    />
  );
  return { onDismiss };
}

describe('AttributionToast', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the message', () => {
    // When: rendering the toast
    renderToast({ message: 'Mara Voss pushed r128 to feature/act-two' });

    // Then: the message text is shown
    expect(screen.getByText('Mara Voss pushed r128 to feature/act-two')).toBeInTheDocument();
  });

  it('auto-dismisses after the default 5s duration', () => {
    // Given: a rendered toast
    const { onDismiss } = renderToast();
    expect(onDismiss).not.toHaveBeenCalled();

    // When: 5 seconds elapse
    jest.advanceTimersByTime(5000);

    // Then: it dismisses itself
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not dismiss before the duration elapses', () => {
    // Given: a rendered toast
    const { onDismiss } = renderToast();

    // When: less than 5 seconds elapse
    jest.advanceTimersByTime(4999);

    // Then: it has not yet dismissed
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('honors a custom duration', () => {
    // Given: a toast with a shorter duration
    const { onDismiss } = renderToast({ durationMs: 1000 });

    // When: that duration elapses
    jest.advanceTimersByTime(1000);

    // Then: it dismisses on schedule
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismisses immediately when the ✕ control is clicked', async () => {
    // Given: a rendered toast, real timers for user-event interaction
    jest.useRealTimers();
    const user = userEvent.setup();
    const { onDismiss } = renderToast();

    // When: clicking the dismiss control
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Then: onDismiss fires without waiting for the timer
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('clears its timer on unmount so a stale dismiss never fires', () => {
    // Given: a rendered toast
    const onDismiss = jest.fn();
    const { unmount } = renderWithMantine(
      <AttributionToast message='test' onDismiss={onDismiss} />
    );

    // When: unmounting before the duration elapses, then letting time pass
    unmount();
    jest.advanceTimersByTime(10000);

    // Then: the stale timer never calls the (now-unmounted) dismiss
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
