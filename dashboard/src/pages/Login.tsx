import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Languages, Mail, Lock, KeyRound, AlertCircle, LogIn } from 'lucide-react';
import { CustomSelect } from '../components/CustomSelect';
import { languageOptions, resolveSupportedLanguage, type SupportedLanguage } from '../i18n';
import { API_BASE_URL, clientApi } from '../services/api';
import './Login.css';

interface LoginProps {
  onLogin: (apiKey: string, role?: string, engineType?: string, scoped?: boolean) => void;
}

export function Login({ onLogin }: LoginProps) {
  const { t, i18n } = useTranslation();
  const [authMode, setAuthMode] = useState<'credentials' | 'apikey'>('credentials');
  
  // Credentials mode
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  // API key mode
  const [apiKey, setApiKey] = useState('');
  
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

  const changeLanguage = (language: SupportedLanguage) => {
    void i18n.changeLanguage(language);
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const res = await clientApi.login(email.trim(), password);
      if (res && res.token) {
        sessionStorage.setItem('openwa_user', JSON.stringify(res.user));
        if (res.user.sessionId) {
          sessionStorage.setItem('openwa_client_session', res.user.sessionId);
        }
        onLogin(
          res.token,
          res.user.role,
          'baileys',
          res.user.role !== 'admin'
        );
      } else {
        setError('Login failed: invalid response from server');
      }
    } catch (err: any) {
      const msg = err?.message || 'Invalid email or password. Please try again.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const handleApiKeySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const key = apiKey.trim();
    if (!key) {
      setError('API key is required');
      return;
    }
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
      });

      if (response.ok) {
        const data: { role?: string; engineType?: string; scoped?: unknown } = await response.json().catch(() => ({}));
        onLogin(
          key,
          data.role,
          typeof data.engineType === 'string' ? data.engineType : undefined,
          data.scoped === true,
        );
      } else {
        const errorData: { message?: unknown } = await response.json().catch(() => ({}));
        const reason = response.status < 500 && typeof errorData.message === 'string' ? errorData.message : '';
        setError(reason || (response.status === 401 ? 'Invalid API key' : 'Connection error'));
      }
    } catch {
      setError('Connection error. Is the server running?');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card">
        {/* Brand Header */}
        <div className="login-logo" style={{ marginBottom: '1.25rem' }}>
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              color: '#ffffff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '1.75rem',
              fontWeight: 800,
              boxShadow: '0 8px 16px -4px rgba(16, 185, 129, 0.4)',
              marginBottom: '0.75rem',
            }}
          >
            ZA
          </div>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 700, margin: '0 0 2px 0', color: 'var(--text-primary)' }}>
            Zubair Ahmed
          </h2>
          <span style={{ fontSize: '0.875rem', color: '#10b981', fontWeight: 600 }}>
            Lecturer & WhatsApp Suite
          </span>
        </div>

        {/* Language selector */}
        <div className="login-language" style={{ marginBottom: '1.25rem' }}>
          <Languages size={18} />
          <CustomSelect
            value={currentLang}
            onChange={value => changeLanguage(value as SupportedLanguage)}
            options={languageOptions.map(opt => ({ value: opt.value, label: opt.label }))}
            ariaLabel={t('common.language')}
          />
        </div>

        {/* Error Notification */}
        {error && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#dc2626',
              padding: '0.75rem',
              borderRadius: '8px',
              marginBottom: '1rem',
              fontSize: '0.875rem',
              textAlign: 'left',
            }}
          >
            <AlertCircle size={18} style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {/* Form */}
        {authMode === 'credentials' ? (
          <form onSubmit={handleCredentialsSubmit} className="login-form">
            <div className="input-group" style={{ marginBottom: '1rem' }}>
              <label htmlFor="email" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                <Mail size={15} /> Email / Username
              </label>
              <div className="input-wrapper">
                <input
                  id="email"
                  type="text"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div className="input-group" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="password" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                <Lock size={15} /> Password
              </label>
              <div className="input-wrapper">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              className="connect-btn"
              disabled={isLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                width: '100%',
                padding: '0.85rem',
                fontSize: '1rem',
                fontWeight: 600,
                borderRadius: '8px',
                background: '#10b981',
                color: '#ffffff',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {isLoading ? (
                'Signing in...'
              ) : (
                <>
                  <LogIn size={18} /> Sign In
                </>
              )}
            </button>
          </form>
        ) : (
          <form onSubmit={handleApiKeySubmit} className="login-form">
            <div className="input-group" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="apiKey" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.875rem', fontWeight: 600, marginBottom: '6px' }}>
                <KeyRound size={15} /> {t('login.apiKey')}
              </label>
              <div className="input-wrapper">
                <input
                  id="apiKey"
                  type={showPassword ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={t('login.apiKeyPlaceholder')}
                />
                <button
                  type="button"
                  className="toggle-visibility"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button type="submit" className="connect-btn" disabled={isLoading} style={{ width: '100%' }}>
              {isLoading ? t('login.connecting') : t('login.connect')}
            </button>
          </form>
        )}

        {/* Mode Switcher */}
        <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
          {authMode === 'credentials' ? (
            <button
              type="button"
              onClick={() => { setAuthMode('apikey'); setError(''); }}
              style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline' }}
            >
              Developer? Sign in with API Key
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setAuthMode('credentials'); setError(''); }}
              style={{ background: 'none', border: 'none', color: '#10b981', fontSize: '0.85rem', cursor: 'pointer', fontWeight: 600 }}
            >
              ← Back to Email Sign In
            </button>
          )}
        </div>

        <p className="login-help" style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          Need an account or renewal? Contact{' '}
          <strong style={{ color: 'var(--text-primary)' }}>Zubair Ahmed</strong>
        </p>
      </div>

      <footer className="login-footer" style={{ marginTop: '1.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        <span>Zubair Ahmed WhatsApp Suite • Multi-Tenant Client Portal</span>
      </footer>
    </div>
  );
}
