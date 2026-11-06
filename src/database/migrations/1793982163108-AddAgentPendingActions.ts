import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAgentPendingActions1793982163108 implements MigrationInterface {
  name = 'AddAgentPendingActions1793982163108';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_751332fc6cc6fc576c6975cd07"`,
    );
    await queryRunner.query(
      `CREATE TABLE "pending_actions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "conversationId" uuid NOT NULL, "messageId" uuid NOT NULL, "toolUseId" character varying(100) NOT NULL, "tool" character varying(100) NOT NULL, "mutating" boolean NOT NULL, "args" jsonb NOT NULL, "originalArgs" jsonb, "summary" jsonb, "status" character varying(16) NOT NULL, "result" jsonb, "error" text, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "resolvedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_ce4a91f62be035bef4054e35fde" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7a5e9f5602a524af374e44374c" ON "pending_actions"  ("messageId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_118e108149af32d2e0fbee226d" ON "pending_actions"  ("userId", "status") `,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD "seq" BIGSERIAL NOT NULL`,
    );
    // Hand-written: number existing messages in chronological order and move
    // the sequence past them, so old conversations replay correctly.
    await queryRunner.query(
      `UPDATE "messages" m SET "seq" = o.rn FROM (SELECT "id", row_number() OVER (ORDER BY "createdAt", "id") AS rn FROM "messages") o WHERE m."id" = o."id"`,
    );
    await queryRunner.query(
      `SELECT setval(pg_get_serial_sequence('messages', 'seq'), COALESCE((SELECT MAX("seq") FROM "messages"), 0) + 1, false)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f0874fbc4bba5c9edc9ca528f8" ON "messages"  ("conversationId", "seq") `,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_actions" ADD CONSTRAINT "FK_d809a63564bb82432a8ede0731d" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_actions" ADD CONSTRAINT "FK_f92cca6468ee9cdf069fd8efc02" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_actions" ADD CONSTRAINT "FK_7a5e9f5602a524af374e44374ce" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pending_actions" DROP CONSTRAINT "FK_7a5e9f5602a524af374e44374ce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_actions" DROP CONSTRAINT "FK_f92cca6468ee9cdf069fd8efc02"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pending_actions" DROP CONSTRAINT "FK_d809a63564bb82432a8ede0731d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f0874fbc4bba5c9edc9ca528f8"`,
    );
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "seq"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_118e108149af32d2e0fbee226d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7a5e9f5602a524af374e44374c"`,
    );
    await queryRunner.query(`DROP TABLE "pending_actions"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_751332fc6cc6fc576c6975cd07" ON "messages" USING btree ("conversationId", "createdAt") `,
    );
  }
}
