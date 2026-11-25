/**
 * dsh-deepseek-share — 浏览器半侧
 *
 * 宿主侧注册的是 /deepseek-share 命令；这里只做一件事：
 * 在「+」菜单的命令行上补上随当前界面语言变化的标题和说明。
 * （命令行的 name 仍保留 deepseek-share，方便直接输入。）
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-share',
  factory: function () {
    var TEXT = {
      zh: {
        label: '读取 DeepSeek 分享对话',
        description: '读取 DeepSeek 网页版分享链接中的对话（/deepseek-share <链接>）',
      },
      en: {
        label: 'Read DeepSeek shared chat',
        description: 'Read a conversation from a DeepSeek web share link (/deepseek-share <url>)',
      },
    }

    function currentLang() {
      try {
        var lang = String(document.documentElement.lang || '').toLowerCase()
        if (lang) return lang.indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        /* ignore */
      }
      try {
        return String(navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch (error) {
        return 'zh'
      }
    }

    function text() {
      return TEXT[currentLang()] || TEXT.zh
    }

    /* 调试标记：便于确认浏览器半侧已加载，以及当前语言取词是否正确。 */
    try {
      window.__dshDeepseekShare = {
        patched: false,
        lang: currentLang,
        copy: text,
      }
    } catch (error) {
      /* ignore */
    }

    function install(ctx, commandUi) {
      var original = commandUi.candidates
      var patched = async function (session, request) {
        var rows = await original.call(commandUi, session, request)
        if (!Array.isArray(rows)) return rows
        var copy = text()
        return rows.map(function (row) {
          if (!row || typeof row !== 'object' || row.name !== 'deepseek-share') return row
          return Object.assign({}, row, {
            label: copy.label,
            description: copy.description,
          })
        })
      }
      commandUi.candidates = patched
      try {
        window.__dshDeepseekShare && (window.__dshDeepseekShare.patched = true)
      } catch (error) {
        /* ignore */
      }

      return function () {
        if (commandUi.candidates === patched) commandUi.candidates = original
      }
    }

    function apply(ctx) {
      var stopped = false
      var dispose = null
      var retry = 0

      function mount() {
        if (stopped || dispose) return
        var commandUi = ctx && typeof ctx.get === 'function' ? ctx.get('commandUi') : undefined
        if (!commandUi || typeof commandUi.candidates !== 'function') {
          if (retry < 40) {
            retry += 1
            setTimeout(mount, 250)
          } else {
            console.warn('[dsh-deepseek-share] commandUi.candidates 不可用，+ 菜单仍显示宿主描述')
          }
          return
        }
        dispose = install(ctx, commandUi)
      }

      function cleanup() {
        stopped = true
        if (dispose) {
          dispose()
          dispose = null
        }
      }

      if (ctx && typeof ctx.effect === 'function') ctx.effect(function () { return cleanup })
      else window.addEventListener('beforeunload', cleanup)
      mount()
    }

    return { inject: [], apply: apply }
  },
})
