import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { BaileysAuthFile } from './baileys-auth-file.entity';
import { createLogger } from '../../common/services/logger.service';

export interface BaileysAuthStore {
  restoreToDisk(sessionId: string, folder: string): Promise<boolean>;
  saveFile(sessionId: string, fileName: string, data: string): Promise<void>;
  removeFile(sessionId: string, fileName: string): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

@Injectable()
export class BaileysAuthStoreService implements BaileysAuthStore {
  private readonly logger = createLogger('BaileysAuthStoreService');

  constructor(
    @InjectRepository(BaileysAuthFile, 'data')
    private readonly repo: Repository<BaileysAuthFile>,
  ) {}

  /**
   * Restore all persisted auth files for this session from the database to the local disk directory.
   * Returns true if creds.json was found and restored.
   */
  async restoreToDisk(sessionId: string, folder: string): Promise<boolean> {
    try {
      const files = await this.repo.find({ where: { sessionId } });
      if (files.length === 0) return false;

      await fsp.mkdir(folder, { recursive: true });
      for (const file of files) {
        // Prevent path traversal
        const safeBaseName = path.basename(file.fileName);
        const target = path.join(folder, safeBaseName);
        await fsp.writeFile(target, file.data, 'utf-8');
      }

      const hasCreds = files.some(f => f.fileName === 'creds.json');
      this.logger.log(`Restored ${files.length} Baileys auth file(s) from database for session ${sessionId}`, {
        sessionId,
        hasCreds,
      });
      return hasCreds;
    } catch (err) {
      this.logger.warn(`Failed to restore auth files from database for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Persist or update an auth file in the database.
   */
  async saveFile(sessionId: string, fileName: string, data: string): Promise<void> {
    try {
      const safeName = path.basename(fileName);
      await this.repo.upsert(
        { sessionId, fileName: safeName, data, updatedAt: new Date() },
        ['sessionId', 'fileName'],
      );
    } catch (err) {
      this.logger.warn(`Failed to persist auth file ${fileName} for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Delete an auth file from the database.
   */
  async removeFile(sessionId: string, fileName: string): Promise<void> {
    try {
      const safeName = path.basename(fileName);
      await this.repo.delete({ sessionId, fileName: safeName });
    } catch (err) {
      this.logger.warn(`Failed to delete auth file ${fileName} for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Remove all auth files for a session (e.g. on terminal logout or session deletion).
   */
  async clearSession(sessionId: string): Promise<void> {
    try {
      await this.repo.delete({ sessionId });
      this.logger.log(`Cleared Baileys auth files from database for session ${sessionId}`);
    } catch (err) {
      this.logger.warn(`Failed to clear auth files for session ${sessionId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
