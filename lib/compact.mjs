/**
 * Чистая логика плагина `dsh-compact`.
 *
 * На вход приходят байты журнала сессии DSH (`session.v4.jsonl.zstd`), на
 * выходе — Markdown-выжимка. Никакой сети, моделей и файловых операций:
 * только `node:zlib` для zstd и строковые эвристики. Поэтому модуль целиком
 * проверяется обычными `node --test` на синтетических событиях.
 *
 * Формат журнала: первый zstd-кадр — строка заголовка `{ type: 'session' }`,
 * дальше — склеенные zstd-кадры с событиями (`user/message`,
 * `assistant/message`, `tool/call`, `tool/result`, служебные события и т. д.).
 * Если журнал записан без сжатия, строки читаются как обычный JSONL.
 */
import zlib from 'node:zlib'

/** Сколько символов выжимки получается по умолчанию. */
export const DEFAULT_BUDGET = 6000
/** Нижняя граница бюджета: меньше шести разделов не помещаются осмысленно. */
export const MIN_BUDGET = 300
/** Верхняя граница: защита от случайного «сожми в гигабайт». */
export const MAX_BUDGET = 200_000

/** Предельная длина одного сообщения пользователя в выжимке. */
export const USER_CLIP = 400
const DECISION_CLIP = 320
const QUESTION_CLIP = 200
const ERROR_CLIP = 200
const DETAIL_CLIP = 160
const MAX_ITEM_TEXT = 12_000

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_FRAME_MAGIC = 0xfd2fb528

// Именованный импорт сломал бы загрузку модуля в Node без поддержки zstd,
// поэтому берём namespace и проверяем наличие функции сами.
const zstdDecompressSync = typeof zlib.zstdDecompressSync === 'function'
  ? zlib.zstdDecompressSync
  : undefined

/** Есть ли в текущем Node поддержка zstd (нужна для чтения журналов). */
export const ZSTD_AVAILABLE = zstdDecompressSync !== undefined

const SECTION_TITLES = {
  task: 'Задача',
  done: 'Что сделано',
  files: 'Файлы',
  commands: 'Команды',
  questions: 'Открытые вопросы',
  errors: 'Ошибки',
}

// --- zstd и JSONL ----------------------------------------------------------

/**
 * Длина одного zstd-кадра, начинающегося в `start`, или -1, если кадр не
 * помещается в буфер. Границы считаются по структуре формата (RFC 8878),
 * потому что и потоковый декодер, и `zstdDecompressSync` останавливаются на
 * первом кадре, а журнал сессии — это тысячи склеенных кадров.
 * @param {Buffer} bytes
 * @param {number} start
 * @returns {number}
 */
export function frameLength(bytes, start = 0) {
  const source = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (start < 0 || start + 5 > source.length) return -1
  if (source.readUInt32LE(start) !== ZSTD_FRAME_MAGIC) return -1
  let pos = start + 4
  const descriptor = source[pos]
  pos += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = (descriptor >> 5) & 1
  const hasChecksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (!singleSegment) pos += 1 // Window Descriptor
  pos += [0, 1, 2, 4][dictionaryFlag] // Dictionary ID
  pos += contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : [0, 2, 4, 8][contentSizeFlag]
  for (;;) {
    if (pos + 3 > source.length) return -1
    const header = source[pos] | (source[pos + 1] << 8) | (source[pos + 2] << 16)
    pos += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    if (type === 0 || type === 2) pos += size
    else if (type === 1) pos += 1
    else return -1
    if (pos > source.length) return -1
    if (last) break
  }
  if (hasChecksum) pos += 4
  return pos > source.length ? -1 : pos - start
}

/**
 * Распаковать журнал сессии: все zstd-кадры подряд либо обычный JSONL.
 * Оборванный хвост (запись ещё идёт) отбрасывается: уже распакованный
 * префикс остаётся пригодным.
 * @param {Buffer|Uint8Array|string} input
 * @returns {string}
 */
