import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';

/**
 * Lets modules that users depend on (the briefing scheduler) react to user
 * changes without users importing them back.
 */
@Injectable()
export class UserEvents {
  private readonly schedule = new Subject<string>();

  /** Emits a user id whenever their briefing times may have moved. */
  readonly scheduleChanged$ = this.schedule.asObservable();

  /** Signed in (maybe for the first time) or changed time zone. */
  scheduleChanged(userId: string): void {
    this.schedule.next(userId);
  }
}
