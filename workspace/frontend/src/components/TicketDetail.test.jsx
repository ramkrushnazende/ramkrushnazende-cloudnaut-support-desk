import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))
vi.mock('./TicketAttachments', () => ({ default: () => <div>Attachments preview</div> }))

import { apiFetch } from '../api'
import TicketDetail from './TicketDetail'

const ticket = {
  id: 42,
  title: 'VPN access failing for remote team',
  description: 'Remote staff cannot connect to the corporate VPN.',
  status: 'In Progress',
  priority: 'High',
  category: 'Access',
  requester_name: 'Asha Rao',
  requester_email: 'asha@example.com',
  assigned_to: 7,
  assigned_to_name: 'Mina Patel',
  due_date: '2026-10-17',
  created_at: '2026-10-14T08:30:00Z',
  updated_at: '2026-10-15T14:20:00Z',
}

function response(data) {
  return { ok: true, json: async () => data }
}

afterEach(() => vi.clearAllMocks())

describe('TicketDetail', () => {
  it('groups ticket identity, information, and staff workflow controls', async () => {
    apiFetch.mockImplementation((path) => {
      if (path === '/requests/42') return Promise.resolve(response(ticket))
      if (path === '/team-members') return Promise.resolve(response([{ id: 7, name: 'Mina Patel' }]))
      if (path.endsWith('/history') || path.endsWith('/notes')) return Promise.resolve(response([]))
      return Promise.resolve(response([]))
    })

    render(<TicketDetail ticketId={42} user={{ role: 'admin' }} onBack={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: ticket.title })).toBeInTheDocument()
    expect(screen.getByText('In Progress', { selector: '.ticket-detail-status' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Request information' })).toBeInTheDocument()
    expect(screen.getByText('Asha Rao (asha@example.com)')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ticket workflow' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Activity History' })).toBeInTheDocument()
  })

  it('keeps employee ticket details read-only', async () => {
    apiFetch.mockImplementation((path) => {
      if (path === '/requests/42') return Promise.resolve(response(ticket))
      if (path.endsWith('/notes')) return Promise.resolve(response([]))
      return Promise.resolve(response([]))
    })

    render(<TicketDetail ticketId={42} user={{ role: 'employee' }} onBack={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: ticket.title })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Ticket workflow' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Activity History' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Progress Updates' })).toBeInTheDocument()
  })
})
