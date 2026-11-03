import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole, UserStatus } from './entities/user.entity';
import { LoginDto, CreateClientDto, UpdateClientDto } from './dto/user.dto';
import { hashPassword, verifyPassword } from './user-auth.util';
import { AuthService } from '../auth/auth.service';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { SessionService } from '../session/session.service';
import { readBootstrapKey } from '../auth/bootstrap-key-file';
import { randomBytes, randomUUID } from 'crypto';

@Injectable()
export class UserService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UserService.name);

  constructor(
    @InjectRepository(User, 'data')
    private readonly userRepo: Repository<User>,
    private readonly authService: AuthService,
    private readonly sessionService: SessionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureUserTableExists();
    await this.seedAdminIfNone();
    await this.syncAllUserApiKeys();
  }

  private async syncAllUserApiKeys(): Promise<void> {
    try {
      const users = await this.userRepo.find();
      for (const user of users) {
        if (user.apiKey) {
          await this.authService.ensureApiKeyExists(
            user.apiKey,
            user.role === 'admin' ? `Admin: ${user.name}` : `Client: ${user.name}`,
            user.role === 'admin' ? ApiKeyRole.ADMIN : ApiKeyRole.OPERATOR,
            user.sessionId ? [user.sessionId] : null,
          );
        }
      }
      this.logger.log(`Synced ${users.length} persistent user API keys to auth store.`);
    } catch (err) {
      this.logger.warn(`Could not sync user API keys on boot: ${String(err)}`);
    }
  }

  private async ensureUserTableExists(): Promise<void> {
    try {
      const isPostgres = this.userRepo.manager.connection.options.type === 'postgres';
      const timestampCol = isPostgres ? "timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP" : "datetime NOT NULL DEFAULT (datetime('now'))";
      const nullableDateCol = isPostgres ? "timestamp" : "datetime";

      await this.userRepo.query(`
        CREATE TABLE IF NOT EXISTS "users" (
          "id" varchar PRIMARY KEY NOT NULL,
          "name" varchar(150) NOT NULL,
          "email" varchar(150) NOT NULL,
          "passwordHash" varchar(255) NOT NULL,
          "role" varchar(50) NOT NULL DEFAULT 'client',
          "status" varchar(50) NOT NULL DEFAULT 'active',
          "sessionId" varchar(100),
          "apiKey" varchar(255),
          "expiresAt" ${nullableDateCol},
          "created_at" ${timestampCol},
          "updated_at" ${timestampCol}
        )
      `);
      await this.userRepo.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_users_email" ON "users" ("email")
      `);
    } catch (err) {
      this.logger.warn(`Notice while ensuring users table: ${String(err)}`);
    }
  }

  private async seedAdminIfNone(): Promise<void> {
    try {
      await this.ensureUserTableExists();
      const masterKey = process.env.API_MASTER_KEY?.trim() || readBootstrapKey(this.logger) || 'owa_k1_zubair_marketing_master_key_2026_render';
      const existingAdmin = await this.userRepo.findOne({ where: { role: 'admin' } });

      if (!existingAdmin) {
        await this.authService.ensureApiKeyExists(masterKey, 'Master Admin Key', ApiKeyRole.ADMIN);
        const admin = this.userRepo.create({
          id: randomUUID(),
          name: 'Zubair Ahmed',
          email: 'admin@zubairahmed.com',
          passwordHash: hashPassword('Admin@Zubair2026'),
          role: 'admin',
          status: 'active',
          sessionId: null, // Admin can access all sessions
          apiKey: masterKey,
          expiresAt: null,
        });

        await this.userRepo.save(admin);
        this.logger.log('Seeded Master Admin: admin@zubairahmed.com');
      } else {
        const adminKey = existingAdmin.apiKey || masterKey;
        if (!existingAdmin.apiKey) {
          existingAdmin.apiKey = adminKey;
          await this.userRepo.save(existingAdmin);
        }
        await this.authService.ensureApiKeyExists(adminKey, 'Master Admin Key', ApiKeyRole.ADMIN);
      }
    } catch (err) {
      this.logger.warn(`Notice while seeding master admin: ${String(err)}`);
    }
  }

  async login(dto: LoginDto): Promise<{
    token: string;
    user: {
      id: string;
      name: string;
      email: string;
      role: UserRole;
      status: UserStatus;
      sessionId: string | null;
      expiresAt: string | null;
      daysRemaining?: number;
    };
  }> {
    try {
      await this.ensureUserTableExists();
      const count = await this.userRepo.count();
      if (count === 0) {
        await this.seedAdminIfNone();
      }

      const email = dto.email.trim().toLowerCase();
      const user = await this.userRepo.findOne({ where: { email } });

      if (!user) {
        throw new UnauthorizedException('Invalid email or password');
      }

      if (!verifyPassword(dto.password, user.passwordHash)) {
        throw new UnauthorizedException('Invalid email or password');
      }

      if (user.status === 'disabled') {
        throw new ForbiddenException('Your account has been deactivated. Please contact Zubair Ahmed.');
      }

      if (user.expiresAt) {
        const now = new Date();
        if (new Date(user.expiresAt) < now) {
          const dateStr = new Date(user.expiresAt).toISOString().slice(0, 10);
          throw new ForbiddenException(
            `Your subscription expired on ${dateStr}. Please contact Zubair Ahmed to renew.`,
          );
        }
      }

      // Ensure user has valid API key and that it is active in auth service
      if (!user.apiKey) {
        user.apiKey = `owa_k1_${randomBytes(32).toString('hex')}`;
      }

      await this.authService.ensureApiKeyExists(
        user.apiKey,
        user.role === 'admin' ? `Admin: ${user.name}` : `Client: ${user.name}`,
        user.role === 'admin' ? ApiKeyRole.ADMIN : ApiKeyRole.OPERATOR,
        user.sessionId ? [user.sessionId] : null,
      );

      await this.userRepo.save(user);

      // Auto-heal: If client has a session name rather than a UUID, resolve it
      const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (user.role === 'client' && user.sessionId) {
        if (!UUID_REGEX.test(user.sessionId)) {
          try {
            const found = await this.sessionService.findAll(null, { name: user.sessionId });
            if (found && found.length > 0) {
              const matchedSession = found[0];
              user.sessionId = matchedSession.id;
              if (user.apiKey) {
                await this.authService.ensureKeyAllowsSession(user.apiKey, matchedSession.id);
                await this.authService.ensureKeyAllowsSession(user.apiKey, matchedSession.name);
              }
              await this.userRepo.save(user);
            }
          } catch (e) {
            this.logger.warn(`Could not auto-migrate client sessionId: ${String(e)}`);
          }
        } else if (user.apiKey) {
          await this.authService.ensureKeyAllowsSession(user.apiKey, user.sessionId);
        }
      }

      let daysRemaining: number | undefined;
      if (user.expiresAt) {
        const ms = new Date(user.expiresAt).getTime() - Date.now();
        daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
      }

      return {
        token: user.apiKey,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          status: user.status,
          sessionId: user.sessionId,
          expiresAt: user.expiresAt ? user.expiresAt.toISOString() : null,
          daysRemaining,
        },
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Login error: ${String(err)}`, (err as any)?.stack);
      throw new InternalServerErrorException(err instanceof Error ? err.message : 'Login failed');
    }
  }

  async getMe(apiKeyHeader?: string): Promise<{
    id: string;
    name: string;
    email: string;
    role: UserRole;
    status: UserStatus;
    sessionId: string | null;
    expiresAt: string | null;
    daysRemaining?: number;
  }> {
    if (!apiKeyHeader) {
      throw new UnauthorizedException('No token provided');
    }

    await this.ensureUserTableExists();
    const user = await this.userRepo.findOne({ where: { apiKey: apiKeyHeader } });
    if (!user) {
      const masterKey = readBootstrapKey(this.logger);
      if (masterKey && masterKey === apiKeyHeader) {
        return {
          id: 'admin-master',
          name: 'Zubair Ahmed',
          email: 'admin@zubairahmed.com',
          role: 'admin',
          status: 'active',
          sessionId: null,
          expiresAt: null,
        };
      }
      throw new NotFoundException('User profile not found');
    }

    let daysRemaining: number | undefined;
    if (user.expiresAt) {
      const ms = new Date(user.expiresAt).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      sessionId: user.sessionId,
      expiresAt: user.expiresAt ? user.expiresAt.toISOString() : null,
      daysRemaining,
    };
  }

  async createClient(dto: CreateClientDto): Promise<any> {
    await this.ensureUserTableExists();
    const email = dto.email.trim().toLowerCase();
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException(`User with email '${email}' already exists`);
    }

    const cleanName = dto.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'user';
    const rand = randomBytes(3).toString('hex');
    const sessionName = `client_${cleanName}_${rand}`;

    let createdSession: any;
    try {
      createdSession = await this.sessionService.create({ name: sessionName });
    } catch (e) {
      this.logger.warn(`Session create notice: ${String(e)}`);
    }

    const actualSessionId = createdSession?.id || sessionName;
    const validityDays = dto.validityDays && dto.validityDays > 0 ? dto.validityDays : 30;
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

    const allowedSessions = createdSession?.id ? [createdSession.id, sessionName] : [sessionName];

    let rawApiKey: string;
    try {
      const key = await this.authService.createApiKey({
        name: `Client: ${dto.name}`,
        role: ApiKeyRole.OPERATOR,
        allowedSessions,
        expiresAt: expiresAt.toISOString(),
      });
      rawApiKey = key.rawKey;
    } catch {
      rawApiKey = 'owa_k1_' + randomBytes(32).toString('hex');
    }

    const user = this.userRepo.create({
      id: randomUUID(),
      name: dto.name.trim(),
      email,
      passwordHash: hashPassword(dto.password),
      role: 'client',
      status: 'active',
      sessionId: actualSessionId,
      apiKey: rawApiKey,
      expiresAt,
    });
    const saved = await this.userRepo.save(user);

    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      role: saved.role,
      status: saved.status,
      sessionId: saved.sessionId,
      expiresAt: saved.expiresAt?.toISOString(),
      daysRemaining: validityDays,
      createdAt: saved.createdAt,
    };
  }

  async getClients(): Promise<any[]> {
    await this.ensureUserTableExists();
    const clients = await this.userRepo.find({
      where: { role: 'client' },
      order: { createdAt: 'DESC' },
    });

    return clients.map(c => {
      let daysRemaining = 0;
      let isExpired = false;
      if (c.expiresAt) {
        const ms = new Date(c.expiresAt).getTime() - Date.now();
        daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
        isExpired = new Date(c.expiresAt) < new Date();
      }
      return {
        id: c.id,
        name: c.name,
        email: c.email,
        role: c.role,
        status: c.status,
        sessionId: c.sessionId,
        expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
        daysRemaining,
        isExpired,
        createdAt: c.createdAt,
      };
    });
  }

  async updateClient(id: string, dto: UpdateClientDto): Promise<any> {
    await this.ensureUserTableExists();
    const user = await this.userRepo.findOne({ where: { id, role: 'client' } });
    if (!user) {
      throw new NotFoundException(`Client with id '${id}' not found`);
    }

    if (dto.name !== undefined) user.name = dto.name.trim();
    if (dto.status !== undefined) user.status = dto.status;
    if (dto.password) user.passwordHash = hashPassword(dto.password);

    if (dto.addDays && dto.addDays > 0) {
      const currentExp = user.expiresAt && new Date(user.expiresAt) > new Date()
        ? new Date(user.expiresAt).getTime()
        : Date.now();
      user.expiresAt = new Date(currentExp + dto.addDays * 24 * 60 * 60 * 1000);
      user.status = 'active';
    } else if (dto.expiresAt) {
      user.expiresAt = new Date(dto.expiresAt);
    }

    const saved = await this.userRepo.save(user);

    let daysRemaining = 0;
    if (saved.expiresAt) {
      const ms = new Date(saved.expiresAt).getTime() - Date.now();
      daysRemaining = Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
    }

    return {
      id: saved.id,
      name: saved.name,
      email: saved.email,
      role: saved.role,
      status: saved.status,
      sessionId: saved.sessionId,
      expiresAt: saved.expiresAt ? saved.expiresAt.toISOString() : null,
      daysRemaining,
      updatedAt: saved.updatedAt,
    };
  }

  async deleteClient(id: string): Promise<void> {
    await this.ensureUserTableExists();
    const user = await this.userRepo.findOne({ where: { id, role: 'client' } });
    if (!user) {
      throw new NotFoundException(`Client with id '${id}' not found`);
    }

    if (user.sessionId) {
      try {
        await this.sessionService.delete(user.sessionId);
      } catch (err) {
        this.logger.warn(`Could not delete session ${user.sessionId}: ${String(err)}`);
      }
    }

    await this.userRepo.remove(user);
  }
}
