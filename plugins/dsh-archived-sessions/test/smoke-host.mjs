/**
 * Host 半侧冒烟测试：
 *   1) 用临时 DSH_HOME 造一份 workspace.json + 投影缓存 + 会话日志
 *   2) apply 后路由按预期注册
 *   3) /list 返回归档会话（标题、工作区、最后活动时间）
 *   4) /restore 调用 workspaceRegistry.unarchiveSession 并更新列表
 *   5) /health 与 /ping 可用
 *   6) 卸载时路由被注销
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
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-smoke-'))
process.env.DSH_HOME = home

/* ── 造一份最小 DSH 存储 ─────────────────────────────────────────────── */

const storages = path.join(home, 'storages')
const projcacheDir = path.join(storages, 'session_projcache', 'sessions')
fs.mkdirSync(projcacheDir, { recursive: true })

const workspaceFile = path.join(storages, 'workspace.json')
const workspaceDoc = {
  unit: { name: 'workspace', version: 2 },
  global: { archivedSessionIds: ['session-a', 'session-b'] },
  tables: {
    workspaces: {
      'ws-1': { title: '测试工作区', path: 'C:\\test', sessionIds: ['session-a', 'session-b'] },
    },
  },
}
fs.writeFileSync(workspaceFile, JSON.stringify(workspaceDoc, null, 2))

fs.writeFileSync(
  path.join(projcacheDir, 'session-a.json'),
  JSON.stringify({ record: { rows: { title: { val: '会话 A 标题' } } } }),
)
fs.writeFileSync(
  path.join(projcacheDir, 'session-b.json'),
  JSON.stringify({ record: { rows: { titleInput: { val: { first: { text: '会话 B 的首条消息' } } } } } }),
)

for (const id of ['session-a', 'session-b']) {
  const dir = path.join(home, 'sessions', '--ws-1--', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
}

/* ── 载入 Host 半侧并挂载 ────────────────────────────────────────────── */

const mod = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href)

assert.equal(typeof mod.apply, 'function')
assert.ok(Array.isArray(mod.inject))
assert.ok(mod.inject.includes('webServer'))
assert.ok(mod.inject.includes('workspaceRegistry'))

const routes = new Map()
const disposed = []
const restored = []
let disposePlugin = null

const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => {
      disposed.push(route.path)
      routes.delete(route.path)
    }
  },
}

const ctx = {
  get(name) {
    if (name === 'webServer') return webServer
    if (name === 'connection') return { requestRejection: () => null }
    return undefined
  },
  webServer,
  logger: { info() {}, warn() {} },
  effect(fn) {
    disposePlugin = fn()
  },
  workspaceRegistry: {
    async unarchiveSession(sessionId) {
      restored.push(sessionId)
      workspaceDoc.global.archivedSessionIds = workspaceDoc.global.archivedSessionIds.filter((id) => id !== sessionId)
      fs.writeFileSync(workspaceFile, JSON.stringify(workspaceDoc, null, 2))
    },
  },
}

mod.apply(ctx)

assert.ok(disposePlugin, 'apply 注册了可清理的 effect')
assert.deepEqual(
  [...routes.keys()].sort(),
  [
    '/dsh-archived-sessions/health',
    '/dsh-archived-sessions/list',
    '/dsh-archived-sessions/ping',
    '/dsh-archived-sessions/restore',
  ].sort(),
)

/* ── 假 req/res ─────────────────────────────────────────────────────── */

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

function jsonOf(res) {
  return JSON.parse(Buffer.from(res.body).toString('utf8'))
}

function getReq(url) {
  return { method: 'GET', url, headers: {} }
}

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
  await routes.get('/dsh-archived-sessions/list').handler(getReq('/dsh-archived-sessions/list'), res)
  const data = jsonOf(res)
  assert.equal(res.statusCode, 200)
  assert.equal(data.ok, true)
  assert.equal(data.count, 2)
  const byId = Object.fromEntries(data.sessions.map((s) => [s.id, s]))
  assert.equal(byId['session-a'].title, '会话 A 标题')
  assert.equal(byId['session-a'].workspaceTitle, '测试工作区')
  assert.equal(byId['session-b'].title, '会话 B 的首条消息')
  assert.ok(byId['session-a'].lastActiveAt, '带最后活动时间')
}

/* ── /restore ───────────────────────────────────────────────────────── */

{
  const res = makeRes()
  await routes.get('/dsh-archived-sessions/restore').handler(
    postReq('/dsh-archived-sessions/restore', { sessionId: 'session-a' }),
    res,
  )
  const data = jsonOf(res)
  assert.equal(data.ok, true)
  assert.deepEqual(restored, ['session-a'])
  assert.equal(data.sessions.length, 1)

  const again = makeRes()
  await routes.get('/dsh-archived-sessions/restore').handler(
    postReq('/dsh-archived-sessions/restore', { sessionId: 'session-a' }),
    again,
  )
  assert.equal(jsonOf(again).ok, false, '重复恢复给出明确失败')

  const missing = makeRes()
  await routes.get('/dsh-archived-sessions/restore').handler(
    postReq('/dsh-archived-sessions/restore', {}),
    missing,
  )
  assert.equal(jsonOf(missing).ok, false, '缺少 sessionId 时失败')
}

/* ── /ping 与 /health ───────────────────────────────────────────────── */

{
  const pingRes = makeRes()
  await routes.get('/dsh-archived-sessions/ping').handler(
    postReq('/dsh-archived-sessions/ping', {
      href: 'http://127.0.0.1:1/',
      version: '0.1.0',
      titlebar: true,
      button: true,
      open: false,
      count: 1,
    }),
    pingRes,
  )
  assert.equal(jsonOf(pingRes).ok, true)

  const healthRes = makeRes()
  await routes.get('/dsh-archived-sessions/health').handler(
    getReq('/dsh-archived-sessions/health'),
    healthRes,
  )
  const health = jsonOf(healthRes)
  assert.equal(healthRes.statusCode, 200)
  assert.equal(health.ok, true)
  assert.equal(health.name, 'dsh-archived-sessions')
  assert.equal(health.archived, 1)
  assert.equal(health.ping.button, true, 'health 能读到浏览器心跳')
}

/* ── 卸载 ───────────────────────────────────────────────────────────── */

disposePlugin()
assert.equal(routes.size, 0, '卸载后路由注销')
assert.equal(disposed.length, 4)

/* ── 没有 webServer 时不应抛错 ──────────────────────────────────────── */

mod.apply({ logger: { info() {}, warn() {} } })

fs.rmSync(home, { recursive: true, force: true })
console.log('smoke-host: ok (routes, list, restore, health/ping, cleanup, no-webServer guard)')
