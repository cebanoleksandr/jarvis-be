import { Injectable } from '@nestjs/common';
import type { AnyTool } from '../agent/tool.js';
import { GoogleClientService } from './google-client.service.js';
import { calendarTools } from './tools/calendar.tools.js';
import { tasksTools } from './tools/tasks.tools.js';

@Injectable()
export class GoogleToolsService {
  readonly tools: AnyTool[];

  constructor(google: GoogleClientService) {
    this.tools = [...calendarTools(google), ...tasksTools(google)];
  }
}
