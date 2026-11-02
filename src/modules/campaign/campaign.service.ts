import { Injectable, NotFoundException, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Campaign } from './entities/campaign.entity';
import { CampaignChunk, ChunkRecipientItem } from './entities/campaign-chunk.entity';
import { CreateCampaignDto, UpdateCampaignDto, CreateChunkDto } from './dto/campaign.dto';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { LidMapping } from '../../engine/identity/lid-mapping.entity';

export type ResponseCategory = 'acknowledged' | 'question' | 'reaction' | 'replied' | 'ignored';

export interface RecipientResponseDetail {
  chatId: string;
  status: 'sent' | 'failed';
  messageId?: string;
  responseCategory: ResponseCategory;
  lastResponseText?: string;
  lastResponseTime?: string;
}

export interface ChunkAnalyticsResult {
  chunkId: string;
  chunkName: string;
  sentAt: string;
  sessionId: string;
  messageType: string;
  messageContent?: string | null;
  totalSent: number;
  totalDelivered: number;
  totalFailed: number;
  totalResponded: number;
  totalIgnored: number;
  responseRatePercent: number;
  summary: {
    acknowledged: number;
    questions: number;
    reactions: number;
    otherReplies: number;
    ignored: number;
    totalAcknowledged?: number;
    ackRatePercent?: number;
  };
  recipients: RecipientResponseDetail[];
}

const QUESTION_REGEX = /[?؟]|\b(kya|kab|kaise|kesay|kese|kidhar|kitna|kitne|kitni|kahan|kyun|kyu|price|cost|rate|fee|what|how|why|when|where|who|which|can|could|would|will|detail|details|info|information|tell|batao|bataen|batain|bataiye|explain)\b|کیا|کب|کیسے|کہاں|کیوں|کتنا|کتنے|تفصیل/i;
const ACK_REGEX = /\b(ok|okay|okey|okk|oky|k|kk|done|thanks|thank you|thx|ty|tnx|received|noted|theek|thik|thek|theek hai|thek hy|thik hy|acha|achha|achi|accha|ji|g|jee|yes|yeah|yep|yup|sure|got it|confirm|confirmed|shukriya|mehrbani|alhamdulillah|hanji|haan|han|ha|sahi|sahi hai|sahi hy|bilkul|fine|welcome|all good|no problem|np|right|rite|correct|alright|all right|exact|exactly|perfect|good|great|agreed)\b|[👍👌✅💯]|ٹھیک|صحیح|اوکے|شکریہ|ہاں|جی|بہتر|معلوم|ملا|وصول|درست/i;
const EMOJI_REGEX = /^(\p{Emoji_Presentation}|\p{Extended_Pictographic})+$/u;

function parseJsonArray<T>(val: any): T[] {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}


