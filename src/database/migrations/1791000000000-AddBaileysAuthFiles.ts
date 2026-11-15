import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `baileys_auth_files` table to persist Baileys authentication files (creds.json, keys)
 * in the database. This prevents cloud containers (such as Render) from losing WhatsApp sessions
 * whenever the container restarts or redeploys.
 */
export class AddBaileysAuthFiles1791000000000 implements MigrationInterface {
  name = 'AddBaileysAuthFiles1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('baileys_auth_files')) return;
    const isPostgres = queryRunner.dataSource.options.type === 'postgres';

    if (isPostgres) {
      await queryRunner.query(
        `CREATE TABLE "baileys_auth_files" (
          "sessionId" varchar(128) NOT NULL,
          "fileName" varchar(255) NOT NULL,
          "data" text NOT NULL,
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
          PRIMARY KEY ("sessionId", "fileName")
        )`,
      );
    } else {
      await queryRunner.query(
        `CREATE TABLE "baileys_auth_files" (
          "sessionId" varchar(128) NOT NULL,
          "fileName" varchar(255) NOT NULL,
          "data" text NOT NULL,
          "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY ("sessionId", "fileName")
        )`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_auth_files"`);
  }
}
