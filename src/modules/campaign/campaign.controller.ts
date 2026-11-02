import { Controller, Get, Post, Put, Delete, Param, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CampaignService } from './campaign.service';
import { CreateCampaignDto, UpdateCampaignDto, CreateChunkDto } from './dto/campaign.dto';
import { RequireRole, CurrentApiKey } from '../auth/decorators/auth.decorators';
import { ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyRole } from '../auth/entities/api-key.entity';

@ApiTags('campaigns')
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a new campaign' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  async create(@Body() dto: CreateCampaignDto, @CurrentApiKey() apiKey?: ApiKey) {
    const sessionId = apiKey?.allowedSessions?.[0];
    return this.campaignService.create(dto, sessionId);
  }

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List all campaigns with summary counts' })
  @ApiResponse({ status: 200, description: 'List of campaigns' })
  async findAll(@CurrentApiKey() apiKey?: ApiKey) {
    return this.campaignService.findAll(apiKey?.allowedSessions);
  }

  @Get('ai-config')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get Gemini AI configuration status' })
  async getAiConfig() {
    return this.campaignService.getAiConfig();
  }

  @Post('ai-config')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update Gemini AI configuration (API key and model)' })
  async updateAiConfig(@Body() body: { geminiApiKey?: string; geminiModel?: string }) {
    return this.campaignService.updateAiConfig(body);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get campaign details by ID' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async findOne(@Param('id') id: string) {
    return this.campaignService.findOne(id);
  }

  @Put(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a campaign' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async update(@Param('id') id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaignService.update(id, dto);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a campaign' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async delete(@Param('id') id: string): Promise<void> {
    return this.campaignService.delete(id);
  }

  @Post(':id/chunks')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Record an execution chunk / run for a campaign' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async createChunk(@Param('id') id: string, @Body() dto: CreateChunkDto) {
    return this.campaignService.createChunk(id, dto);
  }

  @Get(':id/chunks')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get all chunks for a campaign' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async getChunks(@Param('id') id: string) {
    return this.campaignService.getChunks(id);
  }

  @Get(':id/chunks/:chunkId/analytics')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get response analytics and recipient reporting for a chunk' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  @ApiParam({ name: 'chunkId', description: 'Chunk ID' })
  async getChunkAnalytics(@Param('id') id: string, @Param('chunkId') chunkId: string) {
    return this.campaignService.getChunkAnalytics(id, chunkId);
  }

  @Get(':id/analytics')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get overall response analytics for a campaign' })
  @ApiParam({ name: 'id', description: 'Campaign ID' })
  async getCampaignAnalytics(@Param('id') id: string) {
    return this.campaignService.getCampaignAnalytics(id);
  }
}
