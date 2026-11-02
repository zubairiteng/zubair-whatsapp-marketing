import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { UserService } from './user.service';
import { LoginDto, CreateClientDto, UpdateClientDto } from './dto/user.dto';
import { Public, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

@ApiTags('users')
@Controller()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('auth/login')
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiResponse({ status: 200, description: 'Authentication successful' })
  async login(@Body() dto: LoginDto) {
    return this.userService.login(dto);
  }

  @Get('auth/me')
  @Public()
  @ApiOperation({ summary: 'Get current user profile and session info' })
  async getMe(@Req() req: Request) {
    const rawKey =
      (req.headers['x-api-key'] as string) ||
      (req.headers['authorization']?.replace(/^Bearer\s+/i, '') as string);
    return this.userService.getMe(rawKey);
  }

  @Get('admin/clients')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List all client accounts (Admin only)' })
  async getClients() {
    return this.userService.getClients();
  }

  @Post('admin/clients')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a new client account with dedicated session (Admin only)' })
  async createClient(@Body() dto: CreateClientDto) {
    return this.userService.createClient(dto);
  }

  @Patch('admin/clients/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update or extend client account (Admin only)' })
  async updateClient(@Param('id') id: string, @Body() dto: UpdateClientDto) {
    return this.userService.updateClient(id, dto);
  }

  @Delete('admin/clients/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a client account (Admin only)' })
  async deleteClient(@Param('id') id: string): Promise<void> {
    return this.userService.deleteClient(id);
  }
}
