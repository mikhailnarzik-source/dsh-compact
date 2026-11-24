/**
 * Host-часть `dsh-compact`.
 *
 * Читает журнал сессии DSH с диска и отдаёт экстрактивную выжимку диалога:
 * без нейросети, без сети, полностью локально. Наружу выставлены инструмент
 * агента `dialog_compact` и два POST-маршрута для карточки в настройках:
 *
 * - `/api/dsh-compact/state`   — какие сессии есть, где журнал, настройки;
 * - `/api/dsh-compact/preview` — построить выжимку (и при `save: true`
 *   записать её в `~/.dsh/dsh-compact/<session-id>.md`).
 *
 * Вся логика сжатия живёт в `lib/compact.mjs` и не зависит от DSH.
 */
import { readFileSync } from 'node:fs'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_BUDGET,
  MAX_BUDGET,
  MIN_BUDGET,
  ZSTD_AVAILABLE,
  clampBudget,
  compactLog,
  decompressLog,
  extractTitleFromText,
} from './lib/compact.mjs'

export const name = 'dsh-compact'
export const inject = ['tools', 'sessionPersistence', 'connection']

const STATE_PATH = '/api/dsh-compact/state'
const PREVIEW_PATH = '/api/dsh-compact/preview'

/** Предел размера сжатого журнала: защита от случайного гигантского файла. */
const MAX_LOG_BYTES = 192 * 1024 * 1024
/** Сколько байт начала журнала читать ради заголовка сессии. */
const TITLE_PREFIX_BYTES = 96 * 1024
/** Сколько последних сессий показывать в карточке. */
const SESSION_LIMIT = 25

let VERSION = '1.0.0'
try {
  VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version ?? VERSION
} catch {
  // версия — только для отображения
}

const asString = (value) => (typeof value === 'string' ? value : '')

/** DSH home: та же папка, что используют остальные части DSH. */
function dshHome() {
  const configured = asString(process.env.DSH_HOME).trim()
  if (configured !== '') return configured
  return join(homedir(), '.dsh')
}

/** Нормализация пути для сравнения: регистр и разделители не важны. */
function normalizePath(value) {
  return String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

function samePath(a, b) {
  if (a === '' || b === '') return false
  return normalizePath(a) === normalizePath(b)
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function parseBody(request) {
  try {
    return (await request.json()) ?? {}
  } catch {
    return {}
  }
}

function isSubagent(header) {
  return header?.origin === 'subagent' || Number(header?.delegationDepth) > 0
}

function compareSessions(left, right) {
  const a = left.updatedAt || left.createdAt
  const b = right.updatedAt || right.createdAt
  if (b !== a) return b - a
  if ((right.eventCount ?? 0) !== (left.eventCount ?? 0)) return (right.eventCount ?? 0) - (left.eventCount ?? 0)
  return right.createdAt - left.createdAt
}

/**
 * Все сессии, которые видит сам DSH: `sessionPersistence.list()` отдаёт
 * заголовок и путь к журналу, поэтому обходить каталог вручную не нужно.
 * «Свежесть» определяется mtime журнала — сессия дописывается по ходу работы.
 */
async function listSessions(ctx) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined || persistence === null || typeof persistence.list !== 'function') {
    throw new Error('сервис sessionPersistence недоступен: плагин не может перечислить сессии')
  }
  const snapshots = await persistence.list()
  const sessions = []
  for (const snapshot of snapshots ?? []) {
    const header = snapshot?.header
    if (header === null || header === undefined || typeof header !== 'object') continue
    const id = asString(header.id)
    const path = asString(snapshot?.location?.path)
    if (id === '' || path === '') continue
    sessions.push({
      id,
      path,
      cwd: asString(header.cwd),
      createdAt: Number(header.createdAt) || 0,
      updatedAt: 0,
      sizeBytes: Number(snapshot?.sizeBytes) || 0,
      eventCount: Number(snapshot?.eventCount) || 0,
      root: !isSubagent(header),
      origin: asString(header.origin),
    })
  }
  await Promise.all(sessions.map(async (session) => {
    try {
      session.updatedAt = (await stat(session.path)).mtimeMs
      session.readable = true
    } catch {
      session.updatedAt = 0
      session.readable = false
    }
  }))
  // Нематериализованные сессии (журнала ещё нет) пропускаем: выбрать их
  // значило бы пообещать выжимку, которую не из чего строить.
  const readable = sessions.filter((session) => session.readable)
  readable.sort(compareSessions)
  return readable
}

/**
 * Заголовок сессии (`session/title`) может меняться по ходу работы: DSH сначала
 * пишет предварительное имя (первое сообщение), затем настоящее. Ищем последнее
 * событие окнами от конца файла (1, 4, 16, 64 МБ), поэтому список показывает
 * актуальное название, а не первое сообщение.
 */
