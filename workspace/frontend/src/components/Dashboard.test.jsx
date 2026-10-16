import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../api', () => ({
  getDashboardSummary: vi.fn(),
  listAccessRequests: vi.fn(),
  listTeamMembers: vi.fn(),
}))

import { getDashboardSummary, listAccessRequests, listTeamMembers } from '../api'
import Dashboard from './Dashboard'

const okResponse = (data) => ({ ok: true, json: async () => data })

beforeEach(() => {
  getDashboardSummary.mockResolvedValue(okResponse({
    total: 24,
    assigned: 17,
    unassigned: 7,
    by_status: { Open: 6, 'In Progress': 8, Blocked: 2, Resolved: 8 },
    by_priority: { Critical: 2, High: 7, Medium: 10, Low: 5 },
    by_category: { Access: 8, Infrastructure: 7 },
    by_assignee: { 'Mina Patel': 7 },
    recent: [],
  }))
  listAccessRequests.mockResolvedValue(okResponse([{ id: 1 }, { id: 2 }]))
  listTeamMembers.mockResolvedValue(okResponse([
    { id: 1, name: 'Mina Patel', is_active: true },
    { id: 2, name: 'Dev Shah', is_active: false },
  ]))
})

afterEach(() => vi.clearAllMocks())

describe('Dashboard', () => {
  it('shows admin context and readable ticket analysis sections', async () => {
    render(<Dashboard user={{ role: 'admin' }} />)

    expect(await screen.findByRole('heading', { name: 'Admin dashboard' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ticket overview' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Team and access' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ticket breakdown' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent activity' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Pending Access Requests/ })).toHaveTextContent('2')
    expect(screen.getByRole('button', { name: /Active Staff/ })).toHaveTextContent('1')
  })
})
