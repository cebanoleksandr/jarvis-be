import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProfilesGoalsMemories1793981572695 implements MigrationInterface {
  name = 'AddProfilesGoalsMemories1793981572695';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "goals" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "parentId" uuid, "title" character varying(300) NOT NULL, "notes" text NOT NULL DEFAULT '', "status" character varying(16) NOT NULL DEFAULT 'active', "deadline" date, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_26e17b251afab35580dff769223" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3ace23ef9179a434892c9586d6" ON "goals"  ("parentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_618b41eda280b30fe5e8611b8d" ON "goals"  ("userId", "status") `,
    );
    await queryRunner.query(
      `CREATE TABLE "memories" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "text" character varying(1000) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_aaa0692d9496fe827b0568612f8" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_9d0e9100ef9cf99e9f817dd8cd" ON "memories"  ("userId", "createdAt") `,
    );
    await queryRunner.query(
      `CREATE TABLE "profiles" ("userId" uuid NOT NULL, "about" text NOT NULL DEFAULT '', "preferences" jsonb NOT NULL DEFAULT '{}', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_315ecd98bd1a42dcf2ec4e2e985" PRIMARY KEY ("userId"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "goals" ADD CONSTRAINT "FK_57dd8a3fc26eb760d076bf8840e" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "goals" ADD CONSTRAINT "FK_3ace23ef9179a434892c9586d6e" FOREIGN KEY ("parentId") REFERENCES "goals"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "memories" ADD CONSTRAINT "FK_09f2d38267f7e0cf58060592a16" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "profiles" ADD CONSTRAINT "FK_315ecd98bd1a42dcf2ec4e2e985" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "profiles" DROP CONSTRAINT "FK_315ecd98bd1a42dcf2ec4e2e985"`,
    );
    await queryRunner.query(
      `ALTER TABLE "memories" DROP CONSTRAINT "FK_09f2d38267f7e0cf58060592a16"`,
    );
    await queryRunner.query(
      `ALTER TABLE "goals" DROP CONSTRAINT "FK_3ace23ef9179a434892c9586d6e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "goals" DROP CONSTRAINT "FK_57dd8a3fc26eb760d076bf8840e"`,
    );
    await queryRunner.query(`DROP TABLE "profiles"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_9d0e9100ef9cf99e9f817dd8cd"`,
    );
    await queryRunner.query(`DROP TABLE "memories"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_618b41eda280b30fe5e8611b8d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3ace23ef9179a434892c9586d6"`,
    );
    await queryRunner.query(`DROP TABLE "goals"`);
  }
}
