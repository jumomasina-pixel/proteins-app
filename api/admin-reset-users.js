import { createClient } from '@supabase/supabase-js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const secret = process.env.ADMIN_RESET_SECRET
    if (!secret) {
      return res.status(500).json({ error: 'ADMIN_RESET_SECRET env var not set' })
    }

    const authHeader = req.headers['authorization'] || ''
    const provided = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Supabase env vars not set' })
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    )

    // 1. Delete all rows from the users table
    const { error: tableError } = await supabase.from('users').delete().neq('email', '')
    if (tableError) {
      console.error('[admin-reset-users] users table delete error:', tableError)
      return res.status(500).json({ error: tableError.message })
    }

    // 2. List all auth users
    const { data: listData, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    if (listError) {
      console.error('[admin-reset-users] listUsers error:', listError)
      return res.status(500).json({ error: listError.message })
    }

    const users = listData?.users ?? []

    // 3. Delete every auth user
    for (const user of users) {
      const { error: deleteError } = await supabase.auth.admin.deleteUser(user.id)
      if (deleteError) {
        console.error(`[admin-reset-users] deleteUser(${user.id}) error:`, deleteError)
      }
    }

    return res.status(200).json({ success: true, deleted: users.length })
  } catch (err) {
    console.error('[admin-reset-users] unexpected error:', err)
    return res.status(500).json({ error: err.message })
  }
}
