import { Injectable } from '@nestjs/common';
import type { AnyTool } from '../agent/tool.js';
import { TrelloClientService } from './trello-client.service.js';
import { trelloTools } from './tools/trello.tools.js';

/** Registered only when the server has a Trello API key. */
@Injectable()
export class TrelloToolsService {
  readonly tools: AnyTool[];

  constructor(client: TrelloClientService) {
    this.tools = client.available ? [...trelloTools(client)] : [];
  }
}
