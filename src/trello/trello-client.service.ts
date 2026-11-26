import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ToolError } from '../agent/tool.js';
import { TokenCipher } from '../common/crypto/token-cipher.js';
import type { Env } from '../config/env.validation.js';
import { TrelloAccount } from './trello-account.entity.js';

const API = 'https://api.trello.com/1';
const TIMEOUT_MS = 15_000;
const RECONNECT_HINT =
  'Ask the user to reconnect Trello in Memory & Settings → Connections.';

type Query = Record<string, string | number | boolean | undefined>;

export interface TrelloRequest {
  query?: Query;
  /** Sent as JSON. `null` values clear a field (e.g. `due`). */
  body?: Record<string, unknown>;
}

/** Errors the model and the user can act on; `reauthRequired` means reconnect. */
export const trelloError = (message: string, reauth = false) =>
  new ToolError(message, { reauthRequired: reauth, provider: 'trello' });

/**
 * Calls the Trello REST API as a user. The key and token go in the
 * Authorization header, never in the URL, so they stay out of logs.
 */
@Injectable()
export class TrelloClientService {
  readonly apiKey: string | undefined;

  constructor(
    config: ConfigService<Env, true>,
    @InjectRepository(TrelloAccount)
    private readonly accounts: Repository<TrelloAccount>,
    private readonly cipher: TokenCipher,
  ) {
    this.apiKey = config.get('TRELLO_API_KEY', { infer: true });
  }

  /** Whether the server has a Trello API key at all. */
  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async request<T>(
    userId: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    req: TrelloRequest = {},
  ): Promise<T> {
    const account = await this.accounts.findOneBy({ userId });
    if (!account) {
      throw trelloError(`Trello is not connected. ${RECONNECT_HINT}`, true);
    }
    return this.withToken<T>(
      this.cipher.decrypt(account.tokenEnc),
      method,
      path,
      req,
    );
  }

  /** Same, with an explicit token (while connecting or revoking). */
  async withToken<T>(
    token: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    { query, body }: TrelloRequest = {},
  ): Promise<T> {
    if (!this.apiKey) {
      throw trelloError('Trello is not available on this server.');
    }
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `OAuth oauth_consumer_key="${this.apiKey}", oauth_token="${token}"`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      };
      if (body && method !== 'GET') init.body = JSON.stringify(body);
      res = await fetch(url, init);
    } catch {
      throw trelloError('Trello did not respond. Try again later.');
    }
    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T;
    }
    const detail = (await res.text().catch(() => '')).slice(0, 200).trim();
    if (res.status === 401) {
      throw trelloError(
        `Trello access was revoked or has expired. ${RECONNECT_HINT}`,
        true,
      );
    }
    if (res.status === 403) {
      throw trelloError(`Trello denied the request: ${detail || 'forbidden'}`);
    }
    if (res.status === 404) throw trelloError('Not found in Trello.');
    if (res.status === 429) {
      throw trelloError('Trello rate limit reached. Try again in a minute.');
    }
    if (res.status === 400 || res.status === 422) {
      throw trelloError(
        `Trello rejected the request: ${detail || 'bad request'}`,
      );
    }
    throw trelloError(`Trello failed (HTTP ${res.status}). Try again later.`);
  }
}
