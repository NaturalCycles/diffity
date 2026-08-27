import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { NotificationBell } from '../src/components/layout/notification-bell';
import { unreadAlerts } from '../src/lib/answer-alerts';

afterEach(cleanup);

const two = [
  { threadId: 't1', filePath: 'packages/cli/src/live.ts', authorName: 'Agent', preview: 'first answer' },
  { threadId: 't2', filePath: 'packages/ui/src/api.ts', authorName: 'Agent', preview: 'second answer' },
];

describe('the notification bell', () => {
  it('is quiet with nothing unread', () => {
    render(<NotificationBell alerts={[]} onGo={vi.fn()} />);

    expect(screen.queryByText('2')).toBeNull();
    expect(screen.getByRole('button', { name: /no unread/i })).toBeTruthy();
  });

  it('counts what is unread', () => {
    render(<NotificationBell alerts={two} onGo={vi.fn()} />);

    expect(screen.getByText('2')).toBeTruthy();
  });

  it('keeps the list closed until asked', () => {
    render(<NotificationBell alerts={two} onGo={vi.fn()} />);

    expect(screen.queryByText(/first answer/)).toBeNull();
  });

  it('lists them oldest first, with where each came from', () => {
    render(<NotificationBell alerts={two} onGo={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /2 unread/i }));

    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('first answer');
    expect(items[0].textContent).toContain('live.ts');
  });

  it('goes to the one that is clicked', () => {
    const onGo = vi.fn();
    render(<NotificationBell alerts={two} onGo={onGo} />);

    fireEvent.click(screen.getByRole('button', { name: /2 unread/i }));
    fireEvent.click(screen.getAllByRole('menuitem')[1]);

    expect(onGo).toHaveBeenCalledWith('t2');
  });

  it('closes once you have gone somewhere', () => {
    render(<NotificationBell alerts={two} onGo={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /2 unread/i }));
    fireEvent.click(screen.getAllByRole('menuitem')[0]);

    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});

describe('a long list', () => {
  // A batch of asks is how this gets used — seven arrived in one go — and thirty would run off the
  // bottom of the window with no way to reach the end.
  it('scrolls inside itself rather than off the screen', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      threadId: `t${i}`, filePath: 'a.ts', authorName: 'Agent', preview: `answer ${i}`,
    }));
    render(<NotificationBell alerts={many} onGo={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /30 unread/i }));

    const list = screen.getAllByRole('menuitem')[0].parentElement!;
    expect(list.className).toContain('max-h-');
    expect(list.className).toContain('overflow-y-auto');
  });
})

// The two lists the page keeps — a note still on screen, and what one leaves behind — reach the
// bell as one, so what the reader sees is "how many answers are waiting" rather than "how many
// notes have timed out".
describe('the count against the two lists behind it', () => {
  it('includes a note that is still on screen', () => {
    render(<NotificationBell alerts={unreadAlerts([two[0]], [])} onGo={vi.fn()} />);

    expect(screen.getByRole('button', { name: /1 unread/i })).toBeTruthy();
  });

  it('does not move when that note times out', () => {
    const { unmount } = render(<NotificationBell alerts={unreadAlerts(two, [])} onGo={vi.fn()} />);
    expect(screen.getByText('2')).toBeTruthy();
    unmount();

    render(<NotificationBell alerts={unreadAlerts([], two)} onGo={vi.fn()} />);

    expect(screen.getByText('2')).toBeTruthy();
  });
});
