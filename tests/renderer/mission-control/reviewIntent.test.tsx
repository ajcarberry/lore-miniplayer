jest.mock('@mantine/notifications', () => ({ notifications: { show: jest.fn() } }));

import { notifications } from '@mantine/notifications';
import { requestOpenReviewWindow } from '../../../src/renderer/components/mission-control/reviewIntent';
import { makeWorkspace } from './fixtures';

const show = notifications.show as jest.Mock;

describe('requestOpenReviewWindow', () => {
  it('surfaces a not-yet notice naming the merge workflow and branch', () => {
    requestOpenReviewWindow({
      workspace: makeWorkspace({ branchName: 'agent/act2' }),
      workflow: 'merge',
    });

    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        title: 'Review window coming soon',
        message: expect.stringContaining('Merge for agent/act2'),
      })
    );
  });

  it('names the review verb for the commit workflow', () => {
    requestOpenReviewWindow({ workspace: makeWorkspace(), workflow: 'commit' });
    expect(show).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Review for') })
    );
  });
});
