/**
 * Проверки рендера страницы плагина (слот `plugins.detail.section`) в едином
 * стиле DSH: контент по центру (maxWidth 960), шапка с иконкой и статус-чипом,
 * карточки-секции, единая система кнопок (спека `.tools/plugin-design-spec-v2.md`),
 * адаптив и только токены темы.
 *
 * `client.js` исполняется в vm с поддельным `window.__ModuleLoader__` и
 * минимальным React: настоящий браузер для проверки разметки не нужен.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const PLUGIN = 'dsh-compact'

/** Поддельный React: хуки отдают начальные значения или заданные тестом. */
function makeReact(states = []) {
  let index = 0
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const value = index < states.length
        ? states[index]
        : (typeof initial === 'function' ? initial() : initial)
      index += 1
      return [value, () => {}]
    },
    useEffect() {},
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
  }
}

function loadClient() {
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(options) { registration = options } } },
    console,
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(registration !== undefined, 'client.js не вызвал window.__ModuleLoader__.load')
  return registration
}

function makeContext() {
  const locales = []
  const slots = []
  const ctx = {
    locale: {
      register(namespace, dictionaries) { locales.push({ namespace, dictionaries }) },
      bind() { return (key) => `t:${key}` },
    },
    slots: {
      inject(name, callback) { callback() },
      register(options, component) { slots.push({ options, component }); return () => {} },
    },
  }
  return { ctx, locales, slots }
}

/** Отрисовать секцию страницы плагина и развернуть все функциональные компоненты. */
function renderDetail(states = []) {
  const registration = loadClient()
  const module = registration.factory((name) => {
    if (name === 'react') return makeReact(states)
    throw new Error(`неожиданный require: ${name}`)
  })
  const { ctx, locales, slots } = makeContext()
  module.apply(ctx)
  const section = slots.find((item) => item.options.name === 'plugins.detail.section')
  assert.ok(section, 'секция plugins.detail.section не зарегистрирована')
  const tree = section.component({ subject: { kind: 'bundle', pkg: { name: PLUGIN } } })
  return { ...survey(tree), locales }
}

/** Обойти дерево: вернуть элементы и тексты, попутно раскрывая компоненты. */
function survey(node, acc = { nodes: [], texts: [] }) {
  if (node === null || node === undefined || node === false || node === true) return acc
  if (typeof node === 'string' || typeof node === 'number') {
    acc.texts.push(String(node))
    return acc
  }
  if (Array.isArray(node)) {
    for (const item of node) survey(item, acc)
    return acc
  }
  if (typeof node !== 'object') return acc
  if (typeof node.type === 'function') {
    survey(node.type({ ...(node.props ?? {}), children: node.children }), acc)
    return acc
  }
  acc.nodes.push(node)
  for (const child of node.children ?? []) survey(child, acc)
  return acc
}

/** Текст внутри одного элемента (без подъёма к родителям). */
function textsOf(node, out = []) {
  for (const child of node.children ?? []) {
    if (typeof child === 'string' || typeof child === 'number') out.push(String(child))
    else if (child !== null && typeof child === 'object') textsOf(child, out)
  }
  return out
}

/** Все <style> страницы одним текстом. */
function pageCss(nodes) {
  return nodes
    .filter((node) => node.type === 'style')
    .flatMap((node) => node.children)
    .join('\n')
}

/** Состояние React для страницы с загруженным списком сессий. */
function loadedStates() {
  return [
    true,
    { sessions: [{ id: 'abc12345', title: 'Тестовая сессия', createdAt: 1700000000000 }], zstd: true, settings: { minBudget: 300, maxBudget: 200000 } },
    false,
    'abc12345',
    '6000',
    false,
    { before: 1000, after: 250, markdown: '# Выжимка' },
    false,
    '',
    '',
  ]
}

