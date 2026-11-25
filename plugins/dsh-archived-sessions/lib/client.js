/**
 * dsh-archived-sessions — 浏览器半侧（手写 ModuleLoader bundle，无需构建）
 *
 * 在 DSH 窗口标题栏加一个「已归档」按钮；点开弹窗列出被归档（从侧边栏收起）的
 * 会话，点「恢复」调用 Host 半侧的 /restore 接口完成恢复。模块主体只做定义，
 * 只有 apply 里才碰 DOM，避免页面启动阶段把 UI 带崩。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-archived-sessions',
  factory: function () {
    var API = '/dsh-archived-sessions'
    var VERSION = '0.1.0'
    var Z = 2147482400

    /* ── 文案 ───────────────────────────────────────────────────────────── */

    var zh = {
      button: '已归档',
      title: '已归档会话',
      subtitle: '这些会话只是被收起，恢复不会改动任何聊天记录',
      refresh: '刷新',
      close: '关闭',
      restore: '恢复',
      restoring: '恢复中…',
      restored: '已恢复',
      untitled: '（未命名会话）',
      lastActive: '最后活动',
      empty: '没有已归档的会话',
      emptyHint: 'DSH 的「删除会话」实际是归档：会话数据一直保存在磁盘上，随时可以恢复。',
      loading: '正在读取归档列表…',
      retry: '重试',
      loadFailed: '读取归档列表失败',
      restoreFailed: '恢复失败',
      restoredNotice: '已恢复《{title}》，它已经回到侧边栏。',
      unauth: '浏览器信任校验未通过，请刷新页面后再试。',
      footer: '恢复只改工作区记账，不会改写会话日志。',
    }

    var en = {
      button: 'Archived',
      title: 'Archived sessions',
      subtitle: 'Hidden, not deleted — restoring never touches chat history',
      refresh: 'Refresh',
      close: 'Close',
      restore: 'Restore',
      restoring: 'Restoring…',
      restored: 'Restored',
      untitled: '(Untitled session)',
      lastActive: 'last active',
      empty: 'No archived sessions',
      emptyHint: 'DSH "delete" is archive: the session data stays on disk and can always be restored.',
      loading: 'Loading archived sessions…',
      retry: 'Retry',
      loadFailed: 'Failed to load archived sessions',
      restoreFailed: 'Restore failed',
      restoredNotice: 'Restored "{title}" — it is back in the sidebar.',
      unauth: 'Browser trust check failed. Refresh the page and try again.',
      footer: 'Restore only updates workspace bookkeeping; session logs are untouched.',
    }

    function detectLang() {
      try {
        return String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    var T = detectLang() === 'zh' ? zh : en

    /* ── 状态 ───────────────────────────────────────────────────────────── */

    var state = {
      booted: false,
      panel: false,
      loading: false,
      error: null,
      sessions: [],
    }

    var btnHost = null
    var btnLabel = null
    var modal = null
    var refs = null
    var observer = null
    var positionTimer = null
    var keyHandler = null
    var styleEl = null

    /* ── 样式（全部走宿主主题 token） ────────────────────────────────────── */

    var CSS = [
      '.dsa-btn-host{position:fixed;top:0;left:0;height:var(--dsh-windows-titlebar-height,40px);display:flex;align-items:center;gap:2px;z-index:1102;-webkit-app-region:no-drag}',
      '.dsa-btn{height:28px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6470);font:inherit;font-size:14px;cursor:default;display:inline-flex;align-items:center;gap:6px}',
      '.dsa-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111827)}',
      '.dsa-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3964fe);outline-offset:-2px}',
      '.dsa-btn svg{width:15px;height:15px;flex:none;opacity:.85}',
      '.dsa-btn-host.dsa-float{top:auto;left:auto;right:18px;bottom:18px;height:auto;width:auto;z-index:900}',
      '.dsa-float .dsa-btn{height:36px;padding:0 14px;border-radius:999px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:0 8px 24px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#111827);cursor:pointer}',
      '.dsa-backdrop{position:fixed;inset:0;z-index:' + Z + ';background:rgba(12,14,18,.46);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}',
      '.dsa-modal{position:relative;width:min(640px,94vw);max-height:min(720px,86vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111827);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:16px;box-shadow:0 24px 90px rgba(0,0,0,.4);overflow:hidden;font-family:var(--dsw-font-family,system-ui,sans-serif)}',
      '.dsa-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dsa-brand{display:flex;align-items:center;gap:12px;min-width:0}',
      '.dsa-logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#2b7fff,#1f6feb);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
      '.dsa-logo svg{width:19px;height:19px}',
      '.dsa-titles{min-width:0}',
      '.dsa-title{font-size:16px;font-weight:650;letter-spacing:.01em}',
      '.dsa-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919b);margin-top:2px}',
      '.dsa-actions{display:flex;align-items:center;gap:6px;flex:none}',
      '.dsa-chip{min-width:22px;height:22px;padding:0 7px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 12%,transparent);color:var(--dsw-alias-state-business-primary,#3964fe);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsa-ghost{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5b6470);border-radius:8px;height:30px;padding:0 12px;font:inherit;font-size:12.5px;cursor:pointer}',
      '.dsa-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111827)}',
      '.dsa-list{flex:1;min-height:120px;overflow:auto;padding:6px 20px 10px}',
      '.dsa-row{display:flex;align-items:center;gap:14px;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.dsa-row:last-child{border-bottom:0}',
      '.dsa-row-main{min-width:0;flex:1}',
      '.dsa-row-title{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsa-row-meta{margin-top:3px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsa-restore{flex:none;height:30px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}',
      '.dsa-restore:hover{filter:brightness(1.06)}',
      '.dsa-restore:disabled{opacity:.55;cursor:default}',
      '.dsa-row-restored{opacity:.55}',
      '.dsa-empty{padding:44px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}',
      '.dsa-empty-title{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5b6470)}',
      '.dsa-empty-hint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a919b);max-width:420px}',
      '.dsa-spinner{width:22px;height:22px;border-radius:50%;border:2.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-top-color:var(--dsw-alias-state-business-primary,#3964fe);animation:dsa-spin .8s linear infinite}',
      '@keyframes dsa-spin{to{transform:rotate(360deg)}}',
      '.dsa-error{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-state-error-primary,#c4342b);max-width:460px}',
      '.dsa-notice{margin:0 20px;padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.6;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3964fe) 10%,transparent);color:var(--dsw-alias-state-business-primary,#3964fe)}',
      '.dsa-notice.error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f85149) 10%,transparent);color:var(--dsw-alias-state-error-primary,#c4342b)}',
      '.dsa-foot{padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919b)}',
    ]

    /* ── 小工具 ─────────────────────────────────────────────────────────── */

    function el(tag, className) {
      var node = document.createElement(tag)
      if (className) node.className = className
      return node
    }

    function text(tag, className, value) {
      var node = el(tag, className)
      node.textContent = value == null ? '' : String(value)
      return node
    }

    function clear(node) {
      while (node && node.firstChild) node.removeChild(node.firstChild)
    }

    function ago(iso) {
      if (!iso) return ''
      var then = new Date(iso).getTime()
      if (!isFinite(then)) return ''
      var diff = Math.max(0, Date.now() - then)
      var min = Math.floor(diff / 60000)
      if (min < 60) return Math.max(1, min) + 'm'
      var hour = Math.floor(min / 60)
      if (hour < 24) return hour + 'h'
      var day = Math.floor(hour / 24)
      if (day < 30) return day + 'd'
      var month = Math.floor(day / 30)
      if (month < 12) return month + 'mo'
      return Math.floor(month / 12) + 'y'
    }

    function injectStyle() {
      try {
        if (styleEl && styleEl.isConnected) return
        styleEl = document.createElement('style')
        styleEl.id = 'dsa-style'
        styleEl.textContent = CSS.join('')
        ;(document.head || document.body).appendChild(styleEl)
      } catch (error) {
        console.warn('[dsh-archived-sessions] 样式注入失败', error)
      }
    }

    function removeStyle() {
      try {
        if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      } catch (error) {
        /* ignore */
      }
      styleEl = null
    }

    function api(pathname, options) {
      var init = { method: 'GET', headers: {}, credentials: 'same-origin' }
      if (options) {
        if (options.method) init.method = options.method
        if (options.body !== undefined) {
          init.headers['Content-Type'] = 'application/json'
          init.body = JSON.stringify(options.body)
        }
      }
      return fetch(API + pathname, init).then(function (response) {
        var status = (response && response.status) || 200
        return response.json().catch(function () { return {} }).then(function (data) {
          if (status >= 400) {
            if (status === 401 || status === 403) return { ok: false, error: T.unauth }
            if (!data || typeof data !== 'object') return { ok: false, error: 'HTTP ' + status }
            if (data.ok === undefined) data.ok = false
            if (!data.error) data.error = 'HTTP ' + status
          }
          return data || {}
        })
      })
    }

    function hasTitlebar() {
      try {
        return document.documentElement.hasAttribute('data-windows-titlebar')
      } catch (error) {
        return false
      }
    }

    function ping() {
      api('/ping', {
        method: 'POST',
        body: {
          href: window.location.href.slice(0, 400),
          version: VERSION,
          titlebar: hasTitlebar(),
          button: Boolean(btnHost && btnHost.isConnected),
          open: state.panel,
          count: state.sessions.length,
          error: state.error || null,
        },
      }).catch(function () {})
    }

    function updateButtonCount() {
      if (!btnLabel) return
      var n = state.sessions.length
      btnLabel.textContent = n > 0 ? T.button + ' ' + n : T.button
    }

    /* ── 标题栏按钮 ─────────────────────────────────────────────────────── */

    var ICON_ARCHIVE =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/></svg>'

    function buildButton() {
      var host = el('div', 'dsa-btn-host')
      host.setAttribute('data-dsh-archived-sessions-button', '')
      var button = el('button', 'dsa-btn')
      button.type = 'button'
      button.title = T.button
      button.setAttribute('aria-label', T.button)
      button.innerHTML = ICON_ARCHIVE
      var label = text('span', 'dsa-btn-label', T.button)
      button.appendChild(label)
      button.addEventListener('click', function () {
        if (state.panel) closePanel()
        else openPanel()
      })
      host.appendChild(button)
      document.body.appendChild(host)
      btnHost = host
      btnLabel = label
      syncButtonPosition()
      return host
    }

    function syncButtonPosition() {
      if (!btnHost || !btnHost.isConnected) return
      if (!hasTitlebar()) {
        btnHost.classList.add('dsa-float')
        btnHost.style.left = ''
        btnHost.style.display = ''
        return
      }
      btnHost.classList.remove('dsa-float')
      /* 排在插件商店按钮之后；插件商店没装时退回「应用 / 编辑」右侧。 */
      var anchor = document.querySelector('[data-dsh-plugin-store-button]')
      if (anchor && anchor.isConnected) {
        var ar = anchor.getBoundingClientRect()
        if (ar && ar.height > 0) {
          btnHost.style.display = ''
          btnHost.style.left = Math.round(ar.right + 2) + 'px'
          return
        }
      }
      var menu = document.querySelector('[data-windows-menu]')
      if (!menu) {
        btnHost.style.display = 'none'
        return
      }
      var mr = menu.getBoundingClientRect()
      if (!mr || mr.height === 0) {
        btnHost.style.display = 'none'
        return
      }
      btnHost.style.display = ''
      btnHost.style.left = Math.round(mr.right + 4) + 'px'
    }

    function mountButton() {
      if (btnHost && btnHost.isConnected) return
      if (!document.body) return
      buildButton()
      if (observer) observer.disconnect()
      observer = new MutationObserver(function () { syncButtonPosition() })
      observer.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('resize', syncButtonPosition)
      if (positionTimer) clearInterval(positionTimer)
      positionTimer = setInterval(syncButtonPosition, 1200)
      syncButtonPosition()
      ping()
      api('/list').then(function (data) {
        if (data && data.ok === true && Array.isArray(data.sessions)) {
          state.sessions = data.sessions
          updateButtonCount()
        }
        syncButtonPosition()
      }).catch(function () {})
    }

    /* ── 弹窗 ───────────────────────────────────────────────────────────── */

    function openPanel() {
      if (state.panel) return
      state.panel = true
      buildModal()
      refresh()
      ping()
    }

    function closePanel() {
      if (!state.panel) return
      state.panel = false
      if (keyHandler) {
        try { document.removeEventListener('keydown', keyHandler) } catch (error) { /* ignore */ }
        keyHandler = null
      }
      if (modal) {
        modal.remove()
        modal = null
        refs = null
      }
      ping()
    }

    function buildModal() {
      var backdrop = el('div', 'dsa-backdrop')
      backdrop.addEventListener('click', function (event) {
        if (event.target === backdrop) closePanel()
      })

      var card = el('div', 'dsa-modal')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      card.setAttribute('aria-label', T.title)

      var head = el('div', 'dsa-head')
      var brand = el('div', 'dsa-brand')
      var logo = el('div', 'dsa-logo')
      logo.innerHTML = ICON_ARCHIVE
      brand.appendChild(logo)
      var titles = el('div', 'dsa-titles')
      titles.appendChild(text('div', 'dsa-title', T.title))
      titles.appendChild(text('div', 'dsa-sub', T.subtitle))
      brand.appendChild(titles)
      head.appendChild(brand)

      var actions = el('div', 'dsa-actions')
      var chip = text('span', 'dsa-chip', '0')
      var refreshBtn = text('button', 'dsa-ghost', T.refresh)
      refreshBtn.type = 'button'
      refreshBtn.addEventListener('click', function () { refresh(true) })
      var closeBtn = text('button', 'dsa-ghost', T.close)
      closeBtn.type = 'button'
      closeBtn.addEventListener('click', closePanel)
      actions.appendChild(chip)
      actions.appendChild(refreshBtn)
      actions.appendChild(closeBtn)
      head.appendChild(actions)

      var list = el('div', 'dsa-list')
      var notice = text('div', 'dsa-notice', '')
      notice.style.display = 'none'
      var foot = text('div', 'dsa-foot', T.footer)

      card.appendChild(head)
      card.appendChild(list)
      card.appendChild(notice)
      card.appendChild(foot)
      backdrop.appendChild(card)
      document.body.appendChild(backdrop)

      modal = backdrop
      refs = { list: list, chip: chip, notice: notice }
      keyHandler = function (event) {
        if (event && event.key === 'Escape') closePanel()
      }
      document.addEventListener('keydown', keyHandler)
      render()
    }

    function setNotice(kind, message) {
      if (!refs) return
      refs.notice.className = 'dsa-notice' + (kind ? ' ' + kind : '')
      refs.notice.textContent = message || ''
      refs.notice.style.display = message ? '' : 'none'
    }

    function render() {
      if (!refs) return
      clear(refs.list)
      refs.chip.textContent = String(state.sessions.length)

      if (state.loading && state.sessions.length === 0) {
        var loading = el('div', 'dsa-empty')
        loading.appendChild(el('div', 'dsa-spinner'))
        loading.appendChild(text('div', 'dsa-empty-title', T.loading))
        refs.list.appendChild(loading)
        return
      }

      if (state.error) {
        var failed = el('div', 'dsa-empty')
        failed.appendChild(text('div', 'dsa-error', state.error))
        var retry = text('button', 'dsa-ghost', T.retry)
        retry.type = 'button'
        retry.addEventListener('click', function () { refresh(true) })
        failed.appendChild(retry)
        refs.list.appendChild(failed)
        return
      }

      if (!state.sessions.length) {
        var empty = el('div', 'dsa-empty')
        empty.appendChild(text('div', 'dsa-empty-title', T.empty))
        empty.appendChild(text('div', 'dsa-empty-hint', T.emptyHint))
        refs.list.appendChild(empty)
        return
      }

      for (var i = 0; i < state.sessions.length; i += 1) {
        refs.list.appendChild(renderRow(state.sessions[i]))
      }
    }

    function renderRow(session) {
      var row = el('div', 'dsa-row')
      if (session.id) row.setAttribute('data-dsh-archived-session-id', String(session.id))

      var main = el('div', 'dsa-row-main')
      main.appendChild(text('div', 'dsa-row-title', session.title || T.untitled))

      var bits = []
      if (session.workspaceTitle) bits.push(session.workspaceTitle)
      var active = ago(session.lastActiveAt)
      if (active) bits.push(T.lastActive + ' ' + active)
      if (session.id) {
        bits.push(session.id.length > 28 ? session.id.slice(0, 28) + '…' : session.id)
      }
      main.appendChild(text('div', 'dsa-row-meta', bits.join(' · ')))
      row.appendChild(main)

      var restore = text('button', 'dsa-restore', T.restore)
      restore.type = 'button'
      restore.addEventListener('click', function () { restoreSession(session, row, restore) })
      row.appendChild(restore)
      return row
    }

    function restoreSession(session, row, button) {
      if (button.disabled) return
      button.disabled = true
      button.textContent = T.restoring
      setNotice(null, null)
      api('/restore', { method: 'POST', body: { sessionId: session.id } }).then(function (data) {
        if (!data || data.ok !== true) {
          button.disabled = false
          button.textContent = T.restore
          setNotice('error', (data && data.error) ? data.error : T.restoreFailed)
          return
        }
        state.sessions = state.sessions.filter(function (item) { return item.id !== session.id })
        if (refs) refs.chip.textContent = String(state.sessions.length)
        row.classList.add('dsa-row-restored')
        button.textContent = T.restored
        updateButtonCount()
        setNotice('ok', T.restoredNotice.replace('{title}', session.title || T.untitled))
        ping()
        setTimeout(function () {
          if (state.panel) render()
        }, 900)
      }).catch(function (error) {
        button.disabled = false
        button.textContent = T.restore
        setNotice('error', String((error && error.message) || error))
      })
    }

    function refresh(manual) {
      state.loading = true
      state.error = null
      if (manual) setNotice(null, null)
      render()
      api('/list').then(function (data) {
        state.loading = false
        if (!data || data.ok !== true) {
          state.error = (data && data.error) ? data.error : T.loadFailed
        } else {
          state.sessions = Array.isArray(data.sessions) ? data.sessions : []
        }
        updateButtonCount()
        render()
        ping()
      }).catch(function (error) {
        state.loading = false
        state.error = String((error && error.message) || error)
        render()
        ping()
      })
    }

    /* ── 生命周期 ───────────────────────────────────────────────────────── */

    function cleanup() {
      try {
        if (observer) observer.disconnect()
      } catch (error) { /* ignore */ }
      observer = null
      if (positionTimer) {
        clearInterval(positionTimer)
        positionTimer = null
      }
      try {
        window.removeEventListener('resize', syncButtonPosition)
      } catch (error) { /* ignore */ }
      if (keyHandler) {
        try { document.removeEventListener('keydown', keyHandler) } catch (error) { /* ignore */ }
        keyHandler = null
      }
      if (modal) {
        modal.remove()
        modal = null
        refs = null
      }
      if (btnHost) {
        btnHost.remove()
        btnHost = null
        btnLabel = null
      }
      removeStyle()
      state.panel = false
    }

    function apply(ctx) {
      if (state.booted) return
      state.booted = true
      injectStyle()

      var start = function () {
        try {
          mountButton()
        } catch (error) {
          console.warn('[dsh-archived-sessions] 标题栏按钮挂载失败', error)
        }
      }

      if (document.body) start()
      else document.addEventListener('DOMContentLoaded', start, { once: true })

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () { cleanup() }
        })
      }
    }

    return { inject: [], apply: apply }
  },
})
