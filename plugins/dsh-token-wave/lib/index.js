/**
 * dsh-token-wave — Host 半侧
 *
 * 标题栏「价格走势图（峰/谷）」插件：按 DeepSeek 现行的分时计价规则判断
 * 当前是峰期还是谷期，并给出最近 N 天（默认 30 天）的逐小时价格走势。
 *
 * 规则来源与桌宠 dsh-pet / 功能坞 dsh-dock 保持一致：
 *   - 时区 Asia/Shanghai
 *   - 工作日（周一至周五）09:00–12:00、14:00–18:00 为峰期，其余时段为谷期
 *   - 周六、周日全天谷期
 * 单价可在界面里改，保存到 ~/.dsh/token-wave.json。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-token-wave'
export const inject = ['webServer', 'connection']

const NS = 'dsh-token-wave'
const BASE = '/dsh-token-wave'
const VERSION = '0.2.1'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'token-wave.json')
const MAX_BODY = 64 * 1024
const STARTED_AT = new Date().toISOString()

const DEFAULT_SEGMENTS = [
  { start: '09:00', end: '12:00', days: 'workday' },
  { start: '14:00', end: '18:00', days: 'workday' },
]

const DEFAULTS = {
  timezone: 'Asia/Shanghai',
  peakSegments: DEFAULT_SEGMENTS,
  peakPrice: 3,
  valleyPrice: 1.5,
  currency: '¥',
  unit: '/ 百万 tokens',
  model: 'DeepSeek-V4.1-Flash',
  windowDays: 30,
}

const nowIso = () => new Date().toISOString()

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function readConfig() {
  return normalizeConfig(readJson(CONFIG_FILE), DEFAULTS)
}

function parseHHMM(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

function formatHHMM(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`
}

function normalizeDays(value) {
  return value === 'workday' || value === 'nonworkday' ? value : 'all'
}

function normalizeSegments(input) {
  const list = Array.isArray(input) ? input : []
  const segments = []
  for (const item of list.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue
    const start = parseHHMM(item.start)
    const end = parseHHMM(item.end)
    if (start === null || end === null || start === end) continue
    segments.push({ start: formatHHMM(start), end: formatHHMM(end), days: normalizeDays(item.days) })
  }
  return segments.length ? segments : DEFAULT_SEGMENTS.map((item) => ({ ...item }))
}

function isValidTimezone(zone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone }).format(new Date())
    return true
  } catch {
    return false
  }
}

function normalizeConfig(input, base = DEFAULTS) {
  const config = { ...base, peakSegments: base.peakSegments.map((item) => ({ ...item })) }
  const source = input && typeof input === 'object' ? input : {}
  if (typeof source.timezone === 'string' && isValidTimezone(source.timezone)) config.timezone = source.timezone
  if (Array.isArray(source.peakSegments)) config.peakSegments = normalizeSegments(source.peakSegments)
  const peak = Number(source.peakPrice)
  if (Number.isFinite(peak) && peak >= 0 && peak <= 100000) config.peakPrice = peak
  const valley = Number(source.valleyPrice)
  if (Number.isFinite(valley) && valley >= 0 && valley <= 100000) config.valleyPrice = valley
  if (typeof source.currency === 'string' && source.currency.trim()) config.currency = source.currency.trim().slice(0, 8)
  if (typeof source.unit === 'string' && source.unit.trim()) config.unit = source.unit.trim().slice(0, 24)
  if (typeof source.model === 'string' && source.model.trim()) config.model = source.model.trim().slice(0, 80)
  const windowDays = Number(source.windowDays)
  if (Number.isFinite(windowDays)) config.windowDays = Math.min(90, Math.max(1, Math.round(windowDays)))
  return config
}

const localFormatters = new Map()
function localParts(date, timeZone) {
  let formatter = localFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    localFormatters.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(date)
  const weekday = parts.find((part) => part.type === 'weekday')?.value || 'Mon'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0)
  return { weekday, minutes: hour * 60 + minute }
}

function dayMatches(days, weekday) {
  const weekend = weekday === 'Sat' || weekday === 'Sun'
  if (days === 'workday') return !weekend
  if (days === 'nonworkday') return weekend
  return true
}

function inSegment(minutes, segment) {
  const start = parseHHMM(segment.start)
  const end = parseHHMM(segment.end)
  if (start === null || end === null) return false
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

/** 当前是否峰期；判定口径与 dsh-pet / dsh-dock 一致。 */
function isPeak(config, date) {
  const { weekday, minutes } = localParts(date, config.timezone)
  for (const segment of config.peakSegments) {
    if (!dayMatches(segment.days, weekday)) continue
    if (inSegment(minutes, segment)) return true
  }
  return false
}

function priceAt(config, date) {
  return isPeak(config, date) ? config.peakPrice : config.valleyPrice
}

