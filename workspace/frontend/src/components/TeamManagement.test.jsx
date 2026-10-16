import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../api', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '../api'
import TeamManagement from './TeamManagement'

afterEach(() => vi.clearAllMocks())

describe('TeamManagement onboarding', () => {
  it('directs new accounts through registration and admin approval', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      json: async () => [],
    })

    render(<TeamManagement />)

    expect(await screen.findByText(/register using the public sign-up form/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add account/i })).not.toBeInTheDocument()
    expect(apiFetch).toHaveBeenCalledWith('/team-members')
  })
})
