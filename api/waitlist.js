import fs from 'fs'
import path from 'path'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { email, timestamp } = req.body || {}
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' })
  }

  const entry = { email: email.trim(), timestamp: timestamp || new Date().toISOString() }

  console.log('[waitlist] New signup:', JSON.stringify(entry))

  try {
    const filePath = path.join('/tmp', 'remi_waitlist.json')
    let list = []
    if (fs.existsSync(filePath)) {
      try { list = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch {}
    }
    list.push(entry)
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2))
  } catch (err) {
    console.error('[waitlist] Failed to persist entry:', err.message)
  }

  return res.status(200).json({ ok: true })
}
