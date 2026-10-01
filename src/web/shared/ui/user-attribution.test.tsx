import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/helpers/render';
import { UserAttribution } from './user-attribution';

describe('UserAttribution', () => {
  it('keeps the user primary and shows the agent as a readable secondary line', () => {
    renderWithProviders(
      <UserAttribution
        name="Vasya"
        agent={{
          kind: 'API_TOKEN',
          id: 'aaaaaaaa-1111-4111-8111-111111111111',
          name: 'Codex token',
        }}
      />,
    );
    expect(screen.getByText('Vasya')).toBeInTheDocument();
    expect(screen.getByText('via Codex token')).toHaveStyle({
      fontSize: '12px',
      lineHeight: '18px',
    });
  });
  it('does not invent an agent for legacy or browser activity', () => {
    renderWithProviders(<UserAttribution name="Vasya" agent={null} />);
    expect(screen.getByText('Vasya')).toBeInTheDocument();
    expect(screen.queryByText(/^via /)).not.toBeInTheDocument();
  });
});
