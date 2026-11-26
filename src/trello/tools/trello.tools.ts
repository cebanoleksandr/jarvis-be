import { z } from 'zod';
import { type ActionSummary, defineTool } from '../../agent/tool.js';
import { addDays, localClock, zonedToUtc } from '../../common/time.js';
import {
  type TrelloClientService,
  trelloError,
} from '../trello-client.service.js';

/** Trello ids are 24 hex characters. */
const TRELLO_ID = /^[0-9a-f]{24}$/;
const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
/** Due dates without a time are set to noon, as Trello's own picker does. */
const DEFAULT_DUE_TIME = '12:00';
const MAX_BOARDS = 20;
const MAX_CARDS = 100;
const CARD_FIELDS =
  'name,desc,due,dueComplete,idList,idBoard,url,labels,closed,dateLastActivity';

const truncate = (s: string | null | undefined, n: number) =>
  s && s.length > n ? `${s.slice(0, n)}…` : s || undefined;

/** Raw card as the API returns it with CARD_FIELDS. */
interface ApiCard {
  id: string;
  name: string;
  desc?: string;
  due?: string | null;
  dueComplete?: boolean;
  idList: string;
  idBoard: string;
  url?: string;
  closed?: boolean;
  labels?: { name?: string; color?: string | null }[];
  /** Last change to the card; Trello keeps no separate completion time. */
  dateLastActivity?: string;
}

interface ApiBoard {
  id: string;
  name: string;
  url?: string;
  lists?: { id: string; name: string }[];
}

export interface TrelloBoard {
  id: string;
  name: string;
  link?: string;
  lists: { id: string; name: string }[];
}

export interface TrelloCard {
  id: string;
  name: string;
  description?: string;
  /** Local wall-clock time in the user's zone, `YYYY-MM-DDTHH:MM`. */
  due?: string;
  dueComplete: boolean;
  board: { id: string; name: string };
  list: { id: string; name: string };
  labels: string[];
  link?: string;
}

/** List names that mean "finished", in the languages the app supports. */
const DONE_WORDS = new Set([
  'done',
  'complete',
  'completed',
  'finished',
  'готово',
  'сделано',
  'выполнено',
  'завершено',
  'зроблено',
  'виконано',
  'hecho',
  'terminado',
  'completado',
  'gotowe',
  'zrobione',
  'ukończone',
  'zakończone',
]);
const NEGATIONS = new Set(['not', 'no', 'не', 'ні', 'nie']);

/**
 * True for lists like "Done", "✅ Готово" or "Done this week": many boards
 * finish a card by moving it there without ticking its due date. "Not done"
 * and the like are not done lists.
 */
export function isDoneList(name: string): boolean {
  const words = name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return words.some(
    (w, i) => DONE_WORDS.has(w) && !(i > 0 && NEGATIONS.has(words[i - 1])),
  );
}

/** UTC instant from Trello -> `YYYY-MM-DDTHH:MM` in `tz`. */
export function localDue(iso: string, tz: string): string {
  const clock = localClock(new Date(iso), tz);
  const hh = String(Math.floor(clock.minutes / 60)).padStart(2, '0');
  const mm = String(clock.minutes % 60).padStart(2, '0');
  return `${clock.date}T${hh}:${mm}`;
}

/** Local `YYYY-MM-DD[THH:MM]` from the model -> ISO instant for Trello. */
export function dueToTrello(due: string, tz: string): string {
  const local = due.length === 10 ? `${due}T${DEFAULT_DUE_TIME}` : due;
  return zonedToUtc(local, tz).toISOString();
}

export async function fetchBoards(
  client: TrelloClientService,
  userId: string,
): Promise<TrelloBoard[]> {
  const boards = await client.request<ApiBoard[]>(
    userId,
    'GET',
    '/members/me/boards',
    {
      query: {
        filter: 'open',
        fields: 'name,url',
        lists: 'open',
        list_fields: 'name',
      },
    },
  );
  return boards.slice(0, 50).map((b) => ({
    id: b.id,
    name: b.name,
    link: b.url,
    lists: (b.lists ?? []).map((l) => ({ id: l.id, name: l.name })),
  }));
}

