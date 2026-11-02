import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { Campaign } from './campaign.entity';

export interface ChunkRecipientItem {
  chatId: string;
  status: 'sent' | 'failed';
  messageId?: string;
  error?: string;
  sentAt?: string;
}

@Entity('campaign_chunks')
@Index(['campaignId', 'createdAt'])
export class CampaignChunk {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  @Index()
  campaignId!: string;

  @ManyToOne(() => Campaign, campaign => campaign.chunks, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaignId' })
  campaign!: Campaign;

  @Column({ type: 'varchar', length: 150 })
  chunkName!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @Column({ type: 'varchar', nullable: true })
  batchId!: string | null;

  @Column({ type: 'varchar', default: 'text' })
  messageType!: string;

  @Column({ type: 'text', nullable: true })
  messageContent!: string | null;

  @Column({ type: jsonColumnType(), default: '[]' })
  recipients!: ChunkRecipientItem[];

  @CreateDateColumn({ name: 'sent_at' })
  sentAt!: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
