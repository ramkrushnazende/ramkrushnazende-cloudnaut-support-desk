import { useState, useEffect } from 'react'
import LoginForm from './components/LoginForm'
import CognitoLoginForm from './components/CognitoLoginForm'
import ProfilePanel from './components/ProfilePanel'
import { isCognitoMode } from './cognito/config'
import { getAccessToken, signOut as cognitoSignOut } from './cognito/cognitoAuth'
import { resolveIdentity } from './cognito/session'
import ForgotPasswordForm from './components/ForgotPasswordForm'
import PasswordResetForm from './components/PasswordResetForm'
import RoleSelection from './components/RoleSelection'
import SignupForm from './components/SignupForm'
import AccessRequestReview from './components/AccessRequestReview'
import TeamManagement from './components/TeamManagement'
import CreateTicketForm from './components/CreateTicketForm'
import TicketSuccess from './components/TicketSuccess'
import TicketList from './components/TicketList'
import TicketDetail from './components/TicketDetail'
import Dashboard from './components/Dashboard'
import ProgressUpdates from './components/ProgressUpdates'
import RequestTracker from './components/RequestTracker'
import './App.css'

function App() {
  const resetToken = new URLSearchParams(window.location.search).get('reset_token')
  const cognitoMode = isCognitoMode()
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('supportDeskTheme')
    if (saved === 'light' || saved === 'dark') return saved
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  })
  const [session, setSession] = useState(() => {
    // Legacy mode restores synchronously from localStorage. Cognito mode
    // restores asynchronously from the SDK session (see the effect below), so
    // it starts null to avoid trusting a stale localStorage value.
    if (cognitoMode) return null
    const token = localStorage.getItem('supportDeskToken')
    const user = localStorage.getItem('supportDeskUser')
    return token && user ? { token, user: JSON.parse(user) } : null
  })

  // Cognito session restoration: if the SDK still holds a valid session on
  // load, resolve the DB-authoritative identity and restore the session.
  useEffect(() => {
    if (!cognitoMode) return
    let active = true
    ;(async () => {
      const token = await getAccessToken()
      if (!token || !active) return
      try {
        const user = await resolveIdentity()
        if (active) setSession({ token, user })
      } catch {
        // Invalid/expired session or no linked profile: stay logged out.
        if (active) setSession(null)
      }
    })()
    return () => { active = false }
  }, [cognitoMode])
  const [showLogin, setShowLogin] = useState(false)
  const [showSignup, setShowSignup] = useState(false)
  const [showForgotPassword, setShowForgotPassword] = useState(false)
  const [selectedRole, setSelectedRole] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [showList, setShowList] = useState(false)
  const [showDashboard, setShowDashboard] = useState(false)
  const [showTeam, setShowTeam] = useState(false)
  const [showAccessRequests, setShowAccessRequests] = useState(false)
  const [showRequestTracker, setShowRequestTracker] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [selectedTicketId, setSelectedTicketId] = useState(null)
  const [createdTicket, setCreatedTicket] = useState(null)
  const [failedTicketAttachments, setFailedTicketAttachments] = useState([])
  const [attachmentUploadErrors, setAttachmentUploadErrors] = useState([])

  const handleTicketSuccess = (ticket, failedFiles = [], uploadErrors = []) => {
    setCreatedTicket(ticket)
    setFailedTicketAttachments(failedFiles)
    setAttachmentUploadErrors(uploadErrors)
  }

  const handleCreateAnother = () => {
    setCreatedTicket(null)
    setFailedTicketAttachments([])
    setAttachmentUploadErrors([])
    setShowForm(false)
  }

  const goHome = () => {
    setCreatedTicket(null)
    setFailedTicketAttachments([])
    setAttachmentUploadErrors([])
    setShowForm(false)
    setShowList(false)
    setShowDashboard(false)
    setShowTeam(false)
    setShowAccessRequests(false)
    setShowRequestTracker(false)
    setShowProfile(false)
    setSelectedTicketId(null)
  }

  const handleLogin = (loginData) => {
    // Legacy mode persists the app token to localStorage. Cognito mode keeps
    // the token in the SDK session, so we only hold it in React state.
    if (!cognitoMode) {
      localStorage.setItem('supportDeskToken', loginData.access_token)
      localStorage.setItem('supportDeskUser', JSON.stringify(loginData.user))
    }
    setSession({ token: loginData.access_token, user: loginData.user })
    setShowLogin(false)
    setShowSignup(false)
    setShowForgotPassword(false)
  }

  const handleLogout = () => {
    if (cognitoMode) {
      cognitoSignOut()
    } else {
      localStorage.removeItem('supportDeskToken')
      localStorage.removeItem('supportDeskUser')
    }
    setSession(null)
    setShowLogin(false)
    setShowSignup(false)
    setShowForgotPassword(false)
    setSelectedRole(null)
    goHome()
  }

  useEffect(() => {
    localStorage.setItem('supportDeskTheme', theme)
    document.documentElement.dataset.theme = theme
  }, [theme])

  if (createdTicket) {
    return (
      <div className="app-shell" data-theme={theme}>
        <main className="app-container">
          <div className="topbar">
            <div className="topbar-brand">
              <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
              <span>
                <strong>Cloudnaut</strong>
                <small>Support Desk</small>
              </span>
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              <span aria-hidden="true">{theme === 'light' ? '◐' : '☼'}</span>
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </button>
          </div>
          <TicketSuccess
            ticket={createdTicket}
            user={session?.user}
            pendingFiles={failedTicketAttachments}
            attachmentErrors={attachmentUploadErrors}
            onCreateAnother={handleCreateAnother}
            onGoHome={goHome}
          />
        </main>
      </div>
    )
  }

  const showingWelcome = !showForm && !showList && !showDashboard && !showTeam && !showAccessRequests && !showRequestTracker && !showProfile && !selectedTicketId

  return (
    <div className="app-shell" data-theme={theme}>

      <div className="background-glow glow-one"></div>
      <div className="background-glow glow-two"></div>

      <main className="app-container">

        <header className="hero-section">

          <div className="topbar">
            <div className="topbar-brand">
              <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
              <span>
                <strong>Cloudnaut</strong>
                <small>Support Desk</small>
              </span>
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              <span aria-hidden="true">{theme === 'light' ? '◐' : '☼'}</span>
              {theme === 'light' ? 'Dark mode' : 'Light mode'}
            </button>
          </div>

          <div className="brand-badge">
            <span className="status-dot"></span>
            Enterprise support workspace
          </div>

          <h1>
            Cloudnaut <span>Support Desk</span>
          </h1>

          <p className="hero-subtitle">
            Create and manage technical support requests
            through one centralized platform.
          </p>

        </header>

        {resetToken ? (
          <PasswordResetForm
            token={resetToken}
            onComplete={() => {
              window.history.replaceState({}, '', window.location.pathname)
              setSelectedRole(null)
              setShowLogin(true)
              setShowSignup(false)
            }}
          />
        ) : !session ? (
          showForgotPassword ? (
            <ForgotPasswordForm onBack={() => setShowForgotPassword(false)} />
          ) : showSignup ? (
            <SignupForm
              initialRole={selectedRole}
              onBackToLogin={() => setShowSignup(false)}
              onForgotPassword={() => setShowForgotPassword(true)}
            />
          ) : showLogin ? (
            // Cognito is the single active login flow. Role selection is kept
            // purely as a UI preference; the authoritative role is always
            // resolved from the backend after authentication. When Cognito is
            // not configured (local dev without env), fall back to the legacy
            // role-based login so development still works.
            cognitoMode ? (
              selectedRole ? (
                <CognitoLoginForm
                  selectedRole={selectedRole}
                  onLogin={handleLogin}
                  onBackToRoles={() => setSelectedRole(null)}
                  onSignUp={() => setShowSignup(true)}
                />
              ) : (
                <RoleSelection
                  onSelectRole={setSelectedRole}
                  onBackHome={() => setShowLogin(false)}
                />
              )
            ) : selectedRole ? (
              <LoginForm
                role={selectedRole}
                onLogin={handleLogin}
                onBackToRoles={() => setSelectedRole(null)}
                onSignUp={() => setShowSignup(true)}
                onForgotPassword={() => setShowForgotPassword(true)}
              />
            ) : (
              <RoleSelection
                onSelectRole={setSelectedRole}
                onBackHome={() => setShowLogin(false)}
              />
            )
          ) : (
            <section className="welcome-card public-home-card">
              <div className="welcome-icon">🎫</div>
              <span className="section-label">SUPPORT PORTAL</span>
              <h2>Welcome to Cloudnaut Support Desk</h2>
              <p>Sign in with your work account to create support requests and follow their progress.</p>
              <button type="button" className="primary-button" onClick={() => { setSelectedRole(null); setShowSignup(false); setShowLogin(true) }}>
                <span>Sign in</span>
                <span className="button-arrow">→</span>
              </button>
            </section>
          )
        ) : (
          <div className="session-strip">
            <div className="session-identity">
              <span className="session-avatar" aria-hidden="true">
                {(session.user.name || session.user.email || '?').trim().charAt(0).toUpperCase()}
              </span>
              <span className="session-identity-text">
                <span className="session-name">{session.user.name || session.user.email}</span>
                <span className="session-meta">
                  {session.user.email}
                  {' · '}<strong>{session.user.role}</strong>
                  {session.user.is_active === false && (
                    <span className="session-inactive"> · inactive</span>
                  )}
                </span>
              </span>
            </div>
            <div className="session-strip-actions">
              {cognitoMode && (
                <button type="button" className="secondary-button"
                        onClick={() => { goHome(); setShowProfile(true) }}>
                  Profile
                </button>
              )}
              <button type="button" className="secondary-button" onClick={handleLogout}>Sign out</button>
            </div>
          </div>
        )}

        {session && cognitoMode && showProfile && (
          <ProfilePanel
            user={session.user}
            onClose={() => setShowProfile(false)}
            onPhoneVerified={(phone_number) =>
              setSession((current) => current && ({
                ...current,
                user: { ...current.user, phone_number },
              }))
            }
          />
        )}

        {session && showingWelcome && (
          <section className="welcome-card">

            <div className="welcome-icon">
              🎫
            </div>

            <span className="section-label">
              SUPPORT PORTAL
            </span>

            <h2>How can we help you?</h2>

            <p>
              Submit a technical support request and provide
              the details our team needs to investigate your issue.
            </p>

            <div className="welcome-actions">
              <button
                className="primary-button"
                onClick={() => setShowForm(true)}
              >
                <span>Create Support Ticket</span>
                <span className="button-arrow">→</span>
              </button>

              <button
                className="secondary-button"
                onClick={() => setShowList(true)}
              >
                <span>View All Tickets</span>
                <span className="button-arrow">→</span>
              </button>

              {(session.user.role === 'support' || session.user.role === 'admin') && (
                <button
                  className="secondary-button"
                  onClick={() => setShowDashboard(true)}
                >
                  <span>View Dashboard</span>
                  <span className="button-arrow">→</span>
                </button>
              )}

              {session.user.role === 'admin' && (
                <button
                  className="secondary-button"
                  onClick={() => setShowTeam(true)}
                >
                  <span>Manage Staff Access</span>
                  <span className="button-arrow">→</span>
                </button>
              )}

              {session.user.role === 'admin' && (
                <button
                  className="secondary-button"
                  onClick={() => setShowAccessRequests(true)}
                >
                  <span>Access Requests</span>
                  <span className="button-arrow">→</span>
                </button>
              )}
            </div>

            {session.user.role === 'employee' && (
              <div className="feature-grid">
                <RequestTracker
                  compact
                  onViewAll={() => setShowRequestTracker(true)}
                />
              </div>
            )}

          </section>
        )}

        {session && showForm && (
          <section className="ticket-form-card">

            <div className="form-header">

              <div>
                <span className="section-label">
                  NEW SUPPORT REQUEST
                </span>

                <h2>Create Ticket</h2>

                <p>
                  Enter the information below to submit your
                  support request.
                </p>
              </div>

              <button
                type="button"
                className="close-button"
                onClick={() => setShowForm(false)}
              >
                ×
              </button>

            </div>

            <div className="form-divider"></div>

            <CreateTicketForm
              onSuccess={handleTicketSuccess}
              user={session.user}
            />

          </section>
        )}

        {session && showList && !selectedTicketId && (
          <section className="ticket-form-card">

            <div className="form-header">

              <div>
                <span className="section-label">
                  ALL REQUESTS
                </span>

                <h2>{session.user.role === 'employee' ? 'My Requests' : 'Support Requests'}</h2>

                <p>
                  View, filter and sort all submitted tickets. Click a row for details.
                </p>
              </div>

              <button
                type="button"
                className="close-button"
                onClick={goHome}
              >
                ×
              </button>

            </div>

            <div className="form-divider"></div>

            <TicketList
              onSelectTicket={(ticket) => setSelectedTicketId(ticket.id)}
            />

          </section>
        )}

        {session && selectedTicketId && (
          <section className="ticket-form-card">

            <div className="form-header">
              <div>
                <span className="section-label">TICKET DETAIL</span>
              </div>
              <button
                type="button"
                className="close-button"
                onClick={goHome}
              >
                ×
              </button>
            </div>

            <div className="form-divider"></div>

            <TicketDetail
              ticketId={selectedTicketId}
              onBack={() => setSelectedTicketId(null)}
              user={session.user}
            />

          </section>
        )}

        {session && showDashboard && (session.user.role === 'support' || session.user.role === 'admin') && (
          <section className="ticket-form-card">

            <div className="form-header">

              <div>
                <span className="section-label">OVERVIEW</span>
                <h2>Dashboard</h2>
                <p>Summary of all support requests.</p>
              </div>

              <button
                type="button"
                className="close-button"
                onClick={goHome}
              >
                ×
              </button>

            </div>

            <div className="form-divider"></div>

            <Dashboard user={session.user} />

          </section>
        )}

        {session && showRequestTracker && session.user.role === 'employee' && !selectedTicketId && (
          <section className="ticket-form-card request-tracker-page">
            <div className="form-header">
              <div>
                <span className="section-label">YOUR REQUESTS</span>
                <h2>Track Requests</h2>
                <p>Follow each request through the support process.</p>
              </div>
              <button type="button" className="close-button" onClick={goHome} aria-label="Back to dashboard">×</button>
            </div>
            <div className="form-divider"></div>
            <RequestTracker onOpenTicket={(ticketId) => setSelectedTicketId(ticketId)} />
          </section>
        )}

        {session && showTeam && session.user.role === 'admin' && (
          <section className="ticket-form-card">
            <div className="form-header">
              <div>
                <span className="section-label">ADMINISTRATION</span>
                <h2>Staff Access</h2>
                <p>Create accounts, assign roles, reset passwords, and disable access.</p>
              </div>
              <button type="button" className="close-button" onClick={goHome}>×</button>
            </div>
            <div className="form-divider"></div>
            <TeamManagement />
          </section>
        )}

        {session && showAccessRequests && session.user.role === 'admin' && (
          <section className="ticket-form-card">
            <div className="form-header">
              <div>
                <span className="section-label">ADMINISTRATION</span>
                <h2>Access Requests</h2>
                <p>Review Staff and Support Team account requests.</p>
              </div>
              <button type="button" className="close-button" onClick={goHome}>×</button>
            </div>
            <div className="form-divider"></div>
            <AccessRequestReview />
          </section>
        )}

      </main>

      <footer className="app-footer">
        <strong>Cloudnaut Support Desk</strong>
        <span>Technical Support Management System</span>
      </footer>

    </div>
  )
}

export default App