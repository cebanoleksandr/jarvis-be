import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import { GoogleClientService } from './google-client.service.js';
import { type eventsRangeSchema, fetchEvents } from './tools/calendar.tools.js';
import { fetchTasks } from './tools/tasks.tools.js';

/** Read-only Calendar and Tasks data for the REST API (the agent uses the same fetchers). */
@Injectable()
export class GoogleDataService {
  constructor(private readonly google: GoogleClientService) {}

  events(
    userId: string,
    timezone: string,
    range: z.output<typeof eventsRangeSchema>,
  ) {
    return fetchEvents(this.google, userId, timezone, range);
  }

  tasks(userId: string, includeCompleted: boolean) {
    return fetchTasks(this.google, userId, includeCompleted);
  }
}