@Injectable()
export class CampaignService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    @InjectRepository(Campaign, 'data')
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(CampaignChunk, 'data')
    private readonly chunkRepo: Repository<CampaignChunk>,
    @InjectRepository(Message, 'data')
    private readonly messageRepo: Repository<Message>,
    @InjectRepository(LidMapping, 'data')
    private readonly lidRepo: Repository<LidMapping>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureCampaignTablesExist();
  }

  private async ensureCampaignTablesExist(): Promise<void> {
    try {
      const isPostgres = this.campaignRepo.manager.connection.options.type === 'postgres';
      const timestampCol = isPostgres ? "timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP" : "datetime NOT NULL DEFAULT (datetime('now'))";

      await this.campaignRepo.query(`
        CREATE TABLE IF NOT EXISTS "campaigns" (
          "id" varchar PRIMARY KEY NOT NULL,
          "name" varchar(150) NOT NULL,
          "description" text,
          "sessionId" varchar(150),
          "recipients" text NOT NULL DEFAULT '[]',
          "tags" text,
          "created_at" ${timestampCol},
          "updated_at" ${timestampCol}
        )
      `);
      try { await this.campaignRepo.query(`ALTER TABLE "campaigns" ADD COLUMN "sessionId" varchar(150)`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaigns" ADD COLUMN "description" text`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaigns" ADD COLUMN "tags" text`); } catch {}

      await this.campaignRepo.query(`
        CREATE TABLE IF NOT EXISTS "campaign_chunks" (
          "id" varchar PRIMARY KEY NOT NULL,
          "campaignId" varchar NOT NULL,
          "chunkName" varchar(150) NOT NULL,
          "sessionId" varchar NOT NULL,
          "batchId" varchar,
          "messageType" varchar NOT NULL DEFAULT 'text',
          "messageContent" text,
          "recipients" text NOT NULL DEFAULT '[]',
          "sent_at" ${timestampCol},
          "created_at" ${timestampCol}
        )
      `);
      try { await this.campaignRepo.query(`ALTER TABLE "campaign_chunks" ADD COLUMN "sent_at" ${timestampCol}`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaign_chunks" ADD COLUMN "sessionId" varchar(150)`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaign_chunks" ADD COLUMN "batchId" varchar(150)`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaign_chunks" ADD COLUMN "messageType" varchar(50) DEFAULT 'text'`); } catch {}
      try { await this.campaignRepo.query(`ALTER TABLE "campaign_chunks" ADD COLUMN "messageContent" text`); } catch {}
    } catch (err) {
      this.logger.warn(`Notice while ensuring campaign tables: ${String(err)}`);
    }
  }

  async create(dto: CreateCampaignDto, sessionId?: string): Promise<Campaign> {
    await this.ensureCampaignTablesExist();
    const campaign = this.campaignRepo.create({
      id: randomUUID(),
      name: dto.name.trim(),
      description: dto.description?.trim() || null,
      recipients: Array.isArray(dto.recipients) ? Array.from(new Set(dto.recipients.map(r => r.trim()).filter(Boolean))) : [],
      tags: dto.tags || [],
      sessionId: sessionId || null,
    });
    const saved = await this.campaignRepo.save(campaign);
    saved.recipients = parseJsonArray<string>(saved.recipients);
    saved.tags = parseJsonArray<string>(saved.tags);
    return saved;
  }

  async findAll(allowedSessions?: string[] | null): Promise<any[]> {
    await this.ensureCampaignTablesExist();
    try {
      const query = this.campaignRepo.createQueryBuilder('campaign')
        .leftJoinAndSelect('campaign.chunks', 'chunks')
        .orderBy('campaign.updatedAt', 'DESC');

      if (allowedSessions && allowedSessions.length > 0) {
        query.andWhere('(campaign.sessionId IN (:...allowedSessions) OR campaign.sessionId IS NULL)', {
          allowedSessions,
        });
      }

      const campaigns = await query.getMany();

      return campaigns.map(c => {
        const chunks = c.chunks || [];
        let totalMessagesSent = 0;
        for (const chunk of chunks) {
          const recList = parseJsonArray<ChunkRecipientItem>(chunk.recipients);
          totalMessagesSent += recList.filter(r => r && r.status === 'sent').length;
        }

        const recipientsList = parseJsonArray<string>(c.recipients);

        return {
          id: c.id,
          name: c.name,
          description: c.description,
          recipientsCount: recipientsList.length,
          chunksCount: chunks.length,
          roundsCount: chunks.length,
          totalMessagesSent,
          tags: parseJsonArray<string>(c.tags),
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        };
      });
    } catch (err) {
      this.logger.error(`Notice in findAll: ${String(err)}`);
      try {
        const simple = await this.campaignRepo.find({
          order: { updatedAt: 'DESC' },
        });
        return simple.map(c => ({
          id: c.id,
          name: c.name,
          description: c.description,
          recipientsCount: parseJsonArray<string>(c.recipients).length,
          chunksCount: 0,
          roundsCount: 0,
          totalMessagesSent: 0,
          tags: parseJsonArray<string>(c.tags),
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        }));
      } catch (err2) {
        this.logger.error(`Critical error in findAll fallback: ${String(err2)}`);
        return [];
      }
    }
  }

  async findOne(id: string): Promise<Campaign> {
    await this.ensureCampaignTablesExist();
    let campaign: Campaign | null = null;
    try {
      campaign = await this.campaignRepo.findOne({
        where: { id },
        relations: { chunks: true },
        order: { chunks: { createdAt: 'DESC' } },
      });
    } catch {
      campaign = await this.campaignRepo.findOne({ where: { id } });
    }
    if (!campaign) {
      throw new NotFoundException(`Campaign with ID '${id}' not found`);
    }
    campaign.recipients = parseJsonArray<string>(campaign.recipients);
    campaign.tags = parseJsonArray<string>(campaign.tags);
    if (campaign.chunks) {
      for (const ch of campaign.chunks) {
        ch.recipients = parseJsonArray<ChunkRecipientItem>(ch.recipients);
      }
    }
    return campaign;
  }

  async update(id: string, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.findOne(id);
    if (dto.name !== undefined) campaign.name = dto.name.trim();
    if (dto.description !== undefined) campaign.description = dto.description?.trim() || null;
    if (dto.recipients !== undefined && Array.isArray(dto.recipients)) {
      campaign.recipients = Array.from(new Set(dto.recipients.map(r => r.trim()).filter(Boolean)));
    }
    if (dto.tags !== undefined) campaign.tags = dto.tags;

    return this.campaignRepo.save(campaign);
  }

  async delete(id: string): Promise<void> {
    const campaign = await this.findOne(id);
    await this.campaignRepo.remove(campaign);
  }

  async createChunk(campaignId: string, dto: CreateChunkDto): Promise<CampaignChunk> {
    await this.ensureCampaignTablesExist();
    const campaign = await this.findOne(campaignId);
    const existingCount = campaign.chunks?.length || 0;
    const now = new Date();

    const rawName = dto.chunkName?.trim();
    const chunkName = rawName
      ? rawName.replace(/^Chunk\b/i, 'Round')
      : `Round ${existingCount + 1}`;

    const recipientItems: ChunkRecipientItem[] = dto.recipients.map(r => ({
      chatId: r.chatId,
      status: r.status || 'sent',
      messageId: r.messageId,
      error: r.error,
      sentAt: now.toISOString(),
    }));

    const chunk = this.chunkRepo.create({
      id: randomUUID(),
      campaignId,
      chunkName,
      sessionId: dto.sessionId,
      batchId: dto.batchId || null,
      messageType: dto.messageType || 'text',
      messageContent: dto.messageContent || null,
      recipients: recipientItems,
      sentAt: now,
    });

    return this.chunkRepo.save(chunk);
  }

  async getChunks(campaignId: string): Promise<CampaignChunk[]> {
    await this.findOne(campaignId);
    return this.chunkRepo.find({
      where: { campaignId },
      order: { sentAt: 'DESC' },
    });
  }

  async getChunkAnalytics(campaignId: string, chunkId: string): Promise<ChunkAnalyticsResult> {
    const chunk = await this.chunkRepo.findOne({
      where: { id: chunkId, campaignId },
    });
    if (!chunk) {
      throw new NotFoundException(`Chunk '${chunkId}' not found for campaign '${campaignId}'`);
    }

    const recipients = parseJsonArray<ChunkRecipientItem>(chunk.recipients);
    const totalRecipients = recipients.length;
    let deliveredCount = 0;
    let failedCount = 0;

    const details: RecipientResponseDetail[] = [];
    let acknowledgedCount = 0;
    let questionCount = 0;
    let reactionCount = 0;
    let otherReplyCount = 0;
    let ignoredCount = 0;

    const chunkSentDate = new Date(chunk.sentAt);
    const chunkSentTimestamp = Math.floor(chunkSentDate.getTime() / 1000) - 60;
    const bufferSentAt = new Date(chunkSentDate.getTime() - 60000);

    const recipientStates: Array<{
      item: ChunkRecipientItem;
      incomingMsgs: Message[];
      hasReactionMetadata: boolean;
      reactionEmoji?: string;
    }> = [];

    for (const item of recipients) {
      if (item.status === 'failed') {
        failedCount++;
        details.push({
          chatId: item.chatId,
          status: 'failed',
          messageId: item.messageId,
          responseCategory: 'ignored',
        });
        ignoredCount++;
        continue;
      }

      deliveredCount++;

      // 1. Build all possible phone & chat identifier variants
      const rawDigits = item.chatId ? item.chatId.replace(/[^0-9]/g, '') : '';
      let bareDigits = rawDigits;
      if (rawDigits.startsWith('92') && rawDigits.length >= 11) {
        bareDigits = rawDigits.substring(2);
      } else if (rawDigits.startsWith('0') && rawDigits.length >= 10) {
        bareDigits = rawDigits.substring(1);
      }
      const intlDigits = bareDigits ? `92${bareDigits}` : '';
      const localZeroDigits = bareDigits ? `0${bareDigits}` : '';

      const phoneVariants = Array.from(new Set([rawDigits, bareDigits, intlDigits, localZeroDigits].filter(Boolean)));

      // 2. Lookup any associated WhatsApp LIDs from lid_mappings
      let mappedLids: string[] = [];
      if (phoneVariants.length > 0) {
        try {
          const lidRecords = await this.lidRepo
            .createQueryBuilder('l')
            .where('l.phone IN (:...phoneVariants) OR l.phone LIKE :likePhone', {
              phoneVariants,
              likePhone: `%${bareDigits}%`,
            })
            .getMany();
          mappedLids = lidRecords.map(r => r.lid);
        } catch (err) {
          this.logger.warn(`Failed to query lid_mappings for ${item.chatId}: ${String(err)}`);
        }
      }

      // 3. Build candidate identifiers
      const candidateChatIds = new Set<string>();
      if (item.chatId) candidateChatIds.add(item.chatId);
      for (const p of phoneVariants) {
        candidateChatIds.add(`${p}@c.us`);
        candidateChatIds.add(`${p}@s.whatsapp.net`);
        candidateChatIds.add(p);
      }
      for (const lid of mappedLids) {
        candidateChatIds.add(`${lid}@lid`);
        candidateChatIds.add(lid);
      }

      const candidateList = Array.from(candidateChatIds);

      // 4. Check for incoming messages
      let incomingMsgs: Message[] = [];
      try {
        const qb = this.messageRepo.createQueryBuilder('m');
        if (candidateList.length > 0) {
          qb.where(
            '(m.chatId IN (:...candidateList) OR m.from IN (:...candidateList)' +
              (bareDigits ? ' OR m.chatId LIKE :likeDigits OR m.from LIKE :likeDigits)' : ')'),
            {
              candidateList,
              likeDigits: `%${bareDigits}%`,
            },
          );
        } else if (bareDigits) {
          qb.where('(m.chatId LIKE :likeDigits OR m.from LIKE :likeDigits)', {
            likeDigits: `%${bareDigits}%`,
          });
        }
        qb.andWhere('m.direction = :direction', { direction: MessageDirection.INCOMING })
          .andWhere('(m.timestamp >= :ts OR m.createdAt >= :sentAt)', {
            ts: chunkSentTimestamp,
            sentAt: bufferSentAt,
          })
          .orderBy('m.timestamp', 'ASC');

        incomingMsgs = await qb.getMany();
      } catch (err) {
        this.logger.warn(`Failed to query incoming messages for ${item.chatId}: ${String(err)}`);
      }

      // 5. Check outgoing messages for reactions
      let hasReactionMetadata = false;
      let reactionEmoji: string | undefined;

      try {
        const qbOut = this.messageRepo.createQueryBuilder('m');
        if (candidateList.length > 0) {
          qbOut.where(
            '(m.chatId IN (:...candidateList) OR m.to IN (:...candidateList)' +
              (bareDigits ? ' OR m.chatId LIKE :likeDigits OR m.to LIKE :likeDigits)' : ')'),
            {
              candidateList,
              likeDigits: `%${bareDigits}%`,
            },
          );
        } else if (bareDigits) {
          qbOut.where('(m.chatId LIKE :likeDigits OR m.to LIKE :likeDigits)', {
            likeDigits: `%${bareDigits}%`,
          });
        }
        qbOut.andWhere('m.direction = :direction', { direction: MessageDirection.OUTGOING })
          .andWhere('(m.timestamp >= :ts OR m.createdAt >= :sentAt)', {
            ts: chunkSentTimestamp,
            sentAt: bufferSentAt,
          });

        const outgoingMsgs = await qbOut.getMany();
        for (const outMsg of outgoingMsgs) {
          if (outMsg.metadata && typeof outMsg.metadata === 'object') {
            const rx = (outMsg.metadata as Record<string, any>).reactions as Record<string, any> | undefined;
            if (rx && typeof rx === 'object') {
              const keys = Object.keys(rx);
              if (keys.length > 0 && rx[keys[0]]) {
                hasReactionMetadata = true;
                reactionEmoji = String(rx[keys[0]]);
                break;
              }
            }
          }
        }
      } catch {
        // ignore
      }

      // 6. Check specific messageId if known
      if (!hasReactionMetadata && item.messageId) {
        try {
          const outgoingMsg = await this.messageRepo.findOne({
            where: { waMessageId: item.messageId },
            select: { id: true, metadata: true },
          });
          if (outgoingMsg?.metadata && typeof outgoingMsg.metadata === 'object') {
            const reactions = (outgoingMsg.metadata as Record<string, any>).reactions as Record<string, any> | undefined;
            if (reactions && typeof reactions === 'object') {
              const keys = Object.keys(reactions);
              if (keys.length > 0 && reactions[keys[0]]) {
                hasReactionMetadata = true;
                reactionEmoji = String(reactions[keys[0]]);
              }
            }
          }
        } catch {
          // ignore
        }
      }

      recipientStates.push({
        item,
        incomingMsgs,
        hasReactionMetadata,
        reactionEmoji,
      });
    }

    const { apiKey: geminiApiKey, model: geminiModel } = this.getGeminiKeyAndModel();
    let geminiCategories = new Map<number, ResponseCategory>();

    const textToClassify: Array<{ index: number; body: string }> = [];
    for (let i = 0; i < recipientStates.length; i++) {
      const state = recipientStates[i];
      const latestMsg = state.incomingMsgs.length > 0 ? state.incomingMsgs[state.incomingMsgs.length - 1] : null;
      const latestBody = latestMsg?.body?.trim() || '';
      if (latestBody) {
        textToClassify.push({ index: i, body: latestBody });
      }
    }

    if (geminiApiKey && textToClassify.length > 0) {
      geminiCategories = await this.classifyWithGemini(textToClassify, geminiApiKey, geminiModel);
    }

    for (let i = 0; i < recipientStates.length; i++) {
      const state = recipientStates[i];
      const { item, incomingMsgs, hasReactionMetadata, reactionEmoji } = state;

      if (incomingMsgs.length > 0 || hasReactionMetadata) {
        const latestMsg = incomingMsgs.length > 0 ? incomingMsgs[incomingMsgs.length - 1] : null;
        const latestBody = latestMsg?.body?.trim() || '';
        const msgTime = latestMsg?.timestamp
          ? new Date(latestMsg.timestamp * 1000).toISOString()
          : (latestMsg?.createdAt ? new Date(latestMsg.createdAt).toISOString() : new Date().toISOString());

        let category: ResponseCategory = 'replied';
        let responseText = latestBody;

        if (latestBody) {
          const aiCat = geminiCategories.get(i);
          if (aiCat) {
            category = aiCat;
          } else if (QUESTION_REGEX.test(latestBody)) {
            category = 'question';
          } else if (ACK_REGEX.test(latestBody)) {
            category = 'acknowledged';
          } else if (EMOJI_REGEX.test(latestBody)) {
            category = 'reaction';
          } else {
            category = 'replied';
          }

          if (category === 'question') questionCount++;
          else if (category === 'acknowledged') acknowledgedCount++;
          else if (category === 'reaction') reactionCount++;
          else otherReplyCount++;

          if (reactionEmoji && !latestBody.includes(reactionEmoji)) {
            responseText = `${latestBody} ${reactionEmoji}`;
          }
        } else if (hasReactionMetadata || latestMsg?.type === 'reaction') {
          category = 'reaction';
          reactionCount++;
          responseText = reactionEmoji || '👍';
        } else {
          category = 'replied';
          otherReplyCount++;
          responseText = latestBody || 'Replied';
        }

        details.push({
          chatId: item.chatId,
          status: 'sent',
          messageId: item.messageId,
          responseCategory: category,
          lastResponseText: responseText,
          lastResponseTime: msgTime || new Date().toISOString(),
        });
      } else {
        ignoredCount++;
        details.push({
          chatId: item.chatId,
          status: 'sent',
          messageId: item.messageId,
          responseCategory: 'ignored',
        });
      }
    }

    const totalResponded = acknowledgedCount + questionCount + reactionCount + otherReplyCount;
    const responseRatePercent = deliveredCount > 0 ? Math.round((totalResponded / deliveredCount) * 100) : 0;

    return {
      chunkId: chunk.id,
      chunkName: chunk.chunkName,
      sentAt: chunk.sentAt.toISOString(),
      sessionId: chunk.sessionId,
      messageType: chunk.messageType,
      messageContent: chunk.messageContent,
      totalSent: totalRecipients,
      totalDelivered: deliveredCount,
      totalFailed: failedCount,
      totalResponded,
      totalIgnored: ignoredCount,
      responseRatePercent,
      summary: {
        acknowledged: acknowledgedCount,
        questions: questionCount,
        reactions: reactionCount,
        otherReplies: otherReplyCount,
        ignored: ignoredCount,
        totalAcknowledged: acknowledgedCount + reactionCount,
        ackRatePercent: deliveredCount > 0 ? Math.round(((acknowledgedCount + reactionCount) / deliveredCount) * 100) : 0,
      },
      recipients: details,
    };
  }

  async getCampaignAnalytics(campaignId: string) {
    const campaign = await this.findOne(campaignId);
    const chunks = await this.chunkRepo.find({
      where: { campaignId },
      order: { sentAt: 'DESC' },
    });

    let totalSent = 0;
    let totalDelivered = 0;
    let totalFailed = 0;
    let totalResponded = 0;
    let totalIgnored = 0;
    let totalAcknowledged = 0;
    let totalQuestions = 0;
    let totalReactions = 0;
    let totalOtherReplies = 0;

    const chunkSummaries = [];

    for (const chunk of chunks) {
      const analytics = await this.getChunkAnalytics(campaignId, chunk.id);
      totalSent += analytics.totalSent;
      totalDelivered += analytics.totalDelivered;
      totalFailed += analytics.totalFailed;
      totalResponded += analytics.totalResponded;
      totalIgnored += analytics.totalIgnored;
      totalAcknowledged += analytics.summary.acknowledged;
      totalQuestions += analytics.summary.questions;
      totalReactions += analytics.summary.reactions;
      totalOtherReplies += analytics.summary.otherReplies;

      chunkSummaries.push({
        chunkId: chunk.id,
        chunkName: chunk.chunkName,
        sentAt: chunk.sentAt,
        totalSent: analytics.totalSent,
        totalResponded: analytics.totalResponded,
        responseRatePercent: analytics.responseRatePercent,
        summary: analytics.summary,
      });
    }

    const overallResponseRate = totalDelivered > 0 ? Math.round((totalResponded / totalDelivered) * 100) : 0;

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      totalChunks: chunks.length,
      totalRecipientsSaved: campaign.recipients?.length || 0,
      totalSent,
      totalDelivered,
      totalFailed,
      totalResponded,
      totalIgnored,
      overallResponseRate,
      summary: {
        acknowledged: totalAcknowledged,
        questions: totalQuestions,
        reactions: totalReactions,
        otherReplies: totalOtherReplies,
        ignored: totalIgnored,
      },
      chunks: chunkSummaries,
    };
  }

  getAiConfig() {
    try {
      const configPath = path.join(process.cwd(), 'data', 'ai-config.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          configured: !!parsed.geminiApiKey || !!process.env.GEMINI_API_KEY,
          model: parsed.geminiModel || process.env.GEMINI_MODEL || 'gemini-1.5-flash',
          hasCustomKey: !!parsed.geminiApiKey,
        };
      }
    } catch {}
    return {
      configured: !!process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      hasCustomKey: false,
    };
  }

  async generateMessageWithGemini(prompt: string, tone = 'professional & engaging'): Promise<{ message: string }> {
    const { apiKey, model } = this.getGeminiKeyAndModel();
    if (!apiKey) {
      throw new NotFoundException('Gemini API key is not configured. Please add your Gemini API Key in AI Settings.');
    }

    const systemPrompt = `You are an expert WhatsApp marketing copywriter for Pakistani businesses and institutions. 
Write a concise, compelling, polite, and high-converting WhatsApp message based on the user instructions.
Rules:
1. Include friendly greeting, clear value proposition, and actionable call to action.
2. Tone: ${tone}.
3. Support natural English, Urdu, or Roman Urdu as requested in prompt.
4. Use emojis tastefully. Keep it ready to send on WhatsApp without extra preamble or markdown tags like \`\`\`.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\nUser instructions: ${prompt}` }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 600,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini API error (${res.status}): ${err}`);
    }

    const data: any = await res.json();
    const candidate = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    return { message: candidate };
  }

  updateAiConfig(data: { geminiApiKey?: string; geminiModel?: string }) {
    try {
      const configPath = path.join(process.cwd(), 'data', 'ai-config.json');
      let current: Record<string, any> = {};
      if (fs.existsSync(configPath)) {
        try {
          current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch {}
      }
      if (data.geminiApiKey !== undefined) {
        current.geminiApiKey = data.geminiApiKey.trim();
      }
      if (data.geminiModel !== undefined) {
        current.geminiModel = data.geminiModel.trim() || 'gemini-1.5-flash';
      }
      fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
      return {
        success: true,
        configured: !!current.geminiApiKey,
        model: current.geminiModel || 'gemini-1.5-flash',
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private getGeminiKeyAndModel(): { apiKey: string | null; model: string } {
    try {
      const configPath = path.join(process.cwd(), 'data', 'ai-config.json');
      if (fs.existsSync(configPath)) {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (parsed.geminiApiKey) {
          return {
            apiKey: parsed.geminiApiKey,
            model: parsed.geminiModel || 'gemini-1.5-flash',
          };
        }
      }
    } catch {}
    if (process.env.GEMINI_API_KEY) {
      return {
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
      };
    }
    return { apiKey: null, model: 'gemini-1.5-flash' };
  }

  private async classifyWithGemini(
    items: Array<{ index: number; body: string }>,
    apiKey: string,
    model = 'gemini-1.5-flash',
  ): Promise<Map<number, ResponseCategory>> {
    const resultMap = new Map<number, ResponseCategory>();
    if (!items.length || !apiKey) return resultMap;

    try {
      const prompt = `You are an expert AI classifying customer WhatsApp responses to marketing campaigns.
Analyze the following customer replies and classify each message into exactly ONE category:
- "acknowledged": Customer acknowledged, confirmed receipt, agreed, said okay, theek hai, sahi hai, done, yes, got it, confirm, shukriya, thanks, noted, bilkul, etc.
- "question": Customer asked a question, inquiry, price query, details request, timing, etc.
- "reaction": Only emoji or emotional reaction without text statement.
- "replied": Other comment, statement, objection, or casual remark.

Replies:
${items.map(it => `[${it.index}] ${it.body}`).join('\n')}

Respond ONLY with valid JSON array:
[{"index": 0, "category": "acknowledged"}]`;

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data: any = await res.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              const cat = item.category?.toLowerCase()?.trim();
              const idx = typeof item.index === 'number' ? item.index : Number(item.id);
              if (['acknowledged', 'question', 'reaction', 'replied'].includes(cat)) {
                resultMap.set(idx, cat as ResponseCategory);
              }
            }
          }
        }
      } else {
        this.logger.warn(`Gemini API HTTP ${res.status}: ${res.statusText}`);
      }
    } catch (err: any) {
      this.logger.warn(`Gemini classification skipped (${err.message}). Using regex classifier.`);
    }

    return resultMap;
  }
}
