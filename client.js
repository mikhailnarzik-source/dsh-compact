/**
 * Browser half of `dsh-compact`.
 *
 * Карточка в списке плагинов (Настройки → Плагины): выбор сессии, размер
 * выжимки в символах, кнопка «Сжать» и предпросмотр готового Markdown.
 * Вся тяжёлая работа — на host-части через `/api/dsh-compact/*`; браузер
 * только показывает результат, чтобы не тащить распаковку журнала в страницу.
 *
 * Карточка по умолчанию свёрнута: в общем списке плагинов она не должна
 * занимать пол-экрана.
 */
window.__ModuleLoader__.load({
  id: 'dsh-compact',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement

    const NS = 'dshCompact'
    const STATE_PATH = '/api/dsh-compact/state'
    const PREVIEW_PATH = '/api/dsh-compact/preview'
    const DEFAULT_BUDGET = 6000

    const en = {
      title: 'Dialog compaction',
      heading: 'Dialog compaction',
      hint: 'Builds a short extractive summary of a session log — locally, without a neural network and without network requests.',
      open: 'Open',
      collapse: 'Collapse',
      sessionLabel: 'Session',
      sessionLatest: 'latest',
      untitled: 'Untitled session',
      budgetLabel: 'Summary size (characters)',
      budgetHint: 'From {min} to {max}. Default is 6000.',
      saveLabel: 'Save to a file',
      compress: 'Compact',
      compressing: 'Compacting…',
      resultLabel: 'Summary preview',
      resultEmpty: 'Choose a session and press “Compact”.',
      counters: 'was {before} characters → now {after} characters',
      reduction: '{percent}% shorter',
      copy: 'Copy',
      copied: 'Summary copied to the clipboard',
      savedTo: 'Saved: {path}',
      loading: 'Loading sessions…',
      sessionsEmpty: 'No sessions found in ~/.dsh/sessions yet.',
      noZstd: 'This Node build has no zstd support: session logs cannot be read.',
      errorState: 'Could not load the session list',
      errorPreview: 'Could not build the summary',
      errorNetwork: 'Host part did not respond: {message}',
      journal: 'Journal: {path}',
    }
    const ru = {
      title: 'Сжатие диалога',
      heading: 'Сжатие диалога',
      hint: 'Строит короткую выжимку журнала сессии — локально, без нейросети и без сетевых запросов.',
      open: 'Открыть',
      collapse: 'Свернуть',
      sessionLabel: 'Сессия',
      sessionLatest: 'последняя',
      untitled: 'Сессия без названия',
      budgetLabel: 'Размер выжимки (символы)',
      budgetHint: 'От {min} до {max}. По умолчанию 6000.',
      saveLabel: 'Сохранить в файл',
      compress: 'Сжать',
      compressing: 'Сжимаю…',
      resultLabel: 'Предпросмотр выжимки',
      resultEmpty: 'Выберите сессию и нажмите «Сжать».',
      counters: 'было {before} символов → стало {after} символов',
      reduction: 'короче на {percent}%',
      copy: 'Скопировать',
      copied: 'Выжимка скопирована в буфер обмена',
      savedTo: 'Сохранено: {path}',
      loading: 'Загружаю список сессий…',
      sessionsEmpty: 'В ~/.dsh/sessions пока нет сессий.',
      noZstd: 'В этой сборке Node нет поддержки zstd: журнал сессии прочитать нельзя.',
      errorState: 'Не удалось загрузить список сессий',
      errorPreview: 'Не удалось построить выжимку',
      errorNetwork: 'Host-часть не ответила: {message}',
      journal: 'Журнал: {path}',
    }

    const S = {
      card: { display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, maxWidth: 720 },
      heading: { fontSize: 13.5, fontWeight: 600 },
      hint: { fontSize: 12, opacity: 0.72, lineHeight: 1.5 },
      label: { fontSize: 12, fontWeight: 600, opacity: 0.8 },
      field: { display: 'flex', flexDirection: 'column', gap: 5 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      select: {
        width: '100%',
        boxSizing: 'border-box',
        height: 32,
        padding: '0 8px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        colorScheme: 'inherit',
      },
      input: {
        width: 160,
        boxSizing: 'border-box',
        height: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        colorScheme: 'inherit',
      },
      button: {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid rgba(128,128,128,0.35)',
        background: 'rgba(128,128,128,0.12)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      primary: {
        padding: '6px 14px',
        borderRadius: 8,
        border: '1px solid rgba(80,120,200,0.55)',
        background: 'rgba(80,120,200,0.18)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
      },
      pre: {
        margin: 0,
        padding: '10px 12px',
        borderRadius: 10,
        border: '1px solid rgba(128,128,128,0.28)',
        background: 'rgba(128,128,128,0.07)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: 340,
        overflow: 'auto',
      },
      meta: { fontSize: 12, opacity: 0.72, lineHeight: 1.5 },
      counters: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 9px',
        borderRadius: 999,
        border: '1px solid rgba(40,150,80,0.4)',
        background: 'rgba(40,150,80,0.12)',
        fontSize: 12,
        fontWeight: 600,
      },
      error: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid rgba(209,36,47,0.35)',
        background: 'rgba(209,36,47,0.12)',
      },
      notice: {
        fontSize: 12,
        lineHeight: 1.5,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'rgba(128,128,128,0.10)',
      },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12.5 },
    }

    let translate = (key) => key

    const numberText = (value) => {
      const number = Number(value)
      return Number.isFinite(number) ? String(Math.round(number)) : '—'
    }

    const reductionText = (before, after) => {
      if (!(before > 0)) return ''
      const percent = Math.max(0, Math.round((1 - after / before) * 100))
      return `${percent}`
    }

    async function post(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const text = await response.text().catch(() => '')
      if (!response.ok) {
        let detail = text
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.message === 'string') detail = parsed.message
        } catch {
          // оставляем как есть
        }
        const error = new Error(`${response.status} ${path}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`)
        error.status = response.status
        throw error
      }
      try {
        return JSON.parse(text)
      } catch {
        const error = new Error(`ответ без JSON: ${text.slice(0, 200)}`)
        error.status = response.status
        throw error
      }
    }

    function describeError(error) {
      const message = String(error?.message ?? error)
      if (error?.status === 404) {
        return `${message}. Host-часть плагина не загрузилась — полностью закройте DSH (включая значок в трее) и запустите снова; обновления страницы недостаточно.`
      }
      if (error?.status === undefined) return message
      return translate('errorNetwork', { message })
    }

    function sessionLabel(session, t) {
      const title = typeof session.title === 'string' && session.title !== '' ? session.title : t('untitled')
      const id = typeof session.id === 'string' ? session.id.slice(0, 8) : ''
      let date = ''
      if (Number.isFinite(Number(session.createdAt)) && Number(session.createdAt) > 0) {
        try {
          date = new Date(Number(session.createdAt)).toLocaleDateString()
        } catch {
          date = ''
        }
      }
      const parts = [title]
      if (date !== '') parts.push(date)
      if (id !== '') parts.push(`#${id}`)
      return parts.join(' · ')
    }

    function CompactCard() {
      const t = (key, params) => translate(key, params)
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [selectedId, setSelectedId] = React.useState('')
      const [budget, setBudget] = React.useState(String(DEFAULT_BUDGET))
      const [saveFile, setSaveFile] = React.useState(false)
      const [result, setResult] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      React.useEffect(() => {
        if (!open || state !== null) return undefined
        let cancelled = false
        setLoading(true)
        setError('')
        post(STATE_PATH, {})
          .then((payload) => {
            if (cancelled) return
            if (payload === null || payload.ok !== true) {
              throw new Error(typeof payload?.message === 'string' ? payload.message : t('errorState'))
            }
            const sessions = Array.isArray(payload.sessions) ? payload.sessions : []
            setState(payload)
            setSelectedId(sessions[0]?.id ?? '')
            const defaults = payload.settings?.budget
            setBudget(String(Number.isFinite(Number(defaults)) ? Number(defaults) : DEFAULT_BUDGET))
          })
          .catch((caught) => {
            if (!cancelled) setError(describeError(caught))
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [open, state])

      const sessions = Array.isArray(state?.sessions) ? state.sessions : []
      const minBudget = Number(state?.settings?.minBudget) || 300
      const maxBudget = Number(state?.settings?.maxBudget) || 200000
      const selected = sessions.find((session) => session.id === selectedId)
      const journalPath = typeof selected?.path === 'string' ? selected.path : ''

      const compress = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        setNotice('')
        try {
          const payload = await post(PREVIEW_PATH, {
            sessionId: selectedId,
            budget: Number(budget) || DEFAULT_BUDGET,
            save: saveFile,
          })
          if (payload === null || payload.ok !== true) {
            throw new Error(typeof payload?.message === 'string' ? payload.message : t('errorPreview'))
          }
          setResult(payload)
          if (typeof payload.savedPath === 'string' && payload.savedPath !== '') {
            setNotice(t('savedTo', { path: payload.savedPath }))
          }
        } catch (caught) {
          setResult(null)
          setError(describeError(caught))
        } finally {
          setBusy(false)
        }
      }

      const copy = async () => {
        if (result === null) return
        try {
          await navigator.clipboard.writeText(result.markdown)
          setNotice(t('copied'))
        } catch {
          setNotice('')
        }
      }

      const collapse = () => {
        setOpen(false)
        // при следующем открытии список сессий перечитается
        setState(null)
      }

      if (!open) {
        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px solid rgba(128,128,128,0.22)',
              background: 'rgba(128,128,128,0.05)',
              fontSize: 13,
            },
          },
          h('span', { style: { fontWeight: 600 } }, t('heading')),
          h('span', { style: { fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t('hint')),
          h('button', { style: { ...S.primary, marginLeft: 'auto', flex: '0 0 auto' }, onClick: () => setOpen(true) }, t('open')),
        )
      }

      const sessionSelect = h(
        'select',
        {
          style: S.select,
          value: selectedId,
          onChange: (event) => {
            setSelectedId(event.target.value)
            setResult(null)
            setNotice('')
            setError('')
          },
        },
        ...sessions.map((session) => h(
          'option',
          { key: session.id, value: session.id },
          `${sessionLabel(session, t)}${session.root === false ? ' (subagent)' : ''}`,
        )),
      )

      const counters = result === null
        ? null
        : h(
            'div',
            { style: S.counters },
            h('span', null, t('counters', { before: numberText(result.before), after: numberText(result.after) })),
            h('span', { style: S.badge }, `−${reductionText(Number(result.before), Number(result.after))}%`),
          )

      return h(
        'div',
        { style: S.card },
        h('span', { style: S.heading }, t('heading')),
        h('span', { style: S.hint }, t('hint')),

        loading ? h('span', { style: S.meta }, t('loading')) : null,
        state !== null && state.zstd === false ? h('div', { style: S.error }, t('noZstd')) : null,

        h('span', { style: S.label }, t('sessionLabel')),
        !loading && sessions.length === 0
          ? h('span', { style: S.meta }, t('sessionsEmpty'))
          : sessionSelect,
        journalPath === '' ? null : h('span', { style: S.meta }, t('journal', { path: journalPath })),

        h(
          'div',
          { style: S.field },
          h('span', { style: S.label }, t('budgetLabel')),
          h('input', {
            style: S.input,
            type: 'number',
            min: minBudget,
            max: maxBudget,
            step: 500,
            value: budget,
            onChange: (event) => setBudget(event.target.value),
          }),
          h('span', { style: S.meta }, t('budgetHint', { min: numberText(minBudget), max: numberText(maxBudget) })),
        ),

        h(
          'label',
          { style: S.checkboxRow },
          h('input', { type: 'checkbox', checked: saveFile, onChange: (event) => setSaveFile(event.target.checked) }),
          h('span', null, t('saveLabel')),
        ),

        h(
          'div',
          { style: S.row },
          h(
            'button',
            {
              style: S.primary,
              onClick: () => void compress(),
              disabled: busy || sessions.length === 0,
            },
            busy ? t('compressing') : t('compress'),
          ),
          h('button', { style: S.button, onClick: collapse }, t('collapse')),
          result === null ? null : h('button', { style: S.button, onClick: () => void copy() }, t('copy')),
        ),

        error === '' ? null : h('div', { style: S.error }, error),
        notice === '' ? null : h('div', { style: S.notice }, notice),
        counters,

        h('span', { style: S.label }, t('resultLabel')),
        h(
          'pre',
          { style: S.pre },
          result === null ? t('resultEmpty') : String(result.markdown ?? ''),
        ),
      )
    }

    function apply(ctx) {
      ctx.locale.register(NS, { en, ru })
      translate = ctx.locale.bind(NS)

      try {
        ctx.slots.inject('plugins.item', () => ctx.slots.register(
          {
            name: 'plugins.item',
            id: 'dsh-compact',
            order: 60,
            label: () => translate('title'),
            locale: NS,
          },
          CompactCard,
        ))
      } catch (error) {
        console.error('[dsh-compact] карточка недоступна:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.NS = NS
    return module.exports
  },
})
