/**
 * dsh-archive-center — Host 半侧（v0.2）
 *
 * 归档中心：
 *   - 列出被归档（从侧边栏收起）的会话；
 *   - 恢复：调用 DSH 原生 workspaceRegistry.unarchiveSession；如果该会话的工作区
 *     记录已缺失，则用会话原始 cwd 重建工作区、把会话挂回去，再取消归档；
 *   - 彻底删除：二次确认后，级联删除该会话及其全部子会话的日志目录、投影缓存，
 *     并从工作区记账 / 归档集合 / 置顶集合中移除。不可恢复。
 *
 * 恢复只改工作区记账；彻底删除才会删除磁盘上的会话日志。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-archive-center'
export const inject = ['webServer', 'connection', 'workspaceRegistry']

const NS = 'dsh-archive-center'
const BASE = '/dsh-archive-center'
const VERSION = '0.2.0'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
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

function safeStat(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function dirSize(dir) {
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(target)
    else {
      const st = safeStat(target)
      if (st) total += st.size
    }
  }
  return total
}

function sessionWorkspaceDirs() {
  try {
    return fs
      .readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(SESSIONS_ROOT, entry.name))
  } catch {
    return []
  }
}

function findSessionDirs(sessionId) {
  const found = []
  for (const workspaceDir of sessionWorkspaceDirs()) {
    const candidate = path.join(workspaceDir, sessionId)
    const st = safeStat(candidate)
    if (st && st.isDirectory()) found.push(candidate)
  }
  return found
}

/** DSH 持久化工作区状态：归档 id 集合 + 工作区表。 */
function readWorkspaceState() {
  const doc = readJson(path.join(DSH_HOME, 'storages', 'workspace.json'))
  const archived = Array.isArray(doc?.global?.archivedSessionIds)
    ? doc.global.archivedSessionIds.filter((id) => typeof id === 'string' && id.length > 0)
    : []
  const workspaces = doc?.tables?.workspaces && typeof doc.tables.workspaces === 'object' ? doc.tables.workspaces : {}
  return { archived, workspaces }
}

function readProjcache(sessionId) {
  return readJson(path.join(PROJCACHE_DIR, `${sessionId}.json`))
}

function readTitle(sessionId) {
  const cache = readProjcache(sessionId)
  const title = cache?.record?.rows?.title?.val
  if (typeof title === 'string' && title.trim()) return title.trim()
  const first = cache?.record?.rows?.titleInput?.val?.first?.text
  if (typeof first === 'string' && first.trim()) return first.trim().slice(0, 60)
  return ''
}

function readCwdFromProjcache(sessionId) {
  const cache = readProjcache(sessionId)
  const cwd = cache?.record?.identity?.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

function readLastActiveAt(sessionId) {
  for (const workspaceDir of sessionWorkspaceDirs()) {
    const log = path.join(workspaceDir, sessionId, 'session.v4.jsonl.zstd')
    const st = safeStat(log)
    if (st) return st.mtime.toISOString()
  }
  return null
}

/**
 * 全量会话元数据：header 里带 cwd / parentSession，用来
 *   1) 计算每个归档会话的子会话数量（级联删除用）；
 *   2) 工作区缺失时拿到原始 cwd 重建工作区。
 */
async function collectCorpus(ctx) {
  const records = new Map()
  const children = new Map()
  const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
  try {
    const list = await query.listSessions()
    for (const record of list || []) {
      const header = record?.header
      if (!header?.id) continue
      records.set(header.id, header)
      if (header.parentSession) {
        const kids = children.get(header.parentSession) || []
        kids.push(header.id)
        children.set(header.parentSession, kids)
      }
    }
  } catch {
    /* 没有 sessionQuery 时退化为只看文件与归档表 */
  }
  return { records, children }
}

function descendantsOf(rootId, children) {
  const out = []
  const seen = new Set([rootId])
  const stack = [rootId]
  while (stack.length) {
    const current = stack.pop()
    for (const kid of children.get(current) || []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      out.push(kid)
      stack.push(kid)
    }
  }
  return out
}

function findWorkspaceFor(workspaces, sessionId) {
  return workspaces.find((ws) => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) || null
}

async function buildList(ctx) {
  const registry = ctx.workspaceRegistry
  const workspaces = typeof registry.list === 'function' ? registry.list() : []
  const bySession = new Map()
  for (const ws of workspaces) {
    for (const id of ws.sessionIds || []) bySession.set(id, ws)
  }
  const { archived } = readWorkspaceState()
  const { records, children } = await collectCorpus(ctx)
  const sessions = archived.map((id) => {
    const ws = bySession.get(id) || null
    const header = records.get(id) || null
    const cwd = header?.cwd || readCwdFromProjcache(id) || ws?.path || null
    let workspaceDirMissing = false
    if (ws?.path) {
      const st = safeStat(ws.path)
      workspaceDirMissing = !st || !st.isDirectory()
    }
    const childCount = descendantsOf(id, children).length
    return {
      id,
      title: readTitle(id),
      workspaceId: ws?.id || null,
      workspaceTitle: ws?.title || '',
      workspacePath: ws?.path || '',
      workspaceMissing: !ws,
      workspaceDirMissing,
      cwd,
      lastActiveAt: readLastActiveAt(id),
      childCount,
    }
  })
  sessions.sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))
  return sessions
}