export function decompressLog(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (bytes.length === 0) return ''
  const compressed = bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC)
  if (!compressed) return bytes.toString('utf8')
  if (!ZSTD_AVAILABLE) {
    throw new Error(
      'текущий Node не умеет распаковывать zstd: журнал сессии прочитать нельзя. '
      + 'Нужен Node >= 22.15 со встроенным node:zlib zstd.',
    )
  }
  const parts = []
  let pos = 0
  while (pos < bytes.length) {
    const length = frameLength(bytes, pos)
    if (length <= 0) break // неполный кадр в хвосте
    let plain
    try {
      plain = zstdDecompressSync(bytes.subarray(pos, pos + length))
    } catch (error) {
      if (parts.length > 0) break // хвост повреждён — оставляем прочитанное
      throw new Error(`не удалось распаковать журнал сессии: ${error instanceof Error ? error.message : String(error)}`)
    }
    parts.push(plain.toString('utf8'))
    pos += length
  }
  if (parts.length === 0) {
    throw new Error('журнал сессии пуст или повреждён: не распаковано ни одного zstd-кадра')
  }
  return parts.join('')
}

/**
 * Разобрать JSONL в массив событий. Битые строки пропускаются и считаются.
 * @param {string} text
 * @returns {{ events: object[], skipped: number }}
 */
export function parseJsonl(text) {
  const events = []
  let skipped = 0
  for (const row of String(text).split('\n')) {
    const line = row.trim()
    if (line === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) events.push(value)
    else skipped += 1
  }
  return { events, skipped }
}

// --- текстовые примитивы ---------------------------------------------------

