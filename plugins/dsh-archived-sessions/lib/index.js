/**
 * dsh-archived-sessions — Host 半侧
 *
 * 职责：
 *   1) 读取 ~/.dsh 里 DSH 自己的归档状态（workspace.json 的 archivedSessionIds），
 *      与每个会话的投影缓存标题，拼出一份「已归档会话」列表。
 *   2) 提供恢复接口：调用公开的 ctx.workspaceRegistry.unarchiveSession，只改工作区
 *      记账，绝不改写会话日志文件。
 *   3) 提供公用的 /health 路由与浏览器半侧的 /ping 心跳，方便确认按钮是否挂上。
 *
 * 会话日志（sessions/<工作区>/<会话id>/session.v4.jsonl.zstd）全程只读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-archived-sessions'
export const inject = ['webServer', 'connection', 'workspaceRegistry']

const NS = 'dsh-archived-sessions'
const BASE = '/dsh-archived-sessions'
const VERSION = '0.1.0'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, NS)
const PING_FILE = path.join(STATE_DIR, 'ping.json')
const STARTED_AT = new Date().toISOString()
const MAX_BODY = 64 * 1024

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
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** DSH 的持久化工作区状态：归档 id 列表 + 工作区表（含每个工作区的会话 id）。 */
function readWorkspaceState() {
  const doc = readJson(path.join(DSH_HOME, 'storages', 'workspace.json'))
  const archived = Array.isArray(doc?.global?.archivedSessionIds)
    ? doc.global.archivedSessionIds.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  const workspaces = doc?.tables?.workspaces && typeof doc.tables.workspaces === 'object'
    ? doc.tables.workspaces
    : {}
  return { archived, workspaces }
}

/** 标题来自会话投影缓存；没有标题时退回首条用户消息。 */
function readTitle(sessionId) {
  const cache = readJson(
    path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`),
  )
  const title = cache?.record?.rows?.title?.val
  if (typeof title === 'string' && title.trim()) return title.trim()
  const first = cache?.record?.rows?.titleInput?.val?.first?.text
  if (typeof first === 'string' && first.trim()) return first.trim().slice(0, 60)
  return ''
}

/** 会话日志最后写入时间（只读 stat，不读内容）。 */
function readLastActiveAt(sessionId) {
  try {
    const root = path.join(DSH_HOME, 'sessions')
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const log = path.join(root, dir.name, sessionId, 'session.v4.jsonl.zstd')
      try {
        return fs.statSync(log).mtime.toISOString()
      } catch {
        /* 换下一个工作区目录 */
      }
    }
  } catch {
    /* 没有 sessions 目录时不影响列表 */
  }
  return null
}

/** 已归档会话视图（按最后活动时间倒序）。 */
export function listArchivedSessions() {
  const { archived, workspaces } = readWorkspaceState()
  const sessions = []
  for (const id of archived) {
    let workspaceId = null
    let workspaceTitle = ''
    let workspacePath = ''
    for (const [wid, ws] of Object.entries(workspaces)) {
      const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : []
      if (ids.includes(id)) {
        workspaceId = wid
        workspaceTitle = typeof ws?.title === 'string' ? ws.title : ''
        workspacePath = typeof ws?.path === 'string' ? ws.path : ''
        break
      }
    }
    sessions.push({
      id,
      title: readTitle(id),
      workspaceId,
      workspaceTitle,
      workspacePath,
      lastActiveAt: readLastActiveAt(id),
    })
  }
  sessions.sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))
  return sessions
}

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch {
    /* 取不到就当没有 */
  }
  return ctx.webServer
}

function hasRoutes(server) {
  return Boolean(server && typeof server.register === 'function')
}

export function apply(ctx) {
  const webServer = resolveWebServer(ctx)
  const log = (...args) => {
    try {
      ctx.logger?.info?.(`[${NS}]`, ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.(`[${NS}] 当前 profile 没有可用的 webServer，已归档会话接口不会注册。`)
    } catch {
      /* ignore */
    }
    return
  }

  const disposers = []

  function sendJson(res, code, payload) {
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

  function sendText(res, code, text) {
    const body = Buffer.from(String(text), 'utf8')
    try {
      res.writeHead(code, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(body.length),
      })
      res.end(body)
    } catch {
      /* ignore */
    }
  }

  function readBody(req) {
    return new Promise((resolve) => {
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
  }

  function rejected(req, res) {
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
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) })
          } else {
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
    /* 公开健康检查：确认 Host 半侧活着、浏览器半侧按钮是否已挂载。 */
    registerRoute(
      {
        kind: 'exact',
        path: `${BASE}/health`,
        handler: (req, res) => {
          const { archived } = readWorkspaceState()
          sendJson(res, 200, {
            ok: true,
            name: NS,
            version: VERSION,
            pid: process.pid,
            startedAt: STARTED_AT,
            dshHome: DSH_HOME,
            archived: archived.length,
            ping: readJson(PING_FILE),
          })
        },
      },
      { publicRoute: true },
    )

    /* 浏览器半侧心跳：用于判断标题栏按钮是否真的挂上了。 */
    registerRoute(
      {
        kind: 'exact',
        path: `${BASE}/ping`,
        handler: async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          let payload = {}
          try {
            payload = JSON.parse((await readBody(req)) || '{}')
          } catch {
            payload = {}
          }
          const record = {
            at: nowIso(),
            href: typeof payload?.href === 'string' ? payload.href.slice(0, 512) : null,
            clientVersion: typeof payload?.version === 'string' ? payload.version.slice(0, 64) : null,
            titlebar: payload?.titlebar === true,
            button: payload?.button === true,
            open: payload?.open === true,
            count: Number.isFinite(payload?.count) ? payload.count : null,
            error: typeof payload?.error === 'string' ? payload.error.slice(0, 600) : null,
          }
          writeJsonAtomic(PING_FILE, record)
          sendJson(res, 200, { ok: true, at: record.at })
        },
      },
      { publicRoute: true },
    )

    /* 已归档会话列表。 */
    registerRoute({
      kind: 'exact',
      path: `${BASE}/list`,
      handler: (req, res) => {
        const sessions = listArchivedSessions()
        sendJson(res, 200, { ok: true, count: sessions.length, sessions })
      },
    })

    /* 恢复一个已归档会话：沿用 DSH 原生 unarchiveSession。 */
    registerRoute({
      kind: 'exact',
      path: `${BASE}/restore`,
      handler: async (req, res) => {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        let body = {}
        try {
          body = JSON.parse((await readBody(req)) || '{}')
        } catch {
          body = {}
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) {
          sendJson(res, 200, { ok: false, error: '缺少 sessionId' })
          return
        }
        const { archived } = readWorkspaceState()
        if (!archived.includes(sessionId)) {
          sendJson(res, 200, { ok: false, error: '该会话当前不在归档列表中' })
          return
        }
        try {
          await ctx.workspaceRegistry.unarchiveSession(sessionId)
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) })
          return
        }
        sendJson(res, 200, { ok: true, sessionId, sessions: listArchivedSessions() })
      },
    })
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
