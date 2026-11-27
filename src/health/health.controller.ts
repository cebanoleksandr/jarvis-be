import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Public } from '../auth/public.decorator.js';
import { DataSource } from 'typeorm';

@Public()
@Controller('health')
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Liveness without touching the database: for uptime pingers that keep a
   * free instance awake, so the serverless database can still scale to zero.
   */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get()
  async check() {
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
    return { status: 'ok', db: 'up' };
  }
}
