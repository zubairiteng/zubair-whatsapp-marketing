import { useState, useEffect } from 'react';
import {
  Users,
  UserPlus,
  Clock,
  CheckCircle,
  AlertTriangle,
  XCircle,
  RefreshCw,
  PlusCircle,
  Key,
  Trash2,
  Copy,
  Check,
  X,
  Smartphone,
} from 'lucide-react';
import { clientApi, type ClientItem } from '../services/api';
import './ClientManagement.css';

export function ClientManagement() {
  const [clients, setClients] = useState<ClientItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [showAddModal, setShowAddModal] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPassword, setNewClientPassword] = useState('');
  const [validityDays, setValidityDays] = useState(30);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Created Client Credentials Popup
  const [createdInfo, setCreatedInfo] = useState<{
    name: string;
    email: string;
    password: string;
    sessionId: string;
    expiresAt: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Password reset modal
  const [resetTarget, setResetTarget] = useState<ClientItem | null>(null);
  const [resetNewPass, setResetNewPass] = useState('');

  const loadClients = async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await clientApi.list();
      setClients(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load client accounts');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadClients();
  }, []);

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClientName || !newClientEmail || !newClientPassword) return;

    try {
      setIsSubmitting(true);
      const created = await clientApi.create({
        name: newClientName,
        email: newClientEmail,
        password: newClientPassword,
        validityDays,
      });

      setCreatedInfo({
        name: created.name,
        email: created.email,
        password: newClientPassword,
        sessionId: created.sessionId || '',
        expiresAt: created.expiresAt || '',
      });

      setShowAddModal(false);
      setNewClientName('');
      setNewClientEmail('');
      setNewClientPassword('');
      setValidityDays(30);
      loadClients();
    } catch (err: any) {
      alert(err?.message || 'Failed to create client');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExtendDays = async (client: ClientItem, days: number) => {
    if (!window.confirm(`Extend ${client.name}'s license by +${days} days?`)) return;
    try {
      await clientApi.update(client.id, { addDays: days });
      loadClients();
    } catch (err: any) {
      alert(err?.message || 'Failed to extend license');
    }
  };

  const handleToggleStatus = async (client: ClientItem) => {
    const newStatus = client.status === 'active' ? 'disabled' : 'active';
    try {
      await clientApi.update(client.id, { status: newStatus });
      loadClients();
    } catch (err: any) {
      alert(err?.message || 'Failed to update status');
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget || !resetNewPass) return;
    try {
      await clientApi.update(resetTarget.id, { password: resetNewPass });
      alert(`Password updated successfully for ${resetTarget.name}`);
      setResetTarget(null);
      setResetNewPass('');
    } catch (err: any) {
      alert(err?.message || 'Failed to reset password');
    }
  };

  const handleDeleteClient = async (client: ClientItem) => {
    if (
      !window.confirm(
        `Are you sure you want to delete client "${client.name}"? This will delete their account and assigned WhatsApp session!`,
      )
    )
      return;

    try {
      await clientApi.delete(client.id);
      loadClients();
    } catch (err: any) {
      alert(err?.message || 'Failed to delete client');
    }
  };

  const copyCredentials = () => {
    if (!createdInfo) return;
    const text = `*Zubair Ahmed - WhatsApp Marketing Suite*\nPortal URL: ${window.location.origin}\nEmail: ${createdInfo.email}\nPassword: ${createdInfo.password}\nValid Until: ${createdInfo.expiresAt ? createdInfo.expiresAt.slice(0, 10) : '30 Days'}\n\nPlease keep your credentials safe.`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  // Stats
  const totalCount = clients.length;
  const activeCount = clients.filter(c => c.status === 'active' && !c.isExpired).length;
  const expiringSoonCount = clients.filter(
    c => c.status === 'active' && !c.isExpired && c.daysRemaining > 0 && c.daysRemaining <= 7,
  ).length;
  const expiredCount = clients.filter(c => c.isExpired || (c.daysRemaining <= 0 && c.expiresAt)).length;

  return (
    <div className="client-management">
      {/* Header */}
      <div className="cm-header">
        <div className="cm-title-group">
          <h1>Client Management</h1>
          <p>Create client accounts, assign dedicated WhatsApp sessions, and manage 1-month subscriptions</p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="cm-btn cm-btn-outline" onClick={loadClients} title="Refresh">
            <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button className="cm-btn cm-btn-primary" onClick={() => setShowAddModal(true)}>
            <UserPlus size={16} /> + Add New Client
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="cm-stats-grid">
        <div className="cm-stat-card">
          <div className="cm-stat-icon" style={{ background: '#eff6ff', color: '#2563eb' }}>
            <Users size={24} />
          </div>
          <div>
            <div className="cm-stat-val">{totalCount}</div>
            <div className="cm-stat-lbl">Total Clients</div>
          </div>
        </div>

        <div className="cm-stat-card">
          <div className="cm-stat-icon" style={{ background: '#ecfdf5', color: '#059669' }}>
            <CheckCircle size={24} />
          </div>
          <div>
            <div className="cm-stat-val">{activeCount}</div>
            <div className="cm-stat-lbl">Active Licenses</div>
          </div>
        </div>

        <div className="cm-stat-card">
          <div className="cm-stat-icon" style={{ background: '#fffbeb', color: '#d97706' }}>
            <AlertTriangle size={24} />
          </div>
          <div>
            <div className="cm-stat-val">{expiringSoonCount}</div>
            <div className="cm-stat-lbl">Expiring Soon (≤ 7 Days)</div>
          </div>
        </div>

        <div className="cm-stat-card">
          <div className="cm-stat-icon" style={{ background: '#fef2f2', color: '#dc2626' }}>
            <XCircle size={24} />
          </div>
          <div>
            <div className="cm-stat-val">{expiredCount}</div>
            <div className="cm-stat-lbl">Expired Accounts</div>
          </div>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div
          style={{
            background: '#fef2f2',
            color: '#dc2626',
            border: '1px solid #fecaca',
            padding: '1rem',
            borderRadius: '8px',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Clients Table */}
      <div className="cm-table-card">
        <div className="cm-table-responsive">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Client Name & Email</th>
                <th>Dedicated WhatsApp Session</th>
                <th>Status</th>
                <th>Expiry & Days Left</th>
                <th>Created Date</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                    {isLoading ? 'Loading client accounts...' : 'No clients created yet. Click "+ Add New Client" to create your first client!'}
                  </td>
                </tr>
              ) : (
                clients.map(client => {
                  const isExp = client.isExpired || (client.daysRemaining <= 0 && client.expiresAt);
                  const isSoon = !isExp && client.daysRemaining <= 7 && client.expiresAt;

                  return (
                    <tr key={client.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{client.name}</div>
                        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{client.email}</div>
                      </td>
                      <td>
                        <span className="cm-session-code">
                          <Smartphone size={13} style={{ display: 'inline', verticalAlign: 'middle', marginRight: '4px' }} />
                          {client.sessionId || 'Default'}
                        </span>
                      </td>
                      <td>
                        <button
                          onClick={() => handleToggleStatus(client)}
                          className={`cm-badge ${client.status === 'active' ? 'cm-badge-active' : 'cm-badge-disabled'}`}
                          style={{ cursor: 'pointer', border: 'none' }}
                          title="Click to toggle Active/Disabled"
                        >
                          {client.status === 'active' ? '● Active' : '○ Disabled'}
                        </button>
                      </td>
                      <td>
                        {client.expiresAt ? (
                          <div>
                            <span
                              className={`cm-badge ${
                                isExp ? 'cm-badge-expired' : isSoon ? 'cm-badge-expiring' : 'cm-badge-active'
                              }`}
                            >
                              <Clock size={12} />
                              {isExp ? 'Expired' : `${client.daysRemaining} days left`}
                            </span>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                              Until {new Date(client.expiresAt).toLocaleDateString()}
                            </div>
                          </div>
                        ) : (
                          <span className="cm-badge cm-badge-active">Lifetime / Unset</span>
                        )}
                      </td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                        {new Date(client.createdAt).toLocaleDateString()}
                      </td>
                      <td>
                        <div className="cm-actions-group">
                          <button
                            className="cm-btn cm-btn-sm cm-btn-outline"
                            onClick={() => handleExtendDays(client, 30)}
                            title="Extend License by +30 Days"
                            style={{ color: '#059669', borderColor: '#a7f3d0' }}
                          >
                            <PlusCircle size={14} /> +30 Days
                          </button>
                          <button
                            className="cm-btn cm-btn-sm cm-btn-outline"
                            onClick={() => {
                              setResetTarget(client);
                              setResetNewPass('');
                            }}
                            title="Reset Password"
                          >
                            <Key size={14} /> Pass
                          </button>
                          <button
                            className="cm-btn cm-btn-sm cm-btn-danger-outline"
                            onClick={() => handleDeleteClient(client)}
                            title="Delete Client"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Client Modal */}
      {showAddModal && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal">
            <div className="cm-modal-header">
              <h3>Create New Client Account</h3>
              <button
                onClick={() => setShowAddModal(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreateClient}>
              <div className="cm-modal-body">
                <div className="cm-form-group">
                  <label>Client Full Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ali Traders"
                    value={newClientName}
                    onChange={e => setNewClientName(e.target.value)}
                  />
                </div>

                <div className="cm-form-group">
                  <label>Client Email (Login Username)</label>
                  <input
                    type="email"
                    required
                    placeholder="e.g. ali@traders.com"
                    value={newClientEmail}
                    onChange={e => setNewClientEmail(e.target.value)}
                  />
                </div>

                <div className="cm-form-group">
                  <label>Password</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. ClientPass123!"
                    value={newClientPassword}
                    onChange={e => setNewClientPassword(e.target.value)}
                  />
                </div>

                <div className="cm-form-group">
                  <label>Trial / License Duration</label>
                  <select value={validityDays} onChange={e => setValidityDays(Number(e.target.value))}>
                    <option value={30}>30 Days (1 Month Trial - Recommended)</option>
                    <option value={60}>60 Days (2 Months)</option>
                    <option value={90}>90 Days (3 Months)</option>
                    <option value={180}>180 Days (6 Months)</option>
                    <option value={365}>365 Days (1 Year)</option>
                  </select>
                </div>

                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '1rem 0 0 0' }}>
                  ℹ️ This will automatically provision a dedicated WhatsApp session and generate secure credentials for this client.
                </p>
              </div>

              <div className="cm-modal-footer">
                <button
                  type="button"
                  className="cm-btn cm-btn-outline"
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="cm-btn cm-btn-primary"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Creating...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Copy Client Credentials Modal */}
      {createdInfo && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal">
            <div className="cm-modal-header" style={{ background: '#ecfdf5', color: '#065f46' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <CheckCircle size={20} color="#059669" /> Client Account Ready!
              </h3>
              <button
                onClick={() => setCreatedInfo(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <div className="cm-modal-body">
              <p style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                You can now copy and send these login details to <strong>{createdInfo.name}</strong> via WhatsApp:
              </p>

              <div
                style={{
                  background: 'var(--bg-light)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '1rem',
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                  lineHeight: '1.6',
                }}
              >
                <div><strong>Portal:</strong> {window.location.origin}</div>
                <div><strong>Email:</strong> {createdInfo.email}</div>
                <div><strong>Password:</strong> {createdInfo.password}</div>
                <div><strong>WhatsApp Session:</strong> {createdInfo.sessionId}</div>
                <div><strong>Valid Until:</strong> {createdInfo.expiresAt ? createdInfo.expiresAt.slice(0, 10) : '30 Days'}</div>
              </div>

              <div style={{ marginTop: '1.25rem', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                <button
                  className="cm-btn cm-btn-primary"
                  onClick={copyCredentials}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  {copied ? (
                    <>
                      <Check size={16} /> Copied!
                    </>
                  ) : (
                    <>
                      <Copy size={16} /> Copy Credentials for Client
                    </>
                  )}
                </button>
                <button className="cm-btn cm-btn-outline" onClick={() => setCreatedInfo(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="cm-modal-backdrop">
          <div className="cm-modal">
            <div className="cm-modal-header">
              <h3>Reset Password for {resetTarget.name}</h3>
              <button
                onClick={() => setResetTarget(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer' }}
              >
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleResetPassword}>
              <div className="cm-modal-body">
                <div className="cm-form-group">
                  <label>New Password</label>
                  <input
                    type="text"
                    required
                    placeholder="Enter new password (min 6 chars)"
                    value={resetNewPass}
                    onChange={e => setResetNewPass(e.target.value)}
                  />
                </div>
              </div>
              <div className="cm-modal-footer">
                <button
                  type="button"
                  className="cm-btn cm-btn-outline"
                  onClick={() => setResetTarget(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="cm-btn cm-btn-primary">
                  Save Password
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