const ZSTD_MAGIC_BYTES = [0x28, 0xb5, 0x2f, 0xfd]
const TITLE_CACHE_LIMIT = 300
const titleCache = new Map()

function titleFromWindow(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return ''
  let from = -1
  for (let index = 0; index + 4 <= bytes.length; index += 1) {
    if (ZSTD_MAGIC_BYTES.every((value, offset) => bytes[index + offset] === value)) { from = index; break }
  }
  const view = from === -1 ? bytes : bytes.subarray(from)
  try {
    return extractTitleFromText(view.length >= 4 && ZSTD_MAGIC_BYTES.every((value, offset) => view[offset] === value)
      ? decompressLog(view)
      : view.toString('utf8'))
  } catch {
    return ''
  }
}

async function readRange(path, start, end) {
  const handle = await open(path, 'r')
  try {
    const length = Math.max(0, end - start)
    if (length === 0) return Buffer.alloc(0)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer
  } finally {
    await handle.close().catch(() => {})
  }
}

async function readTitle(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    return ''
  }
  if (!info.isFile() || info.size <= 0) return ''
  const cached = titleCache.get(path)
  if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.title
  let title = ''
  try {
    let window = 1024 * 1024
    while (true) {
      const start = Math.max(0, info.size - window)
      const bytes = await readRange(path, start, info.size)
      title = titleFromWindow(bytes)
      if (title !== '' || start === 0) break
      window *= 4
    }
  } catch {
    title = ''
  }
  if (titleCache.size >= TITLE_CACHE_LIMIT) {
    const oldest = titleCache.keys().next()
    if (!oldest.done) titleCache.delete(oldest.value)
  }
  titleCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, title })
  return title
}

async function attachTitles(sessions, limit) {
  const top = sessions.slice(0, limit)
  await Promise.all(top.map(async (session) => {
    session.title = await readTitle(session.path)
  }))
  return top
}

/**
 * Найти нужную сессию: явный id, иначе последняя сессия проекта. Путь проекта
 * берётся из заголовка сессии, в которой вызван инструмент; если контекст
 * вызова недоступен — просто последняя сессия.
 */
function resolveSession(sessions, explicitId, calling) {
  const wanted = asString(explicitId).trim()
  if (wanted !== '') return sessions.find((session) => session.id === wanted)

  const cwd = asString(calling?.cwd)
  let pool = sessions
  if (cwd !== '') {
    const scoped = sessions.filter((session) => samePath(session.cwd, cwd))
    if (scoped.length > 0) pool = scoped
  }
  const roots = pool.filter((session) => session.root)
  const ranked = (roots.length > 0 ? roots : pool).slice().sort(compareSessions)
  return ranked[0]
}

function describeSession(session) {
  return {
    id: session.id,
    title: session.title ?? '',
    path: session.path,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sizeBytes: session.sizeBytes,
    eventCount: session.eventCount,
    root: session.root,
  }
}

/** Доступность плагина для карточки: сессии, пути, настройки. */
async function readState(ctx) {
  const sessions = await listSessions(ctx)
  const withTitles = await attachTitles(sessions, SESSION_LIMIT)
  const latest = withTitles[0]
  const projectSessions = latest === undefined
    ? 0
    : sessions.filter((session) => samePath(session.cwd, latest.cwd)).length
  return {
    ok: true,
    version: VERSION,
    zstd: ZSTD_AVAILABLE,
    home: dshHome(),
    journalRoot: join(dshHome(), 'sessions'),
    saveDir: join(dshHome(), 'dsh-compact'),
    settings: { budget: DEFAULT_BUDGET, minBudget: MIN_BUDGET, maxBudget: MAX_BUDGET },
    total: sessions.length,
    project: latest?.cwd ?? '',
    projectSessions,
    latest: latest === undefined ? null : describeSession(latest),
    sessions: withTitles.map(describeSession),
  }
}

async function readLog(path) {
  const info = await stat(path)
  if (info.size > MAX_LOG_BYTES) {
    throw new Error(`журнал сессии слишком большой: ${info.size} байт (предел ${MAX_LOG_BYTES})`)
  }
  return readFile(path)
}

