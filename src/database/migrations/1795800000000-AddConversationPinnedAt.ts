import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConversationPinnedAt1795800000000 implements MigrationInterface {
  name = 'AddConversationPinnedAt1795800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "pinnedAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "pinnedAt"`,
    );
  }
}
