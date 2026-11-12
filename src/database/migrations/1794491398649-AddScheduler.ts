import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddScheduler1794491398649 implements MigrationInterface {
  name = 'AddScheduler1794491398649';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "notification_settings" ("userId" uuid NOT NULL, "morningEnabled" boolean NOT NULL DEFAULT true, "morningTime" character varying(5) NOT NULL DEFAULT '08:00', "eveningEnabled" boolean NOT NULL DEFAULT true, "eveningTime" character varying(5) NOT NULL DEFAULT '21:00', "weeklyEnabled" boolean NOT NULL DEFAULT true, "weeklyDay" smallint NOT NULL DEFAULT '0', "weeklyTime" character varying(5) NOT NULL DEFAULT '18:00', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_5a8ffc3b89343043c9440d631e2" PRIMARY KEY ("userId"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "scheduled_runs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "kind" character varying(16) NOT NULL, "localDate" date NOT NULL, "status" character varying(16) NOT NULL, "conversationId" uuid, "error" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "finishedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_6ed4b021ad35b034c830a8b5c96" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_848d4044543529a9e1ac6c6aa7" ON "scheduled_runs"  ("userId", "kind", "localDate") `,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "lastActiveAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "kind" character varying(16) NOT NULL DEFAULT 'chat'`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "synthetic" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_settings" ADD CONSTRAINT "FK_5a8ffc3b89343043c9440d631e2" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_runs" ADD CONSTRAINT "FK_6267e484260f5bc9403c1eb1f12" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_runs" ADD CONSTRAINT "FK_579d1afe048edfb8eaee2231c4d" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "scheduled_runs" DROP CONSTRAINT "FK_579d1afe048edfb8eaee2231c4d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "scheduled_runs" DROP CONSTRAINT "FK_6267e484260f5bc9403c1eb1f12"`,
    );
    await queryRunner.query(
      `ALTER TABLE "notification_settings" DROP CONSTRAINT "FK_5a8ffc3b89343043c9440d631e2"`,
    );
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "synthetic"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "kind"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "lastActiveAt"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_848d4044543529a9e1ac6c6aa7"`,
    );
    await queryRunner.query(`DROP TABLE "scheduled_runs"`);
    await queryRunner.query(`DROP TABLE "notification_settings"`);
  }
}
