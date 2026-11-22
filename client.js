/**
 * Browser half of `dsh-compact`.
 *
 * Карточка в списке плагинов (Настройки → Плагины): выбор сессии, размер
 * выжимки в символах, кнопка «Сжать» и предпросмотр готового Markdown.
 * Вся тяжёлая работа — на host-части через `/api/dsh-compact/*`; браузер
 * только показывает результат, чтобы не тащить распаковку журнала в страницу.
 *
 * Страница открыта по умолчанию и оформлена в едином стиле DSH; шеврон в
 * шапке сворачивает её до одной строки. Тот же экран регистрируется как
 * собственная панель в левой меню (`main` + `sidebar.panellist`, ключ
 * `plugin-compact`): клик по иконке открывает настройки, а не страницу
 * плагин-менеджера.
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
    /**
     * Панель в левой панели: ключ `main` и id строки `sidebar.panellist`
     * совпадают (`plugin-compact`) — хост открывает страницу по этому id.
     * `PANEL_ORDER` — позиция в общем списке панелей «Оформления интерфейса»
     * (20 + индекс: карточки 0, сжатие 1, ревью 2, …).
     */
    const PANEL_ID = 'plugin-compact'
    const PANEL_EMOJI = '🗜️'
    const PANEL_ORDER = 21
    /**
     * id плагина в состоянии видимости панелей: его ведёт «Оформление
     * интерфейса» (`dsh-polish`) в localStorage. Пока состояния нет или оно
     * битое, панель считаем закреплённой — так же, как в настройках оформления.
     */
    const PANEL_STATE_ID = 'compact'
    const PANEL_STATE_KEY = 'dsh-polish:panel-visibility'
    const PANELS_CHANGED_EVENT = 'dsh-polish:panels-changed'

    const en = {
      title: 'Dialog compaction',
      panelSubtitle: 'Compress a long dialog locally.',
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
      refresh: 'Refresh',
      settingsLabel: 'Parameters',
      statusIdle: 'Ready',
      statusReady: 'Summary ready',
      statusError: 'Error',
      sessionsEmptyHint: 'Run a session and it appears in the list.',
    }
    const ru = {
      title: 'Сжатие диалога',
      panelSubtitle: 'Локальное сжатие длинного диалога.',
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
      refresh: 'Обновить',
      settingsLabel: 'Параметры',
      statusIdle: 'Готово',
      statusReady: 'Выжимка готова',
      statusError: 'Ошибка',
      sessionsEmptyHint: 'Запустите сессию — она появится в списке.',
    }

    /**
     * Единая система кнопок плагина (спека `.tools/plugin-design-spec-v2.md`):
     * высота 36 px (маленькие в шапке — 32), padding 0 14, радиус 10,
     * шрифт 600 12.5, ширина — по тексту. Все варианты — только токены темы.
     *
     * primary — мягкая заливка brand + текст brand. Белый фон с белым текстом
     * запрещён: в тёмной теме brand-primary сам белый, поэтому старые
     * `button-primary-fill` + `label-primary-inverted` давали нечитаемый текст.
     */
    const BTN_BASE = {
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 36,
      padding: '0 14px',
      borderRadius: 10,
      fontFamily: 'inherit',
      fontSize: 12.5,
      fontWeight: 600,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      transition: 'background-color .14s ease, border-color .14s ease, color .14s ease',
    }
    const BTN = {
      base: BTN_BASE,
      primary: {
        ...BTN_BASE,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      secondary: {
        ...BTN_BASE,
        border: '1px solid var(--dsw-alias-border-l4)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
      },
      danger: {
        ...BTN_BASE,
        border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 50%, transparent)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      small: { ...BTN_BASE, height: 32, padding: '0 12px' },
      icon: {
        ...BTN_BASE,
        width: 32,
        height: 32,
        padding: 0,
        border: '1px solid var(--dsw-alias-border-l4)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
      },
    }

    /**
     * Страница плагина в едином стиле DSH: контент по центру (maxWidth 960),
     * шапка с иконкой и статусом, карточки-секции, адаптив в одну колонку.
     * Цвета — только токены темы; жёстких hex нет.
     */
    const UI = {
      page: {
        boxSizing: 'border-box',
        width: '100%',
        maxWidth: 960,
        margin: '0 auto',
        padding: '24px 28px 40px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--dsw-alias-label-primary)',
      },
      body: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
      head: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' },
      icon: {
        boxSizing: 'border-box',
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 52,
        height: 52,
        borderRadius: 14,
        fontSize: 26,
        lineHeight: 1,
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent)',
      },
      headText: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 240px' },
      title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: 1.25, color: 'var(--dsw-alias-label-primary)' },
      subtitle: {
        margin: 0,
        fontSize: 12.5,
        fontWeight: 400,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-secondary)',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      headRight: { display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flex: '0 0 auto', flexWrap: 'wrap', minWidth: 0 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
        whiteSpace: 'nowrap',
      },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto' },
      refresh: { ...BTN.secondary, height: 32 },
      iconButton: { ...BTN.icon },
      card: {
        boxSizing: 'border-box',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 16,
        borderRadius: 14,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 8 },
      bar: { flex: '0 0 auto', width: 3, height: 14, borderRadius: 2, background: 'var(--dsw-alias-brand-primary)' },
      sectionTitle: { margin: 0, fontSize: 14, fontWeight: 600, lineHeight: 1.3, color: 'var(--dsw-alias-label-primary)' },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
        gap: 16,
        alignItems: 'stretch',
        minWidth: 0,
      },
      field: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
      label: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        height: 34,
        padding: '0 10px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12.5,
      },
      select: {
        boxSizing: 'border-box',
        width: '100%',
        height: 34,
        padding: '0 8px',
        borderRadius: 9,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'inherit',
        font: 'inherit',
        fontSize: 12.5,
        colorScheme: 'inherit',
      },
      primary: { ...BTN.primary },
      secondary: { ...BTN.secondary },
      actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      counters: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5 },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)',
      },
      pre: {
        margin: 0,
        boxSizing: 'border-box',
        width: '100%',
        padding: '12px 14px',
        borderRadius: 12,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        maxHeight: 340,
        overflow: 'auto',
      },
      checkboxRow: { display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '24px 12px',
        textAlign: 'center',
      },
      emptyIcon: { fontSize: 32, lineHeight: 1 },
      emptyText: { fontSize: 12.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
    }

    /** CSS, который нельзя задать inline: наведение, фокус, disabled и адаптив. */
    const PAGE_CSS = [
      // Сетка полей: auto-fit, на узком экране — одна колонка.
      '.dshcm-page-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));align-items:stretch;}',
      // Кнопки — единая система: ширина по тексту, мягкие заливки из токенов.
      '.dshcm-page-primary,.dshcm-page-button,.dshcm-page-refresh,.dshcm-page-icon{flex:0 0 auto;min-width:0;}',
      '.dshcm-page-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent) !important;}',
      '.dshcm-page-button:hover:not(:disabled),.dshcm-page-refresh:hover:not(:disabled),.dshcm-page-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover) !important;}',
      '.dshcm-page-primary:active:not(:disabled),.dshcm-page-button:active:not(:disabled){transform:translateY(1px);}',
      '.dshcm-page-field:focus-visible,.dshcm-page-primary:focus-visible,.dshcm-page-button:focus-visible,.dshcm-page-refresh:focus-visible,.dshcm-page-icon:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent);outline-offset:1px;}',
      '.dshcm-page-primary:disabled,.dshcm-page-button:disabled,.dshcm-page-refresh:disabled{opacity:.55;cursor:default;}',
      // Адаптив: длинные строки переносятся, кнопки — в строку по тексту.
      '.dshcm-page{overflow-wrap:anywhere;}',
      '.dshcm-page-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;margin-top:auto;}',
      '@media (max-width: 900px){.dshcm-page{padding:20px 18px 36px !important;}.dshcm-page-grid{grid-template-columns:1fr !important;}}',
      '@media (max-width: 640px){.dshcm-page{padding:16px 14px 28px !important;}.dshcm-page-head{gap:10px;}.dshcm-page-head-right{flex:1 1 100%;margin-left:0;}}',
    ].join('\n')

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

    /** Шапка страницы: квадрат с иконкой, заголовок, статус-чип и «Обновить». */
    function PageHeader({ icon, title, subtitle, chipLabel, chipTone, refreshLabel, onRefresh, open, onToggle }) {
      return h(
        'div',
        { className: 'dshcm-page-head', style: UI.head },
        h('div', { style: UI.icon }, icon),
        h(
          'div',
          { style: UI.headText },
          h('h1', { style: UI.title }, title),
          subtitle !== '' ? h('p', { style: UI.subtitle }, subtitle) : null,
        ),
        h(
          'div',
          { className: 'dshcm-page-head-right', style: UI.headRight },
          h('span', { style: UI.chip }, h('span', { style: { ...UI.dot, background: chipTone } }), chipLabel),
          h(
            'button',
            { type: 'button', className: 'dshcm-page-refresh', style: UI.refresh, onClick: onRefresh },
            refreshLabel,
          ),
          onToggle === undefined ? null : h(ToggleIcon, { open, onClick: onToggle }),
        ),
      )
    }

    /** Карточка-секция: акцентная полоска, заголовок 14/600 и содержимое. */
    function SectionCard({ title, children }) {
      return h(
        'section',
        { style: UI.card },
        h('div', { style: UI.sectionHead }, h('span', { style: UI.bar }), h('h2', { style: UI.sectionTitle }, title)),
        children,
      )
    }

    /** Плашка ошибки или сообщения: цвет из состояния темы. */
    function Alert({ tone, text }) {
      const palette = {
        error: 'var(--dsw-alias-state-error-primary)',
        warn: 'var(--dsw-alias-state-warn-primary)',
        success: 'var(--dsw-alias-state-success-primary)',
      }
      const color = palette[tone] ?? palette.error
      return h(
        'div',
        {
          style: {
            boxSizing: 'border-box',
            padding: '10px 12px',
            borderRadius: 12,
            fontSize: 12.5,
            lineHeight: 1.5,
            border: `1px solid color-mix(in srgb, ${color} 42%, var(--dsw-alias-border-l2))`,
            background: `color-mix(in srgb, ${color} 10%, var(--dsw-alias-bg-layer-1))`,
            color: 'var(--dsw-alias-label-primary)',
          },
        },
        text,
      )
    }

    /** Пустое состояние: иконка 32, текст tertiary и подсказка. */
    function EmptyState({ icon, text, hint }) {
      return h(
        'div',
        { style: UI.empty },
        h('span', { style: UI.emptyIcon }, icon),
        h('span', { style: UI.emptyText }, text),
        hint === '' ? null : h('span', { style: UI.hint }, hint),
      )
    }

    /** Кнопка-шеврон: свернуть страницу до шапки или развернуть обратно. */
    function ToggleIcon({ open, onClick }) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          title: open ? translate('collapse') : translate('open'),
          'aria-label': open ? translate('collapse') : translate('open'),
          'aria-expanded': open ? 'true' : 'false',
          className: 'dshcm-page-icon',
          style: UI.iconButton,
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' },
          },
          h('path', {
            d: 'M6 15l6-6 6 6',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        ),
      )
    }


    /**
     * Страница настроек: на странице плагина рисует себя целиком (шапка, карточки),
     * а в панели левого меню — только содержимое (`bare`), потому что шапку и
     * отступы даёт `CompactPanelPage`.
     */
    function CompactCard(props) {
      const bare = props?.bare === true
      const t = (key, params) => translate(key, params)
      const [open, setOpen] = React.useState(true)
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

      const toggleOpen = () => {
        if (open) {
          setOpen(false)
          // при следующем открытии список сессий перечитается
          setState(null)
        } else {
          setOpen(true)
        }
      }

      /** «Обновить» в шапке: перечитать список сессий и сбросить прошлую выжимку. */
      const refresh = () => {
        setState(null)
        setResult(null)
        setError('')
        setNotice('')
      }

      const sessionSelect = h(
        'select',
        {
          className: 'dshcm-page-field',
          style: UI.select,
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
            { style: UI.counters },
            h('span', null, t('counters', { before: numberText(result.before), after: numberText(result.after) })),
            h('span', { style: UI.badge }, `−${reductionText(Number(result.before), Number(result.after))}%`),
          )

      // Статус в шапке: ошибка, загрузка, готовая выжимка или ожидание.
      const chipTone = error !== ''
        ? 'var(--dsw-alias-state-error-primary)'
        : loading
          ? 'var(--dsw-alias-state-warn-primary)'
          : result !== null
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-label-tertiary)'
      const chipLabel = error !== ''
        ? t('statusError')
        : loading
          ? t('loading')
          : result !== null
            ? t('statusReady')
            : t('statusIdle')

      const blocks = bare
        ? []
        : [
            h('style', { key: 'page-css' }, PAGE_CSS),
            h(PageHeader, {
              key: 'page-head',
              icon: '🗜️',
              title: t('heading'),
              subtitle: t('hint'),
              chipLabel,
              chipTone,
              refreshLabel: t('refresh'),
              onRefresh: refresh,
              open,
              onToggle: toggleOpen,
            }),
          ]
      blocks.push(
        error === '' ? null : h(Alert, { key: 'error', tone: 'error', text: error }),
        notice === '' ? null : h(Alert, { key: 'notice', tone: 'success', text: notice }),
      )

      if (open) {
        blocks.push(
          h(
            SectionCard,
            { key: 'params', title: t('settingsLabel') },
            loading ? h('span', { style: UI.hint }, t('loading')) : null,
            state !== null && state.zstd === false ? h(Alert, { tone: 'warn', text: t('noZstd') }) : null,
            h(
              'div',
              { className: 'dshcm-page-grid', style: UI.grid },
              h(
                'div',
                { style: UI.field },
                h('span', { style: UI.label }, t('sessionLabel')),
                !loading && sessions.length === 0
                  ? h(EmptyState, { icon: '📭', text: t('sessionsEmpty'), hint: t('sessionsEmptyHint') })
                  : sessionSelect,
                journalPath === '' ? null : h('span', { style: UI.hint }, t('journal', { path: journalPath })),
              ),
              h(
                'div',
                { style: UI.field },
                h('span', { style: UI.label }, t('budgetLabel')),
                h('input', {
                  className: 'dshcm-page-field',
                  style: UI.input,
                  type: 'number',
                  min: minBudget,
                  max: maxBudget,
                  step: 500,
                  value: budget,
                  onChange: (event) => setBudget(event.target.value),
                }),
                h('span', { style: UI.hint }, t('budgetHint', { min: numberText(minBudget), max: numberText(maxBudget) })),
              ),
            ),
            h(
              'label',
              { style: UI.checkboxRow },
              h('input', { type: 'checkbox', checked: saveFile, onChange: (event) => setSaveFile(event.target.checked) }),
              h('span', null, t('saveLabel')),
            ),
          ),
          h(
            SectionCard,
            { key: 'result', title: t('resultLabel') },
            h(
              'div',
              { className: 'dshcm-page-actions' },
              h(
                'button',
                {
                  className: 'dshcm-page-primary',
                  style: UI.primary,
                  onClick: () => void compress(),
                  disabled: busy || sessions.length === 0,
                },
                busy ? t('compressing') : t('compress'),
              ),
              result === null
                ? null
                : h('button', { className: 'dshcm-page-button', style: UI.secondary, onClick: () => void copy() }, t('copy')),
            ),
            counters,
            h('pre', { style: UI.pre }, result === null ? t('resultEmpty') : String(result.markdown ?? '')),
          ),
        )
      }

      return h(
        'div',
        bare
          ? { className: 'dshcm-page-body', style: UI.body }
          : { className: 'dshcm-page', style: UI.page },
        blocks,
      )
    }

    /** Заголовок панели: эмодзи-иконка, название плагина и короткий подзаголовок. */
    function PanelHeader() {
      return h(
        'div',
        { className: 'dshcm-panel-head', style: UI.head },
        h('span', { style: UI.icon, 'aria-hidden': 'true' }, PANEL_EMOJI),
        h(
          'div',
          { style: UI.headText },
          h('h1', { style: UI.title }, translate('title')),
          h('p', { style: UI.subtitle }, translate('panelSubtitle')),
        ),
      )
    }

    /**
     * Главная панель плагина: та же страница настроек в центрированной колонке
     * (maxWidth 960), но без страницы плагин-менеджера — только шапка плагина и
     * его элементы управления.
     */
    function CompactPanelPage() {
      return h(
        'section',
        { className: 'dshcm-page', style: UI.page, 'aria-label': translate('title'), 'data-dsh-panel': PANEL_ID },
        h('style', { key: 'page-css' }, PAGE_CSS),
        h(PanelHeader, { key: 'panel-head' }),
        h(CompactCard, { key: 'settings', bare: true }),
      )
    }

    /** Иконка строки левой панели: эмодзи в размер, который просит хост. */
    function PanelIcon(props) {
      const requested = Number(props?.size)
      const size = Number.isFinite(requested) && requested > 0 ? requested : 16
      return h(
        'span',
        {
          'data-dsh-panel-icon': PANEL_STATE_ID,
          'aria-hidden': true,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            fontSize: Math.round(size * 0.95),
            lineHeight: 1,
          },
        },
        PANEL_EMOJI,
      )
    }

    /** Закреплена ли панель: состояние ведёт «Оформление интерфейса» (dsh-polish). */
    function isPanelPinned() {
      try {
        if (typeof localStorage === 'undefined' || localStorage === null) return true
        const raw = localStorage.getItem(PANEL_STATE_KEY)
        // Пока оформление не сохраняло состояние, все панели видны и закреплены.
        if (raw === null || raw === '') return true
        const state = JSON.parse(raw)
        if (!Array.isArray(state?.pinned)) return true
        return state.pinned.includes(PANEL_STATE_ID) || state.pinned.includes(PANEL_ID)
      } catch {
        return true
      }
    }

    /**
     * Панель в левой панели: `main` регистрируется всегда (она есть и в меню
     * «Ещё»), строка `sidebar.panellist` — только когда панель закреплена.
     * Событие `dsh-polish:panels-changed` приходит из «Оформления интерфейса»
     * после закрепления/открепления: перечитываем состояние и перерегистрируем
     * строку, сняв прошлую регистрацию.
     */
    function registerPanels(ctx) {
      try {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, CompactPanelPage),
        )
      } catch (error) {
        console.error('[dsh-compact] панель в левом меню недоступна:', error)
      }

      let disposeSidebar = null
      const syncSidebar = () => {
        if (typeof disposeSidebar === 'function') {
          try {
            disposeSidebar()
          } catch (error) {
            console.error('[dsh-compact] не удалось снять строку левой панели:', error)
          }
          disposeSidebar = null
        }
        if (!isPanelPinned()) return
        try {
          let dispose = null
          const outer = ctx.slots.inject('sidebar.panellist', () => {
            dispose = ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: PANEL_ORDER,
                label: () => translate('title'),
                locale: NS,
              },
              PanelIcon,
            )
            return dispose
          })
          disposeSidebar = typeof dispose === 'function' ? dispose : outer
        } catch (error) {
          disposeSidebar = null
          console.error('[dsh-compact] строка в левой панели недоступна:', error)
        }
      }
      syncSidebar()

      try {
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener(PANELS_CHANGED_EVENT, syncSidebar)
        }
      } catch (error) {
        console.error('[dsh-compact] событие панелей недоступно:', error)
      }
    }

    /** Содержимое карточки на странице своего плагина. */
    function DetailCard_dshcompact(props) {
      const subject = props?.subject
      const packageName =
        subject?.kind === 'bundle' && typeof subject?.pkg?.name === 'string'
          ? subject.pkg.name
          : typeof subject?.id === 'string'
            ? subject.id
            : ''
      if (packageName !== 'dsh-compact') return null
      return h(CompactCard)
    }

    function apply(ctx) {
      ctx.locale.register(NS, { en, ru })
      translate = ctx.locale.bind(NS)

      // Панель в левом меню: main — всегда, строка sidebar — только если закреплена.
      registerPanels(ctx)

      try {
        ctx.slots.inject('plugins.detail.section', () =>
          ctx.slots.register(
            {
              name: 'plugins.detail.section',
              id: 'dsh-compact-detail',
              order: 45,
              locale: NS,
            },
            DetailCard_dshcompact,
          ),
        )
      } catch (error) {
        console.error('[dsh-compact] секция страницы недоступна:', error)
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.NS = NS
    return module.exports
  },
})