/** Безопасное имя файла для сохранённой выжимки. */
function safeFileName(sessionId) {
  const cleaned = asString(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  return cleaned === '' ? 'session' : cleaned
}

/** Записать выжимку в `~/.dsh/dsh-compact/<session-id>.md`. */
async function saveMarkdown(sessionId, markdown) {
  const directory = join(dshHome(), 'dsh-compact')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${safeFileName(sessionId)}.md`)
  await writeFile(path, markdown, 'utf8')
  return path
}

/**
 * Построить выжимку: выбрать сессию, прочитать журнал, сжать и при желании
 * сохранить результат на диск.
 */
async function buildPreview(ctx, payload, calling) {
  const explicitId = asString(payload?.sessionId).trim()
  const budget = clampBudget(payload?.budget ?? DEFAULT_BUDGET)
  const save = payload?.save === true

  const sessions = await listSessions(ctx)
  if (sessions.length === 0) throw new Error('сессии не найдены: журналов в ~/.dsh/sessions пока нет')
  const target = resolveSession(sessions, explicitId, calling)
  if (target === undefined) {
    throw new Error(explicitId === '' ? 'не удалось выбрать сессию' : `сессия «${explicitId}» не найдена`)
  }

  const bytes = await readLog(target.path)
  const title = target.title ?? await readTitle(target.path)
  const result = compactLog(bytes, { budget, sessionId: target.id, title })

  let savedPath
  if (save) savedPath = await saveMarkdown(target.id, result.markdown)

  const response = {
    ok: true,
    sessionId: target.id,
    title: title ?? '',
    markdown: result.markdown,
    before: result.before,
    after: result.after,
    stats: result.stats,
  }
  if (savedPath !== undefined) response.savedPath = savedPath
  return response
}

/** Сессия, из которой вызван инструмент: её cwd задаёт «проект». */
function callingSession(exec) {
  try {
    const session = exec?.agent?.session
    return {
      id: asString(session?.id),
      cwd: asString(session?.header?.cwd),
    }
  } catch {
    return { id: '', cwd: '' }
  }
}

/** Схема успешного значения инструмента. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    sessionId: { type: 'string' },
    title: { type: 'string' },
    markdown: { type: 'string' },
    before: { type: 'number' },
    after: { type: 'number' },
    savedPath: { type: 'string' },
  },
  required: ['ok', 'markdown', 'before', 'after'],
}

const TOOL_OUTPUT = {
  schema: TOOL_OUTPUT_SCHEMA,
  render(_args, value) {
    const data = value !== null && typeof value === 'object' ? value : {}
    const parts = [asString(data.markdown)]
    const before = Number(data.before) || 0
    const after = Number(data.after) || 0
    parts.push(`было ${before} символов → стало ${after} символов`)
    const savedPath = asString(data.savedPath)
    if (savedPath !== '') parts.push(`сохранено: ${savedPath}`)
    return [{ type: 'text', text: parts.join('\n').trim() }]
  },
}

const DIALOG_COMPACT_TOOL_DESCRIPTION = 'Сжать журнал сессии DSH в короткую Markdown-выжимку без нейросети: задача, что сделано, файлы, команды, открытые вопросы, ошибки. Работает локально, в сеть не ходит.'

/** Определение инструмента создаётся в `apply`, чтобы видеть контекст плагина. */
function createDialogCompactTool(ctx) {
  return {
    name: 'dialog_compact',
    description: DIALOG_COMPACT_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Идентификатор сессии. Если не задан — берётся последняя сессия текущего проекта.',
        },
        budget: {
          type: 'number',
          // У DSH в схеме инструмента нет `minimum`/`maximum`; границы
          // проверяет clampBudget, а модель видит их в описании.
          description: `Размер выжимки в символах, от ${MIN_BUDGET} до ${MAX_BUDGET}. По умолчанию ${DEFAULT_BUDGET}.`,
        },
        save: {
          type: 'boolean',
          description: 'Сохранить выжимку в ~/.dsh/dsh-compact/<session-id>.md.',
        },
      },
    },
    output: TOOL_OUTPUT,

    async execute(args, exec) {
      const payload = args !== null && typeof args === 'object' ? args : {}
      const result = await buildPreview(ctx, {
        sessionId: payload.sessionId,
        budget: payload.budget,
        save: payload.save,
      }, callingSession(exec))
      const value = {
        ok: true,
        sessionId: result.sessionId,
        title: result.title,
        markdown: result.markdown,
        before: result.before,
        after: result.after,
      }
      if (result.savedPath !== undefined) value.savedPath = result.savedPath
      return value
    },
  }
}

export function apply(ctx) {
  const route = (label, path, handler) => {
    try {
      ctx.effect(() => ctx.connection.fetch.register({
        path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: handler,
      }), `dsh-compact: ${label}`)
    } catch (error) {
      console.error(`[dsh-compact] маршрут ${label} не зарегистрирован:`, error)
    }
  }

  route('state', STATE_PATH, async () => {
    try {
      return json(await readState(ctx))
    } catch (error) {
      return json({ ok: false, message: messageOf(error) }, 500)
    }
  })

  route('preview', PREVIEW_PATH, async (request) => {
    try {
      const payload = await parseBody(request)
      return json(await buildPreview(ctx, payload, undefined))
    } catch (error) {
      return json({ ok: false, message: messageOf(error) }, 500)
    }
  })

  try {
    ctx.tools.register(createDialogCompactTool(ctx))
  } catch (error) {
    console.error('[dsh-compact] инструмент dialog_compact не зарегистрирован:', error)
  }
}