test('страница: центрированный контейнер maxWidth 960 и адаптив', () => {
  const { nodes } = renderDetail()
  const page = nodes.find((node) => node.props?.style?.maxWidth === 960)
  assert.ok(page, 'нет контейнера maxWidth 960')
  const style = page.props.style
  assert.equal(style.width, '100%')
  assert.equal(style.margin, '0 auto')
  assert.equal(style.padding, '24px 28px 40px')
  assert.equal(style.boxSizing, 'border-box')
  assert.equal(style.display, 'flex')
  assert.equal(style.flexDirection, 'column')
  assert.equal(style.gap, 16)

  const css = pageCss(nodes)
  assert.match(css, /@media \(max-width: 900px\)/, 'на 900 px — одна колонка')
  assert.match(css, /@media \(max-width: 640px\)/, 'на 640 px — компактные поля')
  assert.match(css, /grid-template-columns:1fr/)
})

test('шапка: иконка 52, заголовок 20/600, статус-чип и «Обновить»', () => {
  const { nodes, texts } = renderDetail()
  const icon = nodes.find((node) => node.props?.style?.width === 52 && node.props?.style?.height === 52)
  assert.ok(icon, 'нет квадрата-иконки 52×52')
  assert.equal(icon.props.style.borderRadius, 14)
  assert.ok(texts.includes('🗜️'), 'в иконке нет эмодзи')

  const title = nodes.find((node) => node.type === 'h1')
  assert.ok(title, 'нет заголовка h1')
  assert.equal(title.props.style.fontSize, 20)
  assert.equal(title.props.style.fontWeight, 600)
  assert.ok(textsOf(title).includes('t:heading'))

  const chip = nodes.find((node) => node.props?.['data-dsh-compact-chip'] === 'status')
  assert.ok(chip, 'нет статус-чипа')
  const chipStyle = chip.props.style
  assert.equal(chipStyle.display, 'inline-flex')
  assert.equal(chipStyle.borderRadius, 10, 'чип — не пилюля, а кнопка: radius 10')
  assert.equal(chipStyle.height, 32, 'в шапке чип height 32')
  assert.equal(chipStyle.padding, '0 12px')
  assert.match(chipStyle.border, /^1px solid /, 'у чипа рамка 1px')
  assert.equal(chipStyle.fontWeight, 600)
  assert.equal(chipStyle.fontSize, 12.5)
  assert.equal(chipStyle.gap, 6)
  assert.ok(textsOf(chip).includes('t:statusIdle'))
  const dot = nodes.find(
    (node) => node.props?.style?.width === 6 && node.props?.style?.height === 6 && node.props?.style?.borderRadius === '50%',
  )
  assert.ok(dot, 'нет точки-индикатора 6px у чипа')
  assert.equal(dot.props.style.background, 'currentColor')

  const refresh = nodes.find(
    (node) => node.type === 'button' && textsOf(node).includes('t:refresh'),
  )
  assert.ok(refresh, 'нет кнопки «Обновить» в шапке')
  assert.equal(refresh.props.style.height, 32)
  assert.equal(refresh.props.style.borderRadius, 10)
  assert.equal(refresh.props.style.padding, '0 14px')
  assert.equal(refresh.props.style.background, 'transparent')
  assert.equal(typeof refresh.props.onClick, 'function')
})

