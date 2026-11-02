import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from './entities/campaign.entity';
import { CampaignChunk } from './entities/campaign-chunk.entity';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { Message } from '../message/entities/message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, CampaignChunk, Message, LidMapping], 'data'),
  ],
  controllers: [CampaignController],
  providers: [CampaignService],
  exports: [CampaignService],
})
export class CampaignModule {}
