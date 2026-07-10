import { useEffect, useMemo, useRef, useState } from 'react';

const storageKeys = {
  chats: 'suna-control-room-chats-v2',
  activeChatId: 'suna-control-room-active-chat-id-v2',
  reports: 'suna-control-room-reports',
  subscription: 'suna-control-room-subscription',
  failureCounts: 'suna-control-room-failure-counts-v2',
};

const chatTypes = {
  general: { id: 'general', label: 'General', placeholder: 'Ask Suna anything...', accent: 'neutral' },
  task: { id: 'task', label: 'Task', placeholder: 'Ask Suna to do something...', accent: 'amber' },
  research: { id: 'research', label: 'Research', placeholder: 'What should Suna look into?', accent: 'blue' },
  build: { id: 'build', label: 'Build', placeholder: 'What should Suna build?', accent: 'green' },
};

const subscriptionPlans = [
  { id: 'free', name: 'Free' },
  { id: 'plus', name: 'Plus' },
  { id: 'pro', name: 'Pro' },
  { id: 'team', name: 'Team' },
  { id: 'enterprise', name: 'Enterprise' },
];

const apiStatusLabels = {
  checking: 'checking',
  online: 'online',
  local: 'local',
  offline: 'offline',
  'needs-key': 'needs key',
};

const reportTypes = {
  hallucination: {
    title: 'Report hallucination',
    description: 'Capture a bad answer or invented detail.',
  },
  bug: {
    title: 'Report bug',
    description: 'Capture a product or workflow issue.',
  },
};

const emptyReport = {
  title: '',
  details: '',
  context: '',
  severity: 'medium',
};

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readStorage(key, fallback) {
  const value = window.localStorage.getItem(key);
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    window.localStorage.removeItem(key);
    return fallback;
  }
}

function makeMessage(role, title, text) {
  return {
    id: createId(),
    role,
    title,
    text,
  };
}

function makeAssistantMessage(text) {
  return makeMessage('assistant', 'Suna', text);
}

function makeArtifactMessage(text, artifact) {
  return {
    ...makeAssistantMessage(text),
    artifact,
  };
}

function makeSystemMessage(title, text) {
  return makeMessage('system', title, text);
}

function makeUserMessage(text) {
  return makeMessage('user', 'You', text);
}

function createChat(type = 'general', title = 'New chat') {
  return {
    id: createId(),
    type,
    title,
    createdAt: new Date().toISOString(),
    messages: [makeAssistantMessage('What are we working on?')],
  };
}

function getInitialChats() {
  const savedChats = typeof window !== 'undefined' ? readStorage(storageKeys.chats, null) : null;
  if (Array.isArray(savedChats) && savedChats.length > 0) {
    return savedChats;
  }

  return [createChat()];
}

function getInitialActiveChatId(chats) {
  if (typeof window === 'undefined') {
    return chats[0]?.id ?? null;
  }

  const savedChatId = window.localStorage.getItem(storageKeys.activeChatId);
  return chats.some((chat) => chat.id === savedChatId) ? savedChatId : chats[0]?.id ?? null;
}

function getInitialSubscription() {
  if (typeof window === 'undefined') {
    return 'plus';
  }

  const savedSubscription = window.localStorage.getItem(storageKeys.subscription);
  return subscriptionPlans.some((plan) => plan.id === savedSubscription) ? savedSubscription : 'plus';
}

function getInitialReports() {
  return typeof window !== 'undefined' ? readStorage(storageKeys.reports, []) : [];
}

function getInitialFailureCounts() {
  return typeof window !== 'undefined' ? readStorage(storageKeys.failureCounts, {}) : {};
}

function buildReply(type) {
  if (type === 'research') {
    return 'I can research that and bring back a clean summary.';
  }

  if (type === 'build') {
    return 'I can help build that.';
  }

  if (type === 'task') {
    return 'Got it. I can work on that.';
  }

  return 'Got it.';
}

function buildSystemSummaryFromTaskResponse(responseData) {
  if (responseData?.status === 'escalated') {
    return responseData.review ?? 'Hermes took over.';
  }

  if (responseData?.status === 'self-flagged') {
    return 'Suna marked this result for review.';
  }

  return '';
}

