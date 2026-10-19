import { useEffect, useState } from 'react'
import { apiFetch } from '../api'

async function fetchMembers() {
  const response = await apiFetch('/team-members')
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Could not load staff accounts.')
  return data
}

async function fetchMfaPolicy() {
  const response = await apiFetch('/security/mfa-policy')
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Could not load MFA policy.')
  return data
}

async function updateMfaPolicy(requireStaffMfa) {
  const response = await apiFetch('/security/mfa-policy', {
    method: 'PATCH',
    body: JSON.stringify({ require_staff_mfa: requireStaffMfa }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail || 'Could not update MFA policy.')
  return data
}

function TeamManagement() {
  const [members, setMembers] = useState([])
  const [mfaPolicy, setMfaPolicy] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [policySaving, setPolicySaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    Promise.all([fetchMembers(), fetchMfaPolicy()])
      .then(([memberData, policyData]) => {
        setMembers(memberData)
        setMfaPolicy(policyData)
      })
      .catch((loadError) => setError(loadError.message))
      .finally(() => setLoading(false))
  }, [])

  const toggleMfaPolicy = async (event) => {
    const enabled = event.target.checked
    setPolicySaving(true)
    setError('')
    setNotice('')
    try {
      const data = await updateMfaPolicy(enabled)
      setMfaPolicy(data)
      setNotice(enabled
        ? 'MFA enforcement is enabled for employees and support staff.'
        : 'MFA enforcement is disabled. Existing optional-MFA behavior is restored.')
    } catch (policyError) {
      setError(policyError.message)
    } finally {
      setPolicySaving(false)
    }
  }

  const startEditing = (member) => {
    setEditingId(member.id)
    setEditDraft({ ...member, password: '' })
    setError('')
    setNotice('')
  }

  const saveMember = async (event) => {
    event?.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')
    const { name, email, role, is_active, password } = editDraft
    const payload = { name, email, role, is_active, password }
    if (!payload.password) delete payload.password
    try {
      const response = await apiFetch(`/team-members/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.detail || 'Could not update account.')
      setEditingId(null)
      setEditDraft(null)
      setNotice(`${data.name}'s account has been updated.`)
      setMembers(await fetchMembers())
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="team-management">
      <section className="team-create-section mfa-policy-card">
        <div>
          <span className="section-label">SECURITY POLICY</span>
          <h3>Staff MFA enforcement</h3>
          <p>
            Require employees and support staff to enroll in an authenticator before they can access support data.
            Administrators are never locked out by this policy.
          </p>
        </div>
        <label className="mfa-policy-toggle">
          <input
            type="checkbox"
            checked={Boolean(mfaPolicy?.require_staff_mfa)}
            onChange={toggleMfaPolicy}
            disabled={policySaving || !mfaPolicy}
          />
          <span>{policySaving ? 'Saving…' : mfaPolicy?.require_staff_mfa ? 'Enforced' : 'Optional'}</span>
        </label>
      </section>

      <section className="team-create-section">
        <h3>Add staff account</h3>
        <p>New employees and support staff register using the public sign-up form. Review and approve verified requests in Access Requests.</p>
      </section>

      {error && <div className="error-box"><strong>Account action failed</strong><span>{error}</span></div>}
      {notice && <p className="team-notice" role="status">{notice}</p>}

      <div className="team-table-wrap">
        <table className="team-table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Access</th><th>Action</th></tr></thead>
          <tbody>
            {members.map((member) => editingId === member.id ? (
              <tr key={member.id}>
                <td><input aria-label="Name" value={editDraft.name} onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })} /></td>
                <td><input aria-label="Email" type="email" value={editDraft.email} onChange={(event) => setEditDraft({ ...editDraft, email: event.target.value })} /></td>
                <td>
                  <select aria-label="Role" value={editDraft.role} onChange={(event) => setEditDraft({ ...editDraft, role: event.target.value })}>
                    <option value="employee">Employee</option><option value="support">Support</option><option value="admin">Admin</option>
                  </select>
                </td>
                <td><select aria-label="Account access" value={String(editDraft.is_active)} onChange={(event) => setEditDraft({ ...editDraft, is_active: event.target.value === 'true' })}><option value="true">Active</option><option value="false">Disabled</option></select></td>
                <td className="team-actions">
                  <input aria-label="New password (optional)" type="password" minLength="12" placeholder="New password" autoComplete="new-password" value={editDraft.password} onChange={(event) => setEditDraft({ ...editDraft, password: event.target.value })} />
                  <button type="button" onClick={saveMember} disabled={saving}>Save</button>
                  <button type="button" className="secondary-button" onClick={() => setEditingId(null)}>Cancel</button>
                </td>
              </tr>
            ) : (
              <tr key={member.id}>
                <td>{member.name}</td><td>{member.email}</td><td>{member.role}</td>
                <td><span className={`account-state ${member.is_active ? 'active' : 'inactive'}`}>{member.is_active ? 'Active' : 'Disabled'}</span></td>
                <td><button type="button" onClick={() => startEditing(member)}>Manage</button></td>
              </tr>
            ))}
            {!loading && members.length === 0 && <tr><td colSpan="5">No staff accounts found.</td></tr>}
            {loading && <tr><td colSpan="5">Loading staff accounts...</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default TeamManagement
