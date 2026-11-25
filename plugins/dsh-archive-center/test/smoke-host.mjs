/**
 * Host 半侧冒烟测试（归档中心 v0.2）：
 *   1) 用临时 DSH_HOME 造工作区 + 会话日志 + 投影缓存 + 会话元数据
 *   2) /list：工作区缺失标记、子会话数
 *   3) /restore：工作区记录缺失时用 cwd 重建工作区并挂回会话，再取消归档
 *   4) /delete：级联删除主会话与子会话的日志、投影缓存，并清理记账
 *   5) /health /ping 与卸载清理
 *
 * 运行：node test/smoke-host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dac-smoke-'))
process.env.DSH_HOME = home

/* ── 目录与存储 ─────────────────────────────────────────────────────── */

const wsDirOne = path.join(home, 'project-one')
fs.mkdirSync(wsDirOne, { recursive: true })

const storages = path.join(home, 'storages')
const projcacheDir = path.join(storages, 'session_projcache', 'sessions')
fs.mkdirSync(projcacheDir, { recursive: true })

const workspaceFile = path.join(storages, 'workspace.json')
const archivedIds = ['session-main', 'session-cascade', 'session-keep']
const workspaceDoc = {
  unit: { name: 'workspace', version: 2 },
  global: { archivedSessionIds: archivedIds },
  tables: {
    workspaces: {
      'ws-1': { title: '工作区一', path: wsDirOne, sessionIds: ['session-cascade', 'session-keep'] },
    },
  },
}
function persistWorkspaceDoc() {
  fs.writeFileSync(workspaceFile, JSON.stringify(workspaceDoc, null, 2))
}
persistWorkspaceDoc()

const sessionsRoot = path.join(home, 'sessions')
const wsSessionsDir = path.join(sessionsRoot, '--project-one--')
for (const id of ['session-main', 'session-cascade', 'session-keep', 'child-1']) {
  const dir = path.join(wsSessionsDir, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('fake-log-content'))
}

function writeProjcache(id, title, cwd) {
  fs.writeFileSync(
    path.join(projcacheDir, `${id}.json`),
    JSON.stringify({ record: { identity: { cwd }, rows: { title: { val: title } } } }),
  )
}
writeProjcache('session-main', '主会话（工作区已丢）', path.join(home, 'project-main'))
writeProjcache('session-cascade', '级联删除测试', wsDirOne)
writeProjcache('session-keep', '保留测试', wsDirOne)

const sessionHeaders = new Map([
  ['session-main', { id: 'session-main', cwd: path.join(home, 'project-main') }],
  ['session-cascade', { id: 'session-cascade', cwd: wsDirOne }],
  ['session-keep', { id: 'session-keep', cwd: wsDirOne }],
  ['child-1', { id: 'child-1', cwd: wsDirOne, parentSession: 'session-cascade', origin: 'subagent' }],
])

/* ── 载入 Host 半侧 ─────────────────────────────────────────────────── */

const mod = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href)
assert.equal(typeof mod.apply, 'function')
assert.ok(mod.inject.includes('webServer'))
assert.ok(mod.inject.includes('workspaceRegistry'))

const routes = new Map()
const disposed = []
let disposePlugin = null
const restored = []
const detached = []
const attached = []
let createdPath = null

function makeWorkspace(id, title, dirPath, sessionIds) {
  return {
    id,
    path: dirPath,
    title,
    sessionIds,
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) {
        this.sessionIds.push(sessionId)
        attached.push(sessionId)
        workspaceDoc.tables.workspaces[this.id].sessionIds = this.sessionIds.slice()
        persistWorkspaceDoc()
      }
    },
    async detachSession(sessionId) {
      this.sessionIds = this.sessionIds.filter((id) => id !== sessionId)
      detached.push(sessionId)
      if (workspaceDoc.tables.workspaces[this.id]) {
        workspaceDoc.tables.workspaces[this.id].sessionIds = this.sessionIds.slice()
        persistWorkspaceDoc()
      }
    },
    async status() {
      return 'ok'
    },
  }
}

const workspaces = [makeWorkspace('ws-1', '工作区一', wsDirOne, ['session-cascade', 'session-keep'])]

const registry = {
  list() {
    return workspaces
  },
  async create(dirPath, title) {
    createdPath = dirPath
    const ws = makeWorkspace('ws-new', title || '重建工作区', dirPath, [])
    workspaces.push(ws)
    workspaceDoc.tables.workspaces['ws-new'] = { title: ws.title, path: dirPath, sessionIds: [] }
    persistWorkspaceDoc()
    return ws
  },
  async unarchiveSession(sessionId) {
    restored.push(sessionId)
    const index = workspaceDoc.global.archivedSessionIds.indexOf(sessionId)
    if (index >= 0) workspaceDoc.global.archivedSessionIds.splice(index, 1)
    persistWorkspaceDoc()
  },
  async unpinSession() {},
}

const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => {
      disposed.push(route.path)
      routes.delete(route.path)
    }
  },
}

const sessionQuery = {
  async listSessions() {
    return [...sessionHeaders.values()].map((header) => ({ header, live: false, persisted: true }))
  },
}

const ctx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'connection') return { requestRejection: () => null }
    if (name === 'sessionQuery') return sessionQuery
    if (name === 'subagents') return { async listDescendants() { return [] } }
    if (name === 'agents') return { get() { return undefined } }
    return undefined
  },
  webServer,
  logger: { info() {}, warn() {} },
  effect(fn) {
    disposePlugin = fn()
  },
  workspaceRegistry: registry,
}

