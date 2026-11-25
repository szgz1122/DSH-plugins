/**
 * Host 半侧冒烟测试：验证路由、峰谷判定（工作日双峰段）、30 天序列、配置读写。
 * 运行：node test/smoke-host.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-token-wave-'))
process.env.DSH_HOME = HOME

const routes = []
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
          routes.push(route)
          return () => {}
        },
      }
    }
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  effect(fn) {
    fn()
  },
  logger: { info() {}, warn() {} },
}

const moduleUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'lib', 'index.js')).href
const mod = await import(moduleUrl)
mod.apply(ctx)

function makeRes() {
  return {
    statusCode: 200,
    headers: null,
    body: '',
    headersSent: false,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    },
  }
}

function makeReq(url, method = 'GET', body) {
  const handlers = new Map()
  const req = {
    url,
    method,
    on(event, callback) {
      handlers.set(event, [...(handlers.get(event) || []), callback])
      return req
    },
    destroy() {},
  }
  if (body !== undefined) {
    queueMicrotask(() => {
      for (const callback of handlers.get('data') || []) callback(Buffer.from(body))
      for (const callback of handlers.get('end') || []) callback()
    })
  }
  return req
}

async function call(routePath, { method = 'GET', body } = {}) {
  const pathname = routePath.split('?')[0]
  const route = routes.find((item) => item.path === pathname)
  assert.ok(route, `route ${pathname} registered`)
  const res = makeRes()
  await route.handler(makeReq(routePath, method, body), res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

const paths = routes.map((route) => route.path).sort()
assert.deepEqual(paths, ['/dsh-token-wave/config', '/dsh-token-wave/health', '/dsh-token-wave/state'])

const health = await call('/dsh-token-wave/health')
assert.equal(health.status, 200)
assert.equal(health.body.ok, true)
assert.equal(health.body.name, 'dsh-token-wave')

/* 工作日 10:30（周二，北京时间）→ 峰期 */
const peak = await call('/dsh-token-wave/state?at=2026-11-03T02:30:00.000Z')
assert.equal(peak.status, 200)
assert.equal(peak.body.current.phase, 'peak')
assert.equal(peak.body.current.price, 3)
assert.equal(peak.body.series.length, 24 * 30)
assert.equal(peak.body.series[peak.body.series.length - 1].price, 3)

/* 工作日 13:00（午休）→ 谷期，且下一次切换应在 14:00 */
const valley = await call('/dsh-token-wave/state?at=2026-11-03T05:00:00.000Z')
assert.equal(valley.body.current.phase, 'valley')
assert.equal(valley.body.current.price, 1.5)
assert.equal(valley.body.current.nextPhase, 'peak')
assert.equal(valley.body.current.minutesToSwitch, 60)

/* 周六 10:30 → 全天谷期 */
const weekend = await call('/dsh-token-wave/state?at=2026-11-07T02:30:00.000Z')
assert.equal(weekend.body.current.phase, 'valley')
assert.equal(weekend.body.current.price, 1.5)

/* 配置读写：改成一个早峰段 + 7 天窗口 */
const saved = await call('/dsh-token-wave/config', {
  method: 'POST',
  body: JSON.stringify({
    peakSegments: [{ start: '08:00', end: '10:00', days: 'workday' }],
    peakPrice: 6,
    valleyPrice: 2,
    currency: '$',
    windowDays: 7,
    model: 'DeepSeek-V4.1-Flash',
  }),
})
assert.equal(saved.status, 200)
assert.equal(saved.body.ok, true)
assert.equal(saved.body.config.peakSegments.length, 1)
assert.equal(saved.body.config.peakSegments[0].start, '08:00')
assert.equal(saved.body.config.peakPrice, 6)

const reloaded = await call('/dsh-token-wave/config')
assert.equal(reloaded.body.config.valleyPrice, 2)
assert.ok(fs.existsSync(path.join(HOME, 'token-wave.json')))

/* 08:30 北京时间 → 新配置下是峰期 */
const afterPeak = await call('/dsh-token-wave/state?at=2026-11-03T00:30:00.000Z')
assert.equal(afterPeak.body.series.length, 7 * 24)
assert.equal(afterPeak.body.current.phase, 'peak')
assert.equal(afterPeak.body.current.price, 6)

/* 11:00 → 新配置下已回到谷期 */
const afterValley = await call('/dsh-token-wave/state?at=2026-11-03T03:00:00.000Z')
assert.equal(afterValley.body.current.phase, 'valley')
assert.equal(afterValley.body.current.price, 2)

fs.rmSync(HOME, { recursive: true, force: true })
console.log('smoke-host: ok (routes, workday peak/valley, weekend valley, 30d series, config roundtrip)')
