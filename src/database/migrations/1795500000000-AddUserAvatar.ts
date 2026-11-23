import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddUserAvatar1795500000000 implements MigrationInterface {
  name = 'AddUserAvatar1795500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "avatarUrl" character varying(2048)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "avatarUrl"`);
  }
}
