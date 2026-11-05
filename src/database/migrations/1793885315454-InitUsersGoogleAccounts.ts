import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitUsersGoogleAccounts1793885315454 implements MigrationInterface {
  name = 'InitUsersGoogleAccounts1793885315454';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "email" character varying(320) NOT NULL, "name" character varying(200), "timezone" character varying(64) NOT NULL DEFAULT 'UTC', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "google_accounts" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "googleSub" character varying(255) NOT NULL, "refreshTokenEnc" text NOT NULL, "accessTokenEnc" text, "expiresAt" TIMESTAMP WITH TIME ZONE, "scopes" text array NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_22a1c6c01dab5ce683395b6525a" UNIQUE ("googleSub"), CONSTRAINT "REL_9c9c99df27fbf1cdad3715a2f6" UNIQUE ("userId"), CONSTRAINT "PK_c443305ba5b302650c3cfd7917a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "google_accounts" ADD CONSTRAINT "FK_9c9c99df27fbf1cdad3715a2f6e" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "google_accounts" DROP CONSTRAINT "FK_9c9c99df27fbf1cdad3715a2f6e"`,
    );
    await queryRunner.query(`DROP TABLE "google_accounts"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
