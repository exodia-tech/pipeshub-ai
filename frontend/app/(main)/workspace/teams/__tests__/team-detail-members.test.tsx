import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import '@/lib/__tests__/test-i18n';
import { TeamDetailSidebar } from '../components/team-detail-sidebar';
import { useTeamsStore } from '../store';
import { TeamsApi } from '../api';
import type { Team } from '../types';

vi.mock('@/config', () => ({ useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }) }));
vi.mock('@/lib/store/user-store', () => ({ useUserStore: (selector: (state: { profile: null }) => unknown) => selector({ profile: null }) }));
vi.mock('../../users/api', () => ({ UsersApi: { fetchMergedUsers: vi.fn(async () => ({ users: [], totalCount: 0 })) } }));
vi.mock('../api', () => ({ TeamsApi: {
  getTeamUsers: vi.fn(async () => ({ members: [{ id: 'member', userId: 'member', userName: 'Sam Example', userEmail: 'sam@example.invalid', role: 'READER', joinedAt: 1, isOwner: false }], totalCount: 1 })),
  updateTeam: vi.fn(),
} }));

const team: Team = {
  id: 'team', name: 'Design team', description: 'Design documents', orgId: 'org',
  createdAtTimestamp: 1, updatedAtTimestamp: 1, members: [], memberCount: 1,
  canEdit: true, canDelete: true, canManageMembers: true,
};

afterEach(() => { cleanup(); useTeamsStore.getState().closeDetailPanel(); vi.clearAllMocks(); });

describe('team detail shared controls', () => {
  it('keeps team roles and cancels staged member and description edits', async () => {
    useTeamsStore.getState().openDetailPanel(team);
    render(<Theme><TeamDetailSidebar /></Theme>);
    expect(await screen.findByText('Sam Example')).toBeTruthy();
    expect(screen.getByText('READER')).toBeTruthy();
    const description = screen.getByLabelText(/team description/i);
    expect(description).toHaveProperty('readOnly', true);
    fireEvent.click(screen.getByRole('button', { name: /edit team/i }));
    fireEvent.change(description, { target: { value: 'Draft description' } });
    fireEvent.click(await screen.findByText('Remove'));
    expect(await screen.findByText('Undo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(description).toHaveProperty('value', 'Design documents'));
    expect(screen.queryByText('Undo')).toBeNull();
    expect(TeamsApi.updateTeam).not.toHaveBeenCalled();
  });
});
