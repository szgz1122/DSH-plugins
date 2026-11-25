window.__ModuleLoader__.load({
  id: '@local/dsh-pending-dock',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    /**
     * 数据来源：宿主半注册的带鉴权路由。
     *
     * 注意必须是**去掉前导斜杠的相对路径**：桌面版前端跑在 Electron 的
     * `dsh-app://` 自定义协议下，写成 `/api/...` 会解析到 `dsh-app://app/api/...`
     * 而 404。内置插件（如 deliverables）同样用 `api/xxx` 这种相对写法。
     */
    const LIST_URL = 'api/pending.list';
    const SET_URL = 'api/pending.set';
    const BEACON_URL = 'api/pending.beacon';
    /** 轮询间隔（毫秒）。仅在面板展开时轮询。 */
    const POLL_MS = 8000;

    /** 诊断信标：汇报浏览器半的执行进度，便于排查"为什么没显示"。 */
    let beaconSeq = 0;
    function beacon(step, extra) {
      beaconSeq += 1;
      try {
        fetch(BEACON_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ step, seq: beaconSeq, extra: extra || null }),
        }).catch(() => {});
      } catch (e) {
        /* 信标失败不影响功能 */
      }
    }

    const KIND_LABEL = { blocked: '挂起', todo: '待办', watch: '观察' };
    const KIND_COLOR = {
      blocked: 'var(--dsw-alias-warning-fill, #d97706)',
      todo: 'var(--dsw-alias-brand-fill, #247bbf)',
      watch: 'var(--dsw-alias-text-secondary, #6b7280)',
    };

    /** 主题令牌，带后备值；只依赖 --dsw-alias-* 家族。 */
    const T = {
      text: 'var(--dsw-alias-text-primary, #1f2328)',
      dim: 'var(--dsw-alias-text-secondary, #6b7280)',
      line: 'var(--dsw-alias-border-subtle, rgba(128,128,128,0.28))',
      surface: 'var(--dsw-alias-bg-elevated, transparent)',
      accent: 'var(--dsw-alias-brand-fill, #247bbf)',
    };

    function kindBadge(it) {
      return h(
        'span',
        {
          key: 'k',
          style: {
            flex: '0 0 auto',
            fontSize: 11,
            lineHeight: '16px',
            padding: '0 5px',
            borderRadius: 4,
            color: '#fff',
            background: KIND_COLOR[it.kind] || T.dim,
          },
        },
        KIND_LABEL[it.kind] || it.kind
      );
    }

    function Row(props) {
      const { item, onToggle, busy } = props;
      const done = item.status !== 'open';
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: '5px 0',
            borderTop: `1px solid ${T.line}`,
            opacity: done ? 0.55 : 1,
          },
        },
        h(
          'button',
          {
            type: 'button',
            title: done ? '标记为未完成' : '标记为已完成',
            disabled: busy,
            onClick: () => onToggle(item),
            style: {
              flex: '0 0 auto',
              width: 16,
              height: 16,
              marginTop: 2,
              padding: 0,
              borderRadius: 4,
              cursor: busy ? 'default' : 'pointer',
              border: `1.5px solid ${done ? T.accent : T.line}`,
              background: done ? T.accent : 'transparent',
              color: '#fff',
              fontSize: 11,
              lineHeight: '12px',
            },
          },
          done ? '✓' : ''
        ),
        kindBadge(item),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            {
              style: {
                fontSize: 12,
                lineHeight: '17px',
                color: T.text,
                textDecoration: done ? 'line-through' : 'none',
                wordBreak: 'break-word',
              },
            },
            item.title
          ),
          item.detail
            ? h(
                'div',
                {
                  title: item.detail,
                  style: {
                    fontSize: 11,
                    lineHeight: '15px',
                    color: T.dim,
                    marginTop: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                item.detail
              )
            : null
        ),
        h(
          'span',
          {
            style: { flex: '0 0 auto', fontSize: 10, lineHeight: '16px', color: T.dim },
          },
          item.id
        )
      );
    }

    function PendingDock() {
      const [doc, setDoc] = useState(null);
      const [error, setError] = useState('');
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState('');
      const inflight = useRef(false);
      const rendered = useRef(false);
      if (!rendered.current) {
        rendered.current = true;
        beacon('component-rendered', { hasFetch: typeof fetch });
        console.log('[pending-dock] 组件已渲染');
      }

      const load = useCallback(async () => {
        if (inflight.current) return;
        inflight.current = true;
        try {
          const res = await fetch(LIST_URL, { credentials: 'same-origin' });
          const body = await res.json();
          if (body && body.ok) {
            setDoc(body.doc);
            setError('');
          } else {
            setError((body && body.error) || `HTTP ${res.status}`);
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          inflight.current = false;
        }
      }, []);

      // 首次加载 + 展开时轮询（收起时停，省资源）
      useEffect(() => {
        load();
      }, [load]);
      useEffect(() => {
        if (!open) return undefined;
        const t = setInterval(load, POLL_MS);
        return () => clearInterval(t);
      }, [open, load]);

      const items = (doc && doc.items) || [];
      const openItems = items.filter((i) => i.status === 'open');
      const blocking = openItems.filter((i) => i.blocking);

      const toggle = useCallback(
        async (item) => {
          if (!doc) return;
          const next = {
            ...doc,
            items: doc.items.map((i) =>
              i.id === item.id
                ? {
                    ...i,
                    status: i.status === 'open' ? 'done' : 'open',
                    closed: i.status === 'open' ? new Date().toISOString().slice(0, 10) : '',
                  }
                : i
            ),
          };
          setBusy(item.id);
          setDoc(next); // 乐观更新
          try {
            const res = await fetch(SET_URL, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(next),
            });
            const body = await res.json();
            if (!body || !body.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
            setError('');
          } catch (e) {
            setError(String((e && e.message) || e));
            load(); // 回滚到服务端的真实状态
          } finally {
            setBusy('');
          }
        },
        [doc, load]
      );

      const summary = (() => {
        if (error) return `待办读取失败：${error}`;
        if (!doc) return '待办加载中…';
        if (doc._missing) return '尚无待办数据（_待办/pending.json 不存在）';
        if (!openItems.length) return '待办：全部完成';
        return `待办 ${openItems.length} 项${blocking.length ? ` · 阻塞 ${blocking.length}` : ''}`;
      })();

      const head = h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            userSelect: 'none',
            fontSize: 12,
            lineHeight: '20px',
            color: error ? 'var(--dsw-alias-danger-fill, #dc2626)' : T.dim,
          },
          onClick: () => setOpen((v) => !v),
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setOpen((v) => !v);
            }
          },
        },
        h('span', { style: { fontSize: 10, width: 10 } }, open ? '▾' : '▸'),
        h('span', { style: { fontWeight: 500 } }, summary),
        h(
          'span',
          {
            title: '立即刷新',
            onClick: (e) => {
              e.stopPropagation();
              load();
            },
            style: { fontSize: 11, opacity: 0.75 },
          },
          '⟳'
        )
      );

      if (!open) return h('div', { style: { padding: '2px 0' } }, head);

      return h(
        'div',
        {
          style: {
            padding: '6px 0 8px',
            borderTop: `1px solid ${T.line}`,
            background: T.surface,
          },
        },
        head,
        h(
          'div',
          { style: { marginTop: 4, maxHeight: 220, overflowY: 'auto' } },
          items.length
            ? items.map((it) => h(Row, { key: it.id, item: it, onToggle: toggle, busy: busy === it.id }))
            : h('div', { style: { fontSize: 11, color: T.dim, padding: '4px 0' } }, '（无条目）')
        ),
        doc && doc.file
          ? h(
              'div',
              {
                title: doc.file,
                style: {
                  marginTop: 4,
                  fontSize: 10,
                  color: T.dim,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              `数据源：${doc.file}`
            )
          : null
      );
    }

    /**
     * 挂载插槽：`conversation.input.dock`（输入框上方的停靠区）。
     *
     * 这个值是实测确定的：候选清单里其它三个（composer.dock /
     * session.header.utilities / sidebar.footer.action）要么不存在、
     * 要么不显示，只有 input.dock 正常渲染。内置的待办面板也在这一带。
     */
    const SLOT = 'conversation.input.dock';
    const SLOT_ID = 'pending-dock';
    const SLOT_ORDER = 30;

    return {
      inject: ['slots'],
      apply(ctx) {
        beacon('apply-entered', { slot: SLOT });
        const dispose = ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: SLOT_ID, order: SLOT_ORDER },
            PendingDock
          )
        );
        console.log(`[pending-dock] 已注册到插槽 ${SLOT}`);
        return dispose;
      },
    };
  },
});
