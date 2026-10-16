import { useState, useEffect, useRef, useCallback } from 'react'
import { getDashboardSummary, listAccessRequests, listTeamMembers } from '../api'
import { BarChart, Sparkline } from './StatCharts'
import TicketList from './TicketList'
import TicketDetail from './TicketDetail'
import AccessRequestReview from './AccessRequestReview'
import TeamManagement from './TeamManagement'

const POLL_INTERVAL_MS = 12000

// Known ticket statuses (status_service.RequestStatus). Shown even when zero
// so the operational view is stable while tickets move between states.
const STATUS_CARDS = [
  { key: 'Open', label: 'Open', icon: '🟢' },
  { key: 'In Progress', label: 'In Progress', icon: '🔧' },
  { key: 'Blocked', label: 'Blocked', icon: '⛔' },
  { key: 'Resolved', label: 'Resolved', icon: '✅' },
]

function Dashboard({ user }) {
  const isAdmin = user?.role === 'admin'

  const [summary, setSummary] = useState(null)
  const [admin, setAdmin] = useState({ pendingAccess: null, activeStaff: null })
  const [teamMembers, setTeamMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState(null)

  // A single drill-down selection drives which reused component is shown.
  // Shape: { kind: 'tickets'|'access'|'staff', title, subtitle, filters, chart, value }
  const [drill, setDrill] = useState(null)
  const [selectedTicketId, setSelectedTicketId] = useState(null)

  // Avoid state updates after unmount and overlapping polls.
  const activeRef = useRef(true)

  const loadDashboard = useCallback(async () => {
    try {
      const response = await getDashboardSummary()
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Failed to load dashboard')
      if (!activeRef.current) return
      setSummary(data)
      setError('')
      setLastUpdated(new Date())
    } catch (fetchError) {
      if (activeRef.current) setError(fetchError.message || 'Could not connect to the API.')
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }, [])

  const loadAdminContext = useCallback(async () => {
    if (!isAdmin) return
    try {
      const accessResp = await listAccessRequests('pending')
      const accessData = accessResp.ok ? await accessResp.json() : []
      if (activeRef.current) {
        setAdmin((current) => ({
          ...current,
          pendingAccess: Array.isArray(accessData) ? accessData.length : 0,
        }))
      }
    } catch {
      // Admin extras are best-effort; the core dashboard still renders.
    }
  }, [isAdmin])

  // Team members power both the "Active Staff" count and the assignee
  // id<->name mapping needed to filter /requests by assigned_to.
  const loadTeam = useCallback(async () => {
    if (user?.role === 'employee') return
    try {
      const response = await listTeamMembers(false)
      const data = response.ok ? await response.json() : []
      if (!activeRef.current) return
      const members = Array.isArray(data) ? data : []
      setTeamMembers(members)
      if (isAdmin) {
        setAdmin((current) => ({
          ...current,
          activeStaff: members.filter((m) => m.is_active).length,
        }))
      }
    } catch {
      // Non-fatal: assignee drill-down falls back to showing all tickets.
    }
  }, [user, isAdmin])

  const refreshAll = useCallback(() => {
    loadDashboard()
    loadAdminContext()
    loadTeam()
  }, [loadDashboard, loadAdminContext, loadTeam])

  useEffect(() => {
    activeRef.current = true
    refreshAll()
    const timer = setInterval(refreshAll, POLL_INTERVAL_MS)
    return () => {
      activeRef.current = false
      clearInterval(timer)
    }
  }, [refreshAll])

  // --- Drill-down helpers -------------------------------------------------

  const openTickets = (title, filters, chart = null, value = null, subtitle = '') => {
    setSelectedTicketId(null)
    setDrill({ kind: 'tickets', title, subtitle, filters, chart, value })
  }

  const closeDrill = () => {
    setSelectedTicketId(null)
    setDrill(null)
  }

  const assigneeNameToId = (name) => {
    const match = teamMembers.find((m) => m.name === name)
    return match ? match.id : null
  }

  // --- Render: drill-down views ------------------------------------------

  if (drill) {
    // Ticket detail reuses the existing component (role checks enforced server-side).
    if (drill.kind === 'tickets' && selectedTicketId) {
      return (
        <div className="dashboard-container">
          <DrillHeader title="Ticket detail" onBack={() => setSelectedTicketId(null)} backLabel="← Back to results" />
          <TicketDetail ticketId={selectedTicketId} user={user} onBack={() => setSelectedTicketId(null)} />
        </div>
      )
    }

    if (drill.kind === 'tickets') {
      return (
        <div className="dashboard-container">
          <DrillHeader title={drill.title} subtitle={drill.subtitle} onBack={closeDrill} />
          <TicketList filters={drill.filters} onSelectTicket={(ticket) => setSelectedTicketId(ticket.id)} />
        </div>
      )
    }

    if (drill.kind === 'access') {
      return (
        <div className="dashboard-container">
          <DrillHeader title="Pending Access Requests" onBack={closeDrill} />
          <AccessRequestReview />
        </div>
      )
    }

    if (drill.kind === 'staff') {
      return (
        <div className="dashboard-container">
          <DrillHeader title="Staff Accounts" onBack={closeDrill} />
          <TeamManagement />
        </div>
      )
    }
  }

  // --- Render: dashboard --------------------------------------------------

  if (loading) return <p>Loading dashboard...</p>

  if (error && !summary) {
    return (
      <div className="error-box">
        <strong>Unable to load dashboard</strong>
        <span>{error}</span>
      </div>
    )
  }

  if (!summary) return null

  const byStatus = summary.by_status || {}

  return (
    <div className="dashboard-container">
      <div className="dashboard-heading">
        <div>
          <span className="section-label">{isAdmin ? 'ADMINISTRATION' : 'OPERATIONS'}</span>
          <h2>{isAdmin ? 'Admin dashboard' : 'Operations dashboard'}</h2>
          <p>{isAdmin
            ? 'Monitor support activity, staff access, and incoming requests.'
            : 'Track support activity and work across the ticket queue.'}</p>
        </div>
        <div className="dashboard-meta" role="status" aria-live="polite">
          <span className="dashboard-live-dot" aria-hidden="true" />
          <span>
            Live · refreshes every {Math.round(POLL_INTERVAL_MS / 1000)}s
            {lastUpdated ? ` · updated ${lastUpdated.toLocaleTimeString()}` : ''}
          </span>
          {error && <span className="dashboard-stale">Reconnecting…</span>}
        </div>
      </div>

      <p className="dashboard-hint">Select any metric, chart item, or day to drill into the related tickets.</p>

      {/* Headline counters */}
      <section className="dashboard-section" aria-labelledby="dashboard-ticket-overview">
      <h3 id="dashboard-ticket-overview">Ticket overview</h3>
      <div className="feature-grid dashboard-kpis">
        <KpiCard icon="📊" label="Total Tickets" value={summary.total}
          onClick={() => openTickets('All Tickets', {})} />

        {STATUS_CARDS.map(({ key, label, icon }) => (
          <KpiCard key={key} icon={icon} label={label} value={byStatus[key] || 0}
            onClick={() => openTickets(`${label} Tickets`, { status: key }, 'status', key)} />
        ))}

        <KpiCard icon="👤" label="Assigned" value={summary.assigned}
          onClick={() => openTickets('Assigned Tickets', { assignment: 'assigned' }, null, null, 'Tickets with an assignee')}
          hint="Tickets with an assignee" />

        <KpiCard icon="🕓" label="Unassigned" value={summary.unassigned}
          onClick={() => openTickets('Unassigned Tickets', { assignment: 'unassigned' }, null, null, 'Tickets awaiting assignment')} />
      </div>
      </section>

      {/* Admin-only context, powered by existing APIs */}
      {isAdmin && (
        <section className="dashboard-section admin-dashboard-section" aria-labelledby="dashboard-admin-overview">
          <div className="dashboard-section-heading">
            <div>
              <h3 id="dashboard-admin-overview">Team and access</h3>
              <p>Review access requests and manage active staff accounts.</p>
            </div>
          </div>
          <div className="feature-grid dashboard-kpis">
            <KpiCard icon="📨" label="Pending Access Requests" value={admin.pendingAccess ?? '—'}
              onClick={() => setDrill({ kind: 'access' })} />
            <KpiCard icon="👥" label="Active Staff" value={admin.activeStaff ?? '—'}
              onClick={() => setDrill({ kind: 'staff' })} />
          </div>
        </section>
      )}

      {/* Breakdown charts */}
      <section className="dashboard-section" aria-labelledby="dashboard-breakdown">
      <div className="dashboard-section-heading">
        <div>
          <h3 id="dashboard-breakdown">Ticket breakdown</h3>
          <p>Explore tickets by status, priority, category, or assignee.</p>
        </div>
      </div>
      <div className="chart-grid dashboard-chart-grid">
        <BarChart title="Tickets by Status" data={summary.by_status}
          onSelect={(label) => openTickets(`${label} Tickets`, { status: label }, 'status', label)} />

        <BarChart title="Tickets by Priority" data={summary.by_priority} order="priority"
          onSelect={(label) => openTickets(`${label} Priority Tickets`, { priority: label }, 'priority', label)} />

        <BarChart title="Tickets by Category" data={summary.by_category}
          onSelect={(label) => openTickets(`${label} Tickets`, { category: label }, 'category', label)} />

        <BarChart title="Tickets by Assignee" data={summary.by_assignee}
          emptyLabel="No tickets are assigned yet."
          onSelect={(name) => {
            const assigneeId = assigneeNameToId(name)
            openTickets(
              `Tickets assigned to ${name}`,
              assigneeId ? { assigned_to: assigneeId } : {},
              'assignee',
              name,
              assigneeId ? '' : 'Showing all tickets (assignee id unavailable)',
            )
          }} />
      </div>
      </section>

      {/* Trend */}
      <section className="dashboard-section" aria-labelledby="dashboard-trend">
      <div className="dashboard-section-heading">
        <div>
          <h3 id="dashboard-trend">Recent activity</h3>
          <p>New tickets created over the past seven days.</p>
        </div>
      </div>
      <div className="chart-grid dashboard-chart-grid">
        <Sparkline title="New Tickets (last 7 days)" series={summary.recent}
          onSelect={(date) => openTickets(
            `Tickets created on ${date}`,
            { created_from: date, created_to: date },
            'day',
            date,
          )} />
      </div>
      </section>
    </div>
  )
}

function KpiCard({ icon, label, value, onClick, hint }) {
  return (
    <button type="button" className="feature-item kpi-card" onClick={onClick} title={hint || `Show ${label}`}>
      <div className="feature-icon">{icon}</div>
      <div>
        <h3>{label}</h3>
        <p>{value}</p>
      </div>
    </button>
  )
}

function DrillHeader({ title, subtitle, onBack, backLabel = '← Back to dashboard' }) {
  return (
    <div className="drill-header">
      <button type="button" className="close-button drill-back" onClick={onBack}>{backLabel}</button>
      <div>
        <h3 className="drill-title">{title}</h3>
        {subtitle && <p className="drill-subtitle">{subtitle}</p>}
      </div>
    </div>
  )
}

export default Dashboard
