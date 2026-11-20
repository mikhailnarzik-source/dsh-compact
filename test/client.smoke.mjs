/**
 * Smoke-тест клиентской части без браузера: `client.js` исполняется в vm с
 * поддельным `window.__ModuleLoader__` и минимальным React. Проверяется, что
 * фабрика регистрирует карточку `plugins.item`, что оба словаря на месте и что
 * карточка рисует свёрнутое и развёрнутое состояние.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const SOURCE = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** Поддельный React: элементы — простые объекты, хуки отдают заданные значения. */
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
  }
}

function collectText(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out)
  }
  return out
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

function makeClientContext() {
  const locales = []
  const slots = []
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries })
      },
      bind(namespace) {
        return (key) => `t:${key}`
      },
    },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'plugins.item')
        callback()
      },
      register(options, component) {
        slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, locales, slots }
}

test('client: фабрика, словари и регистрация карточки', () => {
  const registration = loadClient()
  assert.equal(registration.id, 'dsh-compact')

  const module = registration.factory((name) => {
    if (name === 'react') return makeReact()
    throw new Error(`неожиданный require: ${name}`)
  })
  // Массив создан в другом realm (vm), поэтому сравниваем приведённое значение.
  assert.deepEqual([...module.inject], ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')

  const { ctx, locales, slots } = makeClientContext()
  module.apply(ctx)

  assert.equal(locales.length, 1)
  assert.equal(locales[0].namespace, 'dshCompact')
  const dictionaries = locales[0].dictionaries
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'ru'])
  assert.deepEqual(
    Object.keys(dictionaries.en).sort(),
    Object.keys(dictionaries.ru).sort(),
    'словари en и ru должны содержать одинаковые ключи',
  )

  assert.equal(slots.length, 1)
  assert.equal(slots[0].options.name, 'plugins.item')
  assert.equal(slots[0].options.id, 'dsh-compact')
  assert.equal(slots[0].options.locale, 'dshCompact')
  assert.equal(typeof slots[0].component, 'function')

  // Свёрнутое состояние: заголовок, подсказка и кнопка «Открыть».
  const collapsed = collectText(slots[0].component()).join(' ')
  assert.ok(collapsed.includes('t:heading'))
  assert.ok(collapsed.includes('t:hint'))
  assert.ok(collapsed.includes('t:open'))
})

test('client: развёрнутая карточка показывает выбор сессии, бюджет и «Сжать»', () => {
  const registration = loadClient()
  // Порядок useState в компоненте: open, state, loading, selectedId, budget,
  // saveFile, result, busy, error, notice.
  const react = makeReact([true, null, false, '', '6000', false, null, false, '', ''])
  const module = registration.factory((name) => {
    if (name === 'react') return react
    throw new Error(`неожиданный require: ${name}`)
  })
  const { ctx, slots } = makeClientContext()
  module.apply(ctx)

  const expanded = collectText(slots[0].component()).join(' ')
  assert.ok(expanded.includes('t:sessionLabel'))
  assert.ok(expanded.includes('t:budgetLabel'))
  assert.ok(expanded.includes('t:saveLabel'))
  assert.ok(expanded.includes('t:compress'))
  assert.ok(expanded.includes('t:resultLabel'))
  assert.ok(expanded.includes('t:sessionsEmpty'))
})