/** 恢复一个归档会话；工作区记录缺失时用会话 cwd 重建工作区。 */
async function restoreSession(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  const workspaces = typeof registry.list === 'function' ? registry.list() : []
  let ws = findWorkspaceFor(workspaces, sessionId)

  const { records } = await collectCorpus(ctx)
  const cwd = records.get(sessionId)?.cwd || readCwdFromProjcache(sessionId) || ws?.path || null
  let rebuiltWorkspace = false
  let createdDirectory = false

  if (!ws) {
    if (!cwd) return { ok: false, error: '无法确定该会话的原工作区目录，无法恢复工作区' }
    const st = safeStat(cwd)
    if (!st || !st.isDirectory()) {
      try {
        fs.mkdirSync(cwd, { recursive: true })
        createdDirectory = true
      } catch {
        return { ok: false, error: `原工作区目录不存在且无法重建：${cwd}` }
      }
    }
    try {
      ws = await registry.create(cwd, path.basename(path.resolve(cwd)) || undefined)
      rebuiltWorkspace = true
    } catch (error) {
      return { ok: false, error: `重建工作区失败：${error?.message || error}` }
    }
  } else if (ws.path) {
    const st = safeStat(ws.path)
    if (!st || !st.isDirectory()) {
      try {
        fs.mkdirSync(ws.path, { recursive: true })
        createdDirectory = true
      } catch {
        /* 目录重建失败不阻塞恢复，status 会在 UI 里提示 */
      }
    }
  }

  try {
    if (ws && !ws.sessionIds.includes(sessionId)) await ws.attachSession(sessionId)
  } catch (error) {
    return { ok: false, error: `会话挂回工作区失败：${error?.message || error}` }
  }

  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    return { ok: false, error: `取消归档失败：${error?.message || error}` }
  }

  return { ok: true, sessionId, rebuiltWorkspace, createdDirectory, workspaceTitle: ws?.title || null }
}

