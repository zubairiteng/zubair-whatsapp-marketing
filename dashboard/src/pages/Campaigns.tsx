import { useState, useMemo, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Megaphone,
  Plus,
  Search,
  Upload,
  Download,
  Trash2,
  Edit,
  Send,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  HelpCircle,
  Smile,
  MessageCircle,
  Clock,
  Users,
  Layers,
  ArrowLeft,
  Loader2,
  Sparkles,
} from 'lucide-react';
import {
  campaignApi,
  type CampaignItem,
  type CampaignDetail,
  type ChunkAnalytics,
} from '../services/api';
import {
  useCampaignsQuery,
  useCreateCampaignMutation,
  useUpdateCampaignMutation,
  useDeleteCampaignMutation,
} from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { parseBulkRecipients } from '../utils/bulkRecipients';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import './Campaigns.css';

export function Campaigns() {
  const { t } = useTranslation();
  useDocumentTitle(t('campaigns.title', 'Campaigns'));
  const toast = useToast();
  const navigate = useNavigate();

  const { data: campaigns = [], isLoading } = useCampaignsQuery();
  const createMutation = useCreateCampaignMutation();
  const updateMutation = useUpdateCampaignMutation();
  const deleteMutation = useDeleteCampaignMutation();

  const [search, setSearch] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chunks' | 'recipients'>('chunks');

  // Modals
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isAddNumbersModalOpen, setIsAddNumbersModalOpen] = useState(false);
  const [campaignToDelete, setCampaignToDelete] = useState<CampaignItem | null>(null);

  // Form states
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formRecipientsText, setFormRecipientsText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);

  // Detail View State
  const [selectedCampaignDetail, setSelectedCampaignDetail] = useState<CampaignDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [expandedChunkId, setExpandedChunkId] = useState<string | null>(null);
  const [chunkAnalyticsMap, setChunkAnalyticsMap] = useState<Record<string, ChunkAnalytics>>({});
  const [loadingChunkAnalytics, setLoadingChunkAnalytics] = useState<Record<string, boolean>>({});

  // Contact list search in detail view
  const [recipientSearch, setRecipientSearch] = useState('');

  // Gemini AI States
  const [isAiModalOpen, setIsAiModalOpen] = useState(false);
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-1.5-flash');
  const [isAiConfigured, setIsAiConfigured] = useState(false);
  const [isSavingAi, setIsSavingAi] = useState(false);

  useEffect(() => {
    campaignApi.getAiConfig()
      .then(res => {
        setIsAiConfigured(res.configured);
        if (res.model) setGeminiModel(res.model);
      })
      .catch(() => {});
  }, []);

  const handleSaveAiConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingAi(true);
    try {
      const res = await campaignApi.updateAiConfig({
        geminiApiKey: geminiApiKey || undefined,
        geminiModel,
      });
      if (res.success) {
        setIsAiConfigured(res.configured);
        toast.success(t('campaigns.aiConfigSuccess', 'Gemini AI configured successfully!'));
        setIsAiModalOpen(false);
        setGeminiApiKey('');
        // Refresh analytics for current chunk if opened
        if (expandedChunkId && selectedCampaignId) {
          loadChunkAnalytics(selectedCampaignId, expandedChunkId);
        }
      } else {
        toast.error('Failed to save AI configuration');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Error configuring Gemini AI');
    } finally {
      setIsSavingAi(false);
    }
  };

  // Overview stats
  const totalRecipientsAll = useMemo(
    () => campaigns.reduce((acc, c) => acc + (c.recipientsCount || 0), 0),
    [campaigns],
  );
  const totalChunksAll = useMemo(
    () => campaigns.reduce((acc, c) => acc + (c.chunksCount || 0), 0),
    [campaigns],
  );
  const totalMessagesSentAll = useMemo(
    () => campaigns.reduce((acc, c) => acc + (c.totalMessagesSent || 0), 0),
    [campaigns],
  );

  const filteredCampaigns = useMemo(() => {
    if (!search.trim()) return campaigns;
    const q = search.toLowerCase();
    return campaigns.filter(
      c => c.name.toLowerCase().includes(q) || (c.description && c.description.toLowerCase().includes(q)),
    );
  }, [campaigns, search]);

  const loadCampaignDetail = async (id: string) => {
    setLoadingDetail(true);
    try {
      const detail = await campaignApi.get(id);
      setSelectedCampaignDetail(detail);
      setSelectedCampaignId(id);
      // Auto expand first chunk if exists
      if (detail.chunks && detail.chunks.length > 0) {
        loadChunkAnalytics(id, detail.chunks[0].id);
      }
    } catch {
      toast.error(t('campaigns.loadFailed', 'Failed to load campaign details'));
    } finally {
      setLoadingDetail(false);
    }
  };

  const loadChunkAnalytics = async (campId: string, chunkId: string) => {
    setLoadingChunkAnalytics(prev => ({ ...prev, [chunkId]: true }));
    try {
      const analytics = await campaignApi.getChunkAnalytics(campId, chunkId);
      setChunkAnalyticsMap(prev => ({ ...prev, [chunkId]: analytics }));
      setExpandedChunkId(chunkId);
    } catch {
      toast.error(t('campaigns.analyticsFailed', 'Failed to load chunk analytics'));
    } finally {
      setLoadingChunkAnalytics(prev => ({ ...prev, [chunkId]: false }));
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, isAppend = false) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = event => {
      const text = String(event.target?.result || '');
      if (isAppend) {
        setFormRecipientsText(prev => (prev ? prev + '\n' + text : text));
      } else {
        setFormRecipientsText(text);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const parsedFormRecipients = useMemo(() => {
    return parseBulkRecipients(formRecipientsText);
  }, [formRecipientsText]);

  const openCreateModal = () => {
    setFormName('');
    setFormDesc('');
    setFormRecipientsText('');
    setIsCreateModalOpen(true);
  };

  const openEditModal = (c: CampaignItem | CampaignDetail) => {
    setFormName(c.name);
    setFormDesc(c.description || '');
    if ('recipients' in c && Array.isArray(c.recipients)) {
      setFormRecipientsText(c.recipients.join('\n'));
    } else {
      setFormRecipientsText('');
    }
    setIsEditModalOpen(true);
  };

  const handleCreate = async () => {
    if (!formName.trim()) return;
    try {
      await createMutation.mutateAsync({
        name: formName.trim(),
        description: formDesc.trim() || undefined,
        recipients: parsedFormRecipients,
      });
      toast.success(t('campaigns.created', 'Campaign created successfully'));
      setIsCreateModalOpen(false);
    } catch {
      toast.error(t('campaigns.createFailed', 'Failed to create campaign'));
    }
  };

  const handleUpdate = async () => {
    if (!selectedCampaignId || !formName.trim()) return;
    try {
      const updated = await updateMutation.mutateAsync({
        id: selectedCampaignId,
        body: {
          name: formName.trim(),
          description: formDesc.trim() || undefined,
          ...(formRecipientsText ? { recipients: parsedFormRecipients } : {}),
        },
      });
      setSelectedCampaignDetail(updated);
      toast.success(t('campaigns.updated', 'Campaign updated successfully'));
      setIsEditModalOpen(false);
    } catch {
      toast.error(t('campaigns.updateFailed', 'Failed to update campaign'));
    }
  };

  const handleDelete = async () => {
    if (!campaignToDelete) return;
    try {
      await deleteMutation.mutateAsync(campaignToDelete.id);
      toast.success(t('campaigns.deleted', 'Campaign deleted successfully'));
      setCampaignToDelete(null);
      if (selectedCampaignId === campaignToDelete.id) {
        setSelectedCampaignId(null);
        setSelectedCampaignDetail(null);
      }
    } catch {
      toast.error(t('campaigns.deleteFailed', 'Failed to delete campaign'));
    }
  };

  const handleAddNumbers = async () => {
    if (!selectedCampaignDetail || parsedFormRecipients.length === 0) return;
    const combined = Array.from(new Set([...selectedCampaignDetail.recipients, ...parsedFormRecipients]));
    try {
      const updated = await updateMutation.mutateAsync({
        id: selectedCampaignDetail.id,
        body: { recipients: combined },
      });
      setSelectedCampaignDetail(updated);
      toast.success(t('campaigns.numbersAdded', 'Numbers added successfully'));
      setIsAddNumbersModalOpen(false);
      setFormRecipientsText('');
    } catch {
      toast.error(t('campaigns.addFailed', 'Failed to add numbers'));
    }
  };

  const handleRemoveNumber = async (chatId: string) => {
    if (!selectedCampaignDetail) return;
    const updatedRecipients = selectedCampaignDetail.recipients.filter(r => r !== chatId);
    try {
      const updated = await updateMutation.mutateAsync({
        id: selectedCampaignDetail.id,
        body: { recipients: updatedRecipients },
      });
      setSelectedCampaignDetail(updated);
      toast.success(t('campaigns.numberRemoved', 'Number removed'));
    } catch {
      toast.error(t('campaigns.removeFailed', 'Failed to remove number'));
    }
  };

  const exportContacts = () => {
    if (!selectedCampaignDetail) return;
    const blob = new Blob([selectedCampaignDetail.recipients.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedCampaignDetail.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_contacts.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sendInMessageTester = (campaign: CampaignItem | CampaignDetail) => {
    window.sessionStorage.setItem('openwa_active_campaign_id', campaign.id);
    window.sessionStorage.setItem('openwa_active_campaign_name', campaign.name);
    navigate('/message-tester');
  };

  const filteredRecipients = useMemo(() => {
    if (!selectedCampaignDetail?.recipients) return [];
    if (!recipientSearch.trim()) return selectedCampaignDetail.recipients;
    const q = recipientSearch.toLowerCase();
    return selectedCampaignDetail.recipients.filter(r => r.toLowerCase().includes(q));
  }, [selectedCampaignDetail, recipientSearch]);

  return (
    <div className="campaigns-page">
      <PageHeader
        title={t('campaigns.title', 'Campaigns')}
        subtitle={t('campaigns.subtitle', 'Create campaigns, upload contacts, and track responses chunk-by-chunk')}
      />

      {/* OVERVIEW STATS CARDS */}
      {!selectedCampaignId && (
        <div className="campaigns-stats-grid">
          <div className="stat-card">
            <div className="stat-icon">
              <Megaphone size={22} />
            </div>
            <div className="stat-content">
              <div className="stat-label">{t('campaigns.totalCampaigns', 'Total Campaigns')}</div>
              <div className="stat-value">{campaigns.length}</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">
              <Users size={22} />
            </div>
            <div className="stat-content">
              <div className="stat-label">{t('campaigns.totalContacts', 'Total Contacts')}</div>
              <div className="stat-value">{totalRecipientsAll}</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon purple">
              <Layers size={22} />
            </div>
            <div className="stat-content">
              <div className="stat-label">{t('campaigns.chunksExecuted', 'Chunks Executed')}</div>
              <div className="stat-value">{totalChunksAll}</div>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon amber">
              <Send size={22} />
            </div>
            <div className="stat-content">
              <div className="stat-label">{t('campaigns.messagesSent', 'Messages Sent')}</div>
              <div className="stat-value">{totalMessagesSentAll}</div>
            </div>
          </div>
        </div>
      )}

      {/* MAIN VIEW: LIST OF CAMPAIGNS */}
      {!selectedCampaignId && (
        <>
          <div className="campaigns-toolbar">
            <div className="campaigns-search-box">
              <Search size={18} color="var(--text-muted)" />
              <input
                type="text"
                placeholder={t('campaigns.searchPlaceholder', 'Search campaigns...')}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn-ai-config"
                onClick={() => setIsAiModalOpen(true)}
                title="Configure Google Gemini AI for intelligent response classification"
              >
                <Sparkles size={16} />
                <span>{isAiConfigured ? 'Gemini AI Active' : 'Setup Gemini AI'}</span>
              </button>
              <button className="btn-primary" onClick={openCreateModal}>
                <Plus size={18} />
                {t('campaigns.newCampaign', 'New Campaign')}
              </button>
            </div>
          </div>

          {isLoading ? (
            <div className="empty-state">
              <Loader2 className="animate-spin" size={32} />
              <p>{t('common.loading', 'Loading...')}</p>
            </div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="empty-state">
              <Megaphone size={48} color="var(--text-muted)" style={{ margin: '0 auto' }} />
              <h3>{t('campaigns.noCampaigns', 'No campaigns yet')}</h3>
              <p>{t('campaigns.noCampaignsDesc', 'Create a campaign to upload recipient numbers and track responses.')}</p>
              <button className="btn-primary" onClick={openCreateModal}>
                <Plus size={18} />
                {t('campaigns.createFirst', 'Create First Campaign')}
              </button>
            </div>
          ) : (
            <div className="campaigns-grid">
              {filteredCampaigns.map(c => (
                <div key={c.id} className="campaign-card">
                  <div>
                    <div className="campaign-card-header">
                      <h3 className="campaign-title">{c.name}</h3>
                      <button
                        className="btn-secondary"
                        style={{ padding: '0.35rem 0.6rem' }}
                        onClick={() => openEditModal(c)}
                        title={t('common.edit', 'Edit')}
                      >
                        <Edit size={14} />
                      </button>
                    </div>
                    <div className="campaign-desc">{c.description || t('campaigns.noDesc', 'No description')}</div>

                    <div className="campaign-meta">
                      <span className="meta-chip">
                        <Users size={14} />
                        {c.recipientsCount} {t('campaigns.contacts', 'contacts')}
                      </span>
                      <span className="meta-chip">
                        <Layers size={14} />
                        {c.chunksCount} {t('campaigns.chunks', 'chunks')}
                      </span>
                      {c.totalMessagesSent > 0 && (
                        <span className="meta-chip">
                          <Send size={14} />
                          {c.totalMessagesSent} {t('campaigns.sent', 'sent')}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="campaign-actions">
                    <button className="btn-primary" style={{ flex: 1 }} onClick={() => sendInMessageTester(c)}>
                      <Send size={14} />
                      {t('campaigns.sendNow', 'Send in Tester')}
                    </button>
                    <button className="btn-secondary" onClick={() => loadCampaignDetail(c.id)}>
                      {t('campaigns.details', 'Report & Numbers')}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => setCampaignToDelete(c)}
                      title={t('common.delete', 'Delete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* DETAIL VIEW: CHUNKS, ANALYTICS & RECIPIENTS */}
      {selectedCampaignId && (
        <div>
          <div className="detail-header">
            <div className="detail-title-row">
              <button
                className="btn-secondary"
                onClick={() => {
                  setSelectedCampaignId(null);
                  setSelectedCampaignDetail(null);
                }}
              >
                <ArrowLeft size={16} />
                {t('campaigns.backToCampaigns', 'Back to Campaigns')}
              </button>
              <div>
                <h2 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>
                  {selectedCampaignDetail?.name || t('campaigns.campaignDetails', 'Campaign Details')}
                </h2>
                <span style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
                  {selectedCampaignDetail?.description || ''}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                onClick={() => setIsAiModalOpen(true)}
                title="Configure Gemini AI for response classification"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
              >
                <Sparkles size={16} color="#8b5cf6" />
                <span>{isAiConfigured ? 'AI Active' : 'Setup AI'}</span>
              </button>
              <button
                className="btn-primary"
                onClick={() => selectedCampaignDetail && sendInMessageTester(selectedCampaignDetail)}
              >
                <Send size={16} />
                {t('campaigns.sendInTester', 'Send in Message Tester')}
              </button>
              <button
                className="btn-secondary"
                onClick={() => selectedCampaignDetail && openEditModal(selectedCampaignDetail)}
              >
                <Edit size={16} />
                {t('common.edit', 'Edit')}
              </button>
            </div>
          </div>

          <div className="detail-tabs">
            <button
              className={`tab-btn ${activeTab === 'chunks' ? 'active' : ''}`}
              onClick={() => setActiveTab('chunks')}
            >
              <Layers size={18} />
              {t('campaigns.chunksTab', 'Chunks & Response Reports')} (
              {selectedCampaignDetail?.chunks?.length || 0})
            </button>
            <button
              className={`tab-btn ${activeTab === 'recipients' ? 'active' : ''}`}
              onClick={() => setActiveTab('recipients')}
            >
              <Users size={18} />
              {t('campaigns.recipientsTab', 'Saved Contacts')} (
              {selectedCampaignDetail?.recipients?.length || 0})
            </button>
          </div>

          {loadingDetail ? (
            <div className="empty-state">
              <Loader2 className="animate-spin" size={32} />
              <p>{t('common.loading', 'Loading details...')}</p>
            </div>
          ) : activeTab === 'chunks' ? (
            /* CHUNKS & ANALYTICS TAB */
            <div>
              {(!selectedCampaignDetail?.chunks || selectedCampaignDetail.chunks.length === 0) ? (
                <div className="empty-state">
                  <Layers size={48} color="var(--text-muted)" style={{ margin: '0 auto' }} />
                  <h3>{t('campaigns.noChunks', 'No execution chunks yet')}</h3>
                  <p>
                    {t(
                      'campaigns.noChunksDesc',
                      'Send a batch from Message Tester using this campaign to create your first chunk and track responses.',
                    )}
                  </p>
                  <button
                    className="btn-primary"
                    onClick={() => selectedCampaignDetail && sendInMessageTester(selectedCampaignDetail)}
                  >
                    <Send size={16} />
                    {t('campaigns.launchFirstChunk', 'Send First Batch')}
                  </button>
                </div>
              ) : (
                <div>
                  {selectedCampaignDetail.chunks.map(chunk => {
                    const analytics = chunkAnalyticsMap[chunk.id];
                    const isExpanded = expandedChunkId === chunk.id;
                    const isRefreshing = loadingChunkAnalytics[chunk.id];

                    return (
                      <div key={chunk.id} className="chunk-card">
                        <div
                          className="chunk-header"
                          onClick={() => {
                            if (isExpanded) {
                              setExpandedChunkId(null);
                            } else {
                              loadChunkAnalytics(selectedCampaignDetail.id, chunk.id);
                            }
                          }}
                        >
                          <div className="chunk-info">
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              {isExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                              <h4>{chunk.chunkName}</h4>
                            </div>
                            <span>
                              <Clock size={12} style={{ display: 'inline', marginRight: '4px' }} />
                              {new Date(chunk.sentAt).toLocaleString()} • {chunk.recipients?.length || 0} {t('campaigns.recipients', 'recipients')}
                            </span>
                          </div>

                          <div className="chunk-badges">
                            {analytics && (
                              <>
                                <span className="badge ack">
                                  <CheckCircle size={12} />
                                  {analytics.summary.acknowledged} {t('campaigns.ack', 'Ack')}
                                </span>
                                <span className="badge question">
                                  <HelpCircle size={12} />
                                  {analytics.summary.questions} {t('campaigns.questions', 'Questions')}
                                </span>
                                <span className="badge reaction">
                                  <Smile size={12} />
                                  {analytics.summary.reactions} {t('campaigns.reactions', 'Reactions')}
                                </span>
                                <span className="badge ignored">
                                  {analytics.summary.ignored} {t('campaigns.ignored', 'Ignored')}
                                </span>
                                <span
                                  className="badge replied"
                                  style={{ fontWeight: 700, fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
                                >
                                  {analytics.responseRatePercent}% {t('campaigns.responseRate', 'Response')}
                                </span>
                              </>
                            )}
                            <button
                              className="btn-secondary"
                              style={{ padding: '0.35rem 0.6rem' }}
                              onClick={e => {
                                e.stopPropagation();
                                loadChunkAnalytics(selectedCampaignDetail.id, chunk.id);
                              }}
                              title={t('campaigns.refreshAnalytics', 'Refresh Responses')}
                            >
                              <RefreshCw size={14} className={isRefreshing ? 'animate-spin' : ''} />
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="chunk-body">
                            {isRefreshing && !analytics ? (
                              <div style={{ textAlign: 'center', padding: '2rem' }}>
                                <Loader2 className="animate-spin" size={24} />
                                <p>{t('campaigns.calculatingResponses', 'Analyzing incoming replies & reactions...')}</p>
                              </div>
                            ) : analytics ? (
                              <div>
                                {/* STATS BAR */}
                                <div className="response-bar-container">
                                  <div className="response-bar-title">
                                    <span>{t('campaigns.responseDistribution', 'Response Breakdown')}</span>
                                    <span>
                                      {analytics.totalResponded} / {analytics.totalDelivered} {t('campaigns.respondedTotal', 'responded')} ({analytics.responseRatePercent}%)
                                    </span>
                                  </div>
                                  <div className="response-progress-bar">
                                    {analytics.totalDelivered > 0 && (
                                      <>
                                        <div
                                          className="bar-segment ack"
                                          style={{ width: `${(analytics.summary.acknowledged / analytics.totalDelivered) * 100}%` }}
                                          title={`Acknowledged: ${analytics.summary.acknowledged}`}
                                        />
                                        <div
                                          className="bar-segment question"
                                          style={{ width: `${(analytics.summary.questions / analytics.totalDelivered) * 100}%` }}
                                          title={`Questions: ${analytics.summary.questions}`}
                                        />
                                        <div
                                          className="bar-segment reaction"
                                          style={{ width: `${(analytics.summary.reactions / analytics.totalDelivered) * 100}%` }}
                                          title={`Reactions: ${analytics.summary.reactions}`}
                                        />
                                        <div
                                          className="bar-segment replied"
                                          style={{ width: `${(analytics.summary.otherReplies / analytics.totalDelivered) * 100}%` }}
                                          title={`Other replies: ${analytics.summary.otherReplies}`}
                                        />
                                        <div
                                          className="bar-segment ignored"
                                          style={{ width: `${(analytics.summary.ignored / analytics.totalDelivered) * 100}%` }}
                                          title={`Ignored / No response: ${analytics.summary.ignored}`}
                                        />
                                      </>
                                    )}
                                  </div>
                                  <div className="response-legend">
                                    <div className="legend-item">
                                      <div className="legend-dot ack" />
                                      <span>
                                        {t('campaigns.acknowledged', 'Acknowledged')} ({analytics.summary.acknowledged})
                                      </span>
                                    </div>
                                    <div className="legend-item">
                                      <div className="legend-dot question" />
                                      <span>
                                        {t('campaigns.questions', 'Questions')} ({analytics.summary.questions})
                                      </span>
                                    </div>
                                    <div className="legend-item">
                                      <div className="legend-dot reaction" />
                                      <span>
                                        {t('campaigns.reactions', 'Reactions')} ({analytics.summary.reactions})
                                      </span>
                                    </div>
                                    <div className="legend-item">
                                      <div className="legend-dot replied" />
                                      <span>
                                        {t('campaigns.otherReplies', 'Other Replies')} ({analytics.summary.otherReplies})
                                      </span>
                                    </div>
                                    <div className="legend-item">
                                      <div className="legend-dot ignored" />
                                      <span>
                                        {t('campaigns.ignored', 'Ignored / No Reply')} ({analytics.summary.ignored})
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* RECIPIENT DRILLDOWN TABLE */}
                                <div className="report-table-wrapper">
                                  <table className="report-table">
                                    <thead>
                                      <tr>
                                        <th>{t('campaigns.recipient', 'Recipient')}</th>
                                        <th>{t('campaigns.status', 'Send Status')}</th>
                                        <th>{t('campaigns.responseType', 'Response Type')}</th>
                                        <th>{t('campaigns.lastResponse', 'Last Message / Reaction')}</th>
                                        <th>{t('campaigns.time', 'Time')}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {analytics.recipients.map(r => (
                                        <tr key={r.chatId}>
                                          <td style={{ fontWeight: 600 }}>{r.chatId.replace(/@c\.us$/, '')}</td>
                                          <td>
                                            <span className={`badge ${r.status}`}>
                                              {r.status === 'sent' ? t('campaigns.delivered', 'Sent') : t('campaigns.failed', 'Failed')}
                                            </span>
                                          </td>
                                          <td>
                                            {r.responseCategory === 'acknowledged' && (
                                              <span className="badge ack">
                                                <CheckCircle size={12} />
                                                {t('campaigns.ackLabel', 'Acknowledged')}
                                              </span>
                                            )}
                                            {r.responseCategory === 'question' && (
                                              <span className="badge question">
                                                <HelpCircle size={12} />
                                                {t('campaigns.questionLabel', 'Question Asked')}
                                              </span>
                                            )}
                                            {r.responseCategory === 'reaction' && (
                                              <span className="badge reaction">
                                                <Smile size={12} />
                                                {t('campaigns.reactionLabel', 'Reaction')}
                                              </span>
                                            )}
                                            {r.responseCategory === 'replied' && (
                                              <span className="badge replied">
                                                <MessageCircle size={12} />
                                                {t('campaigns.replyLabel', 'Replied')}
                                              </span>
                                            )}
                                            {r.responseCategory === 'ignored' && (
                                              <span className="badge ignored">
                                                {t('campaigns.ignoredLabel', 'No Response')}
                                              </span>
                                            )}
                                          </td>
                                          <td style={{ maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {r.lastResponseText || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                          </td>
                                          <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                            {r.lastResponseTime ? new Date(r.lastResponseTime).toLocaleTimeString() : '—'}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* RECIPIENTS TAB */
            <div>
              <div className="campaigns-toolbar">
                <div className="campaigns-search-box">
                  <Search size={18} color="var(--text-muted)" />
                  <input
                    type="text"
                    placeholder={t('campaigns.searchContactsPlaceholder', 'Filter contacts...')}
                    value={recipientSearch}
                    onChange={e => setRecipientSearch(e.target.value)}
                  />
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn-secondary" onClick={exportContacts}>
                    <Download size={16} />
                    {t('campaigns.export', 'Export CSV/TXT')}
                  </button>
                  <button className="btn-primary" onClick={() => setIsAddNumbersModalOpen(true)}>
                    <Plus size={16} />
                    {t('campaigns.addContacts', 'Add Contacts')}
                  </button>
                </div>
              </div>

              {filteredRecipients.length === 0 ? (
                <div className="empty-state">
                  <Users size={48} color="var(--text-muted)" style={{ margin: '0 auto' }} />
                  <h3>{t('campaigns.noContactsFound', 'No contacts found')}</h3>
                  <p>{t('campaigns.noContactsFoundDesc', 'Add phone numbers or import a CSV file.')}</p>
                </div>
              ) : (
                <div className="report-table-wrapper">
                  <table className="report-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>{t('campaigns.contactNumber', 'Phone Number / Chat ID')}</th>
                        <th style={{ width: '80px', textAlign: 'center' }}>{t('common.actions', 'Action')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecipients.map((chatId, idx) => (
                        <tr key={chatId}>
                          <td style={{ color: 'var(--text-muted)', width: '60px' }}>{idx + 1}</td>
                          <td style={{ fontWeight: 600 }}>{chatId.replace(/@c\.us$/, '')}</td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              className="btn-danger"
                              style={{ padding: '0.25rem 0.5rem' }}
                              onClick={() => handleRemoveNumber(chatId)}
                              title={t('common.delete', 'Remove')}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* CREATE CAMPAIGN MODAL */}
      {isCreateModalOpen && (
        <Modal
          open={isCreateModalOpen}
          title={t('campaigns.createCampaignModalTitle', 'Create Campaign')}
          onClose={() => setIsCreateModalOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                {t('campaigns.campaignName', 'Campaign Name')} *
              </label>
              <input
                type="text"
                placeholder={t('campaigns.namePlaceholder', 'e.g. Real Estate Promo, VIP Clients')}
                value={formName}
                onChange={e => setFormName(e.target.value)}
                style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                {t('campaigns.description', 'Description')} ({t('common.optional')})
              </label>
              <input
                type="text"
                placeholder={t('campaigns.descPlaceholder', 'Optional notes or purpose')}
                value={formDesc}
                onChange={e => setFormDesc(e.target.value)}
                style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)' }}
              />
            </div>

            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                <label style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                  {t('campaigns.recipientsList', 'Recipient Phone Numbers')}
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt"
                    style={{ display: 'none' }}
                    onChange={e => handleFileUpload(e, true)}
                  />
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={12} />
                    {t('campaigns.uploadFile', 'Upload CSV/TXT')}
                  </button>
                </div>
              </div>

              <textarea
                rows={6}
                placeholder={t('campaigns.recipientsPlaceholder', '+923001234567\n+923009876543\nOne number per line or separated by commas')}
                value={formRecipientsText}
                onChange={e => setFormRecipientsText(e.target.value)}
                style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)', fontFamily: 'monospace' }}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {t('campaigns.detectedContacts', 'Detected {{count}} valid numbers', { count: parsedFormRecipients.length })}
              </span>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn-secondary" onClick={() => setIsCreateModalOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={!formName.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : <Plus size={16} />}
                {t('campaigns.createButton', 'Create Campaign')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* EDIT CAMPAIGN MODAL */}
      {isEditModalOpen && (
        <Modal
          open={isEditModalOpen}
          title={t('campaigns.editCampaignModalTitle', 'Edit Campaign')}
          onClose={() => setIsEditModalOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                {t('campaigns.campaignName', 'Campaign Name')} *
              </label>
              <input
                type="text"
                value={formName}
                onChange={e => setFormName(e.target.value)}
                style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.35rem' }}>
                {t('campaigns.description', 'Description')}
              </label>
              <input
                type="text"
                value={formDesc}
                onChange={e => setFormDesc(e.target.value)}
                style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn-secondary" onClick={() => setIsEditModalOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleUpdate}
                disabled={!formName.trim() || updateMutation.isPending}
              >
                {updateMutation.isPending ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle size={16} />}
                {t('common.save', 'Save Changes')}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* ADD NUMBERS MODAL */}
      {isAddNumbersModalOpen && (
        <Modal
          open={isAddNumbersModalOpen}
          title={t('campaigns.addNumbersTitle', 'Add Numbers to Campaign')}
          onClose={() => setIsAddNumbersModalOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                {t('campaigns.pasteOrUpload', 'Paste numbers or upload a CSV/TXT file')}
              </span>
              <input
                ref={addFileInputRef}
                type="file"
                accept=".csv,.txt"
                style={{ display: 'none' }}
                onChange={e => handleFileUpload(e, true)}
              />
              <button
                type="button"
                className="btn-secondary"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                onClick={() => addFileInputRef.current?.click()}
              >
                <Upload size={12} />
                {t('campaigns.uploadFile', 'Upload CSV/TXT')}
              </button>
            </div>

            <textarea
              rows={8}
              placeholder="+923001234567\n+923009876543\nOne per line..."
              value={formRecipientsText}
              onChange={e => setFormRecipientsText(e.target.value)}
              style={{ width: '100%', padding: '0.625rem', borderRadius: '6px', border: '1px solid var(--border)', fontFamily: 'monospace' }}
            />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {t('campaigns.detectedContacts', 'Detected {{count}} valid numbers', { count: parsedFormRecipients.length })}
            </span>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button className="btn-secondary" onClick={() => setIsAddNumbersModalOpen(false)}>
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleAddNumbers}
                disabled={parsedFormRecipients.length === 0}
              >
                <Plus size={16} />
                {t('campaigns.addCountNumbers', 'Add {{count}} Numbers', { count: parsedFormRecipients.length })}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* GEMINI AI CONFIG MODAL */}
      {isAiModalOpen && (
        <Modal
          open={isAiModalOpen}
          title="Google Gemini AI Response Analyzer"
          onClose={() => setIsAiModalOpen(false)}
        >
          <form onSubmit={handleSaveAiConfig} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div
              style={{
                background: 'var(--bg-hover, #f3f4f6)',
                padding: '0.875rem',
                borderRadius: '8px',
                fontSize: '0.85rem',
                color: 'var(--text-secondary, #4b5563)',
                lineHeight: 1.5,
              }}
            >
              ✨ <strong>Intelligent Customer Reply Classification:</strong> Connect your Gemini API Key to automatically categorize incoming customer replies (English, Roman Urdu, Urdu, Hindi) into <strong>Acknowledged</strong> (e.g. <em>"Okay"</em>, <em>"theek hai"</em>, <em>"sahi hai"</em>, <em>"done"</em>), <strong>Questions</strong> (e.g. <em>"price kya hai"</em>), and <strong>Reactions</strong>.
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 600, fontSize: '0.875rem' }}>
                Google Gemini API Key
              </label>
              <input
                type="password"
                placeholder={isAiConfigured ? '•••••••••••••••••••••••• (Configured)' : 'AIzaSy...'}
                value={geminiApiKey}
                onChange={e => setGeminiApiKey(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border, #e5e7eb)',
                  background: 'var(--bg-card, #ffffff)',
                  color: 'var(--text-primary)',
                  fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
              />
              <span
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--text-muted, #6b7280)',
                  marginTop: '0.25rem',
                  display: 'block',
                }}
              >
                Get your key from Google AI Studio. Leave empty to keep existing key.
              </span>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 600, fontSize: '0.875rem' }}>
                Gemini Model
              </label>
              <select
                value={geminiModel}
                onChange={e => setGeminiModel(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.625rem 0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border, #e5e7eb)',
                  background: 'var(--bg-card, #ffffff)',
                  color: 'var(--text-primary)',
                  fontSize: '0.875rem',
                  boxSizing: 'border-box',
                }}
              >
                <option value="gemini-1.5-flash">Gemini 1.5 Flash (Fast & Recommended)</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
              </select>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsAiModalOpen(false)}
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="submit" className="btn-primary" disabled={isSavingAi}>
                {isSavingAi ? 'Saving...' : 'Save & Enable AI'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {campaignToDelete && (
        <Modal
          open={!!campaignToDelete}
          title={t('campaigns.deleteCampaignTitle', 'Delete Campaign')}
          onClose={() => setCampaignToDelete(null)}
        >
          <p>
            {t(
              'campaigns.deleteConfirm',
              'Are you sure you want to delete campaign "{{name}}"? This will delete its saved contacts and chunk history.',
              { name: campaignToDelete.name },
            )}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.5rem' }}>
            <button className="btn-secondary" onClick={() => setCampaignToDelete(null)}>
              {t('common.cancel', 'Cancel')}
            </button>
            <button className="btn-danger" onClick={handleDelete}>
              <Trash2 size={16} />
              {t('common.delete', 'Delete')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
