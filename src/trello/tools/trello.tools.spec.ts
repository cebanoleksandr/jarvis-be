import type { TrelloClientService } from '../trello-client.service.js';
import { trelloError } from '../trello-client.service.js';
import { dueToTrello, localDue, trelloTools } from './trello.tools.js';

const B = 'b'.repeat(24);
const L1 = '1'.repeat(24);
const L2 = '2'.repeat(24);
const C = 'c'.repeat(24);
const ctx = { userId: 'u1', timezone: 'Europe/Kyiv' };

const board = {
  id: B,
  name: 'Home',
  url: 'https://trello.com/b/x',
  lists: [
    { id: L1, name: 'To do' },
    { id: L2, name: 'Done' },
  ],
};
const card = {
  id: C,
  name: 'Fix the bike',
  desc: '',
  due: '2026-11-26T10:00:00.000Z',
  dueComplete: false,
  idList: L1,
  idBoard: B,
  url: 'https://trello.com/c/abc',
  labels: [{ name: 'home' }],
  closed: false,
};

const request = vi.fn();
const client = { request, available: true } as unknown as TrelloClientService;
const [
  listBoards,
  listCards,
  createCard,
  updateCard,
  archiveCard,
  commentCard,
] = trelloTools(client);

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(
    async (_u: string, method: string, path: string) => {
      if (path === '/members/me/boards') return [board];
      if (path === `/boards/${B}/cards/open`) return [card];
      if (path === `/cards/${C}` && method === 'GET')
        return { ...card, board: { name: 'Home' }, list: { name: 'To do' } };
      if (path === `/lists/${L2}`)
        return { id: L2, name: 'Done', idBoard: B, board: { name: 'Home' } };
      if (path === `/cards/${C}` && method === 'PUT')
        return { ...card, url: card.url };
      throw new Error(`unexpected ${method} ${path}`);
    },
  );
});

describe('trello time helpers', () => {
  it('converts due dates between local wall-clock time and UTC', () => {
    expect(localDue('2026-11-26T10:00:00.000Z', 'Europe/Kyiv')).toBe(
      '2026-11-26T12:00',
    );
    expect(dueToTrello('2026-11-27', 'Europe/Kyiv')).toBe(
      '2026-11-27T10:00:00.000Z',
    );
    expect(dueToTrello('2026-11-27T09:30', 'Europe/Kyiv')).toBe(
      '2026-11-27T07:30:00.000Z',
    );
  });
});

describe('read tools', () => {
  it('list_trello_boards returns boards with their lists', async () => {
    expect(await listBoards.execute(ctx, {})).toEqual([
      { id: B, name: 'Home', link: board.url, lists: board.lists },
    ]);
  });

  it('list_trello_cards needs a filter and names board and list', async () => {
    expect(listCards.input.safeParse({}).success).toBe(false);
    expect(listCards.input.safeParse({ boardId: 'nope' }).success).toBe(false);
    const res = await listCards.execute(ctx, { boardId: B });
    expect(res.cards[0]).toEqual({
      id: C,
      name: 'Fix the bike',
      description: undefined,
      due: '2026-11-26T12:00',
      dueComplete: false,
      board: { id: B, name: 'Home' },
      list: { id: L1, name: 'To do' },
      labels: ['home'],
      link: card.url,
    });
  });

  it('dueWithinDays keeps open cards due by the end of the window', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-26T08:00:00Z') });
    try {
      const done = { ...card, id: 'd'.repeat(24), dueComplete: true };
      const later = {
        ...card,
        id: 'e'.repeat(24),
        due: '2026-11-28T10:00:00Z',
      };
      const tonight = {
        ...card,
        id: 'f'.repeat(24),
        due: '2026-11-26T21:30:00Z',
      };
      request.mockImplementation(
        async (_u: string, _m: string, path: string) =>
          path === '/members/me/boards'
            ? [board]
            : [later, done, tonight, card],
      );
      const res = await listCards.execute(ctx, { dueWithinDays: 0 });
      // 21:30 UTC is 23:30 in Kyiv, still today; sorted by due.
      expect(res.cards.map((c) => c.id)).toEqual([C, 'f'.repeat(24)]);
      const week = await listCards.execute(ctx, { dueWithinDays: 7 });
      expect(week.cards).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mutating tools', () => {
  it('all of them can be undone, read tools cannot', () => {
    expect(
      [
        listBoards,
        listCards,
        createCard,
        updateCard,
        archiveCard,
        commentCard,
      ].map((t) => [t.name, t.mutating, 'undo' in t]),
    ).toEqual([
      ['list_trello_boards', false, false],
      ['list_trello_cards', false, false],
      ['create_trello_card', true, true],
      ['update_trello_card', true, true],
      ['archive_trello_card', true, true],
      ['comment_trello_card', true, true],
    ]);
  });

  it('update_trello_card shows the real card and the move', async () => {
    const v = updateCard.input.parse({
      cardId: C,
      listId: L2,
      dueComplete: true,
    });
    const before = await updateCard.lookup!(ctx, v);
    expect(updateCard.summarize!(v, before)).toEqual({
      title: 'Change Trello card',
      details: {
        Card: 'Fix the bike',
        List: 'Home / To do → Home / Done',
        Done: 'no → yes',
      },
    });
  });

  it('update_trello_card moves, clears due, and undo restores the card', async () => {
    const result = await updateCard.execute(ctx, {
      cardId: C,
      listId: L2,
      due: null,
    });
    expect(request).toHaveBeenCalledWith('u1', 'PUT', `/cards/${C}`, {
      body: {
        name: undefined,
        desc: undefined,
        due: null,
        dueComplete: undefined,
        idList: L2,
        idBoard: B,
      },
    });
    await updateCard.undo!(ctx, result);
    expect(request).toHaveBeenLastCalledWith('u1', 'PUT', `/cards/${C}`, {
      body: {
        name: 'Fix the bike',
        desc: '',
        due: card.due,
        dueComplete: false,
        idList: L1,
        idBoard: B,
      },
    });
  });

  it('an archived card counts as missing', async () => {
    request.mockResolvedValue({ ...card, closed: true });
    await expect(archiveCard.lookup!(ctx, { cardId: C })).rejects.toThrow(
      /archived/,
    );
  });

  it('create_trello_card sends local due as UTC and undo deletes it', async () => {
    request.mockResolvedValue({ ...card, id: C });
    const v = createCard.input.parse({
      listId: L1,
      name: 'Buy tires',
      due: '2026-11-27',
    });
    expect(v.position).toBe('bottom');
    const result = await createCard.execute(ctx, v);
    expect(request).toHaveBeenCalledWith('u1', 'POST', '/cards', {
      body: {
        idList: L1,
        name: 'Buy tires',
        desc: undefined,
        due: '2026-11-27T10:00:00.000Z',
        pos: 'bottom',
      },
    });
    await createCard.undo!(ctx, result);
    expect(request).toHaveBeenLastCalledWith('u1', 'DELETE', `/cards/${C}`);
  });

  it('undo treats an already deleted comment as done', async () => {
    request.mockRejectedValue(trelloError('Not found in Trello.'));
    await expect(
      commentCard.undo!(ctx, { id: 'a'.repeat(24) }),
    ).resolves.toBeUndefined();
  });
});
