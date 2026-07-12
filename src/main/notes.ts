// Turns the raw two-channel transcript into clean, Granola-style meeting notes
// with Claude. This is the *other half* of Granola's product — capture →
// transcribe → notes — so the prototype covers the whole loop, not just STT.
//
// One Messages API call (summarization), no agent loop. Output is plain text
// with simple section labels + unicode bullets/checkboxes, so the renderer can
// display it beautifully without a markdown dependency.

import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-opus-4-8'

const SYSTEM = `You are Granola, an AI notepad for meetings. You turn a raw, messy meeting transcript into clean, skimmable notes — the way a sharp colleague would write them up afterwards.

Output PLAIN TEXT only (no markdown, no asterisks, no backticks), using these sections. Omit any section that doesn't apply:

TL;DR
<one or two sentences on what the meeting was about and the outcome>

KEY POINTS
• <tight bullet>
• <tight bullet>

DECISIONS
• <anything decided or agreed>

ACTION ITEMS
☐ <concrete next step> — <owner, if clear from context>

Rules:
- Be concise. The notes must be shorter than the transcript and easier to read.
- Never invent anything not supported by the transcript.
- "You" is the person whose microphone this is; "Them" / "Speaker N" are other participants.
- If the transcript is too short or garbled to summarise, say so in one line instead of padding.`

export interface NotesResult {
  ok: boolean
  notes?: string
  error?: string
}

export async function generateNotes(transcript: string): Promise<NotesResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'ANTHROPIC_API_KEY missing — add it to .env (see .env.example).' }
  }
  const clean = transcript.trim()
  if (!clean) {
    return { ok: false, error: 'Nothing to summarise yet — capture a meeting first.' }
  }

  try {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{ role: 'user', content: `Meeting transcript:\n\n${clean}` }]
    })
    const notes = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    return notes ? { ok: true, notes } : { ok: false, error: 'Model returned no notes.' }
  } catch (err: unknown) {
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  }
}