function App() {
  const initialChats = useMemo(() => getInitialChats(), []);
  const [chats, setChats] = useState(() => initialChats);
  const [activeChatId, setActiveChatId] = useState(() => getInitialActiveChatId(initialChats));
  const [composerText, setComposerText] = useState('');
  const [reports, setReports] = useState(getInitialReports);
  const [failureCounts, setFailureCounts] = useState(getInitialFailureCounts);
  const [subscription, setSubscription] = useState(getInitialSubscription);
  const [modalType, setModalType] = useState(null);
  const [reportForm, setReportForm] = useState(emptyReport);
  const [apiStatus, setApiStatus] = useState('checking');
  const [isSending, setIsSending] = useState(false);
  const [authState, setAuthState] = useState({ authenticated: false, authRequired: false, user: null, plans: [] });
  const [adminUsers, setAdminUsers] = useState([]);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginStatus, setLoginStatus] = useState('');
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const messagesEndRef = useRef(null);

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId) ?? chats[0], [activeChatId, chats]);
  const activeType = chatTypes[activeChat?.type] ?? chatTypes.general;
  const currentPlan = subscriptionPlans.find((plan) => plan.id === subscription) ?? subscriptionPlans[1];
  const serverUser = authState.user;
  const effectivePlan = serverUser?.planName ?? currentPlan.name;
  const activeFailureCount = activeChat ? Number(failureCounts[activeChat.id] ?? 0) : 0;

  async function refreshAuth() {
    try {
      const response = await fetch('/api/auth/me');
      if (!response.ok) {
        throw new Error('Auth unavailable');
      }
      const data = await response.json();
      setAuthState(data);
      if (data.user?.plan) {
        setSubscription(data.user.plan === 'admin' ? 'enterprise' : data.user.plan);
      }
    } catch {
      setAuthState((current) => ({ ...current, authenticated: false, user: null }));
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function checkApi() {
      try {
        const response = await fetch('/api/health');
        if (!response.ok) {
          throw new Error('API unavailable');
        }

        const data = await response.json();
        if (!cancelled) {
          setApiStatus(data.needsApiKey ? 'needs-key' : data.sunaLinked || data.hermesLinked ? 'online' : 'local');
        }
      } catch {
        if (!cancelled) {
          setApiStatus('offline');
        }
      }
    }

    checkApi();
    const intervalId = window.setInterval(checkApi, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    void refreshAuth();
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.chats, JSON.stringify(chats));
  }, [chats]);

  useEffect(() => {
    if (activeChatId) {
      window.localStorage.setItem(storageKeys.activeChatId, activeChatId);
    }
  }, [activeChatId]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.reports, JSON.stringify(reports));
  }, [reports]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.failureCounts, JSON.stringify(failureCounts));
  }, [failureCounts]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.subscription, subscription);
  }, [subscription]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeChat?.messages.length, isSending]);

  function createNewChat(type = 'general') {
    const nextChat = createChat(type);
    setChats((current) => [nextChat, ...current]);
    setActiveChatId(nextChat.id);
    setComposerText('');
  }

  async function submitMessage(event) {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || !activeChat || isSending) {
      return;
    }

    const userMessage = makeUserMessage(text);
    const targetChatId = activeChat.id;
    const shouldRetitle = activeChat.messages.length <= 1 && activeChat.title === 'New chat';
    const nextTitle = shouldRetitle ? text.slice(0, 42) : activeChat.title;
    const outgoingMessages = [...activeChat.messages, userMessage].map((message) => ({
      role: message.role,
      content: message.text,
    }));
    const failureCount = Number(failureCounts[targetChatId] ?? 0);

    setIsSending(true);
    setComposerText('');
    setChats((current) =>
      current.map((chat) =>
        chat.id === targetChatId
          ? {
              ...chat,
              title: nextTitle,
              messages: [...chat.messages, userMessage],
            }
          : chat,
      ),
    );

    try {
      const response = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: targetChatId,
          chatType: activeChat.type,
          planName: effectivePlan,
          subscription: serverUser?.plan ?? subscription,
          failureCount,
          messages: outgoingMessages,
        }),
      });

      if (!response.ok) {
        throw new Error(`Task request failed with ${response.status}`);
      }

      const data = await response.json();
      if (data.usage) {
        setAuthState((current) => ({ ...current, user: { ...current.user, ...data.usage } }));
      }
      const assistantText = data.reply || buildReply(activeChat.type);
      const summaryText = buildSystemSummaryFromTaskResponse(data);

      setFailureCounts((current) => {
        const nextCount = data.resetFailureCount
          ? 0
          : Number(current[targetChatId] ?? 0) + Number(data.failureDelta ?? 0);
        return { ...current, [targetChatId]: nextCount };
      });

      setChats((current) =>
        current.map((chat) =>
          chat.id === targetChatId
            ? {
                ...chat,
                messages: [
                  ...chat.messages,
                  ...(summaryText ? [makeSystemMessage(data.worker === 'hermes' ? 'Hermes' : 'Status', summaryText)] : []),
                  data.artifact ? makeArtifactMessage(assistantText, data.artifact) : makeAssistantMessage(assistantText),
                ],
              }
            : chat,
        ),
      );
    } catch {
      setChats((current) =>
        current.map((chat) =>
          chat.id === targetChatId
            ? {
                ...chat,
                messages: [...chat.messages, makeAssistantMessage(buildReply(activeChat.type))],
              }
            : chat,
        ),
      );
      setApiStatus('offline');
    } finally {
      setIsSending(false);
    }
  }

  async function startCheckout(plan) {
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Checkout failed');
      }
      window.location.href = data.url;
    } catch (error) {
      setChats((current) =>
        current.map((chat) =>
          chat.id === activeChat?.id
            ? {
                ...chat,
                messages: [...chat.messages, makeSystemMessage('Billing', error instanceof Error ? error.message : 'Checkout failed.')],
              }
            : chat,
        ),
      );
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    await refreshAuth();
  }

  async function startEmailLogin(event) {
    event.preventDefault();
    setLoginStatus('Sending code...');
    try {
      const response = await fetch('/api/auth/email/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Email login failed');
      }
      setEmailCodeSent(true);
      setLoginStatus(data.devCode ? `Dev code: ${data.devCode}` : data.message);
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : 'Email login failed');
    }
  }

  async function verifyEmailLogin(event) {
    event.preventDefault();
    setLoginStatus('Verifying...');
    try {
      const response = await fetch('/api/auth/email/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, code: loginCode }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Invalid code');
      }
      setLoginStatus('');
      setEmailCodeSent(false);
      setLoginCode('');
      await refreshAuth();
    } catch (error) {
      setLoginStatus(error instanceof Error ? error.message : 'Email verification failed');
    }
  }

  async function loadAdminUsers() {
    try {
      const response = await fetch('/api/admin/users');
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Admin request failed');
      }
      setAdminUsers(data.users ?? []);
      setModalType('admin');
    } catch (error) {
      setChats((current) =>
        current.map((chat) =>
          chat.id === activeChat?.id
            ? {
                ...chat,
                messages: [...chat.messages, makeSystemMessage('Admin', error instanceof Error ? error.message : 'Admin request failed.')],
              }
            : chat,
        ),
      );
    }
  }

  async function updateAdminUser(email, updates) {
    const response = await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...updates }),
    });
    const data = await response.json();
    if (response.ok) {
      setAdminUsers((current) => current.map((user) => (user.email === email ? data.user : user)));
    }
  }

  async function requestHermesEscalation(targetChatId, reason, failureCount) {
    const targetChat = chats.find((chat) => chat.id === targetChatId);
    if (!targetChat) {
      return;
    }

    const outgoingMessages = targetChat.messages.map((message) => ({
      role: message.role,
      content: message.text,
    }));

    try {
      const response = await fetch('/api/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chatId: targetChatId,
          chatType: targetChat.type,
          planName: effectivePlan,
          subscription: serverUser?.plan ?? subscription,
          failureCount,
          forceHermes: true,
          escalationReason: reason,
          messages: outgoingMessages,
        }),
      });

      if (!response.ok) {
        throw new Error(`Hermes request failed with ${response.status}`);
      }

      const data = await response.json();
      setFailureCounts((current) => ({ ...current, [targetChatId]: 0 }));
      setChats((current) =>
        current.map((chat) =>
          chat.id === targetChatId
            ? {
                ...chat,
                messages: [...chat.messages, makeSystemMessage('Hermes', data.review ?? 'Hermes took over.')],
              }
            : chat,
        ),
      );
    } catch {
      setChats((current) =>
        current.map((chat) =>
          chat.id === targetChatId
            ? {
                ...chat,
                messages: [...chat.messages, makeSystemMessage('Hermes', 'Queued for review.')],
              }
            : chat,
        ),
      );
    }
  }

  function submitReport(event) {
    event.preventDefault();
    if (!modalType) {
      return;
    }

    const report = {
      id: createId(),
      type: modalType,
      ...reportForm,
      createdAt: new Date().toISOString(),
      chatId: activeChat?.id ?? null,
      chatTitle: activeChat?.title ?? 'Unknown chat',
    };
    const shouldCountAsSunaFailure = modalType === 'hallucination';
    const nextFailureCount = shouldCountAsSunaFailure ? activeFailureCount + 1 : activeFailureCount;

    setReports((current) => [report, ...current]);
    void fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    }).catch(() => undefined);

    if (shouldCountAsSunaFailure && activeChat?.id) {
      setFailureCounts((current) => ({ ...current, [activeChat.id]: nextFailureCount }));
    }

    setChats((current) =>
      current.map((chat) =>
        chat.id === activeChat?.id
          ? {
              ...chat,
              messages: [...chat.messages, makeSystemMessage('Saved', shouldCountAsSunaFailure ? `Review count ${nextFailureCount}/3.` : 'Report saved.')],
            }
          : chat,
      ),
    );

    if (shouldCountAsSunaFailure && activeChat?.id && nextFailureCount >= 3) {
      void requestHermesEscalation(activeChat.id, 'User reported hallucination three times.', nextFailureCount);
    }

    setModalType(null);
    setReportForm(emptyReport);
  }

  if (authState.authRequired && !authState.authenticated) {
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-brand">
            <div className="brand-mark">S</div>
            <span>Suna</span>
          </div>

          <div className="login-copy">
            <h1 id="login-title">Sign in to Suna</h1>
            <p>Use your workspace account to continue.</p>
          </div>

          <form className="login-form" onSubmit={emailCodeSent ? verifyEmailLogin : startEmailLogin}>
            <label>
              <span>Email</span>
              <input
                type="email"
                value={loginEmail}
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                required
              />
            </label>

            {emailCodeSent ? (
              <label>
                <span>Code</span>
                <input
                  value={loginCode}
                  onChange={(event) => setLoginCode(event.target.value)}
                  placeholder="6-digit code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                />
              </label>
            ) : null}

            <button className="send-button full-width" type="submit">
              {emailCodeSent ? 'Verify code' : 'Continue with email'}
            </button>
          </form>

          <div className="login-divider"><span>or</span></div>

          <div className="login-providers">
            <a className={`provider-button ${authState.providers?.google ? '' : 'disabled'}`} href="/api/auth/google/start" aria-disabled={!authState.providers?.google}>
              <span>G</span>
              Continue with Google
            </a>
            <a className={`provider-button ${authState.providers?.microsoft ? '' : 'disabled'}`} href="/api/auth/microsoft/start" aria-disabled={!authState.providers?.microsoft}>
              <span>□</span>
              Continue with Microsoft
            </a>
          </div>

          {loginStatus ? <p className="login-status">{loginStatus}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">S</div>
          <h1>Suna</h1>
        </div>

        <button className="new-chat-button" type="button" onClick={() => createNewChat('general')}>
          New chat
        </button>

        <div className="mode-tabs">
          {Object.values(chatTypes).map((type) => (
              <button
                key={type.id}
                type="button"
              className={`mode-tab ${type.accent} ${activeChat?.type === type.id ? 'active' : ''}`}
              onClick={() => createNewChat(type.id)}
            >
              {type.label}
            </button>
          ))}
        </div>

        <div className="chat-list">
          {chats.map((chat) => {
            const config = chatTypes[chat.type] ?? chatTypes.general;
            return (
              <button
                key={chat.id}
                type="button"
                className={`chat-item ${config.accent} ${chat.id === activeChatId ? 'active' : ''}`}
                onClick={() => setActiveChatId(chat.id)}
              >
                <span className={`chat-dot ${config.accent}`} />
                <span>{chat.title}</span>
              </button>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <div className="account-card">
            <div>
              <strong>{serverUser?.name ?? 'Guest'}</strong>
              <span>{serverUser?.email ?? 'Not signed in'}</span>
            </div>
            <div className="plan-line">
              <span>{effectivePlan}</span>
              <span>{serverUser?.tokensRemainingToday === null ? 'Unlimited' : `${serverUser?.tokensRemainingToday ?? 0} tokens left`}</span>
            </div>
          </div>

          {authState.authenticated ? (
            <button className="ghost-button full-width" type="button" onClick={logout}>
              Log out
            </button>
          ) : (
            <a className="ghost-button full-width" href="/api/auth/microsoft/start">
              Microsoft login
            </a>
          )}

          <div className="billing-grid">
            {(authState.plans.length ? authState.plans : subscriptionPlans).filter((plan) => plan.id !== 'free').map((plan) => (
              <button
                key={plan.id}
                className="ghost-button"
                type="button"
                onClick={() => startCheckout(plan.id)}
                disabled={!authState.authenticated || plan.available === false}
              >
                {plan.name}
              </button>
            ))}
          </div>

          {serverUser?.role === 'admin' ? (
            <button className="send-button full-width" type="button" onClick={loadAdminUsers}>
              Admin
            </button>
          ) : null}
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h2>{activeChat?.title ?? 'New chat'}</h2>
            <span className={`type-chip ${activeType.accent}`}>{activeType.label}</span>
          </div>

          <div className="topbar-actions">
            <span className={`status-pill ${apiStatus}`}>{apiStatusLabels[apiStatus] ?? apiStatus}</span>
            <span className="status-pill local">{effectivePlan}</span>
            <span className="status-pill local">{activeFailureCount}/3</span>
            <button className="ghost-button" type="button" onClick={() => setModalType('hallucination')}>
              Report
            </button>
            <button className="ghost-button" type="button" onClick={() => setModalType('bug')}>
              Bug
            </button>
          </div>
        </header>

        <section className={`chat-panel ${activeType.accent}`}>
          <div className="messages">
            {activeChat?.messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-badge">{message.title}</div>
                <p>{message.text}</p>
                {message.artifact ? (
                  <a className="artifact-link" href={`/api/artifacts/${encodeURIComponent(message.artifact.fileName)}`} target="_blank" rel="noreferrer">
                    Open {message.artifact.fileName}
                  </a>
                ) : null}
              </article>
            ))}
            {isSending ? (
              <article className="message assistant typing-message">
                <div className="message-badge">Suna</div>
                <div className="typing-bubble" aria-label="Suna is typing">
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            ) : null}
            <div ref={messagesEndRef} />
          </div>

          <form className="composer" onSubmit={submitMessage}>
            <label className="sr-only" htmlFor="task-input">
              Message Suna
            </label>
            <textarea
              id="task-input"
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              placeholder={activeType.placeholder}
              rows={1}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button className="send-button" type="submit" disabled={isSending || !composerText.trim()}>
              {isSending ? '...' : 'Send'}
            </button>
          </form>
        </section>
      </main>

      {modalType && modalType !== 'admin' ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setModalType(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="report-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <h3 id="report-title">{reportTypes[modalType].title}</h3>
                <p>{reportTypes[modalType].description}</p>
              </div>
              <button className="close-button" type="button" onClick={() => setModalType(null)} aria-label="Close report dialog">
                x
              </button>
            </div>

            <form className="report-form" onSubmit={submitReport}>
              <label>
                <span>Title</span>
                <input
                  value={reportForm.title}
                  onChange={(event) => setReportForm((current) => ({ ...current, title: event.target.value }))}
                  placeholder="Short summary"
                />
              </label>

              <label>
                <span>Details</span>
                <textarea
                  value={reportForm.details}
                  onChange={(event) => setReportForm((current) => ({ ...current, details: event.target.value }))}
                  rows={4}
                  placeholder="What happened?"
                />
              </label>

              <label>
                <span>Context</span>
                <input
                  value={reportForm.context}
                  onChange={(event) => setReportForm((current) => ({ ...current, context: event.target.value }))}
                  placeholder="Optional"
                />
              </label>

              <label>
                <span>Severity</span>
                <select
                  value={reportForm.severity}
                  onChange={(event) => setReportForm((current) => ({ ...current, severity: event.target.value }))}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>

              <div className="modal-actions">
                <button className="ghost-button" type="button" onClick={() => setModalType(null)}>
                  Cancel
                </button>
                <button className="send-button" type="submit">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {modalType === 'admin' ? (
        <div className="modal-backdrop" role="presentation" onClick={() => setModalType(null)}>
          <div className="modal admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <h3 id="admin-title">Admin panel</h3>
                <p>Manage user roles and plan grants.</p>
              </div>
              <button className="close-button" type="button" onClick={() => setModalType(null)} aria-label="Close admin panel">
                x
              </button>
            </div>

            <div className="admin-table">
              {adminUsers.map((user) => (
                <div className="admin-row" key={user.id}>
                  <div>
                    <strong>{user.name}</strong>
                    <span>{user.email}</span>
                  </div>
                  <span>{user.role}</span>
                  <span>{user.planName}</span>
                  <button className="ghost-button" type="button" onClick={() => updateAdminUser(user.email, { role: user.role === 'admin' ? 'user' : 'admin' })}>
                    {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => updateAdminUser(user.email, { plan: 'enterprise' })}>
                    Grant enterprise
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
