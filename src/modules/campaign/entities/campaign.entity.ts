import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';
import { CampaignChunk } from './campaign-chunk.entity';

@Entity('campaigns')
export class Campaign {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 150 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 150, nullable: true })
  @Index()
  sessionId!: string | null;

  @Column({ type: jsonColumnType(), default: '[]' })
  recipients!: string[];

  @Column({ type: jsonColumnType(), nullable: true })
  tags!: string[] | null;

  @OneToMany(() => CampaignChunk, chunk => chunk.campaign, { cascade: true })
  chunks!: CampaignChunk[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
