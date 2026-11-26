import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTrelloAccounts1795900000000 implements MigrationInterface {
  name = 'AddTrelloAccounts1795900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "trello_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "memberId" character varying(64) NOT NULL, "username" character varying(255) NOT NULL, "fullName" character varying(255), "tokenEnc" text NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_trello_accounts_userId" UNIQUE ("userId"), CONSTRAINT "PK_trello_accounts" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "trello_accounts" ADD CONSTRAINT "FK_trello_accounts_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "trello_accounts" DROP CONSTRAINT "FK_trello_accounts_userId"`,
    );
    await queryRunner.query(`DROP TABLE "trello_accounts"`);
  }
}
