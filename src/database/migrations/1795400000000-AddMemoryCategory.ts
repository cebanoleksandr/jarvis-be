import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMemoryCategory1795400000000 implements MigrationInterface {
  name = 'AddMemoryCategory1795400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "memories" ADD "category" character varying(16) NOT NULL DEFAULT 'other'`,
    );
    await queryRunner.query(
      `ALTER TABLE "memories" ADD "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    // Existing notes were last changed no later than they were created.
    await queryRunner.query(`UPDATE "memories" SET "updatedAt" = "createdAt"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "memories" DROP COLUMN "updatedAt"`);
    await queryRunner.query(`ALTER TABLE "memories" DROP COLUMN "category"`);
  }
}