function toCard(
  c: ApiCard,
  boards: Map<string, TrelloBoard>,
  tz: string,
): TrelloCard {
  const board = boards.get(c.idBoard);
  const list = board?.lists.find((l) => l.id === c.idList);
  return {
    id: c.id,
    name: c.name,
    description: truncate(c.desc, 500),
    due: c.due ? localDue(c.due, tz) : undefined,
    dueComplete: Boolean(c.dueComplete),
    board: { id: c.idBoard, name: board?.name ?? '(unknown board)' },
    list: { id: c.idList, name: list?.name ?? '(unknown list)' },
    labels: (c.labels ?? [])
      .map((l) => l.name || l.color || '')
      .filter(Boolean),
    link: c.url,
  };
}

export interface CardFilter {
  boardId?: string;
  listId?: string;
  /** Cards the user is a member of, across boards. */
  assignedToMe?: boolean;
  /**
   * Not done and due before the end of today + N days, overdue included.
   * Cards in a done list (see isDoneList) count as done.
   */
  dueWithinDays?: number;
  /**
   * With dueWithinDays: also the cards ticked done today (outside done
   * lists), so a checklist of the day keeps showing them as finished.
   */
  includeDoneToday?: boolean;
}

/**
 * Open cards, newest due first when filtering by due date. Without a board
 * or list, due-date filtering looks through the first boards of the user.
 */
export async function fetchCards(
  client: TrelloClientService,
  userId: string,
  tz: string,
  filter: CardFilter,
): Promise<{ cards: TrelloCard[]; truncated: boolean }> {
  const boardList = await fetchBoards(client, userId);
  const boards = new Map(boardList.map((b) => [b.id, b]));
  const query = { fields: CARD_FIELDS };

  let raw: ApiCard[];
  if (filter.listId) {
    raw = await client.request<ApiCard[]>(
      userId,
      'GET',
      `/lists/${filter.listId}/cards`,
      { query },
    );
  } else if (filter.boardId) {
    raw = await client.request<ApiCard[]>(
      userId,
      'GET',
      `/boards/${filter.boardId}/cards/open`,
      { query },
    );
  } else if (filter.assignedToMe) {
    raw = await client.request<ApiCard[]>(userId, 'GET', '/members/me/cards', {
      query: { ...query, filter: 'open' },
    });
  } else {
    const perBoard = await Promise.all(
      boardList.slice(0, MAX_BOARDS).map((b) =>
        client.request<ApiCard[]>(userId, 'GET', `/boards/${b.id}/cards/open`, {
          query,
        }),
      ),
    );
    raw = perBoard.flat();
  }

  let cards = raw.filter((c) => !c.closed);
  if (filter.dueWithinDays !== undefined) {
    const today = localClock(new Date(), tz).date;
    const until = zonedToUtc(addDays(today, filter.dueWithinDays + 1), tz);
    const listName = (c: ApiCard) =>
      boards.get(c.idBoard)?.lists.find((l) => l.id === c.idList)?.name ?? '';
    const doneToday = (c: ApiCard) =>
      !!c.dateLastActivity &&
      localClock(new Date(c.dateLastActivity), tz).date === today;
    cards = cards
      .filter(
        (c) =>
          c.due &&
          new Date(c.due) < until &&
          !isDoneList(listName(c)) &&
          (!c.dueComplete || (filter.includeDoneToday && doneToday(c))),
      )
      .sort((a, b) => Date.parse(a.due!) - Date.parse(b.due!));
  }
  return {
    cards: cards.slice(0, MAX_CARDS).map((c) => toCard(c, boards, tz)),
    truncated:
      cards.length > MAX_CARDS ||
      (!filter.boardId &&
        !filter.listId &&
        !filter.assignedToMe &&
        boardList.length > MAX_BOARDS),
  };
}

