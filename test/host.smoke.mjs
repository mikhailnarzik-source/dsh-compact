/**
 * Smoke-тест host-части: поднимает `apply()` с поддельным контекстом Cordis
 * и временным журналом сессии. Профиль DSH не трогается, реальные сессии не
 * нужны — проверяются маршруты, инструмент и сохранение выжимки.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import { apply, inject, name } from '../index.js'
import { ZSTD_AVAILABLE } from '../lib/compact.mjs'

const SESSION_ID = 'session-host-test'
const TITLE = 'Сборка плагина'
const CWD = 'E:\\DeepSeek Harness'

function eventsOfSession() {
  return [
    { type: 'session', version: 4, id: SESSION_ID, createdAt: 1795000000000, cwd: CWD, isSeeded: false },
    { type: 'session/title', seq: 1, time: 1795000000001, data: { title: TITLE, messageSeqs: [2], source: 'auto' } },
    {
      type: 'user/message',
      seq: 2,
      time: 1795000000002,
      data: {
        content: [{ type: 'text', text: 'Сожми диалог в выжимку: создай плагин dsh-compact.' }],
        source: { kind: 'user' },
        role: 'user',
        id: 'u1',
      },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1795000000003,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'рассуждение не должно попасть в выжимку' },
            { type: 'text', text: 'Итог: готово.\n- index.js\n- lib/compact.mjs' },
          ],
        },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: 4,
      time: 1795000000004,
      data: { turn: 1, step: 2, callId: 'call-1', name: 'pwsh', arguments: '{"command":"node --check index.js"}' },
    },
    {
      type: 'tool/result',
      seq: 5,
      time: 1795000000005,
      data: {
        turn: 1,
        step: 2,
        message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ERROR: синтаксис сломан' }] },
      },
      surfaceOp: 'append',
    },
  ]
}

function logBytes(events) {
  const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  if (!ZSTD_AVAILABLE) return Buffer.from(text, 'utf8')
  const frames = [events.slice(0, 1), events.slice(1, 4), events.slice(4)].map((group) => zlib.zstdCompressSync(Buffer.from(
    `${group.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )))
  return Buffer.concat(frames)
}

function makeContext(snapshot) {
  const routes = new Map()
  const tools = new Map()
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    connection: {
      fetch: {
        register(options) {
          routes.set(options.path, options)
          return () => {}
        },
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    get(service) {
      if (service === 'sessionPersistence') {
        return { list: async () => [snapshot] }
      }
      return undefined
    },
  }
  return { ctx, routes, tools }
}

function post(path, payload) {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
}

test('host-часть: маршруты, инструмент и сохранение выжимки', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-compact-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sessionDir = join(home, 'sessions', '--E-DeepSeek-Harness--', SESSION_ID)
    await mkdir(sessionDir, { recursive: true })
    const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
    const events = eventsOfSession()
    const bytes = logBytes(events)
    await writeFile(logPath, bytes)

    const snapshot = {
      header: { id: SESSION_ID, createdAt: 1795000000000, cwd: CWD, isSeeded: false },
      location: { kind: 'jsonl', path: logPath },
      sizeBytes: bytes.length,
      eventCount: events.length,
    }
    const { ctx, routes, tools } = makeContext(snapshot)

    assert.equal(name, 'dsh-compact')
    assert.deepEqual(inject, ['tools', 'sessionPersistence', 'connection'])
    apply(ctx)

    assert.ok(routes.has('/api/dsh-compact/state'))
    assert.ok(routes.has('/api/dsh-compact/preview'))
    for (const route of routes.values()) {
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
    }

    // state: доступность, список сессий и заголовок прочитаны с диска
    const stateResponse = await routes.get('/api/dsh-compact/state').fetch(post('/api/dsh-compact/state'))
    assert.equal(stateResponse.status, 200)
    const state = await stateResponse.json()
    assert.equal(state.ok, true)
    assert.equal(state.total, 1)
    assert.equal(state.latest.id, SESSION_ID)
    assert.equal(state.latest.title, TITLE)
    assert.equal(state.sessions[0].cwd, CWD)
    assert.equal(state.zstd, ZSTD_AVAILABLE)
    assert.equal(state.settings.budget, 6000)

    // preview: бюджет соблюдается, разделы на месте
    const previewResponse = await routes.get('/api/dsh-compact/preview').fetch(post('/api/dsh-compact/preview', { budget: 1500 }))
    assert.equal(previewResponse.status, 200)
    const preview = await previewResponse.json()
    assert.equal(preview.ok, true)
    assert.equal(preview.sessionId, SESSION_ID)
    assert.ok(preview.after <= 1500)
    assert.ok(preview.before > preview.after)
    for (const heading of ['Задача', 'Что сделано', 'Файлы', 'Команды', 'Открытые вопросы', 'Ошибки']) {
      assert.ok(preview.markdown.includes(`## ${heading}`), `нет раздела «${heading}»`)
    }

    // неизвестный sessionId — понятная ошибка, а не падение
    const missingResponse = await routes.get('/api/dsh-compact/preview').fetch(post('/api/dsh-compact/preview', { sessionId: 'нет-такой' }))
    assert.equal(missingResponse.status, 500)
    const missing = await missingResponse.json()
    assert.equal(missing.ok, false)
    assert.match(missing.message, /не найдена/)

    // инструмент агента
    assert.ok(tools.has('dialog_compact'))
    const tool = tools.get('dialog_compact')
    assert.equal(tool.parameters.properties.sessionId.type, 'string')
    assert.equal(tool.parameters.properties.budget.type, 'number')
    assert.equal(tool.parameters.properties.save.type, 'boolean')

    // DSH принимает только подмножество JSON Schema: type/oneOf/properties/
    // required/additionalProperties/items/enum/const + аннотации. Лишний
    // ключ молча ломает регистрацию инструмента, поэтому проверяем схемы.
    const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
    const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
    const checkSchema = (node, label) => {
      assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${label}: не объект схемы`)
      for (const key of Object.keys(node)) {
        assert.ok(CONSTRAINT.has(key) || ANNOTATION.has(key), `${label}: неподдерживаемый ключ «${key}»`)
      }
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          assert.ok(node.properties !== undefined && Object.hasOwn(node.properties, key), `${label}.required: нет свойства «${key}»`)
        }
      }
      if (node.properties !== undefined) {
        for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${label}.${key}`)
      }
      if (node.items !== undefined) checkSchema(node.items, `${label}.items`)
    }
    checkSchema(tool.parameters, 'dialog_compact.parameters')
    checkSchema(tool.output.schema, 'dialog_compact.output.schema')

    const value = await tool.execute({ budget: 1200, save: true }, {})
    assert.equal(value.ok, true)
    assert.equal(value.sessionId, SESSION_ID)
    assert.ok(value.after <= 1200)
    assert.ok(typeof value.savedPath === 'string' && value.savedPath !== '')
    const saved = await readFile(value.savedPath, 'utf8')
    assert.equal(saved, value.markdown)

    const blocks = tool.output.render({}, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /было \d+ символов → стало \d+ символов/)
    assert.match(blocks[0].text, /сохранено:/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
