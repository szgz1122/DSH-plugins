/**
 * dsh-token-wave — 浏览器半侧（手写 ModuleLoader bundle，无需构建）
 *
 * 标题栏「价格走势图（峰/谷）」按钮 + 面板：
 *   - 按钮实时显示当前是峰期（红）还是谷期（绿）；
 *   - 面板左上角显示峰/谷、当前单价、距下次切换的倒计时；
 *   - 中间是最近 N 天（默认 30 天）的逐小时价格走势，峰红谷绿；
 *   - 每次打开都会重新拉取，打开期间每 30 秒刷新一次，倒计时每秒走。
 *
 * 窗口背景严格遵循 PLUGIN-UI-CONVENTIONS.md：标准 backdrop + bg-base + role=dialog，
 * 不写主题专用样式。
 */
window.__ModuleLoader__.load({
  id: 'dsh-token-wave',
  factory: function () {
    var API = '/dsh-token-wave'
    var VERSION = '0.1.0'
    var Z = 2147482500

    /* ── 文案（每次取词时再判断语言，避免启动时被锁死） ─────────────── */

    var zh = {
      label: '价格走势图',
      peak: '（峰）',
      valley: '（谷）',
      title: '价格走势图',
      subtitle: '当前 Token 峰期 / 谷期与最近走势',
      phasePeak: '峰期',
      phaseValley: '谷期',
      currentPrice: '当前价格',
      perUnit: '/ 百万 tokens',
      nextSwitch: '距下一次切换',
      nextToPeak: '切换到峰期',
      nextToValley: '切换到谷期',
      now: '现在',
      chartTitle: '近 {days} 天价格走势',
      chartHint: '每小时一个点 · 峰期红 / 谷期绿',
      configTitle: '时段与单价设置',
      peak1Start: '峰段 1 开始',
      peak1End: '峰段 1 结束',
      peak2Start: '峰段 2 开始',
      peak2End: '峰段 2 结束',
      peakPriceLabel: '峰期单价',
      valleyPriceLabel: '谷期单价',
      currencyLabel: '货币符号',
      windowDaysLabel: '窗口天数',
      save: '保存设置',
      saving: '保存中…',
      saved: '已保存',
      refresh: '刷新',
      close: '关闭',
      loading: '正在读取价格状态…',
      loadFailed: '读取价格状态失败',
      noData: '暂无数据',
      unauth: '浏览器信任校验未通过，请刷新页面后再试。',
      foot: '按本地时区计算：工作日 09:00–12:00、14:00–18:00 为峰期，周末全天谷期；每次打开、每 30 秒自动更新。单价为示例默认值，可在上方改成自己的计费单价。',
    }

    var en = {
      label: 'Price trend',
      peak: ' (peak)',
      valley: ' (valley)',
      title: 'Token price trend',
      subtitle: 'Current peak / valley pricing and recent trend',
      phasePeak: 'Peak',
      phaseValley: 'Valley',
      currentPrice: 'Current price',
      perUnit: '/ 1M tokens',
      nextSwitch: 'Next switch',
      nextToPeak: 'switch to peak in',
      nextToValley: 'switch to valley in',
      now: 'now',
      chartTitle: 'Price over the last {days} days',
      chartHint: 'One point per hour · peak red / valley green',
      configTitle: 'Schedule & price settings',
      peak1Start: 'Peak 1 starts',
      peak1End: 'Peak 1 ends',
      peak2Start: 'Peak 2 starts',
      peak2End: 'Peak 2 ends',
      peakPriceLabel: 'Peak price',
      valleyPriceLabel: 'Valley price',
      currencyLabel: 'Currency',
      windowDaysLabel: 'Window (days)',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Saved',
      refresh: 'Refresh',
      close: 'Close',
      loading: 'Loading price state…',
      loadFailed: 'Failed to load price state',
      noData: 'No data',
      unauth: 'Browser trust check failed. Refresh the page and try again.',
      foot: 'Computed in local timezone: workdays 09:00–12:00 and 14:00–18:00 are peak, weekends are valley all day. Refreshes on every open and every 30 seconds. Prices are sample defaults — edit them above.',
    }

    function detectLang() {
      try {
        return String(document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        return 'en'
      }
    }

    var T = new Proxy(
      {},
      {
        get: function (_target, key) {
          var dict = detectLang() === 'zh' ? zh : en
          return dict[key]
        },
        has: function (_target, key) {
          return key in (detectLang() === 'zh' ? zh : en)
        },
      }
    )

    /* ── 状态 ─────────────────────────────────────────────────────────── */

    var state = {
      booted: false,
      open: false,
      loading: false,
      saving: false,
      saved: false,
      config: null,
      current: null,
      series: null,
      error: null,
    }

    var refs = {}
    var btnHost = null
    var btnLabel = null
    var btnState = null
    var backdrop = null
    var modal = null
    var styleEl = null
    var observer = null
    var langObserver = null
    var positionTimer = null
    var pollTimer = null
    var tickTimer = null
    var buttonTimer = null

    /* ── 工具 ─────────────────────────────────────────────────────────── */

    function el(tag, className, text) {
      var node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = String(text)
      return node
    }

    function api(pathname, options) {
      var opts = options || {}
      var init = {
        method: opts.method || 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      }
      if (opts.body !== undefined) {
        init.headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(opts.body)
      }
      return fetch(API + pathname, init).then(function (response) {
        return response
          .json()
          .catch(function () {
            return {}
          })
          .then(function (data) {
            if (response.status === 401 || response.status === 403) {
              return { ok: false, error: T.unauth, unauthorized: true }
            }
            if (!response.ok || data.ok === false) {
              var message = data && data.error ? data.error : 'HTTP ' + response.status
              return { ok: false, error: message, data: data }
            }
            return data
          })
      })
    }

    function token(name, fallback) {
      try {
        var value = getComputedStyle(document.body).getPropertyValue(name)
        return value && value.trim() ? value.trim() : fallback
      } catch (error) {
        return fallback
      }
    }

    function money(config, price) {
      if (!config) return String(price)
      return config.currency + price
    }

    function formatDuration(milliseconds) {
      var total = Math.max(0, Math.floor(milliseconds / 1000))
      var hours = Math.floor(total / 3600)
      var minutes = Math.floor((total % 3600) / 60)
      var seconds = total % 60
      return (
        String(hours).padStart(2, '0') +
        ':' +
        String(minutes).padStart(2, '0') +
        ':' +
        String(seconds).padStart(2, '0')
      )
    }

    /* ── 标题栏按钮 ───────────────────────────────────────────────────── */

    var ICON_TREND =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 5-6 4 4 5-7 4 3"/><path d="M3 21h18"/></svg>'

    function hasTitlebar() {
      try {
        return document.documentElement.hasAttribute('data-windows-titlebar')
      } catch (error) {
        return false
      }
    }

    function buildButton() {
      var host = el('div', 'tw-btn-host')
      host.setAttribute('data-dsh-token-wave-button', '')
      var button = el('button', 'tw-btn')
      button.type = 'button'
      button.innerHTML = ICON_TREND
      btnLabel = el('span', 'tw-label', T.label)
      btnState = el('span', 'tw-state peak', T.peak)
      button.appendChild(btnLabel)
      button.appendChild(btnState)
      button.addEventListener('click', function () {
        if (backdrop && backdrop.isConnected) closePanel()
        else openPanel()
      })
      host.appendChild(button)
      document.body.appendChild(host)
      btnHost = host
      syncButtonPosition()
      updateButtonStatus()
      return host
    }

    function syncButtonPosition() {
      if (!btnHost || !btnHost.isConnected) return
      if (!hasTitlebar()) {
        btnHost.classList.add('tw-float')
        btnHost.style.left = ''
        btnHost.style.display = ''
        return
      }
      btnHost.classList.remove('tw-float')
      var anchors = ['[data-dsh-archive-center-button]', '[data-dsh-plugin-store-button]']
      for (var index = 0; index < anchors.length; index += 1) {
        var anchor = document.querySelector(anchors[index])
        if (anchor && anchor.isConnected) {
          var box = anchor.getBoundingClientRect()
          if (box && box.height > 0) {
            btnHost.style.display = ''
            btnHost.style.left = Math.round(box.right + 2) + 'px'
            return
          }
        }
      }
      var menu = document.querySelector('[data-windows-menu]')
      if (!menu) {
        btnHost.style.display = 'none'
        return
      }
      var menuBox = menu.getBoundingClientRect()
      if (!menuBox || menuBox.height === 0) {
        btnHost.style.display = 'none'
        return
      }
      btnHost.style.display = ''
      btnHost.style.left = Math.round(menuBox.right + 4) + 'px'
    }

    function updateButtonStatus() {
      if (!btnHost) return
      var button = btnHost.querySelector('button.tw-btn')
      var phase = state.current ? state.current.phase : null
      if (btnLabel) btnLabel.textContent = T.label
      if (btnState) {
        btnState.textContent = phase === 'valley' ? T.valley : T.peak
        btnState.className = 'tw-state ' + (phase === 'valley' ? 'valley' : 'peak')
      }
      if (button) {
        var label = T.label + (phase === 'valley' ? T.valley : T.peak)
        button.title = label
        button.setAttribute('aria-label', label)
        button.dataset.twLastRefresh = String(Date.now())
      }
    }

    function mountButton() {
      if (btnHost && btnHost.isConnected) return
      if (!document.body) return
      buildButton()
      if (observer) observer.disconnect()
      observer = new MutationObserver(function () {
        syncButtonPosition()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('resize', syncButtonPosition)
      if (positionTimer) clearInterval(positionTimer)
      positionTimer = setInterval(syncButtonPosition, 1200)
      startButtonStatusPolling()
      document.addEventListener('visibilitychange', handleVisibilityChange)
      window.addEventListener('focus', handleWindowFocus)
      if (langObserver) langObserver.disconnect()
      langObserver = new MutationObserver(function () {
        refreshLanguage()
      })
      langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    }

    function refreshButtonStatus() {
      refresh()
    }

    /* 标题栏按钮常驻轮询：面板关着时也每分钟更新一次峰/谷 */
    function startButtonStatusPolling() {
      stopButtonStatusPolling()
      refreshButtonStatus()
      buttonTimer = setInterval(refreshButtonStatus, 60000)
    }

    function stopButtonStatusPolling() {
      if (buttonTimer) {
        clearInterval(buttonTimer)
        buttonTimer = null
      }
    }

    function handleVisibilityChange() {
      if (!document.hidden) refreshButtonStatus()
    }

    function handleWindowFocus() {
      refreshButtonStatus()
    }

    function refreshLanguage() {
      updateButtonStatus()
      if (!state.open) return
      var wasOpen = state.open
      rebuildModal()
      if (wasOpen && state.config) {
        renderStatus()
        drawChart()
      }
    }

    /* ── 样式（遵循统一下载规范：标准 backdrop + bg-base + token） ───────── */

    var CSS = [
      '.tw-btn-host{position:fixed;top:0;left:0;height:var(--dsh-windows-titlebar-height,40px);display:flex;align-items:center;z-index:1103;-webkit-app-region:no-drag}',
      '.tw-btn{height:28px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5b6470);font:inherit;font-size:14px;cursor:default;display:inline-flex;align-items:center;gap:5px}',
      '.tw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111827)}',
      '.tw-btn .tw-state{font-weight:700}',
      '.tw-btn .tw-state.peak{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.tw-btn .tw-state.valley{color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.tw-btn-host.tw-float{top:auto;left:auto;right:18px;bottom:18px;height:auto;width:auto;z-index:900}',
      '.tw-float .tw-btn{height:36px;padding:0 14px;border-radius:999px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));box-shadow:0 8px 24px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary,#111827)}',
      '.tw-backdrop{position:fixed;inset:0;z-index:' + Z + ';background:rgba(12,14,18,.46);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}',
      '.tw-modal{position:relative;width:min(760px,94vw);max-height:min(680px,86vh);display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111827);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:16px;box-shadow:0 24px 90px rgba(0,0,0,.4);overflow:hidden;font-family:var(--dsw-font-family,system-ui,sans-serif)}',
      '.tw-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 20px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.tw-brand{display:flex;align-items:center;gap:12px;min-width:0}',
      '.tw-logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#e5484d,#f2a03d);color:#fff;display:flex;align-items:center;justify-content:center;flex:none}',
      '.tw-logo svg{width:19px;height:19px}',
      '.tw-titles{min-width:0}',
      '.tw-title{font-size:15.5px;font-weight:650}',
      '.tw-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919b);margin-top:2px}',
      '.tw-actions{display:flex;align-items:center;gap:8px}',
      '.tw-ghost,.tw-primary{height:30px;padding:0 12px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer}',
      '.tw-ghost{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#111827);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08))}',
      '.tw-ghost:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.18))}',
      '.tw-primary{background:var(--dsw-alias-state-business-primary,#3964fe);color:#fff;border:1px solid transparent}',
      '.tw-primary:disabled{opacity:.6;cursor:default}',
      '.tw-body{padding:16px 20px;overflow:auto;display:flex;flex-direction:column;gap:14px}',
      '.tw-status{display:flex;align-items:center;gap:18px;flex-wrap:wrap}',
      '.tw-badge{font-size:26px;font-weight:800;line-height:1.1;letter-spacing:.02em}',
      '.tw-badge.peak{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.tw-badge.valley{color:var(--dsw-alias-state-success-primary,#2f9e6b)}',
      '.tw-meta{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#4b5563)}',
      '.tw-meta b{color:var(--dsw-alias-label-primary,#111827);font-size:14px}',
      '.tw-countdown{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#111827);font-weight:600}',
      '.tw-card{border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);padding:12px 14px}',
      '.tw-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#4b5563);margin-bottom:8px}',
      '.tw-canvas{display:block;width:100%;height:230px}',
      '.tw-config{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px 12px}',
      '.tw-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919b)}',
      '.tw-field input{height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.5));color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:12.5px;box-sizing:border-box}',
      '.tw-config-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:2px}',
      '.tw-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919b)}',
      '.tw-error{font-size:12.5px;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.tw-foot{padding:9px 20px;border-top:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.08));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a919b)}',
    ]

    function injectStyle() {
      if (styleEl) return
      styleEl = document.createElement('style')
      styleEl.setAttribute('data-dsh-token-wave-style', '')
      styleEl.textContent = CSS.join('\n')
      document.head.appendChild(styleEl)
    }

    /* ── 面板 ─────────────────────────────────────────────────────────── */

    function reportClientError(message) {
      try {
        var box = document.getElementById('tw-client-error')
        if (!box) {
          box = el('div', '')
          box.id = 'tw-client-error'
          box.style.position = 'fixed'
          box.style.right = '16px'
          box.style.bottom = '16px'
          box.style.maxWidth = '560px'
          box.style.padding = '10px 14px'
          box.style.borderRadius = '10px'
          box.style.background = 'var(--dsw-alias-bg-base, #fff)'
          box.style.color = 'var(--dsw-alias-state-error-primary, #e5484d)'
          box.style.border = '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12))'
          box.style.font = '12px/1.5 monospace'
          box.style.zIndex = '2147483000'
          box.style.whiteSpace = 'pre-wrap'
          document.body.appendChild(box)
        }
        box.textContent = 'dsh-token-wave: ' + String(message || '')
      } catch (error) {
        /* ignore */
      }
    }

    function openPanel() {
      try {
        if (backdrop && backdrop.isConnected) return
        if (backdrop) {
          backdrop.remove()
          backdrop = null
        }
        state.open = true
        rebuildModal()
        refresh()
        startPolling()
      } catch (error) {
        state.open = false
        reportClientError(error && error.stack ? error.stack : error)
      }
    }

    function closePanel() {
      state.open = false
      stopTimers()
      if (backdrop) {
        backdrop.remove()
        backdrop = null
        modal = null
        refs = {}
      }
    }

    function rebuildModal() {
      if (backdrop) {
        backdrop.remove()
        backdrop = null
      }
      var layer = el('div', 'tw-backdrop')
      layer.addEventListener('click', function (event) {
        if (event.target === layer) closePanel()
      })
      var card = el('div', 'tw-modal')
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      card.setAttribute('aria-label', T.title)
      card.addEventListener('click', function (event) {
        event.stopPropagation()
      })
      card.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') closePanel()
      })

      var head = el('div', 'tw-head')
      var brand = el('div', 'tw-brand')
      var logo = el('div', 'tw-logo')
      logo.innerHTML = ICON_TREND
      var titles = el('div', 'tw-titles')
      titles.appendChild(el('div', 'tw-title', T.title))
      titles.appendChild(el('div', 'tw-sub', T.subtitle))
      brand.appendChild(logo)
      brand.appendChild(titles)
      head.appendChild(brand)

      var actions = el('div', 'tw-actions')
      var refreshBtn = el('button', 'tw-ghost', T.refresh)
      refreshBtn.type = 'button'
      refreshBtn.addEventListener('click', function () {
        refresh()
      })
      var closeBtn = el('button', 'tw-ghost', T.close)
      closeBtn.type = 'button'
      closeBtn.addEventListener('click', closePanel)
      actions.appendChild(refreshBtn)
      actions.appendChild(closeBtn)
      head.appendChild(actions)

      var body = el('div', 'tw-body')
      var status = el('div', 'tw-status')
      var badge = el('div', 'tw-badge peak', T.loading)
      var meta = el('div', 'tw-meta')
      var priceLine = el('div', 'tw-price-line')
      var nextLine = el('div', 'tw-next-line')
      meta.appendChild(priceLine)
      meta.appendChild(nextLine)
      status.appendChild(badge)
      status.appendChild(meta)

      var chartCard = el('div', 'tw-card')
      var chartHead = el('div', 'tw-card-head')
      var chartTitle = el('span', '', T.chartTitle.replace('{days}', '30'))
      var chartHint = el('span', '', T.chartHint)
      chartHead.appendChild(chartTitle)
      chartHead.appendChild(chartHint)
      var canvas = el('canvas', 'tw-canvas')
      chartCard.appendChild(chartHead)
      chartCard.appendChild(canvas)

      var configCard = el('div', 'tw-card')
      var configHead = el('div', 'tw-card-head')
      configHead.appendChild(el('span', '', T.configTitle))
      configCard.appendChild(configHead)

      var configGrid = el('div', 'tw-config')
      var fields = {}
      var makeField = function (key, label, type, value, extra) {
        var wrap = el('label', 'tw-field')
        wrap.appendChild(el('span', '', label))
        var input = el('input', '')
        input.type = type
        if (type === 'number') input.step = '0.01'
        input.value = value
        if (extra) extra(input)
        wrap.appendChild(input)
        fields[key] = input
        configGrid.appendChild(wrap)
      }
      makeField('peak1Start', T.peak1Start, 'time', '')
      makeField('peak1End', T.peak1End, 'time', '')
      makeField('peak2Start', T.peak2Start, 'time', '')
      makeField('peak2End', T.peak2End, 'time', '')
      makeField('peakPrice', T.peakPriceLabel, 'number', '')
      makeField('valleyPrice', T.valleyPriceLabel, 'number', '')
      makeField('currency', T.currencyLabel, 'text', '')
      makeField('windowDays', T.windowDaysLabel, 'number', '', function (input) {
        input.min = '1'
        input.max = '90'
        input.step = '1'
      })
      configCard.appendChild(configGrid)

      var configActions = el('div', 'tw-config-actions')
      var savedHint = el('span', 'tw-hint', '')
      var saveBtn = el('button', 'tw-primary', T.save)
      saveBtn.type = 'button'
      saveBtn.addEventListener('click', function () {
        saveConfig()
      })
      configActions.appendChild(savedHint)
      configActions.appendChild(saveBtn)
      configCard.appendChild(configActions)

      var errorLine = el('div', 'tw-error', '')
      errorLine.style.display = 'none'

      body.appendChild(status)
      body.appendChild(chartCard)
      body.appendChild(configCard)
      body.appendChild(errorLine)

      var foot = el('div', 'tw-foot', T.foot)
      card.appendChild(head)
      card.appendChild(body)
      card.appendChild(foot)
      layer.appendChild(card)
      document.body.appendChild(layer)

      backdrop = layer
      modal = card
      refs = {
        badge: badge,
        meta: meta,
        priceLine: priceLine,
        nextLine: nextLine,
        chartTitle: chartTitle,
        chartHint: chartHint,
        canvas: canvas,
        fields: fields,
        saveBtn: saveBtn,
        savedHint: savedHint,
        errorLine: errorLine,
        foot: foot,
      }

      if (state.config) {
        fillConfigInputs(state.config)
        renderStatus()
        drawChart()
      }
    }

    function fillConfigInputs(config) {
      if (!refs.fields) return
      var segments = Array.isArray(config.peakSegments) ? config.peakSegments : []
      var first = segments[0] || {}
      var second = segments[1] || {}
      if (refs.fields.peak1Start) refs.fields.peak1Start.value = first.start || ''
      if (refs.fields.peak1End) refs.fields.peak1End.value = first.end || ''
      if (refs.fields.peak2Start) refs.fields.peak2Start.value = second.start || ''
      if (refs.fields.peak2End) refs.fields.peak2End.value = second.end || ''
      if (refs.fields.peakPrice) refs.fields.peakPrice.value = String(config.peakPrice)
      if (refs.fields.valleyPrice) refs.fields.valleyPrice.value = String(config.valleyPrice)
      if (refs.fields.currency) refs.fields.currency.value = config.currency
      if (refs.fields.windowDays) refs.fields.windowDays.value = String(config.windowDays)
    }

    function renderStatus() {
      if (!refs.badge || !state.current || !state.config) return
      var peak = state.current.phase === 'peak'
      refs.badge.textContent = peak ? T.phasePeak : T.phaseValley
      refs.badge.className = 'tw-badge ' + (peak ? 'peak' : 'valley')
      if (refs.chartTitle) refs.chartTitle.textContent = T.chartTitle.replace('{days}', String(state.config.windowDays))

      refs.priceLine.textContent = ''
      var priceText = T.currentPrice + ' '
      var strong = el('b', '', money(state.config, state.current.price))
      refs.priceLine.appendChild(document.createTextNode(priceText))
      refs.priceLine.appendChild(strong)
      refs.priceLine.appendChild(document.createTextNode(' ' + T.perUnit))

      refs.nextLine.textContent = ''
      var toPeak = state.current.nextPhase === 'peak'
      var nextLabel = (toPeak ? T.nextToPeak : T.nextToValley) + ' '
      refs.nextLine.appendChild(document.createTextNode(T.nextSwitch + ' · ' + nextLabel))
      var countdown = el('span', 'tw-countdown', state.current.nextSwitchAt ? '--:--:--' : '—')
      refs.countdown = countdown
      refs.nextLine.appendChild(countdown)
      updateCountdown()
    }

    function updateCountdown() {
      if (!refs.countdown || !state.current || !state.current.nextSwitchAt) return
      var remaining = new Date(state.current.nextSwitchAt).getTime() - Date.now()
      if (remaining <= 0) {
        refs.countdown.textContent = '00:00:00'
        refresh()
        return
      }
      refs.countdown.textContent = formatDuration(remaining)
    }

    function showError(message) {
      if (!refs.errorLine) return
      refs.errorLine.textContent = message || ''
      refs.errorLine.style.display = message ? '' : 'none'
    }

    /* ── 数据刷新 ─────────────────────────────────────────────────────── */

    function refresh() {
      if (state.loading) return
      state.loading = true
      state.saved = false
      api('/state')
        .then(function (data) {
          if (!data || data.ok === false) {
            throw new Error((data && data.error) || T.loadFailed)
          }
          state.config = data.config
          state.current = data.current
          state.series = data.series
          state.error = null
          updateButtonStatus()
          if (state.open) {
            if (refs.badge) {
              renderStatus()
              drawChart()
              if (refs.savedHint) refs.savedHint.textContent = ''
              showError('')
            }
          }
        })
        .catch(function (error) {
          state.error = error && error.message ? error.message : T.loadFailed
          if (state.open) showError(state.error)
          if (refs.badge && !state.current) {
            refs.badge.textContent = T.loadFailed
            refs.badge.className = 'tw-badge peak'
          }
        })
        .then(function () {
          state.loading = false
        })
    }

    function saveConfig() {
      if (!refs.fields || state.saving) return
      state.saving = true
      if (refs.saveBtn) refs.saveBtn.disabled = true
      if (refs.savedHint) refs.savedHint.textContent = T.saving
      var peakSegments = []
      var addSegment = function (startField, endField) {
        var start = startField && startField.value ? startField.value : ''
        var end = endField && endField.value ? endField.value : ''
        if (start && end) peakSegments.push({ start: start, end: end, days: 'workday' })
      }
      addSegment(refs.fields.peak1Start, refs.fields.peak1End)
      addSegment(refs.fields.peak2Start, refs.fields.peak2End)
      var payload = {
        peakSegments: peakSegments,
        peakPrice: Number(refs.fields.peakPrice.value),
        valleyPrice: Number(refs.fields.valleyPrice.value),
        currency: refs.fields.currency.value,
        windowDays: Number(refs.fields.windowDays.value),
      }
      api('/config', { method: 'POST', body: payload })
        .then(function (data) {
          if (!data || data.ok === false) throw new Error((data && data.error) || '保存失败')
          state.config = data.config
          state.saved = true
          if (refs.savedHint) refs.savedHint.textContent = T.saved
          showError('')
          refresh()
        })
        .catch(function (error) {
          showError(error && error.message ? error.message : '保存失败')
          if (refs.savedHint) refs.savedHint.textContent = ''
        })
        .then(function () {
          state.saving = false
          if (refs.saveBtn) refs.saveBtn.disabled = false
        })
    }

    function startPolling() {
      stopTimers()
      pollTimer = setInterval(function () {
        refresh()
      }, 30000)
      tickTimer = setInterval(function () {
        updateCountdown()
      }, 1000)
    }

    function stopTimers() {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
      }
    }

    /* ── 走势图 ───────────────────────────────────────────────────────── */

    function drawChart() {
      var canvas = refs.canvas
      if (!canvas) return
      var series = Array.isArray(state.series) ? state.series : []
      var ratio = window.devicePixelRatio || 1
      var cssWidth = Math.max(320, Math.round(canvas.getBoundingClientRect().width || 640))
      var cssHeight = 230
      canvas.width = Math.round(cssWidth * ratio)
      canvas.height = Math.round(cssHeight * ratio)
      var ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
      ctx.clearRect(0, 0, cssWidth, cssHeight)

      var red = token('--dsw-alias-state-error-primary', '#e5484d')
      var green = token('--dsw-alias-state-success-primary', '#2f9e6b')
      var grid = token('--dsw-alias-border-l3', 'rgba(127,127,127,.18)')
      var label = token('--dsw-alias-label-tertiary', '#8a919b')
      var strong = token('--dsw-alias-label-primary', '#111827')

      var pad = { left: 56, right: 18, top: 16, bottom: 28 }
      var width = cssWidth - pad.left - pad.right
      var height = cssHeight - pad.top - pad.bottom

      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
      ctx.fillStyle = label
      ctx.strokeStyle = grid
      ctx.lineWidth = 1

      if (!series.length) {
        ctx.fillText(T.noData, pad.left, pad.top + height / 2)
        return
      }

      var prices = series.map(function (point) {
        return Number(point.price) || 0
      })
      var min = Math.min.apply(null, prices)
      var max = Math.max.apply(null, prices)
      if (max - min < 0.000001) {
        max += 1
        min = Math.max(0, min - 1)
      }
      var padY = (max - min) * 0.16
      min -= padY
      max += padY
      var yOf = function (value) {
        return pad.top + height - ((value - min) / (max - min)) * height
      }
      var xOf = function (index) {
        return pad.left + (index / Math.max(1, series.length - 1)) * width
      }

      /* 网格：峰/谷两条参考线 */
      var levels = []
      if (state.config) {
        levels.push({ value: state.config.peakPrice, color: red })
        levels.push({ value: state.config.valleyPrice, color: green })
      } else {
        levels.push({ value: max, color: red })
        levels.push({ value: min, color: green })
      }
      levels.forEach(function (level) {
        var y = yOf(level.value)
        ctx.strokeStyle = grid
        ctx.beginPath()
        ctx.moveTo(pad.left, y)
        ctx.lineTo(pad.left + width, y)
        ctx.stroke()
        ctx.fillStyle = level.color
        ctx.fillText(String(Number(level.value.toFixed(2))), 8, y + 3)
      })

      /* 面积 + 阶梯线 */
      var step = Math.max(1, Math.ceil(series.length / 240))
      for (var index = 0; index < series.length; index += step) {
        var point = series[index]
        var x1 = xOf(index)
        var nextIndex = Math.min(series.length - 1, index + step)
        var x2 = xOf(nextIndex)
        var y1 = yOf(Number(point.price) || 0)
        var color = point.off ? green : red
        ctx.fillStyle = color
        ctx.globalAlpha = 0.12
        ctx.fillRect(x1, y1, Math.max(1, x2 - x1), pad.top + height - y1)
        ctx.globalAlpha = 1
        ctx.strokeStyle = color
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y1)
        var nextPoint = series[nextIndex]
        if (nextPoint && nextIndex !== index) {
          ctx.lineTo(x2, yOf(Number(nextPoint.price) || 0))
        }
        ctx.stroke()
      }

      /* 当前点标记 */
      var last = series[series.length - 1]
      if (last) {
        var x = xOf(series.length - 1)
        var y = yOf(Number(last.price) || 0)
        ctx.strokeStyle = strong
        ctx.globalAlpha = 0.45
        ctx.setLineDash([3, 4])
        ctx.beginPath()
        ctx.moveTo(x, pad.top)
        ctx.lineTo(x, pad.top + height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        ctx.fillStyle = last.off ? green : red
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = strong
        ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
        ctx.fillText(T.now, x - 14, pad.top + 10)
      }

      /* x 轴日期 */
      ctx.fillStyle = label
      ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif'
      var ticks = 5
      for (var tick = 0; tick < ticks; tick += 1) {
        var tickIndex = Math.round((tick / (ticks - 1)) * (series.length - 1))
        var tickPoint = series[tickIndex]
        if (!tickPoint) continue
        var date = new Date(tickPoint.t)
        var text = String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
        var tickX = xOf(tickIndex)
        ctx.fillText(text, Math.min(cssWidth - pad.right - 26, Math.max(pad.left - 10, tickX - 14)), cssHeight - 8)
      }
    }

    /* ── 生命周期 ─────────────────────────────────────────────────────── */

    function cleanup() {
      closePanel()
      stopTimers()
      stopButtonStatusPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
      try {
        if (observer) observer.disconnect()
      } catch (error) {
        /* ignore */
      }
      observer = null
      try {
        if (langObserver) langObserver.disconnect()
      } catch (error) {
        /* ignore */
      }
      langObserver = null
      if (positionTimer) {
        clearInterval(positionTimer)
        positionTimer = null
      }
      window.removeEventListener('resize', syncButtonPosition)
      window.removeEventListener('resize', drawChart)
      if (btnHost) {
        btnHost.remove()
        btnHost = null
      }
      btnLabel = null
      btnState = null
      if (styleEl) {
        styleEl.remove()
        styleEl = null
      }
    }

    function apply(ctx) {
      if (state.booted) return
      state.booted = true
      injectStyle()
      var start = function () {
        try {
          mountButton()
        } catch (error) {
          console.warn('[dsh-token-wave] 标题栏按钮挂载失败', error)
        }
      }
      if (document.body) start()
      else document.addEventListener('DOMContentLoaded', start, { once: true })
      window.addEventListener('resize', drawChart)
      window.addEventListener('error', function (event) {
        var source = String((event && event.filename) || '')
        if (source.indexOf('dsh-token-wave') >= 0) {
          reportClientError((event && event.message) || 'unknown error')
        }
      })
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            cleanup()
          }
        })
      }
    }

    return { inject: [], apply: apply }
  },
})
