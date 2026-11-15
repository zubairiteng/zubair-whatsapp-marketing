import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Persisted Baileys auth files (creds.json, signal keys, app-state sync keys, pre-keys).
 * Storing these in PostgreSQL ensures session logins survive container restarts,
 * ephemeral disk resets, and redeployments on cloud platforms (Render, Heroku, Docker).
 */
@Entity('baileys_auth_files')
export class BaileysAuthFile {
  /** Session UUID that owns this auth file. */
  @PrimaryColumn({ type: 'varchar', length: 128 })
  sessionId!: string;

  /** Relative file name (e.g. "creds.json", "pre-key-1.json", "session-xyz.json"). */
  @PrimaryColumn({ type: 'varchar', length: 255 })
  fileName!: string;

  /** Serialized UTF-8 JSON file contents. */
  @Column({ type: 'text' })
  data!: string;

  @UpdateDateColumn()
  updatedAt!: Date;
}
