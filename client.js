/**
 * Browser half of the daily-token bundle.
 *
 * Draws one small figure beside the window traffic lights: the tokens this DSH
 * installation has consumed today. It never blocks a click on the lights or the
 * window drag, so the overlay stays pointer-transparent.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-daily-tokens',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dailyTokens'

    const DICT = {
      en: {
        'label': 'Today',
        'unit': 'tok',
        'title': 'Tokens consumed in DSH today: {tokens} (input {input} · output {output} · cache {cache}, {count} calls)',
        'error': 'Today’s token count is unavailable',
      },
      zh: {
        'label': '今日',
        'unit': 'token',
        'title': '今日 DSH 已消耗：{tokens}（输入 {input} · 输出 {output} · 缓存 {cache}，{count} 次调用）',
        'error': '今日 token 统计不可用',
      },
    }

    /**
     * Component-local styles. The seat sits in the window title strip, to the
     * right of the traffic lights, and stays out of the pointer's way.
     */
    const CSS = `
      .dsh-daily-tokens {
        position: fixed;
        left: 80px;
        top: 15.5px;
        height: 24px;
        z-index: 5;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        box-sizing: border-box;
        padding: 0 6px;
        border-radius: 6px;
        font: inherit;
        font-size: 11.5px;
        line-height: 1;
        font-variant-numeric: tabular-nums;
        color: var(--dsw-alias-label-secondary);
        background: transparent;
        pointer-events: none;
        user-select: none;
        -webkit-app-region: no-drag;
        white-space: nowrap;
      }
      .dsh-daily-tokens__label { font-size: 11px; opacity: 0.7; }
      .dsh-daily-tokens__value { font-size: 12px; font-weight: 500; }
      .dsh-daily-tokens__number {
        display: inline-flex;
        align-items: flex-start;
        font-variant-numeric: tabular-nums;
        color: inherit;
        transition: transform 170ms ease-out, color 320ms ease-out;
      }
      .dsh-daily-tokens__number--tick {
        transform: translateY(-1px);
        color: var(--dsw-alias-label-primary);
      }
      .dsh-daily-tokens__digit {
        display: inline-block;
        width: 1ch;
        height: 1em;
        overflow: hidden;
        text-align: center;
      }
      .dsh-daily-tokens__strip {
        display: block;
        transition: transform 700ms cubic-bezier(0.22, 0.61, 0.36, 1);
        will-change: transform;
      }
      .dsh-daily-tokens__cell { display: block; height: 1em; line-height: 1; }
      .dsh-daily-tokens__punct { display: inline-block; }
      @media (prefers-reduced-motion: reduce) {
        .dsh-daily-tokens__strip { transition: none; }
        .dsh-daily-tokens__number { transition: none; }
        .dsh-daily-tokens__number--tick { transform: none; color: inherit; }
      }
      .dsh-daily-tokens__error { color: var(--dsw-alias-state-warn-primary); }
    `

    /** Minimal observable snapshot store. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    const INITIAL = Object.freeze({
      loaded: false,
      everLoaded: false,
      loading: false,
      total: null,
      input: 0,
      output: 0,
      cache: 0,
      requests: 0,
      error: null,
    })

    /**
     * Compact count for a token figure.
     *
     * Decimals are fixed per magnitude on purpose: a stable digit count keeps
     * the odometer's columns in place, so a value that only moves the last
     * digit rolls that digit instead of re-laying out the whole figure.
     * @param {number} value - Raw count.
     * @returns {string} e.g. "12.34M", "768.0k", "0".
     */
    function formatCount(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(Math.round(n))
    }

    /** The ten glyphs every digit column cycles through. */
    const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

    /**
     * One digit as a vertical wheel: the column translates to the glyph's
     * index, so a change rolls through the digits in between instead of
     * snapping. Motion is pure CSS (`transition` on `transform`).
     * @param {{ glyph: string }} props - One digit character.
     */
    function DigitWheel(props) {
      return h(
        'span',
        { className: 'dsh-daily-tokens__digit', 'aria-hidden': 'true' },
        h(
          'span',
          {
            className: 'dsh-daily-tokens__strip',
            style: { transform: `translateY(${-Number(props.glyph)}em)` },
          },
          ...DIGITS.map(digit => h('span', { key: digit, className: 'dsh-daily-tokens__cell' }, digit)),
        ),
      )
    }

    /**
     * The token figure, digit by digit.
     *
     * The accessible name carries the final value, so screen readers never see
     * the animating columns.
     * @param {{ text: string }} props - Formatted figure, e.g. "437.17M".
     */
    function RollingNumber(props) {
      const chars = Array.from(props.text)
      // One short lift-and-brighten per change, so a change is noticeable even
      // when only the last digit moves. State keeps the wheels mounted (a
      // remount would reset their transition).
      const [ticking, setTicking] = React.useState(false)
      const mounted = React.useRef(false)
      React.useEffect(() => {
        if (!mounted.current) {
          mounted.current = true
          return undefined
        }
        setTicking(true)
        const timer = setTimeout(() => setTicking(false), 320)
        return () => clearTimeout(timer)
      }, [props.text])
      return h(
        'span',
        {
          className: `dsh-daily-tokens__number${ticking ? ' dsh-daily-tokens__number--tick' : ''}`,
          role: 'text',
          'aria-label': props.text,
        },
        // Key by position only. Including the glyph would unmount the node on
        // every change, and a fresh node has no previous transform for the CSS
        // transition to animate from — the wheel would snap instead of roll.
        ...chars.map((char, index) => (
          char >= '0' && char <= '9'
            ? h(DigitWheel, { key: index, glyph: char })
            : h('span', { key: index, className: 'dsh-daily-tokens__punct', 'aria-hidden': 'true' }, char)
        )),
      )
    }

    /** The date figure drawn beside the traffic lights. */
    function TokenBadge(props) {
      const state = props.useTokens(value => value)
      const attempted = React.useRef(false)
      React.useEffect(() => {
        if (attempted.current || state.loaded) return
        attempted.current = true
        props.refresh()
      }, [state.loaded, props.refresh])

      // A failed read must not erase a figure that was already shown: the
      // value only goes missing when there has never been one.
      if (state.total === null && state.error !== null) {
        return h(
          React.Fragment,
          null,
          h('style', null, CSS),
          h('span', { className: 'dsh-daily-tokens dsh-daily-tokens__error' }, props.t('error')),
        )
      }
      if (state.total === null) return null


      const title = props.t('title', {
        tokens: formatCount(state.total),
        input: formatCount(state.input),
        output: formatCount(state.output),
        cache: formatCount(state.cache),
        count: state.requests,
      })
      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'span',
          { className: 'dsh-daily-tokens', role: 'status', 'aria-label': title },
          h('span', { className: 'dsh-daily-tokens__label' }, props.t('label')),
          h('span', { className: 'dsh-daily-tokens__value' },
            h(RollingNumber, { text: formatCount(state.total) }),
            ' ',
            props.t('unit')),
        ),
      )
    }

    return {
      inject: ['connection', 'slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT), 'daily-tokens: dictionaries')

        const t = ctx.locale.bind(NS)
        const tokenStore = createStore(INITIAL)
        let loading = false

        /** Consecutive failures; drives the retry backoff. */
        let failures = 0
        /** Earliest time the next attempt may run after a failure. */
        let notBefore = 0

        const refresh = async () => {
          if (loading) return
          if (Date.now() < notBefore) return
          loading = true
          tokenStore.set({ ...tokenStore.getSnapshot(), loading: true })
          try {
            const envelope = await ctx.connection.rpc.call('/api', 'dailyTokens/read', { args: {} })
            if (!envelope.ok) throw new Error(envelope.error?.message ?? '')
            const result = envelope.value
            if (result === null || typeof result !== 'object' || result.ok !== true) {
              throw new Error(result?.error?.message ?? '')
            }
            const value = result.value ?? {}
            failures = 0
            notBefore = 0
            tokenStore.set({
              loaded: true,
              everLoaded: true,
              loading: false,
              total: Number(value.total) || 0,
              input: Number(value.input) || 0,
              output: Number(value.output) || 0,
              cache: (Number(value.cacheRead) || 0) + (Number(value.cacheWrite) || 0),
              requests: Number(value.requests) || 0,
              error: null,
            })
          } catch (error) {
            failures += 1
            // 1s, 2s, 4s … capped at 30s. The poll skips until then.
            notBefore = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5))
            const previous = tokenStore.getSnapshot()
            tokenStore.set({
              ...previous,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
            })
          } finally {
            loading = false
          }
        }

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'daily-tokens',
          order: 20,
          locale: NS,
          inject: () => ({
            hooks: { tokens: tokenStore },
            refresh,
          }),
        }, TokenBadge))

        // The Host keeps today's figure in memory and updates it from the
        // event feed, so a read is pure memory: one second is cheap.
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
            void refresh()
          }, 1000)
          return () => clearInterval(timer)
        }, 'daily-tokens: refresh timer')
      },
    }
  },
})