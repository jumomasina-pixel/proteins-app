import fs from 'fs'
import path from 'path'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { name, email, gym, clientCount, timestamp } = req.body || {}
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' })
  }

  const entry = {
    name: String(name).trim(),
    email: String(email).trim(),
    gym: String(gym || '').trim(),
    clientCount: String(clientCount || '').trim(),
    timestamp: timestamp || new Date().toISOString(),
  }

  console.log('[pt-waitlist] New PT application:', JSON.stringify(entry))

  try {
    const filePath = path.join('/tmp', 'remi_pt_waitlist.json')
    let list = []
    if (fs.existsSync(filePath)) {
      try { list = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch {}
    }
    list.push(entry)
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2))
  } catch (err) {
    console.error('[pt-waitlist] Failed to persist entry:', err.message)
  }

  return res.status(200).json({ ok: true })
}
