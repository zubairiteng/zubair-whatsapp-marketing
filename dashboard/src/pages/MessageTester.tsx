import { Fragment, useState, useEffect, useRef, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { Send, CheckCircle, XCircle, Loader2, Upload, X, Plus, AlertCircle, Sparkles, Mic } from 'lucide-react';
import {
  messageApi,
  contactApi,
  campaignApi,
  type SendMediaPayload,
  type MessageResponse,
  type BatchStatus,
  type BatchStatusResponse,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { Modal } from '../components/Modal';
import { useSessionsQuery, useSessionGroupsQuery, useCampaignsQuery } from '../hooks/queries';
import { parseBulkRecipients, BULK_MAX_RECIPIENTS, BULK_RECIPIENTS_FILE_MAX_BYTES } from '../utils/bulkRecipients';
import {
  BULK_CAPTION_MAX_LENGTH,
  BULK_INLINE_MEDIA_MAX_BYTES,
  BULK_MEDIA_KINDS,
  buildBulkMessages,
  captionLength,
  formatFileSize,
  inlineMediaBudgetBytes,
  isHttpMediaUrl,
  mediaKindFromMime,
  mediaKindFromUrl,
  toBulkAttachment,
  type BulkMediaKind,
} from '../utils/bulkMedia';
import { PageHeader } from '../components/PageHeader';
import { GroupPicker } from '../components/GroupPicker';
import { groupLabel, isGatewayRefusal, planGroupSend } from '../utils/groupSelection';
import { sendSequentially } from '../utils/sendSequentially';
import './MessageTester.css';

interface ApiResponse {
  success: boolean;
  messageId?: string;
  /** Bulk sends return 202 + a batch instead of a messageId; the panel polls its progress. */
  batchId?: string;
  timestamp: string;
  error?: string;
  // The real HTTP status, carried on the Error by `request()` in services/api.ts. Absent when no
  // request was made (the recipient pre-check below short-circuits) — the panel then shows the
  // outcome without a code rather than inventing one.
  status?: number;
  groups?: {
    sent: number;
    total: number;
    failures: { id: string; name: string; error: string }[];
    notSent: number;
    stoppedBy?: 'abort' | 'refusal';
    refusedWith?: number;
  };
}

const GROUP_SEND_DELAY_MS = 3000;

const messageTypes = [
  'text',
  'image',
  'video',
  'audio',
  'document',
  'location',
  'contact',
  'sticker',
  'poll',
  'forward',
  'bulk',
] as const;

// The types that share the media upload/URL block (base64 XOR url + mimetype).
const mediaMessageTypes: readonly string[] = ['image', 'video', 'audio', 'document', 'sticker'];

// The gateway's @MaxLength bounds on the single-send bodies. A multi-group send repeats one body per group,
// so a body over any of them would be refused once per group.
const MESSAGE_TEXT_MAX_LENGTH = 4096;
const MEDIA_FILENAME_MAX_LENGTH = 255;
const LOCATION_TEXT_MAX_LENGTH = 1024;
const CONTACT_NAME_MAX_LENGTH = 255;
const CONTACT_NUMBER_MAX_LENGTH = 30;
const POLL_NAME_MAX_LENGTH = 255;
const POLL_OPTION_MAX_LENGTH = 100;

// Hint the native file picker at the right category (documents accept anything).
const mediaAccept: Record<(typeof messageTypes)[number], string> = {
  text: '*/*',
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
  document: '*/*',
  location: '*/*',
  contact: '*/*',
  sticker: 'image/*',
  poll: '*/*',
  forward: '*/*',
  bulk: '*/*',
};

// Fallback MIME for when the browser leaves File.type empty (some extensions). The backend requires a
// mimetype on every base64 send, so default by the selected message category.
const fallbackMime: Record<(typeof messageTypes)[number], string> = {
  text: 'text/plain',
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  document: 'application/octet-stream',
  location: 'application/octet-stream',
  contact: 'application/octet-stream',
  sticker: 'image/webp',
  poll: 'application/octet-stream',
  forward: 'application/octet-stream',
  bulk: 'application/octet-stream',
};

// Client pre-check before base64-encoding an upload. Aligned with the default request-body limit: base64
// inflates ~1.33x, so ~18 MiB raw stays under the 25 MiB BODY_SIZE_LIMIT and lets the backend reject with a
// clear 413 instead of the tab OOMing on a multi-hundred-MB pick before the request is even sent. The
// backend's MEDIA_DOWNLOAD_MAX_BYTES (default 50 MiB) stays authoritative for URL sends (fetched server-side).
const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

// Batch statuses that stop the progress polling (mirrors the backend BatchStatus enum).
const TERMINAL_BATCH_STATUSES: readonly BatchStatus[] = ['completed', 'cancelled', 'failed'];

export function MessageTester() {
  const { t } = useTranslation();
  useDocumentTitle(t('messageTester.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions, error: sessionsError } = useSessionsQuery();
  // A read that never produced a list is not "no ready sessions"; a failed refetch keeps the cached one.
  const sessionsFailed = !!sessionsError && allSessions.length === 0;
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientType, setRecipientType] = useState<'personal' | 'group'>('personal');
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [groupSendProgress, setGroupSendProgress] = useState<{ current: number; total: number } | null>(null);
  const [groupSendCancelling, setGroupSendCancelling] = useState(false);
  const groupSendAbort = useRef<AbortController | null>(null);
  const [messageType, setMessageType] = useState<(typeof messageTypes)[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  // A locally-picked media file, read as raw base64 (the engine contract — NOT a data: URI). Mutually
  // exclusive with mediaUrl: picking a file clears the URL field; typing a URL drops the file.
  const [mediaFile, setMediaFile] = useState<{ base64: string; mimetype: string; filename: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  // Monotonic token invalidating an in-flight FileReader: a second pick, a URL edit, a removal,
  // or an unmount before `onload` fires must win over the late-arriving bytes — otherwise the
  // slower read overwrites the newer state (and re-clears a URL the user just typed).
  const mediaReadSeq = useRef(0);
  const clearMediaFile = () => {
    mediaReadSeq.current += 1;
    setMediaFile(null);
  };
  useEffect(() => {
    return () => {
      mediaReadSeq.current += 1;
    };
  }, []);
  // Per-type fields for the non-media types; text/media keep using `content`/`mediaUrl` above.
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locationDescription, setLocationDescription] = useState('');
  const [locationAddress, setLocationAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactNumber, setContactNumber] = useState('');
  const [pollQuestion, setPollQuestion] = useState('');
  // WhatsApp caps polls at 2..12 options; rows are trimmed and empty ones dropped at send time.
  const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
  const [allowMultipleAnswers, setAllowMultipleAnswers] = useState(false);
  const [forwardFrom, setForwardFrom] = useState('');
  const [forwardTo, setForwardTo] = useState('');
  const [forwardMessageId, setForwardMessageId] = useState('');
  const [bulkRecipients, setBulkRecipients] = useState('');
  const [bulkMinDelay, setBulkMinDelay] = useState('7000');
  const [bulkMaxDelay, setBulkMaxDelay] = useState('15000');
  const [bulkMediaKind, setBulkMediaKind] = useState<BulkMediaKind>('document');
  const [bulkMediaKindChosen, setBulkMediaKindChosen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  // Live bulk-batch progress, polled every ~2s while the batch runs (see startBatchPolling).
  const [batchStatus, setBatchStatus] = useState<BatchStatusResponse | null>(null);
  const [batchCancelling, setBatchCancelling] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The session a running batch belongs to: the user may switch the selector mid-batch, and
  // poll/cancel must keep addressing the session the batch was created on.
  const batchSessionRef = useRef('');

  const [searchParams] = useSearchParams();
  const { data: campaigns = [] } = useCampaignsQuery();
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const toast = useToast();

  // Voice note (PTT)
  const [isVoiceNote, setIsVoiceNote] = useState(false);

  // Gemini AI Writer state
  const [isAiWriterOpen, setIsAiWriterOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiTone, setAiTone] = useState('Urdu / Roman Urdu Marketing');
  const [aiGeneratedText, setAiGeneratedText] = useState('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [hasAiKey, setHasAiKey] = useState(false);
  const [aiApiKeyInput, setAiApiKeyInput] = useState('');
  const [isSavingAiKey, setIsSavingAiKey] = useState(false);

  useEffect(() => {
    if (isAiWriterOpen) {
      campaignApi.getAiConfig()
        .then(res => setHasAiKey(res.configured))
        .catch(() => {});
    }
  }, [isAiWriterOpen]);

  const handleSaveAiKey = async () => {
    if (!aiApiKeyInput.trim()) return;
    setIsSavingAiKey(true);
    try {
      await campaignApi.saveAiConfig({ geminiApiKey: aiApiKeyInput.trim() });
      setHasAiKey(true);
      toast.success(t('messageTester.aiKeySaved', 'Gemini API key saved successfully!'));
    } catch {
      toast.error(t('messageTester.aiKeyError', 'Failed to save Gemini API key'));
    } finally {
      setIsSavingAiKey(false);
    }
  };

  const handleGenerateAiMessage = async () => {
    if (!aiPrompt.trim()) return;
    setIsGeneratingAi(true);
    try {
      const res = await campaignApi.generateAiMessage(aiPrompt, aiTone);
      setAiGeneratedText(res.message);
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate message with Gemini AI');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const handleApplyAiMessage = () => {
    if (aiGeneratedText) {
      setContent(aiGeneratedText);
      setIsAiWriterOpen(false);
      toast.success('Message applied to composer!');
    }
  };
  const [chunkName, setChunkName] = useState('');
  const [recordedChunkInfo, setRecordedChunkInfo] = useState<{ campaignId: string; chunkName: string; chunkId?: string } | null>(null);

  useEffect(() => {
    const campIdFromSession = window.sessionStorage.getItem('openwa_active_campaign_id');
    const campIdFromUrl = searchParams.get('campaignId');
    const targetCampId = campIdFromSession || campIdFromUrl;

    if (targetCampId) {
      setSelectedCampaignId(targetCampId);
      setMessageType('bulk');
      void campaignApi.get(targetCampId).then(camp => {
        if (camp?.recipients?.length) {
          setBulkRecipients(camp.recipients.join('\n'));
        }
        const defaultName = `Run ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        setChunkName(defaultName);
      }).catch(() => {});
      if (campIdFromSession) {
        window.sessionStorage.removeItem('openwa_active_campaign_id');
        window.sessionStorage.removeItem('openwa_active_campaign_name');
      }
    }
  }, [searchParams]);

  const handleCampaignSelect = async (e: ChangeEvent<HTMLSelectElement>) => {
    const campId = e.target.value;
    setSelectedCampaignId(campId);
    if (!campId) return;

    try {
      const camp = await campaignApi.get(campId);
      if (camp?.recipients?.length) {
        setBulkRecipients(camp.recipients.join('\n'));
      }
      if (!chunkName) {
        const defaultName = `Run ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        setChunkName(defaultName);
      }
    } catch {
      // non-fatal
    }
  };

  const {
    data: groups = [],
    isLoading: loadingGroups,
    isError: groupsFailed,
  } = useSessionGroupsQuery(session, recipientType === 'group');

  // Also re-picks when the chosen session leaves the ready list on a refetch: the select would show
  // the first option while every send still went to the dropped one.
  useEffect(() => {
    if (!sessions.some(s => s.id === session)) setSession(sessions[0]?.id ?? '');
  }, [sessions, session]);

  useEffect(() => {
    setSelectedGroups([]);
  }, [session, recipientType]);

  useEffect(() => () => groupSendAbort.current?.abort(), []);

  const stopBatchPolling = () => {
    if (batchPollRef.current) {
      clearInterval(batchPollRef.current);
      batchPollRef.current = null;
    }
  };

  // Stop polling on unmount; the batch itself keeps running server-side regardless. A send-bulk still
  // in flight at unmount resolves later, so startBatchPolling must refuse to start once unmounted.
  // Reset on every mount: StrictMode runs mount, unmount, mount.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      stopBatchPolling();
    };
  }, []);

  const startBatchPolling = (batchSessionId: string, batchId: string) => {
    stopBatchPolling();
    if (unmountedRef.current) return;
    const timer = setInterval(async () => {
      try {
        const status = await messageApi.getBatchStatus(batchSessionId, batchId);
        // Polling was stopped (a cancel, a terminal status, a new batch, unmount) while this read
        // was in flight: its snapshot is older than what is on screen.
        if (batchPollRef.current !== timer) return;
        setBatchStatus(status);
        if (TERMINAL_BATCH_STATUSES.includes(status.status)) stopBatchPolling();
      } catch (err) {
        if (batchPollRef.current !== timer) return;
        // A 404 (the batch or its session was deleted) or 403 (the key lost access) is permanent: stop
        // and say so. A transient failure (network blip, backend restart, 5xx, 408, 429) must not kill
        // progress tracking.
        const status = (err as { status?: number }).status;
        if (status === 404 || status === 403) {
          stopBatchPolling();
          setBatchError(err instanceof Error ? err.message : t('messageTester.sendFailed'));
        }
      }
    }, 2000);
    batchPollRef.current = timer;
  };

  const handleBulkFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Reject before reading, mirroring the media pick above: FileReader would materialize the whole
    // file as a string before any backend cap could weigh in.
    if (file.size > BULK_RECIPIENTS_FILE_MAX_BYTES) {
      setResponse({
        success: false,
        timestamp: new Date().toISOString(),
        error: t('messageTester.recipientsFileTooLarge'),
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      if (typeof text !== 'string' || !text.trim()) return;
      setBulkRecipients(prev => (prev.trim() ? `${prev.trimEnd()}\n` : '') + text.trim());
    };
    reader.onerror = () => {
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileReadError') });
    };
    reader.readAsText(file);
  };

  const handleCancelBatch = async () => {
    if (!batchStatus || !batchSessionRef.current) return;
    setBatchCancelling(true);
    setBatchError(null);
    try {
      const status = await messageApi.cancelBatch(batchSessionRef.current, batchStatus.batchId);
      setBatchStatus(prev => (prev ? { ...prev, ...status } : prev));
      stopBatchPolling();
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : t('messageTester.sendFailed'));
    } finally {
      setBatchCancelling(false);
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after it's removed
    if (!file) return;
    // Reject before base64-encoding so an oversized pick surfaces a clear error instead of OOMing the tab
    // (the backend 413 cap only applies after the whole body is uploaded).
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileTooLarge') });
      return;
    }
    const myRead = ++mediaReadSeq.current;
    const reader = new FileReader();
    reader.onload = () => {
      // A newer pick, a URL edit, a removal, or an unmount since the read started supersedes
      // these bytes — drop them.
      if (mediaReadSeq.current !== myRead) return;
      const dataUrl = reader.result;
      if (typeof dataUrl !== 'string') return;
      // readAsDataURL yields "data:<mime>;base64,<payload>"; the engine expects raw base64, so strip the prefix.
      const base64 = dataUrl.split(',')[1] ?? '';
      if (!base64) return;
      const mimetype = file.type || fallbackMime[messageType];
      setMediaFile({ base64, mimetype, filename: file.name });
      setMediaUrl('');
      if (messageType === 'document') setContent(file.name);
      if (messageType === 'bulk') {
        setBulkMediaKind(mediaKindFromMime(mimetype));
        setBulkMediaKindChosen(false);
      }
    };
    reader.onerror = () => {
      if (mediaReadSeq.current !== myRead) return;
      setResponse({ success: false, timestamp: new Date().toISOString(), error: t('messageTester.fileReadError') });
    };
    reader.readAsDataURL(file);
  };

  const isMediaMessageType = mediaMessageTypes.includes(messageType);
  const bulkRecipientList = parseBulkRecipients(bulkRecipients);
  const pollOptionsFilled = pollOptions.map(o => o.trim()).filter(o => o.length > 0);
  const lat = parseFloat(latitude);
  const lng = parseFloat(longitude);
  const minDelayMs = bulkMinDelay.trim() === '' ? 7000 : parseInt(bulkMinDelay, 10);
  const maxDelayMs = bulkMaxDelay.trim() === '' ? 15000 : parseInt(bulkMaxDelay, 10);
  const isDelayValid =
    !Number.isNaN(minDelayMs) &&
    !Number.isNaN(maxDelayMs) &&
    minDelayMs >= 1000 &&
    minDelayMs <= 60000 &&
    maxDelayMs >= 1000 &&
    maxDelayMs <= 60000 &&
    minDelayMs <= maxDelayMs;
  const bulkAttachment = messageType === 'bulk' ? toBulkAttachment(bulkMediaKind, mediaFile, mediaUrl) : null;
  const bulkMediaTooLarge =
    messageType === 'bulk' &&
    !!mediaFile &&
    mediaFile.base64.length * bulkRecipientList.length > BULK_INLINE_MEDIA_MAX_BYTES;
  // The gateway reads a media string as a URL only with an http(s) prefix and decodes anything else as
  // base64, so a URL without one is refused (or sent as garbage bytes) for every recipient alike.
  const mediaUrlInvalid = !mediaFile && mediaUrl.trim() !== '' && !isHttpMediaUrl(mediaUrl);
  // Audio goes out without a caption (the bulk service does not forward one), so text next to an audio
  // attachment would be dropped while the batch reports success. Refuse it instead of sending half.
  const bulkAudioWithText = bulkAttachment?.kind === 'audio' && content.trim().length > 0;
  const bulkCaptionTooLong =
    bulkAttachment !== null && bulkAttachment.kind !== 'audio' && captionLength(content) > BULK_CAPTION_MAX_LENGTH;
  // Without an attachment every item is a text message, under the same bound as a single text send.
  const bulkTextTooLong = bulkAttachment === null && captionLength(content) > MESSAGE_TEXT_MAX_LENGTH;

  // The text field goes out as the caption on image and video and as the filename on a document.
  const mediaContentMax =
    messageType === 'document'
      ? MEDIA_FILENAME_MAX_LENGTH
      : messageType === 'image' || messageType === 'video'
        ? BULK_CAPTION_MAX_LENGTH
        : Infinity;

  // Per-type required-field validation (the backend stays the authoritative validator). A multi-group
  // send repeats the request per group, so a body the backend would refuse must not start the run.
  let formValid = true;
  if (messageType === 'text') {
    formValid = content.trim().length > 0 && captionLength(content) <= MESSAGE_TEXT_MAX_LENGTH;
  } else if (isMediaMessageType) {
    formValid = (!!mediaFile || isHttpMediaUrl(mediaUrl)) && captionLength(content) <= mediaContentMax;
  } else if (messageType === 'location') {
    formValid =
      !Number.isNaN(lat) &&
      !Number.isNaN(lng) &&
      lat >= -90 &&
      lat <= 90 &&
      lng >= -180 &&
      lng <= 180 &&
      captionLength(locationDescription.trim()) <= LOCATION_TEXT_MAX_LENGTH &&
      captionLength(locationAddress.trim()) <= LOCATION_TEXT_MAX_LENGTH;
  } else if (messageType === 'contact') {
    formValid =
      contactName.trim().length > 0 &&
      captionLength(contactName.trim()) <= CONTACT_NAME_MAX_LENGTH &&
      contactNumber.trim().length > 0 &&
      captionLength(contactNumber.trim()) <= CONTACT_NUMBER_MAX_LENGTH;
  } else if (messageType === 'poll') {
    formValid =
      pollQuestion.trim().length > 0 &&
      captionLength(pollQuestion.trim()) <= POLL_NAME_MAX_LENGTH &&
      pollOptionsFilled.length >= 2 &&
      pollOptionsFilled.every(option => captionLength(option) <= POLL_OPTION_MAX_LENGTH);
  } else if (messageType === 'forward') {
    formValid = forwardTo.trim().length > 0 && forwardMessageId.trim().length > 0;
  } else if (messageType === 'bulk') {
    formValid =
      (content.trim().length > 0 || bulkAttachment !== null) &&
      !bulkMediaTooLarge &&
      !mediaUrlInvalid &&
      !bulkAudioWithText &&
      !bulkCaptionTooLong &&
      !bulkTextTooLong &&
      bulkRecipientList.length > 0 &&
      bulkRecipientList.length <= BULK_MAX_RECIPIENTS &&
      isDelayValid;
  }

  // A new send replaces the batch on screen, so it waits for an in-flight cancel: the cancel's answer
  // would otherwise be merged into the newer batch and stop its progress polling.
  const isSendDisabled =
    !canWrite ||
    isLoading ||
    batchCancelling ||
    !session ||
    !formValid ||
    (messageType !== 'bulk' && (recipientType === 'group' ? selectedGroups.length === 0 : !recipient));

  // Says why Send is held when a field runs past its bound, counted the way `formValid` counts it.
  const tooLongHint = (value: string, max: number) => {
    const count = captionLength(value);
    return (
      <span className="hint error" role="status">
        {count > max ? t('common.fieldTooLong', { max, count }) : ''}
      </span>
    );
  };

  const isGroupSending = groupSendProgress !== null;

  const sendToGroups = async (chatIds: string[], sendTo: (chatId: string) => Promise<MessageResponse>) => {
    const controller = new AbortController();
    groupSendAbort.current = controller;
    const labels = new Map(groups.map(group => [group.id, groupLabel(group)]));
    try {
      const outcome = await sendSequentially(
        chatIds,
        async chatId => {
          const result = await sendTo(chatId);
          if (!result.messageId) throw new Error(t('messageTester.sendFailed'));
        },
        {
          delayMs: GROUP_SEND_DELAY_MS,
          minDelayMs,
          maxDelayMs,
          signal: controller.signal,
          stopOn: isGatewayRefusal,
          onProgress: (current, total) => setGroupSendProgress({ current, total }),
        },
      );
      setResponse({
        success: outcome.sent === chatIds.length,
        timestamp: new Date().toISOString(),
        groups: {
          sent: outcome.sent,
          total: chatIds.length,
          failures: outcome.failures.map(({ target, error }) => ({
            id: target,
            name: labels.get(target) ?? target,
            error,
          })),
          notSent: outcome.notAttempted.length,
          stoppedBy: outcome.stoppedBy,
          refusedWith: outcome.stoppedBy === 'refusal' ? outcome.failures.at(-1)?.status : undefined,
        },
      });
    } finally {
      groupSendAbort.current = null;
      setGroupSendProgress(null);
      setGroupSendCancelling(false);
    }
  };

  const cancelGroupSend = () => {
    setGroupSendCancelling(true);
    groupSendAbort.current?.abort();
  };

  const handleSend = async () => {
    const targetId = recipientType === 'group' ? (selectedGroups[0] ?? '') : recipient;
    if (!session || (messageType !== 'bulk' && !targetId)) return;
    setIsLoading(true);
    setResponse(null);
    // An earlier batch keeps running server-side, but its polling must not overwrite this response.
    stopBatchPolling();
    setBatchStatus(null);
    setBatchError(null);

    try {
      // For a personal recipient, let the engine resolve the number to its canonical chat id rather
      // than hand-building an engine-specific JID here (#265) — also surfaces unregistered numbers.
      // Bulk carries its own recipient list, so the shared selector's target is not resolved there.
      let chatId = targetId;
      if (messageType !== 'bulk' && recipientType !== 'group') {
        const resolved = await contactApi.checkNumber(session, targetId.replace(/[^0-9]/g, ''));
        if (!resolved.exists || !resolved.whatsappId) {
          setResponse({
            success: false,
            timestamp: new Date().toISOString(),
            error: t('messageTester.notOnWhatsApp'),
          });
          return;
        }
        chatId = resolved.whatsappId;
      }

      // Bulk is a batch, not a single send: 202 + batchId, then poll progress until terminal.
      if (messageType === 'bulk') {
        const batch = await messageApi.sendBulk(session, {
          messages: buildBulkMessages(bulkRecipientList, content, bulkAttachment, isVoiceNote),
          options: {
            delayBetweenMessages: minDelayMs,
            minDelayBetweenMessages: minDelayMs,
            maxDelayBetweenMessages: maxDelayMs,
            randomizeDelay: true,
          },
        });
        batchSessionRef.current = session;
        setResponse({ success: true, timestamp: new Date().toISOString(), batchId: batch.batchId });
        setBatchStatus({
          batchId: batch.batchId,
          status: 'pending',
          progress: { total: batch.totalMessages, sent: 0, failed: 0, pending: batch.totalMessages, cancelled: 0 },
          results: [],
        });
        startBatchPolling(session, batch.batchId);

        if (selectedCampaignId) {
          const effectiveChunkName =
            chunkName.trim() ||
            `Run ${new Date().toLocaleDateString('en-GB')} ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
          try {
            const createdChunk = await campaignApi.createChunk(selectedCampaignId, {
              chunkName: effectiveChunkName,
              sessionId: session,
              batchId: batch.batchId,
              messageType: bulkAttachment ? bulkAttachment.kind : 'text',
              messageContent: content || (bulkAttachment ? `[${bulkAttachment.kind}]` : ''),
              recipients: bulkRecipientList.map(phone => ({ chatId: phone, status: 'sent' as const })),
            });
            setRecordedChunkInfo({ campaignId: selectedCampaignId, chunkName: effectiveChunkName, chunkId: createdChunk.id });
          } catch {
            // non-fatal
          }
        } else {
          setRecordedChunkInfo(null);
        }

        return;
      }

      const sendTo = async (target: string): Promise<MessageResponse> => {
        switch (messageType) {
          case 'text':
            return messageApi.sendText(session, target, content);
          case 'image':
          case 'video':
          case 'audio':
          case 'document': {
            // sendMedia unifies URL and base64 (local file) sends; base64 wins when a file is picked. The
            // backend accepts url XOR base64 and requires a mimetype for base64 (always provided here).
            const payload: SendMediaPayload = mediaFile
              ? { base64: mediaFile.base64, mimetype: mediaFile.mimetype }
              : { url: mediaUrl.trim() };
            if ((messageType === 'image' || messageType === 'video') && content) payload.caption = content;
            if (messageType === 'document' && content) payload.filename = content;
            return messageApi.sendMedia(session, target, messageType, payload);
          }
          case 'sticker': {
            const payload: SendMediaPayload = mediaFile
              ? { base64: mediaFile.base64, mimetype: mediaFile.mimetype }
              : { url: mediaUrl.trim() };
            return messageApi.sendSticker(session, target, payload);
          }
          case 'location':
            return messageApi.sendLocation(session, {
              chatId: target,
              latitude: lat,
              longitude: lng,
              ...(locationDescription.trim() ? { description: locationDescription.trim() } : {}),
              ...(locationAddress.trim() ? { address: locationAddress.trim() } : {}),
            });
          case 'contact':
            return messageApi.sendContact(session, {
              chatId: target,
              contactName: contactName.trim(),
              contactNumber: contactNumber.trim(),
            });
          case 'poll':
            return messageApi.sendPoll(session, {
              chatId: target,
              name: pollQuestion.trim(),
              options: pollOptionsFilled,
              ...(allowMultipleAnswers ? { allowMultipleAnswers: true } : {}),
            });
          case 'forward': {
            // toChatId passes through as-is when it is a full chat ID; a bare number is resolved
            // through the same check-number flow as the main recipient.
            let toChatId = forwardTo.trim();
            if (!toChatId.includes('@')) {
              const resolvedTo = await contactApi.checkNumber(session, toChatId.replace(/[^0-9]/g, ''));
              if (!resolvedTo.exists || !resolvedTo.whatsappId) throw new Error(t('messageTester.notOnWhatsApp'));
              toChatId = resolvedTo.whatsappId;
            }
            return messageApi.forward(session, {
              // An empty fromChatId defaults to the current (already resolved) recipient.
              fromChatId: forwardFrom.trim() || target,
              toChatId,
              messageId: forwardMessageId.trim(),
            });
          }
          default:
            throw new Error(`Unsupported message type: ${messageType}`);
        }
      };

      const plan = recipientType === 'group' ? planGroupSend(selectedGroups, messageType) : null;
      if (plan?.mode === 'sequential') {
        await sendToGroups(plan.chatIds, sendTo);
        return;
      }

      const result = await sendTo(chatId);

      setResponse({
        success: !!result.messageId,
        messageId: result.messageId,
        timestamp: result.timestamp ? new Date(result.timestamp * 1000).toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      setResponse({
        success: false,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : t('messageTester.sendFailed'),
        status: err instanceof Error ? (err as Error & { status?: number }).status : undefined,
      });
    } finally {
      setIsLoading(false);
    }
  };

  const batchPercent =
    batchStatus && batchStatus.progress.total > 0
      ? Math.round(
          ((batchStatus.progress.sent + batchStatus.progress.failed + batchStatus.progress.cancelled) /
            batchStatus.progress.total) *
            100,
        )
      : 0;

  const optionalInBulk = messageType === 'bulk' ? ` (${t('common.optional')})` : '';
  const mediaSourceFields = (
    <>
      <div className="form-group">
        <label htmlFor="mt-3">
          {t('messageTester.mediaUrl')}
          {optionalInBulk}
        </label>
        <input
          id="mt-3"
          type="text"
          value={mediaUrl}
          onChange={e => {
            setMediaUrl(e.target.value);
            // Typing a URL supersedes the file: drop the picked file AND any read still
            // in flight (its late onload would otherwise re-clear this URL).
            mediaReadSeq.current += 1;
            if (mediaFile) setMediaFile(null);
            if (messageType === 'bulk') {
              if (!e.target.value.trim()) setBulkMediaKindChosen(false);
              else if (!bulkMediaKindChosen) setBulkMediaKind(mediaKindFromUrl(e.target.value));
            }
          }}
          placeholder="https://example.com/file.jpg"
          disabled={!!mediaFile}
        />
        <span className="hint error" role="status">
          {mediaUrlInvalid ? t('messageTester.bulkMediaUrlInvalid') : ''}
        </span>
      </div>
      <div className="form-group">
        <label>
          {t('messageTester.uploadFile')}
          {optionalInBulk}
        </label>
        {mediaFile ? (
          <div className="file-selected">
            <span className="file-name" title={mediaFile.filename}>
              {mediaFile.filename}
            </span>
            <button type="button" className="remove-file-btn" onClick={clearMediaFile}>
              <X size={14} /> {t('messageTester.removeFile')}
            </button>
          </div>
        ) : (
          <button type="button" className="browse-btn" onClick={() => fileInputRef.current?.click()}>
            <Upload size={14} /> {t('messageTester.browse')}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: 'none' }}
          accept={mediaAccept[messageType]}
          onChange={handleFileChange}
        />
        {messageType === 'bulk' && (
          <span className={bulkMediaTooLarge ? 'hint error' : 'hint'} role="status">
            {bulkMediaTooLarge
              ? t('messageTester.bulkMediaTooLarge', {
                  count: bulkRecipientList.length,
                  size: formatFileSize(inlineMediaBudgetBytes(bulkRecipientList.length)),
                })
              : t('messageTester.bulkMediaHint')}
          </span>
        )}
      </div>
    </>
  );

  if (loadingSessions) {
    return (
      <div
        className="message-tester"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="message-tester">
      <PageHeader title={t('messageTester.title')} subtitle={t('messageTester.subtitle')} />

      {sessionsFailed && (
        <div className="error-banner" role="alert">
          <AlertCircle size={20} />
          <span className="error-banner-text">
            {t('dashboard.loadError')}: {sessionsError.message}
          </span>
        </div>
      )}

      <div className="tester-panels">
        <div className="compose-panel">
          <h2 className="eyebrow">{t('messageTester.compose')}</h2>

          <div className="form-group">
            <label htmlFor="mt-1">{t('messageTester.session')}</label>
            <select id="mt-1" value={session} onChange={e => setSession(e.target.value)} disabled={isGroupSending}>
              {sessions.length === 0 && (
                <option value="">{t(sessionsFailed ? 'dashboard.loadError' : 'messageTester.noReadySessions')}</option>
              )}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phone || t('messageTester.sessionOptionPhoneNone')})
                </option>
              ))}
            </select>
          </div>

          {/* Bulk carries its own recipient list, so the single-recipient selector is hidden there. */}
          {messageType !== 'bulk' && (
            <>
              <div className="form-group">
                {/* A caption, not a label: it names the group, and there is no single control to bind
                    it to. The buttons are exclusive choices, so each reports its own pressed state. */}
                <span className="group-label" id="recipient-type-label">
                  {t('messageTester.recipientType')}
                </span>
                <div className="toggle-group" role="group" aria-labelledby="recipient-type-label">
                  <button
                    type="button"
                    aria-pressed={recipientType === 'personal'}
                    className={recipientType === 'personal' ? 'active' : ''}
                    onClick={() => setRecipientType('personal')}
                    disabled={isGroupSending}
                  >
                    {t('messageTester.personal')}
                  </button>
                  <button
                    type="button"
                    aria-pressed={recipientType === 'group'}
                    className={recipientType === 'group' ? 'active' : ''}
                    onClick={() => setRecipientType('group')}
                    disabled={isGroupSending}
                  >
                    {t('messageTester.group')}
                  </button>
                </div>
              </div>

              <div className="form-group">
                {recipientType === 'group' ? (
                  <>
                    <span className="group-label" id="group-picker-label">
                      {t('messageTester.selectGroup')}
                    </span>
                    <GroupPicker
                      groups={groups}
                      selectedIds={selectedGroups}
                      onChange={setSelectedGroups}
                      loading={loadingGroups}
                      loadFailed={groupsFailed}
                      limit={BULK_MAX_RECIPIENTS}
                      labelledBy="group-picker-label"
                      disabled={isGroupSending}
                    />
                    <span className="hint">
                      {messageType === 'forward'
                        ? t('messageTester.forwardUsesFirstGroup')
                        : t('messageTester.selectGroupHint')}
                    </span>
                  </>
                ) : (
                  <>
                    <label htmlFor="mt-13">{t('messageTester.recipientPhone')}</label>
                    <input
                      id="mt-13"
                      type="text"
                      value={recipient}
                      onChange={e => setRecipient(e.target.value)}
                      placeholder="+62812345678"
                    />
                    <span className="hint">{t('messageTester.phoneHint')}</span>
                  </>
                )}
              </div>
            </>
          )}

          {/* A multi-group run sends what was on screen when it started, so the fields are locked until it
              ends or is cancelled; Cancel sits outside, so it stays usable. */}
          <fieldset className="composer-fields" disabled={isGroupSending}>
            <div className="form-group">
              <span className="group-label" id="message-type-label">
                {t('messageTester.messageType')}
              </span>
              <div className="toggle-group toggle-group-wrap" role="group" aria-labelledby="message-type-label">
                {messageTypes.map(type => (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={messageType === type}
                    className={messageType === type ? 'active' : ''}
                    onClick={() => {
                      // A picked file's mimetype is bound to the category active at pick time, so dropping the
                      // category would route stale bytes to the wrong send-${type} endpoint — clear it.
                      if (type !== messageType) {
                        clearMediaFile();
                        if (type === 'bulk' || messageType === 'bulk') {
                          setMediaUrl('');
                          setBulkMediaKindChosen(false);
                        }
                      }
                      setMessageType(type);
                    }}
                  >
                    {t(`messageTester.types.${type}`)}
                  </button>
                ))}
              </div>
            </div>

            {messageType === 'text' && (
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <label htmlFor="mt-2" style={{ margin: 0 }}>{t('messageTester.messageContent')}</label>
                  <button
                    type="button"
                    className="btn-ai-sparkle"
                    onClick={() => setIsAiWriterOpen(true)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      padding: '0.25rem 0.6rem',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    <Sparkles size={13} />
                    <span>✨ {t('messageTester.aiWriteBtn', 'Gemini AI Assistant')}</span>
                  </button>
                </div>
                <textarea
                  id="mt-2"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  placeholder={t('messageTester.messagePlaceholder')}
                  rows={5}
                />
                {tooLongHint(content, MESSAGE_TEXT_MAX_LENGTH)}
              </div>
            )}

            {isMediaMessageType && (
              <>
                {mediaSourceFields}
                {messageType === 'audio' && (
                  <div className="form-group" style={{ marginTop: '0.5rem' }}>
                    <label className="checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isVoiceNote}
                        onChange={e => setIsVoiceNote(e.target.checked)}
                      />
                      <Mic size={15} color={isVoiceNote ? '#10b981' : 'var(--text-muted)'} />
                      <span>{t('messageTester.sendAsVoiceNote', 'Send as WhatsApp Voice Note (PTT mic bubble)')}</span>
                    </label>
                  </div>
                )}
                {messageType !== 'audio' && messageType !== 'sticker' && (
                  <div className="form-group">
                    <label htmlFor="mt-14">
                      {messageType === 'document' ? t('messageTester.filename') : t('messageTester.caption')} (
                      {t('common.optional')})
                    </label>
                    <input
                      id="mt-14"
                      type="text"
                      value={content}
                      onChange={e => setContent(e.target.value)}
                      placeholder={
                        messageType === 'document'
                          ? t('messageTester.filenamePlaceholder')
                          : t('messageTester.captionPlaceholder')
                      }
                    />
                    {tooLongHint(content, mediaContentMax)}
                  </div>
                )}
              </>
            )}

            {messageType === 'location' && (
              <>
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="mt-4">{t('messageTester.locationLatitude')}</label>
                    <input
                      id="mt-4"
                      type="number"
                      step="any"
                      min={-90}
                      max={90}
                      value={latitude}
                      onChange={e => setLatitude(e.target.value)}
                      placeholder="-6.2088"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="mt-5">{t('messageTester.locationLongitude')}</label>
                    <input
                      id="mt-5"
                      type="number"
                      step="any"
                      min={-180}
                      max={180}
                      value={longitude}
                      onChange={e => setLongitude(e.target.value)}
                      placeholder="106.8456"
                    />
                  </div>
                </div>
                <div className="form-group">
                  <label htmlFor="mt-15">
                    {t('messageTester.locationDescription')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-15"
                    type="text"
                    value={locationDescription}
                    onChange={e => setLocationDescription(e.target.value)}
                  />
                  {tooLongHint(locationDescription.trim(), LOCATION_TEXT_MAX_LENGTH)}
                </div>
                <div className="form-group">
                  <label htmlFor="mt-16">
                    {t('messageTester.locationAddress')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-16"
                    type="text"
                    value={locationAddress}
                    onChange={e => setLocationAddress(e.target.value)}
                  />
                  {tooLongHint(locationAddress.trim(), LOCATION_TEXT_MAX_LENGTH)}
                </div>
              </>
            )}

            {messageType === 'contact' && (
              <>
                <div className="form-group">
                  <label htmlFor="mt-6">{t('messageTester.contactName')}</label>
                  <input
                    id="mt-6"
                    type="text"
                    value={contactName}
                    onChange={e => setContactName(e.target.value)}
                    placeholder={t('messageTester.contactNamePlaceholder')}
                  />
                  {tooLongHint(contactName.trim(), CONTACT_NAME_MAX_LENGTH)}
                </div>
                <div className="form-group">
                  <label htmlFor="mt-7">{t('messageTester.contactNumber')}</label>
                  <input
                    id="mt-7"
                    type="text"
                    value={contactNumber}
                    onChange={e => setContactNumber(e.target.value)}
                    placeholder="+62812345678"
                  />
                  {tooLongHint(contactNumber.trim(), CONTACT_NUMBER_MAX_LENGTH)}
                </div>
              </>
            )}

            {messageType === 'poll' && (
              <>
                <div className="form-group">
                  <label htmlFor="mt-8">{t('messageTester.pollQuestion')}</label>
                  <input
                    id="mt-8"
                    type="text"
                    value={pollQuestion}
                    onChange={e => setPollQuestion(e.target.value)}
                    placeholder={t('messageTester.pollQuestionPlaceholder')}
                  />
                  {tooLongHint(pollQuestion.trim(), POLL_NAME_MAX_LENGTH)}
                </div>
                <div className="form-group">
                  <label>{t('messageTester.pollOptions')}</label>
                  {pollOptions.map((option, index) => (
                    <Fragment key={index}>
                      <div className="poll-option-row">
                        <input
                          type="text"
                          value={option}
                          onChange={e => setPollOptions(prev => prev.map((o, i) => (i === index ? e.target.value : o)))}
                          placeholder={t('messageTester.pollOptionPlaceholder', { index: index + 1 })}
                        />
                        <button
                          type="button"
                          className="remove-option-btn"
                          onClick={() => setPollOptions(prev => prev.filter((_, i) => i !== index))}
                          disabled={pollOptions.length <= 2}
                          aria-label={t('messageTester.removeOption')}
                        >
                          <X size={14} />
                        </button>
                      </div>
                      {tooLongHint(option.trim(), POLL_OPTION_MAX_LENGTH)}
                    </Fragment>
                  ))}
                  <button
                    type="button"
                    className="add-option-btn"
                    onClick={() => setPollOptions(prev => [...prev, ''])}
                    disabled={pollOptions.length >= 12}
                  >
                    <Plus size={14} /> {t('messageTester.addOption')}
                  </button>
                  <span className="hint">{t('messageTester.pollOptionsHint')}</span>
                </div>
                <div className="form-group">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={allowMultipleAnswers}
                      onChange={e => setAllowMultipleAnswers(e.target.checked)}
                    />
                    {t('messageTester.allowMultipleAnswers')}
                  </label>
                </div>
              </>
            )}

            {messageType === 'forward' && (
              <>
                <div className="form-group">
                  <label htmlFor="mt-17">
                    {t('messageTester.forwardFromChatId')} ({t('common.optional')})
                  </label>
                  <input
                    id="mt-17"
                    type="text"
                    value={forwardFrom}
                    onChange={e => setForwardFrom(e.target.value)}
                    placeholder={
                      (recipientType === 'group' ? selectedGroups[0] : recipient) ||
                      t('messageTester.forwardFromPlaceholder')
                    }
                  />
                  <span className="hint">{t('messageTester.forwardFromHint')}</span>
                </div>
                <div className="form-group">
                  <label htmlFor="mt-9">{t('messageTester.forwardToChatId')}</label>
                  <input
                    id="mt-9"
                    type="text"
                    value={forwardTo}
                    onChange={e => setForwardTo(e.target.value)}
                    placeholder={t('messageTester.forwardToPlaceholder')}
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="mt-10">{t('messageTester.forwardMessageId')}</label>
                  <input
                    id="mt-10"
                    type="text"
                    value={forwardMessageId}
                    onChange={e => setForwardMessageId(e.target.value)}
                  />
                  <span className="hint">{t('messageTester.forwardMessageIdHint')}</span>
                </div>
              </>
            )}

            {messageType === 'bulk' && (
              <>
                <div className="form-row" style={{ marginBottom: '1rem' }}>
                  <div className="form-group" style={{ flex: 1 }}>
                    <label htmlFor="mt-bulk-campaign">{t('messageTester.bulkCampaign')}</label>
                    <select
                      id="mt-bulk-campaign"
                      value={selectedCampaignId}
                      onChange={handleCampaignSelect}
                    >
                      <option value="">{t('messageTester.bulkCampaignNone')}</option>
                      {campaigns.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.recipientsCount})
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedCampaignId && (
                    <div className="form-group" style={{ flex: 1 }}>
                      <label htmlFor="mt-bulk-chunk-name">{t('messageTester.bulkChunkName')}</label>
                      <input
                        id="mt-bulk-chunk-name"
                        type="text"
                        value={chunkName}
                        onChange={e => setChunkName(e.target.value)}
                        placeholder={t('messageTester.bulkChunkNamePlaceholder')}
                      />
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '0.5rem',
                    }}
                  >
                    <label htmlFor="mt-11" style={{ marginBottom: 0 }}>
                      {t('messageTester.bulkRecipients')}
                    </label>
                    <button type="button" className="browse-btn" onClick={() => bulkFileInputRef.current?.click()}>
                      <Upload size={14} /> {t('messageTester.bulkRecipientsUpload')}
                    </button>
                    <input
                      ref={bulkFileInputRef}
                      type="file"
                      accept=".txt,.csv"
                      style={{ display: 'none' }}
                      onChange={handleBulkFileChange}
                    />
                  </div>
                  <textarea
                    id="mt-11"
                    value={bulkRecipients}
                    onChange={e => setBulkRecipients(e.target.value)}
                    placeholder={t('messageTester.bulkRecipientsPlaceholder')}
                    rows={4}
                  />
                  <span className="hint">
                    {t('messageTester.bulkRecipientsHint')} ·{' '}
                    {t('messageTester.bulkRecipientsCount', { count: bulkRecipientList.length })}
                  </span>
                </div>
                <div className="form-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                    <label htmlFor="mt-12" style={{ margin: 0 }}>{t('messageTester.messageContent')}</label>
                    <button
                      type="button"
                      className="btn-ai-sparkle"
                      onClick={() => setIsAiWriterOpen(true)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        padding: '0.25rem 0.6rem',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      <Sparkles size={13} />
                      <span>✨ {t('messageTester.aiWriteBtn', 'Gemini AI Assistant')}</span>
                    </button>
                  </div>
                  <textarea
                    id="mt-12"
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder={t('messageTester.messagePlaceholder')}
                    rows={4}
                  />
                  <span className="hint error" role="status">
                    {bulkAudioWithText
                      ? t('messageTester.bulkAudioNoCaption')
                      : bulkCaptionTooLong
                        ? t('messageTester.bulkCaptionTooLong', {
                            max: BULK_CAPTION_MAX_LENGTH,
                            count: captionLength(content),
                          })
                        : bulkTextTooLong
                          ? t('common.fieldTooLong', { max: MESSAGE_TEXT_MAX_LENGTH, count: captionLength(content) })
                          : ''}
                  </span>
                </div>
                {mediaSourceFields}
                {bulkAttachment && (bulkAttachment.kind === 'audio' || bulkMediaKind === 'audio') && (
                  <div className="form-group" style={{ marginTop: '0.5rem', marginBottom: '0.75rem' }}>
                    <label className="checkbox-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isVoiceNote}
                        onChange={e => setIsVoiceNote(e.target.checked)}
                      />
                      <Mic size={15} color={isVoiceNote ? '#10b981' : 'var(--text-muted)'} />
                      <span>{t('messageTester.sendAsVoiceNote', 'Send audio as WhatsApp Voice Notes (PTT)')}</span>
                    </label>
                  </div>
                )}
                {bulkAttachment && (
                  <div className="form-group">
                    <span className="group-label" id="bulk-media-kind-label">
                      {t('messageTester.bulkMediaKind')}
                    </span>
                    <div
                      className="toggle-group toggle-group-wrap bulk-media-kind"
                      role="group"
                      aria-labelledby="bulk-media-kind-label"
                    >
                      {BULK_MEDIA_KINDS.map(kind => (
                        <button
                          key={kind}
                          type="button"
                          aria-pressed={bulkMediaKind === kind}
                          className={bulkMediaKind === kind ? 'active' : ''}
                          onClick={() => {
                            setBulkMediaKind(kind);
                            setBulkMediaKindChosen(true);
                          }}
                        >
                          {t(`messageTester.types.${kind}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <div className="form-group">
                    <label htmlFor="mt-min-delay">
                      {t('messageTester.bulkMinDelay')} ({t('common.optional')})
                    </label>
                    <input
                      id="mt-min-delay"
                      type="number"
                      min={1000}
                      max={60000}
                      step={500}
                      value={bulkMinDelay}
                      onChange={e => setBulkMinDelay(e.target.value)}
                      placeholder="7000"
                    />
                    <span className="hint">{t('messageTester.bulkMinDelayHint')}</span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="mt-max-delay">
                      {t('messageTester.bulkMaxDelay')} ({t('common.optional')})
                    </label>
                    <input
                      id="mt-max-delay"
                      type="number"
                      min={1000}
                      max={60000}
                      step={500}
                      value={bulkMaxDelay}
                      onChange={e => setBulkMaxDelay(e.target.value)}
                      placeholder="15000"
                    />
                    <span className="hint">{t('messageTester.bulkMaxDelayHint')}</span>
                  </div>
                </div>
                {minDelayMs > maxDelayMs && (
                  <span className="hint error" role="status" style={{ marginTop: '-0.75rem', marginBottom: '1rem', display: 'block' }}>
                    {t('messageTester.bulkDelayOrderError')}
                  </span>
                )}
              </>
            )}
          </fieldset>

          <button className="send-btn" onClick={handleSend} disabled={isSendDisabled}>
            {isLoading ? <Loader2 className="animate-spin" size={18} /> : <Send size={18} />}
            {isLoading ? t('messageTester.sending') : canWrite ? t('messageTester.send') : t('messageTester.viewOnly')}
          </button>
          <div className="group-send-status">
            <span role="status">{groupSendProgress ? t('messageTester.sendingProgress', groupSendProgress) : ''}</span>
            {isGroupSending && (
              <button
                type="button"
                className="batch-cancel-btn"
                onClick={cancelGroupSend}
                disabled={groupSendCancelling}
              >
                {groupSendCancelling ? t('messageTester.batch.cancelling') : t('common.cancel')}
              </button>
            )}
          </div>
        </div>

        <div className="response-panel">
          <h2 className="eyebrow">{t('messageTester.responseTitle')}</h2>

          {response ? (
            <>
              <div className={`response-status ${response.success ? 'success' : 'error'}`}>
                {response.success ? (
                  <>
                    <CheckCircle size={20} />
                    <span>{t('messageTester.successLabel')}</span>
                  </>
                ) : (
                  <>
                    <XCircle size={20} />
                    <span>{t('messageTester.failedLabel')}</span>
                  </>
                )}
                {/* `<code>` earns both halves from index.css with no new rule: a monospace face, and the
                    LTR isolation that stops the bidi algorithm reordering the number against an RTL label
                    (ar/he). The `.mono` class only carries the second — its monospacing lives on compound
                    selectors like `.detail-value.mono`, which a bare span never matches. */}
                {response.status !== undefined && <code>HTTP {response.status}</code>}
              </div>

              <div className="response-details">
                <div className="detail-row">
                  <span className="detail-label">{t('messageTester.response.timestamp')}</span>
                  <span className="detail-value">{response.timestamp}</span>
                </div>
                {response.messageId && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.messageId')}</span>
                    <span className="detail-value mono">{response.messageId}</span>
                  </div>
                )}
                {response.batchId && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.batchId')}</span>
                    <span className="detail-value mono">{response.batchId}</span>
                  </div>
                )}
                {response.error && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.error')}</span>
                    <span className="detail-value" style={{ color: 'var(--error)' }}>
                      {response.error}
                    </span>
                  </div>
                )}
                {response.groups && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.groups')}</span>
                    <span className="detail-value">
                      {t('messageTester.groupsSentSummary', {
                        sent: response.groups.sent,
                        total: response.groups.total,
                      })}
                    </span>
                  </div>
                )}
                {response.groups && response.groups.failures.length > 0 && (
                  <div className="detail-row group-failures">
                    <span className="detail-label">{t('messageTester.response.error')}</span>
                    <ul className="detail-value">
                      {response.groups.failures.map(failure => (
                        <li key={failure.id}>
                          <strong>{failure.name}</strong>: {failure.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {response.groups && response.groups.notSent > 0 && (
                  <div className="detail-row">
                    <span className="detail-label">{t('messageTester.response.notSent')}</span>
                    <span className="detail-value">
                      {response.groups.stoppedBy === 'refusal'
                        ? t('messageTester.groupSendStopped', {
                            count: response.groups.notSent,
                            status: response.groups.refusedWith,
                          })
                        : t('messageTester.groupSendCancelled', { count: response.groups.notSent })}
                    </span>
                  </div>
                )}
              </div>

              {response.batchId && batchStatus && response.batchId === batchStatus.batchId && (
                <div className="batch-status">
                  <div className="batch-status-row">
                    <span className={`batch-badge ${batchStatus.status}`}>
                      {t(`messageTester.batch.status.${batchStatus.status}`)}
                    </span>
                    {(batchStatus.status === 'pending' || batchStatus.status === 'processing') && (
                      <button
                        type="button"
                        className="batch-cancel-btn"
                        onClick={handleCancelBatch}
                        disabled={batchCancelling}
                      >
                        {batchCancelling ? t('messageTester.batch.cancelling') : t('messageTester.batch.cancel')}
                      </button>
                    )}
                  </div>
                  <div className="batch-progress-bar">
                    <div className="batch-progress-fill" style={{ width: `${batchPercent}%` }} />
                  </div>
                  <div className="batch-progress-line">
                    {t('messageTester.batch.progress', {
                      sent: batchStatus.progress.sent,
                      failed: batchStatus.progress.failed,
                      pending: batchStatus.progress.pending,
                      total: batchStatus.progress.total,
                    })}
                  </div>
                  {batchError && <div className="batch-error">{batchError}</div>}
                </div>
              )}

              {recordedChunkInfo && (
                <div
                  className="campaign-chunk-notice"
                  style={{
                    padding: '0.85rem 1rem',
                    margin: '1rem 0',
                    backgroundColor: 'rgba(37, 211, 102, 0.1)',
                    border: '1px solid rgba(37, 211, 102, 0.3)',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem' }}>
                      ✓ {t('messageTester.chunkRecorded')}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      {recordedChunkInfo.chunkName}
                    </div>
                  </div>
                  <Link
                    to="/campaigns"
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--primary)',
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    {t('messageTester.viewAnalytics')} →
                  </Link>
                </div>
              )}

              <div className="response-json">
                <pre>{JSON.stringify(response, null, 2)}</pre>
              </div>
            </>
          ) : (
            <div className="response-empty">
              <p>{t('messageTester.responseEmpty')}</p>
            </div>
          )}
        </div>
      </div>

      {/* GEMINI AI WRITER MODAL */}
      {isAiWriterOpen && (
        <Modal
          open={isAiWriterOpen}
          title="✨ Gemini AI Marketing Copywriter"
          onClose={() => setIsAiWriterOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {!hasAiKey ? (
              <div style={{ backgroundColor: 'var(--bg-muted, rgba(0,0,0,0.05))', padding: '1rem', borderRadius: '8px' }}>
                <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', lineHeight: 1.5 }}>
                  Google Gemini AI is not yet configured with an API key. Enter your Gemini API key below to unlock automated high-converting WhatsApp message writing in English, Urdu, and Roman Urdu.
                </p>
                <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                  <label htmlFor="ai-key-input">Gemini API Key</label>
                  <input
                    id="ai-key-input"
                    type="password"
                    value={aiApiKeyInput}
                    onChange={e => setAiApiKeyInput(e.target.value)}
                    placeholder="AIzaSy..."
                  />
                  <span className="hint" style={{ fontSize: '0.75rem', marginTop: '4px', display: 'block' }}>
                    Get your free key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: 'var(--primary)' }}>Google AI Studio</a>.
                  </span>
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSaveAiKey}
                  disabled={isSavingAiKey || !aiApiKeyInput.trim()}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {isSavingAiKey ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  <span>Save Gemini API Key</span>
                </button>
              </div>
            ) : (
              <>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="ai-prompt">What is your message about?</label>
                  <textarea
                    id="ai-prompt"
                    rows={3}
                    value={aiPrompt}
                    onChange={e => setAiPrompt(e.target.value)}
                    placeholder="e.g. Admission open for Web & Graphic Design Batch 2026, 30% discount till Friday, call Sir Zubair 0300..."
                  />
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="ai-tone">Message Style & Tone</label>
                  <select
                    id="ai-tone"
                    value={aiTone}
                    onChange={e => setAiTone(e.target.value)}
                  >
                    <option value="Urdu / Roman Urdu Marketing (مارکیٹنگ میسج)">Urdu / Roman Urdu Marketing (مارکیٹنگ میسج)</option>
                    <option value="Professional English">Professional English</option>
                    <option value="Urgent Limited-Time Offer (محدود مدت آفر)">Urgent Limited-Time Offer (محدود مدت آفر)</option>
                    <option value="Friendly & Persuasive WhatsApp message">Friendly & Persuasive WhatsApp Message</option>
                  </select>
                </div>

                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleGenerateAiMessage}
                  disabled={isGeneratingAi || !aiPrompt.trim()}
                  style={{
                    background: 'linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%)',
                    justifyContent: 'center',
                    padding: '0.65rem 1rem',
                  }}
                >
                  {isGeneratingAi ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  <span>{isGeneratingAi ? 'Generating Copy with Gemini...' : 'Generate Marketing Message'}</span>
                </button>

                {aiGeneratedText && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <label style={{ fontSize: '0.85rem', fontWeight: 600, display: 'block', marginBottom: '0.35rem' }}>
                      Generated WhatsApp Copy:
                    </label>
                    <div
                      style={{
                        padding: '0.75rem 1rem',
                        backgroundColor: 'var(--bg-muted, rgba(0,0,0,0.03))',
                        border: '1px solid var(--border-color, #e2e8f0)',
                        borderRadius: '8px',
                        whiteSpace: 'pre-wrap',
                        fontSize: '0.9rem',
                        maxHeight: '200px',
                        overflowY: 'auto',
                        lineHeight: 1.5,
                      }}
                    >
                      {aiGeneratedText}
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleGenerateAiMessage}
                        disabled={isGeneratingAi}
                      >
                        Regenerate
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        onClick={handleApplyAiMessage}
                      >
                        <CheckCircle size={16} />
                        <span>Use This Message</span>
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Modal>
      )}

    </div>
  );
}
