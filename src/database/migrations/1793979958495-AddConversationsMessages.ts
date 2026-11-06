import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConversationsMessages1793979958495 implements MigrationInterface {
  name = 'AddConversationsMessages1793979958495';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversations" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "title" character varying(200), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6e1fc25c9e988cd5688b39f14f" ON "conversations"  ("userId", "updatedAt") `,
    );
    await queryRunner.query(
      `CREATE TABLE "messages" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "conversationId" uuid NOT NULL, "role" character varying(16) NOT NULL, "content" jsonb NOT NULL, "stopReason" character varying(32), "model" character varying(100), "usage" jsonb, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_751332fc6cc6fc576c6975cd07" ON "messages"  ("conversationId", "createdAt") `,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_a9b3b5d51da1c75242055338b59" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_e5663ce0c730b2de83445e2fd19" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_e5663ce0c730b2de83445e2fd19"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_a9b3b5d51da1c75242055338b59"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_751332fc6cc6fc576c6975cd07"`,
    );
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6e1fc25c9e988cd5688b39f14f"`,
    );
    await queryRunner.query(`DROP TABLE "conversations"`);
  }
}