test('контент: карточки-секции, кнопка primary 36/10 и поле 34/9', () => {
  const { nodes } = renderDetail(loadedStates())
  const cards = nodes.filter(
    (node) => node.type === 'section' && node.props?.style?.borderRadius === 14,
  )
  assert.ok(cards.length >= 2, `ожидались две карточки-секции, найдено ${cards.length}`)
  for (const card of cards) {
    assert.equal(card.props.style.background, 'var(--dsw-alias-bg-layer-1)')
    assert.equal(card.props.style.border, '1px solid var(--dsw-alias-border-l2)')
    assert.equal(card.props.style.padding, 16)
    assert.equal(card.props.style.gap, 12)
    assert.equal(card.props.style.flexDirection, 'column')
    assert.equal(card.props.style.minWidth, 0)
  }

  const bars = nodes.filter(
    (node) => node.props?.style?.width === 3 && node.props?.style?.height === 14,
  )
  assert.ok(bars.length >= 2, 'нет акцентных полосок у заголовков секций')
  for (const bar of bars) assert.match(bar.props.style.background, /--dsw-alias-brand-primary/)

  const sectionTitles = nodes.filter(
    (node) => node.type === 'h2' && node.props?.style?.fontSize === 14,
  )
  assert.ok(sectionTitles.length >= 2, 'нет заголовков секций 14/600')

  const primary = nodes.find(
    (node) => node.type === 'button' && textsOf(node).includes('t:compress'),
  )
  assert.ok(primary, 'нет кнопки «Сжать»')
  assert.equal(primary.props.style.height, 36)
  assert.equal(primary.props.style.borderRadius, 10)
  assert.match(String(primary.props.style.background), /color-mix\(in srgb, ?var\(--dsw-alias-brand-primary\) 18%, ?transparent\)/)
  assert.equal(primary.props.style.color, 'var(--dsw-alias-brand-primary)')

  const input = nodes.find((node) => node.type === 'input' && node.props?.type === 'number')
  assert.ok(input, 'нет поля размера выжимки')
  assert.equal(input.props.style.height, 34)
  assert.equal(input.props.style.borderRadius, 9)
  assert.equal(input.props.style.border, '1px solid var(--dsw-alias-border-l2)')
  assert.equal(input.props.style.background, 'var(--dsw-alias-bg-layer-2)')
  assert.equal(input.props.style.width, '100%')

  const select = nodes.find((node) => node.type === 'select')
  assert.ok(select, 'нет выбора сессии')
  assert.equal(select.props.style.height, 34)
  assert.equal(select.props.style.borderRadius, 9)
})

