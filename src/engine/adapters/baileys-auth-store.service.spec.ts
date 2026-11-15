import { Repository } from 'typeorm';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaileysAuthStoreService } from './baileys-auth-store.service';
import { BaileysAuthFile } from './baileys-auth-file.entity';

describe('BaileysAuthStoreService', () => {
  let service: BaileysAuthStoreService;
  let repo: jest.Mocked<Repository<BaileysAuthFile>>;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'baileys-auth-store-test-'));
    repo = {
      find: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined as never),
      delete: jest.fn().mockResolvedValue(undefined as never),
    } as unknown as jest.Mocked<Repository<BaileysAuthFile>>;
    service = new BaileysAuthStoreService(repo);
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('restoreToDisk', () => {
    it('returns false when no files exist in the database', async () => {
      repo.find.mockResolvedValueOnce([]);
      const result = await service.restoreToDisk('s1', tempDir);
      expect(result).toBe(false);
    });

    it('restores files to disk and returns true when creds.json exists', async () => {
      repo.find.mockResolvedValueOnce([
        { sessionId: 's1', fileName: 'creds.json', data: '{"me":{"id":"123"}}' } as BaileysAuthFile,
        { sessionId: 's1', fileName: 'app-state-sync-key-1.json', data: '{"key":"abc"}' } as BaileysAuthFile,
      ]);

      const result = await service.restoreToDisk('s1', tempDir);
      expect(result).toBe(true);

      const credsOnDisk = await fsp.readFile(path.join(tempDir, 'creds.json'), 'utf-8');
      expect(credsOnDisk).toBe('{"me":{"id":"123"}}');

      const keyOnDisk = await fsp.readFile(path.join(tempDir, 'app-state-sync-key-1.json'), 'utf-8');
      expect(keyOnDisk).toBe('{"key":"abc"}');
    });
  });

  describe('saveFile', () => {
    it('upserts the file record into the database', async () => {
      await service.saveFile('s1', 'creds.json', '{"test":1}');
      expect(repo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 's1',
          fileName: 'creds.json',
          data: '{"test":1}',
        }),
        ['sessionId', 'fileName'],
      );
    });
  });

  describe('removeFile', () => {
    it('deletes the file from the database', async () => {
      await service.removeFile('s1', 'creds.json');
      expect(repo.delete).toHaveBeenCalledWith({ sessionId: 's1', fileName: 'creds.json' });
    });
  });

  describe('clearSession', () => {
    it('deletes all files for the session from the database', async () => {
      await service.clearSession('s1');
      expect(repo.delete).toHaveBeenCalledWith({ sessionId: 's1' });
    });
  });
});
