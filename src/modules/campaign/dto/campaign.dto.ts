import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, MaxLength, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCampaignDto {
  @ApiProperty({ description: 'Campaign name', example: 'Product Launch 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description of the campaign' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'List of recipient chat IDs or phone numbers', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipients?: string[];

  @ApiPropertyOptional({ description: 'Optional tags for categorization', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateCampaignDto {
  @ApiPropertyOptional({ description: 'Campaign name' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'List of recipient chat IDs or phone numbers', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recipients?: string[];

  @ApiPropertyOptional({ description: 'Optional tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class ChunkRecipientDto {
  @ApiProperty({ description: 'Chat ID', example: '15550000001@c.us' })
  @IsString()
  chatId!: string;

  @ApiPropertyOptional({ description: 'Send status', enum: ['sent', 'failed'], default: 'sent' })
  @IsOptional()
  @IsString()
  status?: 'sent' | 'failed';

  @ApiPropertyOptional({ description: 'Sent WhatsApp message ID' })
  @IsOptional()
  @IsString()
  messageId?: string;

  @ApiPropertyOptional({ description: 'Error message if failed' })
  @IsOptional()
  @IsString()
  error?: string;
}

export class CreateChunkDto {
  @ApiPropertyOptional({ description: 'Chunk or Run name', example: 'Chunk #1 - Day 1 Intro' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  chunkName?: string;

  @ApiProperty({ description: 'Session ID used to send', example: 'default' })
  @IsString()
  @IsNotEmpty()
  sessionId!: string;

  @ApiPropertyOptional({ description: 'Bulk batch ID if sent via bulk engine' })
  @IsOptional()
  @IsString()
  batchId?: string;

  @ApiPropertyOptional({ description: 'Message type', default: 'text' })
  @IsOptional()
  @IsString()
  messageType?: string;

  @ApiPropertyOptional({ description: 'Message content or text' })
  @IsOptional()
  @IsString()
  messageContent?: string;

  @ApiProperty({ description: 'Recipients included in this chunk', type: [ChunkRecipientDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChunkRecipientDto)
  recipients!: ChunkRecipientDto[];
}