mod.apply(ctx)

assert.ok(disposePlugin)
assert.deepEqual(
  [...routes.keys()].sort(),
  [
    '/dsh-archive-center/delete',
    '/dsh-archive-center/health',
    '/dsh-archive-center/list',
    '/dsh-archive-center/ping',
    '/dsh-archive-center/restore',
  ].sort(),
)

function makeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    body: null,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(body) {
      this.body = body
      this.headersSent = true
    },
  }
}
const jsonOf = (res) => JSON.parse(Buffer.from(res.body).toString('utf8'))
const getReq = (url) => ({ method: 'GET', url, headers: {} })
function postReq(url, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')])
  req.method = 'POST'
  req.url = url
  req.headers = {}
  return req
}

/* ── /list ──────────────────────────────────────────────────────────── */

{
  const res = makeRes()
  await routes.get('/dsh-archive-center/list').handler(getReq('/dsh-archive-center/list'), res)
  const data = jsonOf(res)
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.equal(data.count, 3)
  const byId = Object.fromEntries(data.sessions.map((s) => [s.id, s]))
  assert.equal(byId['session-main'].workspaceMissing, true, '工作区缺失被标记')
  assert.equal(byId['session-main'].childCount, 0)
  assert.equal(byId['session-keep'].workspaceTitle, '工作区一')
  assert.equal(byId['session-cascade'].childCount, 1, '识别子会话数量')
}

/* ── /restore（工作区缺失 → 用 cwd 重建） ──────────────────────────── */

{
  const res = makeRes()
  await routes.get('/dsh-archive-center/restore').handler(
    postReq('/dsh-archive-center/restore', { sessionId: 'session-main' }),
    res,
  )
  const data = jsonOf(res)
  assert.equal(data.ok, true, JSON.stringify(data))
  assert.equal(data.rebuiltWorkspace, true, '重建了工作区')
  assert.equal(createdPath, path.join(home, 'project-main'), '按会话原始 cwd 创建')
  assert.ok(attached.includes('session-main'), '会话挂回工作区')
  assert.ok(restored.includes('session-main'), '取消归档')
  assert.equal(data.sessions.some((s) => s.id === 'session-main'), false, '恢复后不在归档列表')
}

/* ── /delete（级联子会话） ──────────────────────────────────────────── */

{
  const res = makeRes()
  await routes.get('/dsh-archive-center/delete').handler(
    postReq('/dsh-archive-center/delete', { sessionId: 'session-cascade' }),
    res,
  )
  const data = jsonOf(res)
  assert.equal(data.ok, true, JSON.stringify(data))
  assert.equal(data.childCount, 1, '级联删除了 1 个子会话')
  assert.ok(data.deletedIds.includes('session-cascade'))
  assert.ok(data.deletedIds.includes('child-1'))
  assert.ok(data.bytes > 0)
  assert.equal(fs.existsSync(path.join(wsSessionsDir, 'session-cascade')), false, '主会话日志目录已删')
  assert.equal(fs.existsSync(path.join(wsSessionsDir, 'child-1')), false, '子会话日志目录已删')
  assert.equal(fs.existsSync(path.join(projcacheDir, 'session-cascade.json')), false, '主会话投影缓存已删')
  assert.ok(detached.includes('session-cascade'), '工作区记账已解除')
}

/* ── /delete 单个会话 ───────────────────────────────────────────────── */

{
  const res = makeRes()
  await routes.get('/dsh-archive-center/delete').handler(
    postReq('/dsh-archive-center/delete', { sessionId: 'session-keep' }),
    res,
  )
  const data = jsonOf(res)
  assert.equal(data.ok, true)
  assert.equal(data.childCount, 0)
  assert.equal(fs.existsSync(path.join(wsSessionsDir, 'session-keep')), false)
}

/* ── 缺 sessionId 与重复删除的错误路径 ─────────────────────────────── */

{
  const missing = makeRes()
  await routes.get('/dsh-archive-center/delete').handler(postReq('/dsh-archive-center/delete', {}), missing)
  assert.equal(jsonOf(missing).ok, false)

  const gone = makeRes()
  await routes.get('/dsh-archive-center/delete').handler(
    postReq('/dsh-archive-center/delete', { sessionId: 'session-keep' }),
    gone,
  )
  assert.equal(jsonOf(gone).ok, false, '已删除的会话再次删除应失败')
}

/* ── /ping 与 /health ───────────────────────────────────────────────── */

{
  const pingRes = makeRes()
  await routes.get('/dsh-archive-center/ping').handler(
    postReq('/dsh-archive-center/ping', { href: 'http://127.0.0.1:1/', version: '0.2.0', titlebar: true, button: true, open: false, count: 0 }),
    pingRes,
  )
  assert.equal(jsonOf(pingRes).ok, true)

  const healthRes = makeRes()
  await routes.get('/dsh-archive-center/health').handler(getReq('/dsh-archive-center/health'), healthRes)
  const health = jsonOf(healthRes)
  assert.equal(healthRes.statusCode, 200)
  assert.equal(health.name, 'dsh-archive-center')
  assert.equal(health.ping.button, true)
}

/* ── 卸载 ───────────────────────────────────────────────────────────── */

disposePlugin()
assert.equal(routes.size, 0)
assert.equal(disposed.length, 5)

/* ── 没有 webServer 时不抛错 ────────────────────────────────────────── */

mod.apply({ logger: { info() {}, warn() {} } })

fs.rmSync(home, { recursive: true, force: true })
console.log('smoke-host: ok (list, workspace rebuild, cascade delete, health/ping, cleanup)')
