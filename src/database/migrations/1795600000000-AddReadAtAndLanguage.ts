import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReadAtAndLanguage1795600000000 implements MigrationInterface {
  name = 'AddReadAtAndLanguage1795600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "readAt" TIMESTAMP WITH TIME ZONE`,
    );
    // Existing conversations are not news: count them as read.
    await queryRunner.query(
      `UPDATE "conversations" SET "readAt" = "updatedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "language" character varying(8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "language"`);
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "readAt"`);
  }
}