/** 距离下一次峰/谷切换还有多久（分钟），以及切换后的状态。 */
function nextSwitch(config, date) {
  const current = isPeak(config, date)
  for (let offset = 1; offset <= 60 * 24 * 8; offset += 1) {
    const candidate = new Date(date.getTime() + offset * 60000)
    if (isPeak(config, candidate) !== current) {
      return { minutes: offset, to: current ? 'valley' : 'peak' }
    }
  }
  return { minutes: null, to: current ? 'valley' : 'peak' }
}

function buildSeries(config, now) {
  const points = []
  const count = Math.max(1, config.windowDays) * 24
  const stepMs = 60 * 60 * 1000
  for (let index = count - 1; index >= 0; index -= 1) {
    const at = new Date(now.getTime() - index * stepMs)
    const peak = isPeak(config, at)
    points.push({ t: at.toISOString(), price: peak ? config.peakPrice : config.valleyPrice, off: !peak })
  }
  return points
}

function buildState(config, at) {
  const date = at instanceof Date && !Number.isNaN(at.getTime()) ? at : new Date()
  const peak = isPeak(config, date)
  const switching = nextSwitch(config, date)
  return {
    ok: true,
    version: VERSION,
    now: date.toISOString(),
    generatedAt: nowIso(),
    config,
    current: {
      off: !peak,
      phase: peak ? 'peak' : 'valley',
      price: peak ? config.peakPrice : config.valleyPrice,
      peakPrice: config.peakPrice,
      valleyPrice: config.valleyPrice,
      nextSwitchAt: switching.minutes === null ? null : new Date(date.getTime() + switching.minutes * 60000).toISOString(),
      nextPhase: switching.to,
      minutesToSwitch: switching.minutes,
    },
    series: buildSeries(config, date),
  }
}

function resolveWebServer(ctx) {
  try {
    const fromGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (fromGet && typeof fromGet.register === 'function') return fromGet
    if (ctx.webServer && typeof ctx.webServer.register === 'function') return ctx.webServer
  } catch {
    /* ignore */
  }
  return undefined
}

function urlOf(req) {
  try {
    return new URL(req?.url || '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

export function apply(ctx) {
  const webServer = resolveWebServer(ctx)
  const log = (...args) => {
    try {
      ctx.logger?.info?.(`[${NS}]`, ...args)
    } catch {
      /* ignore */
    }
  }
  if (!webServer) {
    try {
      ctx.logger?.warn?.(`[${NS}] 当前 profile 没有可用的 webServer，价格走势图接口不会注册。`)
    } catch {
      /* ignore */
    }
    return
  }

  const disposers = []

  const sendJson = (res, code, payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    try {
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
      })
      res.end(body)
    } catch {
      /* 连接已断开 */
    }
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let size = 0
      const chunks = []
      if (!req || typeof req.on !== 'function') {
        resolve('')
        return
      }
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
          resolve('')
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

  const rejected = (req, res) => {
    try {
      const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch {
      return false
    }
  }

  const registerRoute = (route, { publicRoute = false } = {}) => {
    const inner = route.handler
    const wrapped = {
      ...route,
      handler: async (req, res) => {
        try {
          if (!publicRoute && rejected(req, res)) return
          await inner(req, res)
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message || error) })
          else {
            try {
              res.end()
            } catch {
              /* ignore */
            }
          }
        }
      },
    }
    const dispose = webServer.register(wrapped)
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  }

  const registerAll = () => {
    registerRoute(
      {
        kind: 'exact',
        path: `${BASE}/health`,
        handler: (req, res) => {
          sendJson(res, 200, {
            ok: true,
            name: NS,
            version: VERSION,
            startedAt: STARTED_AT,
            configFile: CONFIG_FILE,
            now: nowIso(),
          })
        },
      },
      { publicRoute: true }
    )

    registerRoute({
      kind: 'exact',
      path: `${BASE}/state`,
      handler: (req, res) => {
        const url = urlOf(req)
        const atParam = url.searchParams.get('at')
        let at = new Date()
        if (atParam) {
          const parsed = new Date(atParam)
          if (!Number.isNaN(parsed.getTime())) at = parsed
        }
        sendJson(res, 200, buildState(readConfig(), at))
      },
    })

    registerRoute(
      {
        kind: 'exact',
        path: `${BASE}/config`,
        handler: async (req, res) => {
          const method = (req.method || 'GET').toUpperCase()
          if (method === 'GET') {
            sendJson(res, 200, { ok: true, config: readConfig() })
            return
          }
          if (method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = JSON.parse((await readBody(req)) || '{}')
          const config = normalizeConfig(body, readConfig())
          const saved = writeJsonAtomic(CONFIG_FILE, config)
          sendJson(res, 200, { ok: saved, config, error: saved ? undefined : '写入配置失败' })
        },
      },
      { publicRoute: false }
    )
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      registerAll()
      return () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      }
    })
  } else {
    registerAll()
  }

  log(`已注册 ${BASE} 路由`, { DSH_HOME })
}

export const __test = { isPeak, buildState, normalizeConfig, nextSwitch, buildSeries, DEFAULTS }