test('единая система кнопок: 36/32, радиус 10, мягкая заливка brand', () => {
  const { nodes } = renderDetail(loadedStates())
  const buttons = nodes.filter((node) => node.type === 'button')
  assert.ok(buttons.length >= 3, 'на странице есть кнопки')

  for (const button of buttons) {
    const style = button.props.style ?? {}
    assert.ok([32, 36].includes(style.height), `высота кнопки 32 или 36, а не ${style.height}`)
    assert.equal(style.borderRadius, 10, 'радиус кнопки 10')
    assert.equal(style.display, 'inline-flex', 'кнопка — inline-flex')
    assert.equal(style.fontWeight, 600, 'кнопка — 600')
    assert.equal(style.fontSize, 12.5, 'кнопка — 12.5')
    assert.equal(style.whiteSpace, 'nowrap', 'подпись кнопки не переносится')
    if (textsOf(button).join('').trim() !== '') {
      assert.equal(style.width, undefined, 'у текстовой кнопки нет фиксированной ширины')
      assert.equal(style.minWidth, undefined, 'у кнопки нет фиксированной min-width')
    }
    const color = String(style.color ?? '')
    assert.doesNotMatch(color, /#fff|#ffffff|label-primary-inverted/i, 'нет белого текста на кнопке')
  }

  const secondary = nodes.find(
    (node) => node.type === 'button' && textsOf(node).includes('t:copy'),
  )
  assert.ok(secondary, 'нет вторичной кнопки «Скопировать»')
  assert.equal(secondary.props.style.background, 'transparent')
  assert.equal(secondary.props.style.color, 'var(--dsw-alias-label-primary)')

  const css = pageCss(nodes)
  assert.match(css, /\.dshcm-page-primary:hover:not\(:disabled\)/, 'есть hover у primary')
  assert.match(css, /\.dshcm-page-primary:disabled/, 'есть disabled у primary')
  assert.match(css, /:focus-visible/, 'есть фокус-рамка у кнопок')
  assert.doesNotMatch(css, /#fff|#ffffff/i, 'в CSS нет белого текста')
})

test('адаптив: сетка auto-fit, перенос кнопок и длинных строк', () => {
  const { nodes } = renderDetail(loadedStates())
  const grid = nodes.find((node) => node.props?.style?.display === 'grid')
  assert.ok(grid, 'нет сетки полей')
  assert.equal(grid.props.style.gridTemplateColumns, 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))')
  assert.equal(grid.props.style.alignItems, 'stretch')
  assert.equal(grid.props.style.minWidth, 0)

  const headRight = nodes.find((node) => node.props?.className === 'dshcm-page-head-right')
  assert.ok(headRight, 'правая часть шапки переносится')
  assert.equal(headRight.props.style.flexWrap, 'wrap')

  const actions = nodes.find((node) => node.props?.className === 'dshcm-page-actions')
  assert.ok(actions, 'строка кнопок переносится')

  assert.match(SOURCE, /overflowWrap: 'anywhere'/, 'у подсказок есть overflow-wrap:anywhere')
  const css = pageCss(nodes)
  assert.match(css, /\.dshcm-page\{overflow-wrap:anywhere;\}/)
  assert.match(css, /\.dshcm-page-actions\{[^}]*flex-wrap:wrap/)
  assert.match(css, /\.dshcm-page-actions\{[^}]*margin-top:auto/, 'футер прижат к низу')
})

test('пустое состояние: иконка 32, текст и подсказка', () => {
  const { nodes, texts } = renderDetail()
  const emptyIcon = nodes.find((node) => node.props?.style?.fontSize === 32)
  assert.ok(emptyIcon, 'нет иконки пустого состояния')
  assert.ok(texts.includes('t:sessionsEmpty'))
  assert.ok(texts.includes('t:sessionsEmptyHint'))
})

test('чип показывает готовую выжимку и её счётчики', () => {
  const states = [
    true,
    { sessions: [], zstd: true, settings: { minBudget: 300, maxBudget: 200000 } },
    false,
    '',
    '6000',
    false,
    { before: 1000, after: 250, markdown: '# Выжимка' },
    false,
    '',
    '',
  ]
  const { nodes } = renderDetail(states)
  const chip = nodes.find((node) => node.props?.['data-dsh-compact-chip'] === 'status')
  assert.ok(chip, 'нет статус-чипа')
  assert.equal(chip.props.style.borderRadius, 10)
  assert.equal(chip.props.style.height, 32)
  assert.ok(textsOf(chip).includes('t:statusReady'))
  const badge = nodes.find((node) => node.props?.['data-dsh-compact-chip'] === 'reduction')
  assert.ok(badge, 'нет бейджа с процентом сжатия')
  assert.equal(badge.props.style.borderRadius, 10, 'бейдж — тоже кнопочный чип')
  assert.equal(badge.props.style.height, 32)
  assert.match(badge.props.style.border, /^1px solid /)
  assert.ok(
    nodes.some((node) => node.type === 'button' && textsOf(node).includes('t:copy')),
    'нет кнопки «Скопировать» после результата',
  )
  assert.ok(
    nodes.some((node) => node.type === 'pre' && textsOf(node).includes('# Выжимка')),
    'нет предпросмотра выжимки',
  )
})

test('цвета: только токены темы, жёстких hex и белого текста нет', () => {
  const { nodes } = renderDetail(loadedStates())
  const styles = nodes
    .map((node) => node.props?.style)
    .filter((style) => style !== undefined && style !== null)
  const dump = JSON.stringify(styles)
  assert.doesNotMatch(dump, /#[0-9a-fA-F]{3,8}\b/, 'в стилях есть жёсткий hex-цвет')
  assert.doesNotMatch(dump, /label-primary-inverted/, 'нет белого текста через label-primary-inverted')
  assert.match(dump, /var\(--dsw-alias-/, 'в стилях нет токенов темы')
})

test('свёрнутое состояние: только шапка, без карточек', () => {
  const { nodes } = renderDetail([false])
  assert.ok(nodes.some((node) => node.props?.style?.maxWidth === 960), 'страница осталась')
  assert.equal(
    nodes.filter((node) => node.type === 'section' && node.props?.style?.borderRadius === 14).length,
    0,
    'в свёрнутом виде карточки не показываются',
  )
})

test('словари en и ru содержат одинаковые ключи', () => {
  const { locales } = renderDetail()
  const dictionaries = locales[0].dictionaries
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'ru'])
  assert.deepEqual(
    Object.keys(dictionaries.en).sort(),
    Object.keys(dictionaries.ru).sort(),
    'словари en и ru должны содержать одинаковые ключи',
  )
  for (const key of ['refresh', 'settingsLabel', 'statusIdle', 'statusReady', 'statusError', 'sessionsEmptyHint']) {
    assert.ok(key in dictionaries.en, `en: нет ключа ${key}`)
    assert.ok(key in dictionaries.ru, `ru: нет ключа ${key}`)
  }
})
