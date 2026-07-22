import { requestOpenReviewWindow } from '../../../src/renderer/components/mission-control/reviewIntent';
import { installMockElectronAPI } from '../../mocks/electron-api';
import { makeWorkspace } from './fixtures';

function installReviewApi(): jest.Mock {
  const api = installMockElectronAPI();
  const open = jest.fn();
  Object.assign(api, { review: { open, requestContext: jest.fn(), onContext: jest.fn() } });
  return open;
}

describe('requestOpenReviewWindow', () => {
  it('opens the review window with the commit workflow and revision → working tree compare', () => {
    const open = installReviewApi();

    requestOpenReviewWindow({
      workspace: makeWorkspace({ path: '/wt/act2', branchName: 'agent/act2', revision: 'r130' }),
      workflow: 'commit',
    });

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/wt/act2',
        branchName: 'agent/act2',
        workflow: 'commit',
        compare: {
          source: { kind: 'revision', revision: 'r130' },
          target: { kind: 'workingTree' },
        },
      })
    );
  });

  it('falls back to the branch head when the workspace revision is unknown', () => {
    const open = installReviewApi();

    requestOpenReviewWindow({
      workspace: makeWorkspace({ branchName: 'agent/act2', revision: '' }),
      workflow: 'commit',
    });

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        compare: expect.objectContaining({
          source: { kind: 'branchHead', branch: 'agent/act2' },
        }),
      })
    );
  });

  it('opens the merge workflow comparing the branch against main', () => {
    const open = installReviewApi();

    requestOpenReviewWindow({
      workspace: makeWorkspace({ branchName: 'agent/act2' }),
      workflow: 'merge',
    });

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: 'merge',
        compare: {
          source: { kind: 'branchHead', branch: 'agent/act2' },
          target: { kind: 'branchHead', branch: 'main' },
        },
      })
    );
  });
});