/** One card with its board and list names, for confirmation cards. */
async function loadCard(
  client: TrelloClientService,
  userId: string,
  tz: string,
  cardId: string,
): Promise<{ raw: ApiCard; card: TrelloCard }> {
  const raw = await client.request<
    ApiCard & { board?: { name: string }; list?: { name: string } }
  >(userId, 'GET', `/cards/${cardId}`, {
    query: {
      fields: CARD_FIELDS,
      board: true,
      board_fields: 'name',
      list: true,
      list_fields: 'name',
    },
  });
  if (raw.closed)
    throw trelloError('Not found in Trello: the card is archived.');
  const boards = new Map<string, TrelloBoard>([
    [
      raw.idBoard,
      {
        id: raw.idBoard,
        name: raw.board?.name ?? '(unknown board)',
        lists: [{ id: raw.idList, name: raw.list?.name ?? '(unknown list)' }],
      },
    ],
  ]);
  return { raw, card: toCard(raw, boards, tz) };
}

interface ListInfo {
  id: string;
  name: string;
  board: { id: string; name: string };
}

async function loadList(
  client: TrelloClientService,
  userId: string,
  listId: string,
): Promise<ListInfo> {
  const list = await client.request<{
    id: string;
    name: string;
    closed?: boolean;
    idBoard: string;
    board?: { name: string };
  }>(userId, 'GET', `/lists/${listId}`, {
    query: { fields: 'name,closed,idBoard', board: true, board_fields: 'name' },
  });
  if (list.closed)
    throw trelloError('Not found in Trello: the list is archived.');
  return {
    id: list.id,
    name: list.name,
    board: { id: list.idBoard, name: list.board?.name ?? '(unknown board)' },
  };
}

const idSchema = (what: string) =>
  z
    .string()
    .regex(TRELLO_ID)
    .describe(`${what} id from list_trello_boards / list_trello_cards`);

const dueSchema = z
  .string()
  .regex(DATE_OR_DATETIME)
  .describe(
    `Local YYYY-MM-DD or YYYY-MM-DDTHH:MM in the user's timezone; a date alone means ${DEFAULT_DUE_TIME}`,
  );

const shortDue = (due: string | undefined) =>
  due ? due.replace('T', ' ') : 'none';
const place = (board: string, list: string) => `${board} / ${list}`;
const change = (from: string | undefined, to: string) =>
  from === undefined || from === to ? to : `${from} → ${to}`;

/** The fields update_trello_card can change, as they were, for undo. */
interface CardSnapshot {
  name: string;
  desc: string;
  due: string | null;
  dueComplete: boolean;
  idList: string;
  idBoard: string;
}

const snapshot = (c: ApiCard): CardSnapshot => ({
  name: c.name,
  desc: c.desc ?? '',
  due: c.due ?? null,
  dueComplete: Boolean(c.dueComplete),
  idList: c.idList,
  idBoard: c.idBoard,
});

const createdId = (result: unknown): string => {
  const id = (result as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) {
    throw trelloError('There is nothing to undo for this action.');
  }
  return id;
};

/** Removing something that is already gone counts as done. */
async function removeFromTrello(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err) {
    if ((err as Error).message.startsWith('Not found in Trello')) return;
    throw err;
  }
}

