import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
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
import { randomBytes } from 'crypto';

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
    await this.seedAdminIfNone();
  }

  private async seedAdminIfNone(): Promise<void> {
    try {
      const adminCount = await this.userRepo.count({ where: { role: 'admin' } });
      if (adminCount === 0) {
        const rawMasterKey = readBootstrapKey(this.logger);
        
        let masterApiKey = rawMasterKey;
        if (!masterApiKey) {
          const created = await this.authService.createApiKey({
            name: 'Master Admin Key',
            role: ApiKeyRole.ADMIN,
          });
          masterApiKey = created.rawKey;
        }

        const admin = this.userRepo.create({
          name: 'Zubair Ahmed',
          email: 'admin@zubairahmed.com',
          passwordHash: hashPassword('Admin@Zubair2026'),
          role: 'admin',
          status: 'active',
          sessionId: null, // Admin can access all sessions
          apiKey: masterApiKey,
          expiresAt: null,
        });

        await this.userRepo.save(admin);
        this.logger.log('Seeded Master Admin: admin@zubairahmed.com');
      }
    } catch (err) {
      this.logger.warn(`Could not seed master admin: ${String(err)}`);
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

    // Ensure user has valid API key
    if (!user.apiKey) {
      if (user.role === 'admin') {
        const key = await this.authService.createApiKey({
          name: `Admin: ${user.name}`,
          role: ApiKeyRole.ADMIN,
        });
        user.apiKey = key.rawKey;
      } else {
        const key = await this.authService.createApiKey({
          name: `Client: ${user.name}`,
          role: ApiKeyRole.OPERATOR,
          allowedSessions: user.sessionId ? [user.sessionId] : [],
        });
        user.apiKey = key.rawKey;
      }
      await this.userRepo.save(user);
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

    const user = await this.userRepo.findOne({ where: { apiKey: apiKeyHeader } });
    if (!user) {
      // Fallback for bootstrap key
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
    const email = dto.email.trim().toLowerCase();
    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException(`User with email '${email}' already exists`);
    }

    // Generate unique session id for this client
    const cleanName = dto.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'user';
    const rand = randomBytes(3).toString('hex');
    const sessionId = `client_${cleanName}_${rand}`;

    // Create session in OpenWA
    try {
      await this.sessionService.create({ name: sessionId });
    } catch (e) {
      this.logger.warn(`Session create notice: ${String(e)}`);
    }

    const validityDays = dto.validityDays && dto.validityDays > 0 ? dto.validityDays : 30;
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

    // Create API Key scoped to this session
    const key = await this.authService.createApiKey({
      name: `Client: ${dto.name}`,
      role: ApiKeyRole.OPERATOR,
      allowedSessions: [sessionId],
      expiresAt: expiresAt.toISOString(),
    });

    const user = this.userRepo.create({
      name: dto.name.trim(),
      email,
      passwordHash: hashPassword(dto.password),
      role: 'client',
      status: 'active',
      sessionId,
      apiKey: key.rawKey,
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
      user.status = 'active'; // automatically reactivate if renewed
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
    const user = await this.userRepo.findOne({ where: { id, role: 'client' } });
    if (!user) {
      throw new NotFoundException(`Client with id '${id}' not found`);
    }

    // Try deleting session if exists
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
