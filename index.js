/**
 * Host half of the daily-token bundle.
 *
 * Counts the tokens this DSH installation has consumed since local midnight by
 * reading the session logs it already keeps: every committed `assistant/message`
 * event carries a `usage` block. Nothing is asked of the model providers —
 * OpenCode, for one, publishes allowance percentages but no token counts.
 *
 * @module dsh-plugin-daily-tokens
 */

import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/** Zstandard frame magic, used to split an append-only log into frames. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Where the durable daily counters live, one JSON file per day. */
const STATE_DIR = 'daily-tokens'

/** Largest session generation file the scan will read. */
const MAX_LOG_BYTES = 256 * 1024 * 1024

/**
 * Decode the frames of one log starting at a known frame boundary.
 *
 * The backend appends one zstd frame per write, so a refresh only has to decode
 * the bytes written since the previous read: `fromOffset` is the end of the last
 * fully decoded frame. A trailing frame that is still being written fails to
 * decode and is left for the next pass, which keeps the offset on a frame
 * boundary.
 * @param {Buffer} buffer - Bytes read from `fromOffset` onward.
 * @param {number} fromOffset - Absolute byte offset of `buffer[0]`.
 * @returns {{ text: string, offset: number }} Decoded text and the byte offset just past the last complete frame.
 */
function decodeFrom(buffer, fromOffset) {
  let offset = fromOffset
  let cursor = 0
  const parts = []
  while (cursor < buffer.length) {
    const next = buffer.indexOf(ZSTD_MAGIC, cursor + ZSTD_MAGIC.length)
    const end = next === -1 ? buffer.length : next
    try {
      parts.push(zstdDecompressSync(buffer.subarray(cursor, end)))
      offset = fromOffset + end
      cursor = end
    } catch {
      // Partial tail frame or a false magic inside a payload: stop here.
      break
    }
    if (next === -1) break
  }
  return { text: Buffer.concat(parts).toString('utf8'), offset }
}

/** @param {unknown} error @returns {string} */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Directory holding the durable per-day counters.
 * @returns {string} Absolute path under the DSH home.
 */
function stateDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), STATE_DIR)
}

/**
 * The parts of one day's reading that survive a log being deleted.
 * @param {number} sinceMs - Day start.
 * @returns {string[]} Bucket field names.
 */
const COUNTER_FIELDS = ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'total']

/**
 * Clamp a persisted counter to plain non-negative integers.
 * @param {unknown} bucket - Possibly-saved bucket.
 * @returns {Record<string, number>} Safe bucket.
 */
function sanitizeBucket(bucket) {
  const clean = emptyBucket()
  if (bucket === null || typeof bucket !== 'object') return clean
  for (const field of COUNTER_FIELDS) {
    const value = Number(bucket[field])
    if (Number.isFinite(value) && value > 0) clean[field] = value
  }
  return clean
}

