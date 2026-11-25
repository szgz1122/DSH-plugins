/**
 * Client 半侧冒烟测试：最小 DOM 桩，验证 ModuleLoader 注册、apply 挂载、卸载清理。
 * 运行：node test/smoke-client.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

class NodeStub {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.attrs = {}
    this.className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.value = ''
    this.isConnected = true
    this.classList = {
      add: (name) => {
        if (this.className.indexOf(name) < 0) this.className = (this.className + ' ' + name).trim()
      },
      remove: (name) => {
        this.className = this.className.replace(new RegExp('(^|\\s)' + name + '(?=\\s|$)', 'g'), ' ').trim()
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    }
  }

  appendChild(child) {
    if (!child) return child
    child.parentNode = this
    child.isConnected = true
    this.children.push(child)
    return child
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    child.isConnected = false
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
    this.isConnected = false
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  getAttribute(name) {
    return this.attrs[name] ?? null
  }

  addEventListener() {}
  removeEventListener() {}
  querySelector() {
    return null
  }
  querySelectorAll() {
    return []
  }
  getBoundingClientRect() {
    return { right: 0, left: 0, top: 0, bottom: 0, width: 0, height: 0 }
  }
  focus() {}
}

const documentElement = new NodeStub('html')
documentElement.lang = 'zh-CN'
documentElement.hasAttribute = () => false

const documentStub = {
  documentElement,
  head: new NodeStub('head'),
  body: new NodeStub('body'),
  createElement: (tag) => new NodeStub(tag),
  createTextNode: (value) => ({ nodeType: 3, textContent: String(value) }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}

const windowStub = {
  location: { href: 'http://127.0.0.1:1/' },
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
}

let captured = null
windowStub.__ModuleLoader__ = {
  load(entry) {
    captured = entry
  },
}

let fetchCount = 0
const intervals = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, delay) => {
  intervals.push({ fn, delay })
  return realSetInterval(fn, delay)
}

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Node = NodeStub
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.fetch = async () => {
  fetchCount += 1
  return {
    status: 200,
    ok: true,
    json: async () => ({ ok: true, config: {}, current: { phase: 'valley' }, series: [] }),
  }
}
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

vm.runInThisContext(source, { filename: 'client.js' })
assert.ok(captured, 'ModuleLoader 收到注册')
assert.equal(captured.id, 'dsh-token-wave', 'id 与包名一致')
assert.equal(typeof captured.factory, 'function')

const exportsObject = captured.factory(() => {
  throw new Error('client bundle 不应 require 任何东西')
})
assert.equal(typeof exportsObject.apply, 'function')
assert.ok(Array.isArray(exportsObject.inject))

let dispose = null
const ctx = {
  effect(fn) {
    dispose = fn()
  },
}
exportsObject.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 20))

assert.equal(documentStub.body.children.length, 1, '标题栏按钮宿主挂进 body')
const host = documentStub.body.children[0]
assert.equal(host.attrs['data-dsh-token-wave-button'], '', '带数据属性标记')
assert.equal(host.children.length, 1, '一个按钮')
assert.equal(host.children[0].tagName, 'BUTTON')
assert.ok(documentStub.head.children.length >= 1, '样式已注入')

/* 标题栏按钮必须常驻 60 秒刷新：即使面板没开，也要自己更新峰/谷 */
const buttonInterval = intervals.find((item) => item.delay === 60000)
assert.ok(buttonInterval, '注册了 60 秒的按钮状态刷新定时器')
const fetchBeforeTick = fetchCount
buttonInterval.fn()
await new Promise((resolve) => setTimeout(resolve, 20))
assert.ok(fetchCount > fetchBeforeTick, '60 秒定时器会重新请求 /state 更新按钮')

exportsObject.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(documentStub.body.children.length, 1, '重复 apply 不重复挂')

assert.equal(typeof dispose, 'function')
dispose()
assert.equal(documentStub.body.children.length, 0, '卸载移除按钮宿主')
assert.equal(documentStub.head.children.length, 0, '卸载移除样式')

console.log('smoke-client: ok (registration, titlebar mount, idempotent apply, cleanup)')
