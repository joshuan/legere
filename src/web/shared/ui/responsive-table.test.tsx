import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ResponsiveTable } from '.';

describe('ResponsiveTable', () => {
  it('renders populated rows and keeps their actions usable through the shared public API', async () => {
    const open = vi.fn();
    render(
      <ResponsiveTable
        rowKey="id"
        pagination={false}
        columns={[
          { title: 'Name', dataIndex: 'name' },
          {
            title: 'Actions',
            render: (_, row) => (
              <button
                onClick={() => {
                  open(row.id);
                }}
              >
                Open {row.name}
              </button>
            ),
          },
        ]}
        dataSource={[
          { id: 'first', name: 'First receipt' },
          { id: 'second', name: 'Second receipt' },
        ]}
      />,
    );

    expect(screen.getByRole('cell', { name: 'First receipt' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Second receipt' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Second receipt' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('second');
  });
});