export function trelloTools(client: TrelloClientService) {
  const listBoards = defineTool({
    name: 'list_trello_boards',
    description:
      "List the user's open Trello boards with their open lists (columns). Use the ids for other Trello tools.",
    mutating: false,
    input: z.object({}).strict(),
    execute: ({ userId }) => fetchBoards(client, userId),
  });

  const listCards = defineTool({
    name: 'list_trello_cards',
    description:
      'List open Trello cards: of one list (listId), of one board (boardId), the ones the user is a member of ' +
      '(assignedToMe), or with dueWithinDays the cards not done yet (not ticked and not in a list like "Done") ' +
      'that are due by the end of today + N days, ' +
      `overdue included, across the user's boards (first ${MAX_BOARDS}). Due times are local to the user's timezone.`,
    mutating: false,
    input: z
      .object({
        boardId: idSchema('Board').optional(),
        listId: idSchema('List').optional(),
        assignedToMe: z.boolean().optional(),
        dueWithinDays: z
          .number()
          .int()
          .min(0)
          .max(31)
          .optional()
          .describe('0 = due today or overdue'),
      })
      .strict()
      .refine(
        (v) =>
          v.boardId ||
          v.listId ||
          v.assignedToMe ||
          v.dueWithinDays !== undefined,
        'Give boardId, listId, assignedToMe or dueWithinDays',
      ),
    execute: ({ userId, timezone }, filter) =>
      fetchCards(client, userId, timezone, filter),
  });

  const createCard = defineTool({
    name: 'create_trello_card',
    description:
      "Create a card in a Trello list. Requires the user's confirmation before it runs. Get the listId from " +
      'list_trello_boards first.',
    mutating: true,
    input: z
      .object({
        listId: idSchema('List'),
        name: z.string().trim().min(1).max(500),
        description: z.string().max(8000).optional(),
        due: dueSchema.optional(),
        position: z
          .enum(['top', 'bottom'])
          .default('bottom')
          .describe('Where in the list'),
      })
      .strict(),
    lookup: ({ userId }, v) => loadList(client, userId, v.listId),
    summarize(v, before): ActionSummary {
      const list = before as ListInfo | undefined;
      return {
        title: 'Create Trello card',
        details: {
          Card: v.name,
          ...(list ? { List: place(list.board.name, list.name) } : {}),
          ...(v.due ? { Due: shortDue(v.due) } : {}),
          ...(v.description ? { Description: v.description } : {}),
        },
      };
    },
    async execute({ userId, timezone }, v) {
      const card = await client.request<ApiCard>(userId, 'POST', '/cards', {
        body: {
          idList: v.listId,
          name: v.name,
          desc: v.description,
          due: v.due ? dueToTrello(v.due, timezone) : undefined,
          pos: v.position,
        },
      });
      return {
        id: card.id,
        name: card.name,
        due: card.due ? localDue(card.due, timezone) : undefined,
        link: card.url,
      };
    },
    async undo({ userId }, result) {
      const id = createdId(result);
      await removeFromTrello(() =>
        client.request(userId, 'DELETE', `/cards/${id}`),
      );
    },
  });

  const updateCard = defineTool({
    name: 'update_trello_card',
    description:
      'Change a Trello card: rename it, edit the description, set or clear (null) the due date, mark it done ' +
      "(dueComplete), or move it to another list (listId, also on another board). Requires the user's confirmation " +
      'before it runs. Get the cardId from list_trello_cards first and pass only what changes.',
    mutating: true,
    input: z
      .object({
        cardId: idSchema('Card'),
        name: z.string().trim().min(1).max(500).optional(),
        description: z.string().max(8000).optional(),
        due: dueSchema.nullable().optional(),
        dueComplete: z.boolean().optional(),
        listId: idSchema('List')
          .optional()
          .describe('Move the card to this list'),
      })
      .strict()
      .refine(
        (v) => Object.keys(v).some((k) => k !== 'cardId'),
        'Nothing to change',
      ),
    async lookup({ userId, timezone }, v) {
      const { card } = await loadCard(client, userId, timezone, v.cardId);
      const target = v.listId
        ? await loadList(client, userId, v.listId)
        : undefined;
      return { card, target };
    },
    summarize(v, before): ActionSummary {
      const b = before as { card: TrelloCard; target?: ListInfo } | undefined;
      const card = b?.card;
      return {
        title: 'Change Trello card',
        details: {
          Card: card?.name ?? v.cardId,
          ...(v.name ? { Name: change(card?.name, v.name) } : {}),
          ...(v.listId
            ? {
                List: change(
                  card && place(card.board.name, card.list.name),
                  b?.target
                    ? place(b.target.board.name, b.target.name)
                    : v.listId,
                ),
              }
            : {}),
          ...(v.due !== undefined
            ? {
                Due: change(
                  card && shortDue(card.due),
                  v.due === null ? 'none' : shortDue(v.due),
                ),
              }
            : {}),
          ...(v.dueComplete !== undefined
            ? {
                Done: change(
                  card && (card.dueComplete ? 'yes' : 'no'),
                  v.dueComplete ? 'yes' : 'no',
                ),
              }
            : {}),
          ...(v.description !== undefined
            ? { Description: v.description }
            : {}),
        },
      };
    },
    async execute({ userId, timezone }, v) {
      const { raw } = await loadCard(client, userId, timezone, v.cardId);
      const target = v.listId
        ? await loadList(client, userId, v.listId)
        : undefined;
      const card = await client.request<ApiCard>(
        userId,
        'PUT',
        `/cards/${v.cardId}`,
        {
          body: {
            name: v.name,
            desc: v.description,
            due:
              v.due === undefined
                ? undefined
                : v.due === null
                  ? null
                  : dueToTrello(v.due, timezone),
            dueComplete: v.dueComplete,
            ...(target ? { idList: target.id, idBoard: target.board.id } : {}),
          },
        },
      );
      return {
        id: card.id,
        name: card.name,
        due: card.due ? localDue(card.due, timezone) : null,
        dueComplete: Boolean(card.dueComplete),
        ...(target ? { movedTo: place(target.board.name, target.name) } : {}),
        link: card.url,
        previous: snapshot(raw),
      };
    },
    async undo({ userId }, result) {
      const id = createdId(result);
      const prev = (result as { previous?: CardSnapshot }).previous;
      if (!prev) throw trelloError('There is nothing to undo for this action.');
      await client.request(userId, 'PUT', `/cards/${id}`, {
        body: { ...prev },
      });
    },
  });

  const archiveCard = defineTool({
    name: 'archive_trello_card',
    description:
      "Archive a Trello card (it can be restored from the board's archive). Requires the user's confirmation " +
      'before it runs. To mark a card done, use update_trello_card with dueComplete or move it instead.',
    mutating: true,
    input: z.object({ cardId: idSchema('Card') }).strict(),
    lookup: async ({ userId, timezone }, v) =>
      (await loadCard(client, userId, timezone, v.cardId)).card,
    summarize(v, before): ActionSummary {
      const card = before as TrelloCard | undefined;
      return {
        title: 'Archive Trello card',
        details: card
          ? {
              Card: card.name,
              List: place(card.board.name, card.list.name),
              ...(card.due ? { Due: shortDue(card.due) } : {}),
            }
          : { Card: v.cardId },
      };
    },
    async execute({ userId }, v) {
      const card = await client.request<ApiCard>(
        userId,
        'PUT',
        `/cards/${v.cardId}`,
        { body: { closed: true } },
      );
      return { id: card.id, name: card.name, archived: true, link: card.url };
    },
    async undo({ userId }, result) {
      const id = createdId(result);
      await client.request(userId, 'PUT', `/cards/${id}`, {
        body: { closed: false },
      });
    },
  });

  const commentCard = defineTool({
    name: 'comment_trello_card',
    description:
      "Add a comment to a Trello card. Requires the user's confirmation before it runs.",
    mutating: true,
    input: z
      .object({
        cardId: idSchema('Card'),
        text: z.string().trim().min(1).max(5000),
      })
      .strict(),
    lookup: async ({ userId, timezone }, v) =>
      (await loadCard(client, userId, timezone, v.cardId)).card,
    summarize(v, before): ActionSummary {
      const card = before as TrelloCard | undefined;
      return {
        title: 'Comment on Trello card',
        details: {
          Card: card?.name ?? v.cardId,
          ...(card ? { List: place(card.board.name, card.list.name) } : {}),
          Comment: v.text,
        },
      };
    },
    async execute({ userId }, v) {
      const action = await client.request<{
        id: string;
        data?: { card?: { shortLink?: string } };
      }>(userId, 'POST', `/cards/${v.cardId}/actions/comments`, {
        body: { text: v.text },
      });
      const shortLink = action.data?.card?.shortLink;
      return {
        id: action.id,
        cardId: v.cardId,
        link: shortLink ? `https://trello.com/c/${shortLink}` : undefined,
      };
    },
    async undo({ userId }, result) {
      const id = createdId(result);
      await removeFromTrello(() =>
        client.request(userId, 'DELETE', `/actions/${id}`),
      );
    },
  });

  return [
    listBoards,
    listCards,
    createCard,
    updateCard,
    archiveCard,
    commentCard,
  ] as const;
}