const plural = (count, one, few, many) => {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

const pluralSteps = (count) => plural(count, 'шаг', 'шага', 'шагов')
const pluralEvents = (count) => plural(count, 'событие', 'события', 'событий')
const pluralMessages = (count) => plural(count, 'сообщение', 'сообщения', 'сообщений')
const pluralCommands = (count) => plural(count, 'команда', 'команды', 'команд')
const pluralErrors = (count) => plural(count, 'ошибка', 'ошибки', 'ошибок')
const pluralPaths = (count) => plural(count, 'путь', 'пути', 'путей')

const asText = (value) => (typeof value === 'string' ? value : '')

/** Схлопнуть переводы строк и повторные пробелы: выжимка должна быть плоской. */
export function flatten(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/**
 * Обрезать текст до `max` символов, по возможности не посреди слова.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clip(text, max) {
  const flat = flatten(text)
  const limit = Math.max(1, Math.floor(max))
  if (flat.length <= limit) return flat
  if (limit <= 1) return '…'
  let cut = flat.slice(0, limit - 1)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > limit * 0.6) cut = cut.slice(0, lastSpace)
  return `${cut.trimEnd()}…`
}

/** Множество значимых слов для оценки похожести сообщений. */
function words(text) {
  const normalized = String(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (normalized === '') return new Set()
  return new Set(normalized.split(' ').filter((word) => word.length >= 3 || /^\d+$/.test(word)))
}

/**
 * Похожи ли два текста (коэффициент Жаккара по словам).
 * @param {string} a
 * @param {string} b
 * @param {number} threshold
 * @returns {boolean}
 */
export function similarText(a, b, threshold = 0.8) {
  const left = flatten(a)
  const right = flatten(b)
  if (left === right) return true
  if (left.length < 12 || right.length < 12) return false
  const setA = words(left)
  const setB = words(right)
  if (setA.size === 0 || setB.size === 0) return false
  let common = 0
  for (const word of setA) if (setB.has(word)) common += 1
  const union = setA.size + setB.size - common
  return union > 0 && common / union >= threshold
}

function dedupeTexts(texts, threshold = 0.8) {
  const accepted = []
  for (const text of texts) {
    const flat = flatten(text)
    if (flat === '') continue
    if (accepted.some((existing) => similarText(existing, flat, threshold))) continue
    accepted.push(flat)
  }
  return accepted
}

// --- эвристики -------------------------------------------------------------

const HEADING_RE = /(^|\n)\s*#{1,6}\s+\S/
const LIST_RE = /(^|\n)\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/
const DECISION_RE = /\b(итог\w*|итого|готов\w*|сделан\w*|остал\w*|вывод\w*|решени\w*|результат\w*|проблем\w*|summary|done|remaining|conclusion|result)\b/i

/**
 * Похоже ли сообщение ассистента на решение/вывод: есть список, заголовок
 * или слово вроде «итог», «готово», «осталось».
 * @param {string} text
 * @returns {boolean}
 */
export function isDecision(text) {
  if (typeof text !== 'string' || text.trim() === '') return false
  return HEADING_RE.test(text) || LIST_RE.test(text) || DECISION_RE.test(text)
}

const OPEN_RE = /(\?|остал\w*|нужно|надо|требует\w*|следующ\w* шаг|дальше|todo|fixme|не проверен\w*|waiting|pending|remaining|next step|open question|вопрос\w*)/i
const ERROR_RE = /(\[exit code:\s*\d+\]|(^|[\s([{])(error|failed|failure|fatal|exception|traceback|denied|refused|not found|enoent|eacces|epipe|timeout|ошибк\w*|не удалось|не найден\w*|отказано|сбо\w+|провал\w*))/i

const WIN_PATH_RE = /[A-Za-z]:\\[^\n\r\t"'`<>|*?,();]+/g
const POSIX_PATH_RE = /(?:^|[\s"'`(])((?:\/[\w.@+-]+){2,}\/?)/g
const REL_PATH_RE = /(?:^|[\s"'`(])((?:[\w.@+-]+[\\/]){1,}[\w.@+-]+\.[A-Za-z0-9]{1,8})/g
const FILENAME_RE = /\b[\w.@+-]+\.(?:mjs|cjs|js|jsx|ts|tsx|json|jsonl|md|markdown|ya?ml|toml|ini|cfg|conf|css|scss|html|svg|png|jpe?g|webp|gif|ico|txt|log|ps1|cmd|bat|sh|bash|py|go|rs|java|kt|kts|swift|cs|c|h|cpp|hpp|rb|php|sql|zst|zstd|lock|docx?|xlsx?|pptx?|pdf|zip|tar|gz)\b/gi

/**
 * Найти в текстах имена файлов и пути. Возвращает уникальные значения в
 * порядке первого появления. Короткие фрагменты, целиком входящие в более
 * длинный путь, отбрасываются: `index.js` не дублирует
 * `E:\проект\index.js`.
 * @param {string[]} chunks
 * @returns {string[]}
 */
export function extractPaths(chunks) {
  const seen = new Map()
  const add = (raw) => {
    let value = String(raw)
      .trim()
      .replace(/^[("'`<\s]+/, '')
      .replace(/[)"'`>.,;:!?\]]+$/, '')
    // В аргументах инструментов путь лежит внутри JSON-строки: `\\` — это
    // обычный одиночный разделитель.
    value = value.replace(/\\\\/g, '\\')
    // Путь в русской фразе часто продолжается прозой: «…\index.js и рядом».
    // Обрываем захват перед первым кириллическим словом.
    const prose = value.search(/\s+[А-Яа-яЁё]/)
    if (prose > 0) value = value.slice(0, prose)
    if (value.length > 3) value = value.replace(/[\\/]+$/, '')
    value = value.trim()
    if (value.length < 3 || value.length > 180) return
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return
    if (value === '.' || value === '..') return
    const key = value.replace(/\\/g, '/').toLowerCase()
    if (!seen.has(key)) seen.set(key, value)
  }
  for (const chunk of chunks) {
    if (typeof chunk !== 'string' || chunk === '') continue
    const text = chunk.slice(0, 20_000)
    for (const match of text.matchAll(WIN_PATH_RE)) add(match[0])
    for (const match of text.matchAll(POSIX_PATH_RE)) add(match[1])
    for (const match of text.matchAll(REL_PATH_RE)) add(match[1])
    for (const match of text.matchAll(FILENAME_RE)) add(match[0])
  }
  const entries = [...seen.values()].map((value) => ({ value, key: value.replace(/\\/g, '/').toLowerCase() }))
  return entries
    .filter((entry, index) => !entries.some((other, otherIndex) => otherIndex !== index
      && other.key.length > entry.key.length
      && other.key.includes(entry.key)))
    .map((entry) => entry.value)
}

/**
 * Короткое описание аргументов инструмента: команда, путь или описание.
 * @param {{ name?: string, args?: string }} call
 * @returns {string}
 */
export function summarizeArgs(call) {
  const raw = asText(call?.args)
  if (raw === '') return ''
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return clip(raw, DETAIL_CLIP)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return clip(JSON.stringify(parsed), DETAIL_CLIP)
  }
  const priority = [
    'description', 'command', 'cmd', 'file_path', 'path', 'filePath', 'pattern',
    'query', 'url', 'name', 'prompt', 'task', 'label', 'title', 'action', 'sessionId',
  ]
  for (const key of priority) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(value, DETAIL_CLIP)
  }
  for (const value of Object.values(parsed)) {
    if (typeof value === 'string' && value.trim() !== '') return clip(value, DETAIL_CLIP)
    if (typeof value === 'number' || typeof value === 'boolean') return clip(String(value), 60)
  }
  return clip(raw, DETAIL_CLIP)
}

// --- разбор событий --------------------------------------------------------

function textBlocks(content) {
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text') continue
    const text = asText(block.text)
    if (text.trim() !== '') blocks.push(text)
  }
  return blocks
}

/**
 * Извлечь из журнала только то, что нужно выжимке: сообщения пользователя,
 * тексты ассистента (без reasoning), вызовы и результаты инструментов.
 * @param {object[]} events
 * @returns {{
 *   header: object | undefined,
 *   title: string,
 *   users: object[],
 *   assistants: object[],
 *   toolCalls: object[],
 *   toolResults: object[],
 *   jobs: object[],
 *   timeline: object[],
 * }}
 */
export function extractMessages(events) {
  const header = events.find((event) => event?.type === 'session')
  const users = []
  const assistants = []
  const toolCalls = []
  const toolResults = []
  const jobs = []
  const timeline = []
  let title = ''

  for (const event of events) {
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    switch (event.type) {
      case 'session/title': {
        const value = asText(data.title).trim()
        if (value !== '') title = value
        break
      }
      case 'user/message': {
        // В user/message приходят не только реплики человека: runtime-context,
        // time-context, skill-catalog и user-approval — служебные блоки.
        const kind = asText(data.source?.kind)
        if (kind !== '' && kind !== 'user') break
        const text = textBlocks(data.content).join('\n').trim()
        if (text === '') break
        const item = { kind: 'user', seq: Number(event.seq) || 0, text: text.slice(0, MAX_ITEM_TEXT) }
        users.push(item)
        timeline.push(item)
        break
      }
      case 'assistant/message': {
        // reasoning/thinking в message.content сознательно игнорируется.
        const text = textBlocks(data.message?.content).join('\n').trim()
        if (text === '') break
        const item = { kind: 'assistant', seq: Number(event.seq) || 0, text: text.slice(0, MAX_ITEM_TEXT) }
        assistants.push(item)
        timeline.push(item)
        break
      }
      case 'tool/call': {
        const args = typeof data.arguments === 'string'
          ? data.arguments
          : JSON.stringify(data.arguments ?? '')
        const item = {
          kind: 'tool',
          seq: Number(event.seq) || 0,
          callId: asText(data.callId),
          name: asText(data.name) || 'инструмент',
          args: args.slice(0, 8000),
        }
        toolCalls.push(item)
        timeline.push(item)
        break
      }
      case 'tool/result': {
        // Полный вывод инструмента не нужен: оставляем только первые
        // найденные строки-ошибки (не больше трёх), остальное выбрасываем.
        const callId = asText(data.message?.toolCallId) || asText(data.callId)
        const text = textBlocks(data.message?.content).join('\n')
        const errorLines = []
        if (text !== '') {
          for (const row of text.split('\n')) {
            if (errorLines.length >= 3) break
            const line = row.trim()
            if (line === '' || !ERROR_RE.test(line)) continue
            errorLines.push(line)
          }
        }
        toolResults.push({ seq: Number(event.seq) || 0, callId, errorLines })
        break
      }
      case 'job/settled': {
        const status = asText(data.status)
        if (status !== '' && !/^(success|succeeded|ok|completed|done|fulfilled)$/i.test(status)) {
          jobs.push({
            seq: Number(event.seq) || 0,
            label: asText(data.label) || asText(data.jobId) || 'задание',
            status,
            detail: asText(data.detail),
          })
        }
        break
      }
      default:
        break
    }
  }

  return { header, title, users, assistants, toolCalls, toolResults, jobs, timeline }
}

/** Заголовок сессии из уже разобранных событий. */
export function extractTitle(events) {
  let title = ''
  for (const event of events) {
    if (event?.type !== 'session/title') continue
    const value = asText(event.data?.title).trim()
    if (value !== '') title = value
  }
  return title
}

/** Заголовок сессии из текста журнала (в том числе из прочитанного префикса). */
export function extractTitleFromText(text) {
  return extractTitle(parseJsonl(text).events)
}

// --- ограничение бюджета ---------------------------------------------------

/** Привести `budget` к допустимому целому числу символов. */
export function clampBudget(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_BUDGET
  return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, Math.floor(number)))
}

/** Размеры отсечек подстраиваются под бюджет: чем он меньше, тем короче строки. */
function budgetProfile(budget) {
  const limit = clampBudget(budget)
  const tight = limit <= 1000
  const medium = limit <= 2600
  return {
    limit,
    userClip: tight ? 90 : medium ? 180 : USER_CLIP,
    decisionClip: tight ? 110 : medium ? 200 : DECISION_CLIP,
    maxUsers: tight ? 3 : medium ? 6 : 10,
    maxDecisions: tight ? 3 : medium ? 7 : 10,
    maxFiles: tight ? 4 : medium ? 10 : 24,
    maxCommands: tight ? 4 : medium ? 8 : 14,
    maxQuestions: tight ? 2 : medium ? 4 : 6,
    maxErrors: tight ? 2 : medium ? 4 : 6,
    maxLines: tight ? 6 : medium ? 12 : 20,
  }
}

// --- сборка разделов -------------------------------------------------------

function buildTaskLines(model, profile) {
  const texts = dedupeTexts(model.users.map((item) => item.text))
  if (texts.length === 0) return ['- сообщений пользователя не найдено']
  const lines = texts.slice(0, profile.maxUsers).map((text) => `- ${clip(text, profile.userClip)}`)
  if (texts.length > profile.maxUsers) {
    const rest = texts.length - profile.maxUsers
    lines.push(`- … ещё ${rest} ${pluralMessages(rest)} пользователя`)
  }
  return lines
}

function buildDoneLines(model, profile) {
  const lines = []
  const accepted = []
  let run = []
  let omitted = 0

  const flushRun = () => {
    if (run.length >= 3) {
      const names = [...new Set(run.map((call) => call.name))].slice(0, 4)
        .map((name) => `\`${name}\``)
        .join(', ')
      const line = `- … ещё ${run.length} ${pluralSteps(run.length)}${names === '' ? '' : ` (${names})`}`
      if (lines.length < profile.maxLines) lines.push(line)
      else omitted += 1
    }
    run = []
  }

  for (const item of model.timeline) {
    if (item.kind === 'tool') {
      run.push(item)
      continue
    }
    flushRun()
    if (item.kind !== 'assistant' || !isDecision(item.text)) continue
    const text = clip(item.text, profile.decisionClip)
    if (accepted.some((existing) => similarText(existing, text))) continue
    accepted.push(text)
    if (lines.length < profile.maxLines) lines.push(`- ${text}`)
    else omitted += 1
  }
  flushRun()

  if (accepted.length === 0) {
    // Явных решений не нашлось — оставляем последний текст ассистента,
    // иначе раздел состоял бы только из схлопнутых шагов.
    const last = [...model.assistants].reverse().find((item) => item.text.trim() !== '')
    if (last !== undefined) lines.push(`- ${clip(last.text, profile.decisionClip)}`)
  }
  if (omitted > 0) lines.push(`- … ещё ${omitted} ${pluralSteps(omitted)}`)
  if (lines.length === 0) lines.push('- выводов не найдено')
  return lines
}

/**
 * Отбросить шумные «пути»: журналы приложения, временные каталоги и строки со
 * стрелками из объяснений. Они попадают в текст вместе с выводом инструментов
 * и мешают читать раздел «Файлы».
 * @param {string} candidate возможный путь
 */
function isNoisyPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length < 2 || candidate.length > 200) return true
  if (/\\Temp\\|\\tmp\\|\/var\/folders\/|Crashpad|\/logs?\/|crash-\d{4}-/i.test(candidate)) return true
  if (/[▶◀→←]|──|=>/.test(candidate)) return true
  if (/^(http|https):/i.test(candidate)) return true
  return false
}

function buildFileLines(model, profile) {
  const chunks = []
  for (const item of model.users) chunks.push(item.text)
  for (const item of model.assistants) chunks.push(item.text)
  for (const call of model.toolCalls) {
    chunks.push(call.args)
    chunks.push(call.name)
  }
  const paths = extractPaths(chunks).filter((candidate) => !isNoisyPath(candidate))
  if (paths.length === 0) return ['- не найдено']
  const lines = paths.slice(0, profile.maxFiles).map((path) => `- \`${clip(path, 120)}\``)
  if (paths.length > profile.maxFiles) {
    const rest = paths.length - profile.maxFiles
    lines.push(`- … ещё ${rest} ${pluralPaths(rest)}`)
  }
  return lines
}

function buildCommandLines(model, profile) {
  const entries = []
  for (const call of model.toolCalls) {
    const detail = summarizeArgs(call)
    const found = entries.find((entry) => entry.name === call.name
      && (entry.detail === detail || similarText(entry.detail, detail, 0.9)))
    if (found !== undefined) {
      found.count += 1
      continue
    }
    entries.push({ name: call.name, detail, count: 1 })
  }
  if (entries.length === 0) return ['- вызовов инструментов не было']
  const lines = entries.slice(0, profile.maxCommands).map((entry) => {
    const suffix = entry.count > 1 ? ` · ×${entry.count}` : ''
    const detail = entry.detail === '' ? '' : ` — ${entry.detail}`
    return `- \`${entry.name}\`${detail}${suffix}`
  })
  if (entries.length > profile.maxCommands) {
    const rest = entries.length - profile.maxCommands
    lines.push(`- … ещё ${rest} ${pluralCommands(rest)}`)
  }
  return lines
}

function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

function buildQuestionLines(model, profile) {
  const found = []
  for (const item of [...model.assistants].reverse()) {
    for (const sentence of splitSentences(item.text)) {
      if (!OPEN_RE.test(sentence)) continue
      const line = clip(sentence, QUESTION_CLIP)
      if (found.some((existing) => similarText(existing, line))) continue
      found.push(line)
      if (found.length >= profile.maxQuestions) break
    }
    if (found.length >= profile.maxQuestions) break
  }
  return found.length === 0 ? ['- не найдено'] : found.map((line) => `- ${line}`)
}

function buildErrorLines(model, profile) {
  const names = new Map(model.toolCalls.map((call) => [call.callId, call.name]))
  const found = []
  const add = (text) => {
    const line = clip(text, ERROR_CLIP)
    if (line === '') return
    if (found.some((existing) => similarText(existing, line, 0.9))) return
    found.push(line)
  }

  for (const result of model.toolResults) {
    const name = names.get(result.callId)
    for (const line of result.errorLines) add(name === undefined ? line : `\`${name}\`: ${line}`)
    if (found.length >= 40) break
  }
  for (const item of model.assistants) {
    for (const sentence of splitSentences(item.text)) {
      if (ERROR_RE.test(sentence)) add(sentence)
    }
  }
  for (const job of model.jobs) {
    add(`job \`${job.label}\`: ${job.status}${job.detail === '' ? '' : ` — ${job.detail}`}`)
  }

  if (found.length === 0) return ['- не найдено']
  const lines = found.slice(0, profile.maxErrors).map((line) => `- ${line}`)
  if (found.length > profile.maxErrors) {
    const rest = found.length - profile.maxErrors
    lines.push(`- … ещё ${rest} ${pluralErrors(rest)}`)
  }
  return lines
}

// --- Markdown --------------------------------------------------------------

function formatDate(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return ''
  const date = new Date(milliseconds)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
}

function renderMarkdown({ title, id, createdAt, events, before, sections }) {
  const lines = ['# Выжимка диалога', '']
  const meta = []
  if (id !== '') meta.push(`сессия \`${id}\``)
  const date = formatDate(createdAt)
  if (date !== '') meta.push(date)
  meta.push(`${events} ${pluralEvents(events)}`)
  if (before > 0) meta.push(`журнал: ${before} симв.`)
  if (title !== '') meta.push(`тема: ${clip(title, 80)}`)
  lines.push(meta.join(' · '))
  lines.push('')
  for (const section of sections) {
    lines.push(`## ${section.title}`)
    if (section.lines.length === 0) lines.push('- —')
    else lines.push(...section.lines)
    lines.push('')
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function buildSections(model, profile) {
  return [
    { key: 'task', title: SECTION_TITLES.task, lines: buildTaskLines(model, profile) },
    { key: 'done', title: SECTION_TITLES.done, lines: buildDoneLines(model, profile) },
    { key: 'files', title: SECTION_TITLES.files, lines: buildFileLines(model, profile) },
    { key: 'commands', title: SECTION_TITLES.commands, lines: buildCommandLines(model, profile) },
    { key: 'questions', title: SECTION_TITLES.questions, lines: buildQuestionLines(model, profile) },
    { key: 'errors', title: SECTION_TITLES.errors, lines: buildErrorLines(model, profile) },
  ]
}

/** Уложить выжимку в бюджет, выкидывая хвосты разделов в порядке важности. */
function fitBudget(sections, limit, render) {
  let markdown = render()
  if (markdown.length <= limit) return markdown
  const priorities = ['done', 'commands', 'files', 'errors', 'questions', 'task']
  const minimum = { task: 1 }
  for (let guard = 0; guard < 500 && markdown.length > limit; guard += 1) {
    let trimmed = false
    for (const key of priorities) {
      const section = sections.find((candidate) => candidate.key === key)
      if (section === undefined) continue
      if (section.lines.length <= (minimum[key] ?? 0)) continue
      section.lines.pop()
      markdown = render()
      trimmed = true
      break
    }
    if (!trimmed) break
  }
  if (markdown.length > limit) {
    markdown = `${markdown.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
    if (markdown.length > limit) markdown = markdown.slice(0, limit)
  }
  return markdown
}

// --- публичная сборка ------------------------------------------------------

/**
 * Собрать выжимку из уже разобранных событий.
 * @param {object[]} events
 * @param {{ budget?: number, before?: number, sessionId?: string, title?: string, skipped?: number }} [options]
 * @returns {{ markdown: string, before: number, after: number, stats: object }}
 */
export function compactEvents(events, options = {}) {
  const list = Array.isArray(events) ? events : []
  const model = extractMessages(list)
  const profile = budgetProfile(options.budget)
  const before = Number.isFinite(options.before) && options.before > 0 ? Math.floor(options.before) : 0
  const title = (typeof options.title === 'string' && options.title.trim() !== ''
    ? options.title.trim()
    : model.title) || ''
  const id = (typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : asText(model.header?.id)) || ''
  const createdAt = Number(model.header?.createdAt)
  const sections = buildSections(model, profile)
  const render = () => renderMarkdown({
    title,
    id,
    createdAt,
    events: list.length,
    before,
    sections,
  })
  const markdown = fitBudget(sections, profile.limit, render)
  return {
    markdown,
    before,
    after: markdown.length,
    stats: {
      events: list.length,
      users: model.users.length,
      decisions: model.assistants.filter((item) => isDecision(item.text)).length,
      toolCalls: model.toolCalls.length,
      toolResults: model.toolResults.length,
      errors: model.toolResults.reduce((sum, result) => sum + result.errorLines.length, 0),
      title,
      skipped: Number(options.skipped) || 0,
    },
  }
}

/**
 * Собрать выжимку из текста журнала (JSONL, возможно с zstd-кадрами).
 * @param {string} text
 * @param {object} [options]
 */
export function compactText(text, options = {}) {
  const source = String(text)
  const { events, skipped } = parseJsonl(source)
  return compactEvents(events, { ...options, before: source.length, skipped })
}

/**
 * Собрать выжимку из байтов журнала сессии.
 * @param {Buffer|Uint8Array} bytes
 * @param {object} [options]
 */
export function compactLog(bytes, options = {}) {
  return compactText(decompressLog(bytes), options)
}