/** 彻底删除：主会话 + 全部子会话（不可恢复）。 */
async function deleteSessionTree(ctx, sessionId) {
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents && typeof agents.get === 'function' && agents.get(sessionId)) {
    return { ok: false, error: '该会话正在运行，请先归档或停止后再删除' }
  }

  const registry = ctx.workspaceRegistry
  const { records, children } = await collectCorpus(ctx)
  const childIds = descendantsOf(sessionId, children)

  /* 额外用 subagents 的持久目录补全子会话列表（两份来源取并集）。 */
  try {
    const subagents = typeof ctx.get === 'function' ? ctx.get('subagents') : undefined
    if (subagents && typeof subagents.listDescendants === 'function') {
      const entries = await subagents.listDescendants(sessionId)
      for (const entry of entries || []) {
        if (entry?.kind !== 'child' || !entry.id) continue
        if (entry.id === sessionId) continue
        if (!childIds.includes(entry.id)) childIds.push(entry.id)
      }
    }
  } catch {
    /* 目录不可读时至少按 header.parentSession 的级联树删除 */
  }

  const ids = [sessionId, ...childIds]
  const deletedIds = []
  let bytes = 0

  for (const id of ids) {
    for (const ws of registry.list()) {
      if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(id)) {
        try {
          await ws.detachSession(id)
        } catch {
          /* 记账清理失败不阻塞文件删除 */
        }
      }
    }
    try {
      await registry.unpinSession(id)
    } catch {
      /* 幂等 */
    }
    try {
      await registry.unarchiveSession(id)
    } catch {
      /* 幂等 */
    }

    let touched = false
    for (const dir of findSessionDirs(id)) {
      bytes += dirSize(dir)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        touched = true
      } catch {
        /* 占用中的文件跳过 */
      }
    }
    const cacheFile = path.join(PROJCACHE_DIR, `${id}.json`)
    const cacheStat = safeStat(cacheFile)
    if (cacheStat) {
      bytes += cacheStat.size
      try {
        fs.rmSync(cacheFile, { force: true })
        touched = true
      } catch {
        /* ignore */
      }
    }
    if (touched) deletedIds.push(id)
  }

  if (!deletedIds.includes(sessionId)) {
    return { ok: false, error: '未找到该会话的日志或投影缓存，可能已经被删除' }
  }

  return {
    ok: true,
    sessionId,
    deletedIds,
    childCount: childIds.filter((id) => deletedIds.includes(id)).length,
    bytes,
  }
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
      /* ignore */
    }
  }

  if (!hasRoutes(webServer)) {
    try {
      ctx.logger?.warn?.(`[${NS}] 当前 profile 没有可用的 webServer，归档中心接口不会注册。`)
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

  const readJsonBody = async (req) => {
    try {
      return JSON.parse((await readBody(req)) || '{}')
    } catch {
      return {}
    }
  }

  const registerAll = () => {
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
            archived: archived.length,
            ping: readJson(PING_FILE),
          })
        },
      },
      { publicRoute: true },
    )

    registerRoute(
      {
        kind: 'exact',
        path: `${BASE}/ping`,
        handler: async (req, res) => {
          if ((req.method || 'GET').toUpperCase() !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const payload = await readJsonBody(req)
          const record = {
            at: nowIso(),
            href: typeof payload?.href === 'string' ? payload.href.slice(0, 512) : null,
            clientVersion: typeof payload?.version === 'string' ? payload.version.slice(0, 64) : null,
            titlebar: payload?.titlebar === true,
            button: payload?.button === true,
            open: payload?.open === true,
            count: Number.isFinite(payload?.count) ? payload.count : null,
            sheet: typeof payload?.sheet === 'string' ? payload.sheet.slice(0, 64) : null,
            error: typeof payload?.error === 'string' ? payload.error.slice(0, 600) : null,
          }
          writeJsonAtomic(PING_FILE, record)
          sendJson(res, 200, { ok: true, at: record.at })
        },
      },
      { publicRoute: true },
    )

    registerRoute({
      kind: 'exact',
      path: `${BASE}/list`,
      handler: async (req, res) => {
        const sessions = await buildList(ctx)
        sendJson(res, 200, { ok: true, count: sessions.length, sessions })
      },
    })

    registerRoute({
      kind: 'exact',
      path: `${BASE}/restore`,
      handler: async (req, res) => {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) {
          sendJson(res, 200, { ok: false, error: '缺少 sessionId' })
          return
        }
        const result = await restoreSession(ctx, sessionId)
        if (result.ok) {
          try {
            result.sessions = await buildList(ctx)
          } catch {
            result.sessions = []
          }
        }
        sendJson(res, 200, result)
      },
    })

    registerRoute({
      kind: 'exact',
      path: `${BASE}/delete`,
      handler: async (req, res) => {
        if ((req.method || 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const body = await readJsonBody(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) {
          sendJson(res, 200, { ok: false, error: '缺少 sessionId' })
          return
        }
        const result = await deleteSessionTree(ctx, sessionId)
        if (result.ok) {
          try {
            result.sessions = await buildList(ctx)
          } catch {
            result.sessions = []
          }
        }
        sendJson(res, 200, result)
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
