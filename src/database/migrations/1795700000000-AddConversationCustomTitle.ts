import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConversationCustomTitle1795700000000 implements MigrationInterface {
  name = 'AddConversationCustomTitle1795700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "customTitle" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "customTitle"`,
    );
  }
}