/** An empty usage bucket. */
function emptyBucket() {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/**
 * Host Remote service owning the daily token reading.
 *
 * Registered through `ctx.provide` and marked on its prototype: this authored
 * JavaScript bundle has no decorator transform, so the Typert Gateway's source
 * fallback reads the same marker shape the decorator writes.
 */
export class DailyTokensService {
  /** @param {import('@deepseek-ai/cordis').Context} ctx - Host context. */
  constructor(ctx) {
    this.ctx = ctx
    /** @type {Map<string, { sinceMs: number, size: number, offset: number, bucket: Record<string, number>, maxSeq: number, sessionId: string }>} */
    this.logCache = new Map()
    /** Today's totals, primed from the logs and then kept live by events. */
    this.base = null
    /** Day start the primed totals belong to. */
    this.sinceMs = 0
    /** Events seen before the first prime; drained once the baseline exists. */
    this.pending = []
    /** Messages already folded into the persisted counter, by `sessionId:seq`. */
    this.seen = new Set()
    /** When the durable file was last written, in epoch milliseconds. */
    this.savedAt = 0
    /** Write queued behind an in-flight one. */
    this.writing = false
    this.writeAgain = false
    /** Whether the queued write (or a throttled one) must bypass the debounce. */
    this.writeForce = false
    /** A write was skipped by the debounce and still needs to happen. */
    this.saveOwed = false
  }

  /**
   * Local start of the current day, in epoch milliseconds.
   * @returns {number} Midnight today in this machine's time zone.
   */
  dayStart() {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now.getTime()
  }

  /**
   * Every session generation file this installation keeps.
   * @returns {Promise<string[]>} Absolute paths of session log generations.
   */
  async sessionLogFiles() {
    const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
    /** @type {string[]} */
    const files = []
    /** @param {string} dir @param {number} depth */
    const walk = async (dir, depth) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (depth > 0) await walk(path, depth - 1)
        } else if (/^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?$/.test(entry.name)) {
          files.push(path)
        }
      }
    }
    await walk(root, 2)
    return files
  }

  /**
   * Sum one log file's usage committed today, decoding only what was appended
   * since the previous read.
   * @param {string} path - Session generation file.
   * @param {number} sinceMs - Day start in epoch milliseconds.
   * @returns {Promise<Record<string, number>>} Usage bucket.
   */
  async fileUsage(path, sinceMs) {
    let stat
    try {
      stat = await fs.stat(path)
    } catch {
      return emptyBucket()
    }
    if (stat.size === 0 || stat.size > MAX_LOG_BYTES || stat.mtimeMs < sinceMs) {
      return { sinceMs, size: stat.size, offset: 0, bucket: emptyBucket(), maxSeq: -1, sessionId: '' }
    }

    const cached = this.logCache.get(path)
    if (cached !== undefined && cached.sinceMs === sinceMs && cached.size === stat.size) return cached

    const reusable = cached !== undefined && cached.sinceMs === sinceMs && stat.size > cached.size
    const fromOffset = reusable ? cached.offset : 0
    const bucket = reusable ? { ...cached.bucket } : emptyBucket()
    let maxSeq = reusable ? cached.maxSeq : -1
    let sessionId = reusable ? cached.sessionId : ''

    let bytes
    try {
      bytes = await this.readFrom(path, fromOffset, stat.size)
    } catch {
      return { sinceMs, size: stat.size, offset: fromOffset, bucket, maxSeq, sessionId }
    }

    const { text, offset } = decodeFrom(bytes, fromOffset)
    if (fromOffset === 0) {
      const header = /"id"\s*:\s*"([^"]+)"/.exec(text.slice(0, 400))
      if (header !== null) sessionId = header[1]
    }
    for (const line of text.split('\n')) {
      // Cheap reject before paying for JSON.parse.
      if (line.length === 0 || !line.includes('"assistant/message"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.type !== 'assistant/message') continue
      const usage = event.data?.usage
      if (usage === null || typeof usage !== 'object') continue
      const time = Number(event.time)
      if (Number.isFinite(time) && time < sinceMs) continue

      const seq = Number(event.seq)
      if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq
      const input = Number(usage.inputTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const cacheRead = Number(usage.cacheReadTokens) || 0
      const cacheWrite = Number(usage.cacheWriteTokens) || 0
      bucket.requests += 1
      bucket.input += input
      bucket.output += output
      bucket.cacheRead += cacheRead
      bucket.cacheWrite += cacheWrite
      bucket.total += Number(usage.totalTokens) || (input + output + cacheRead + cacheWrite)
    }

    const entry = { sinceMs, size: stat.size, offset, bucket, maxSeq, sessionId }
    this.logCache.set(path, entry)
    return entry
  }

  /**
   * Read the bytes of one file from `fromOffset` to `toOffset`.
   * @param {string} path - File path.
   * @param {number} fromOffset - First byte to read.
   * @param {number} toOffset - File size at read time.
   * @returns {Promise<Buffer>} The requested slice.
   */
  async readFrom(path, fromOffset, toOffset) {
    if (toOffset <= fromOffset) return Buffer.alloc(0)
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(toOffset - fromOffset)
      let read = 0
      while (read < buffer.length) {
        const { bytesRead } = await handle.read(buffer, read, buffer.length - read, fromOffset + read)
        if (bytesRead === 0) break
        read += bytesRead
      }
      return buffer.subarray(0, read)
    } finally {
      await handle.close()
    }
  }

  /**
   * Fold one usage block into a bucket.
   * @param {Record<string, number>} bucket - Target bucket.
   * @param {Record<string, unknown>} usage - Event usage block.
   * @param {number} time - Event time in epoch milliseconds.
   * @param {number} sinceMs - Day start to filter against.
   */
  addUsage(bucket, usage, time, sinceMs) {
    if (Number.isFinite(time) && time < sinceMs) return
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    bucket.requests += 1
    bucket.input += input
    bucket.output += output
    bucket.cacheRead += cacheRead
    bucket.cacheWrite += cacheWrite
    bucket.total += Number(usage.totalTokens) || (input + output + cacheRead + cacheWrite)
  }

  /**
   * Fold one bucket into another.
   * @param {Record<string, number>} target - Accumulator.
   * @param {Record<string, number>} source - Bucket to add.
   */
  addBucket(target, source) {
    target.requests += source.requests
    target.input += source.input
    target.output += source.output
    target.cacheRead += source.cacheRead
    target.cacheWrite += source.cacheWrite
    target.total += source.total
  }

  /**
   * Record one committed Session event.
   *
   * This is the live path: the Host sees every append the moment it commits, so
   * the figure moves without touching the filesystem. Events that arrive before
   * the baseline scan has finished are buffered and deduplicated by `seq`.
   * @param {{ id?: string }} session - Session that committed the event.
   * @param {{ type?: string, seq?: number, time?: number, data?: { usage?: unknown } }} event - Committed event.
   */
  observe(session, event) {
    const usage = event?.data?.usage
    if (event?.type !== 'assistant/message') return
    if (usage === null || typeof usage !== 'object') return
    const record = {
      sessionId: typeof session?.id === 'string' ? session.id : '',
      seq: Number(event.seq) || 0,
      usage,
      time: Number(event.time) || Date.now(),
    }
    if (this.base === null) {
      // Bounded: a pathological burst must not grow this forever.
      if (this.pending.length < 20_000) this.pending.push(record)
      return
    }
    const key = `${record.sessionId}:${record.seq}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.addUsage(this.base, usage, record.time, this.sinceMs)
    // Debounced by saveState; the durable copy trails the live figure by <5s.
    void this.saveState()
  }

  /**
   * Build today's baseline from the logs, then drain the events buffered while
   * the scan ran. An event already covered by the scanned bytes is skipped, so
   * nothing is counted twice.
   * @returns {Promise<Record<string, number>>} Today's bucket.
   */
  async prime() {
    const sinceMs = this.dayStart()
    const saved = await this.loadState(sinceMs)
    if (saved !== null) {
      // The durable counter already holds everything folded so far, including
      // Sessions whose logs were deleted since. Rebuild only the entries that
      // are still on disk and NOT yet accounted for, then keep the larger of
      // the two so a deleted log never lowers the figure.
      for (const key of saved.seen) this.seen.add(key)
      const scanned = emptyBucket()
      /** @type {Map<string, number>} */
      const maxSeq = new Map()
      for (const path of await this.sessionLogFiles()) {
        const entry = await this.fileUsage(path, sinceMs)
        this.addBucket(scanned, entry.bucket)
        if (entry.sessionId.length > 0 && entry.maxSeq >= 0) {
          this.seen.add(`${entry.sessionId}:${entry.maxSeq}`)
        }
        if (entry.sessionId.length > 0 && entry.maxSeq > (maxSeq.get(entry.sessionId) ?? -1)) {
          maxSeq.set(entry.sessionId, entry.maxSeq)
        }
      }
      // Flush anything a previous run skipped, now that the watermark is in
      // `seen`: a message already counted from the logs must not be re-added.
      this.sinceMs = sinceMs
      this.base = saved.bucket
      if (this.saveOwed) {
        this.saveOwed = false
        await this.saveState(true)
      }
      const total = emptyBucket()
      for (const field of COUNTER_FIELDS) total[field] = Math.max(saved.bucket[field], scanned[field])
      for (const record of this.pending) {
        const key = `${record.sessionId}:${record.seq}`
        if (this.seen.has(key)) continue
        if ((maxSeq.get(record.sessionId) ?? -1) >= record.seq) continue
        this.seen.add(key)
        this.addUsage(total, record.usage, record.time, sinceMs)
      }
      this.pending = []
      this.sinceMs = sinceMs
      this.base = total
      void this.pruneOldState(sinceMs)
      void this.saveState(true)
      return total
    }

    const total = emptyBucket()
    /** @type {Map<string, number>} */
    const maxSeq = new Map()
    for (const path of await this.sessionLogFiles()) {
      const entry = await this.fileUsage(path, sinceMs)
      this.addBucket(total, entry.bucket)
      if (entry.sessionId.length > 0 && entry.maxSeq > (maxSeq.get(entry.sessionId) ?? -1)) {
        maxSeq.set(entry.sessionId, entry.maxSeq)
      }
    }
    for (const record of this.pending) {
      if ((maxSeq.get(record.sessionId) ?? -1) >= record.seq) continue
      this.addUsage(total, record.usage, record.time, sinceMs)
    }
    this.pending = []
    this.sinceMs = sinceMs
    this.base = total
    void this.pruneOldState(sinceMs)
    void this.saveState(true)
    return total
  }

  /**
   * Load today's durable counter.
   * @param {number} sinceMs - Day start.
   * @returns {Promise<{ bucket: Record<string, number>, seen: Set<string> } | null>} Saved state, or null when absent.
   */
  async loadState(sinceMs) {
    const path = join(stateDirectory(), `${sinceMs}.json`)
    let raw
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
    try {
      const saved = JSON.parse(raw)
      if (saved?.since !== sinceMs) return null
      const seen = new Set(
        Array.isArray(saved.seen)
          ? saved.seen.filter(entry => typeof entry === 'string').slice(-100_000)
          : [],
      )
      return { bucket: sanitizeBucket(saved.total), seen }
    } catch {
      return null
    }
  }

  /**
   * Persist today's counter. Atomic (temp file + rename) and coalesced, so a
   * burst of commits writes at most one file per `SAVE_MS`.
   * @param {boolean} [force] - Write even if the debounce window is open.
   * @returns {Promise<void>} settle after the write attempt.
   */
  async saveState(force = false) {
    if (this.base === null) return
    if (this.writing) {
      // Remember that a write is still owed, and whether it must be unthrottled.
      this.writeAgain = true
      this.writeForce = this.writeForce || force
      return
    }
    if (!force && Date.now() - this.savedAt < 5000) {
      this.saveOwed = true
      return
    }
    this.writing = true
    try {
      const directory = stateDirectory()
      await fs.mkdir(directory, { recursive: true })
      // Trim the seen-set to a bounded, newest-first slice before writing.
      const seen = [...this.seen].slice(-50_000)
      const payload = JSON.stringify({
        version: 1,
        since: this.sinceMs,
        savedAt: new Date().toISOString(),
        total: this.base,
        seen,
      })
      const path = join(directory, `${this.sinceMs}.json`)
      const temp = `${path}.tmp`
      await fs.writeFile(temp, payload, 'utf8')
      await fs.rename(temp, path)
      this.savedAt = Date.now()
    } catch {
      // A failed write only costs durability for this window, never correctness
      // of the live figure; the next commit retries.
    } finally {
      this.writing = false
    }
    if (this.writeAgain) {
      const forced = this.writeForce === true
      this.writeAgain = false
      this.writeForce = false
      await this.saveState(forced)
    }
  }

  /**
   * Delete counters older than yesterday so the directory stays small.
   * @param {number} sinceMs - Today's day start.
   */
  async pruneOldState(sinceMs) {
    const directory = stateDirectory()
    let names
    try {
      names = await fs.readdir(directory)
    } catch {
      return
    }
    for (const name of names) {
      const match = /^(\d{10,})\.json$/.exec(name)
      if (match === null) continue
      if (Number(match[1]) >= sinceMs - 86_400_000) continue
      try {
        await fs.unlink(join(directory, name))
      } catch {
        // A leftover file is harmless.
      }
    }
  }

  /**
   * Reading for the Client half.
   * @returns {Promise<{ ok: true, value: { total: number, input: number, output: number, cacheRead: number, cacheWrite: number, requests: number, since: string, readAt: string } } | { ok: false, error: { code: string, message: string } }>} Reading.
   */
  async read() {
    try {
      const today = this.dayStart()
      if (this.base === null || this.sinceMs !== today) {
        // First read (or a new day): rebuild from the logs once.
        this.base = null
        await this.prime()
      }
      return {
        ok: true,
        value: {
          ...this.base,
          since: new Date(this.sinceMs).toISOString(),
          readAt: new Date().toISOString(),
        },
      }
    } catch (error) {
      return { ok: false, error: { code: 'scan-failed', message: messageOf(error) } }
    }
  }
}

Object.defineProperty(DailyTokensService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'read', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

/**
 * Mount the daily-token Remote on this Host composition.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 */
export function apply(ctx) {
  const service = new DailyTokensService(ctx)
  service.typertRemote = Object.freeze({
    service,
    serviceKey: 'dailyTokens',
    namespace: 'dailyTokens',
  })
  // The Remote is only reachable once the service is provided under this name:
  // the Client calls `/api/dailyTokens/read`.
  ctx.provide('dailyTokens', service)
  // Flush the durable counter before the process goes away.
  ctx.effect(() => () => { void service.saveState(true) }, 'daily-tokens: flush on unload')
  // Live feed: every committed event arrives here, so the figure moves without
  // re-reading any file.
  ctx.on('session/event', (session, event) => service.observe(session, event))
}