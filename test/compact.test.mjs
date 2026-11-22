/**
 * Тесты чистой логики `dsh-compact`. Реальные сессии не нужны: журнал
 * собирается из синтетических событий прямо здесь.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

// Host- и client-smoke идут тем же прогоном: `node --test test/` на Node 24
// считает позиционный аргумент glob-шаблоном файлов, поэтому каталог
// разрешается в этот файл, а остальные наборы тестов подключаются импортом.
import './host.smoke.mjs'
import './client.smoke.mjs'
import './panel.test.mjs'

import {
  DEFAULT_BUDGET,
  MAX_BUDGET,
  MIN_BUDGET,
  ZSTD_AVAILABLE,
  clampBudget,
  compactLog,
  compactText,
  decompressLog,
  extractMessages,
  extractPaths,
  isDecision,
  parseJsonl,
  similarText,
} from '../lib/compact.mjs'

const HEADINGS = ['Задача', 'Что сделано', 'Файлы', 'Команды', 'Открытые вопросы', 'Ошибки']

function header(extra = {}) {
  return {
    type: 'session',
    version: 4,
    id: 'session-test-1',
    createdAt: 1795000000000,
    cwd: 'E:\\DeepSeek Harness',
    isSeeded: false,
    ...extra,
  }
}

function userEvent(seq, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    time: 1795000000000 + seq,
    data: { content: [{ type: 'text', text }], source: { kind }, role: 'user', id: `u${seq}` },
    surfaceOp: 'append',
  }
}

function assistantEvent(seq, text) {
  return {
    type: 'assistant/message',
    seq,
    time: 1795000000000 + seq,
    data: {
      turn: 1,
      step: seq,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'скрытое рассуждение, в выжимку попадать не должно' },
          { type: 'text', text },
        ],
      },
    },
    surfaceOp: 'append',
  }
}

function toolCall(seq, callId, name, args) {
  return {
    type: 'tool/call',
    seq,
    time: 1795000000000 + seq,
    data: { turn: 1, step: seq, callId, name, arguments: JSON.stringify(args) },
  }
}

function toolResult(seq, callId, text) {
  return {
    type: 'tool/result',
    seq,
    time: 1795000000000 + seq,
    data: {
      turn: 1,
      step: seq,
      message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] },
    },
    surfaceOp: 'append',
  }
}

function fixtureEvents() {
  return [
    header(),
    { type: 'sandbox/mode', seq: 1, time: 1795000000001, data: { mode: 'workspace-write' } },
    { type: 'session/title', seq: 2, time: 1795000000002, data: { title: 'Сборка плагина', messageSeqs: [3], source: 'auto' } },
    userEvent(3, 'Создай плагин dsh-compact: сожми журнал сессии в выжимку.'),
    userEvent(4, 'RUNTIME CONTEXT: Current working directory: E:\\DeepSeek Harness', 'runtime-context'),
    assistantEvent(5, 'Начну с изучения структуры.'),
    toolCall(6, 'call-1', 'pwsh', { command: 'node --check index.js', description: 'Проверить синтаксис' }),
    toolResult(7, 'call-1', Array.from({ length: 40 }, (_, index) => `строка вывода ${index + 1}`).join('\n')),
    assistantEvent(8, 'Итог: структура готова.\n\n- index.js\n- lib/compact.mjs\n- test/compact.test.mjs'),
    toolCall(9, 'call-2', 'pwsh', { command: 'node --test test/', description: 'Прогнать тесты' }),
    toolResult(10, 'call-2', 'ERROR: тест не прошёл\nостальные строки в норме'),
    assistantEvent(11, 'Осталось проверить README и потом отчитаться.'),
    toolCall(12, 'call-3', 'read', { file_path: 'E:\\DeepSeek Harness\\plugins\\dsh-compact\\README.md' }),
    toolResult(13, 'call-3', 'длинный вывод\n'.repeat(200)),
    toolCall(14, 'call-4', 'read', { file_path: 'E:\\DeepSeek Harness\\plugins\\dsh-compact\\README.md' }),
    toolCall(15, 'call-5', 'read', { file_path: 'E:\\DeepSeek Harness\\plugins\\dsh-compact\\LICENSE' }),
    toolCall(16, 'call-6', 'read', { file_path: 'E:\\DeepSeek Harness\\plugins\\dsh-compact\\icon.svg' }),
  ]
}

function fixtureText(events = fixtureEvents()) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

function section(markdown, title) {
  const heading = `## ${title}`
  const start = markdown.indexOf(heading)
  if (start < 0) return ''
  const rest = markdown.slice(start + heading.length)
  const next = rest.indexOf('\n## ')
  return (next < 0 ? rest : rest.slice(0, next)).trim()
}

test('парсер извлекает сообщения и отбрасывает служебные блоки', () => {
  const { events, skipped } = parseJsonl(fixtureText())
  assert.equal(skipped, 0)
  assert.equal(events.length, fixtureEvents().length)

  const model = extractMessages(events)
  assert.equal(model.title, 'Сборка плагина')
  assert.equal(model.header.id, 'session-test-1')
  // runtime-context — не реплика пользователя
  assert.equal(model.users.length, 1)
  assert.equal(model.users[0].text, 'Создай плагин dsh-compact: сожми журнал сессии в выжимку.')
  // три сообщения с текстом; reasoning отброшен
  assert.equal(model.assistants.length, 3)
  assert.ok(model.assistants.every((item) => !item.text.includes('скрытое рассуждение')))
  assert.equal(model.toolCalls.length, 6)
  assert.equal(model.toolResults.length, 3)
  assert.equal(model.toolCalls[0].name, 'pwsh')
})

test('JSONL с битой строкой не падает, а считает пропуски', () => {
  const text = `${JSON.stringify(header())}\nне json\n${JSON.stringify(userEvent(1, 'привет'))}\n`
  const { events, skipped } = parseJsonl(text)
  assert.equal(skipped, 1)
  assert.equal(events.length, 2)
})

test('эвристики решения и похожести текстов', () => {
  assert.equal(isDecision('Итог: всё готово.\n- пункт один\n- пункт два'), true)
  assert.equal(isDecision('## Результат\nстрока'), true)
  assert.equal(isDecision('Начну с изучения структуры.'), false)
  assert.equal(isDecision(''), false)
  assert.equal(similarText('Сожми диалог и покажи итог.', 'Сожми диалог и покажи итог. Пожалуйста!'), true)
  assert.equal(similarText('Сожми диалог', 'Проверь тесты'), false)
})

test('Markdown содержит все обязательные разделы', () => {
  const result = compactText(fixtureText(), { budget: DEFAULT_BUDGET })
  assert.ok(result.markdown.startsWith('# Выжимка диалога'))
  for (const title of HEADINGS) {
    assert.ok(result.markdown.includes(`## ${title}`), `нет раздела «${title}»`)
  }
  assert.ok(section(result.markdown, 'Задача').includes('Создай плагин dsh-compact'))
  assert.ok(section(result.markdown, 'Что сделано').includes('Итог: структура готова'))
  assert.ok(section(result.markdown, 'Файлы').includes('README.md'))
  assert.ok(section(result.markdown, 'Команды').includes('pwsh'))
  assert.ok(section(result.markdown, 'Открытые вопросы').includes('Осталось проверить README'))
  assert.ok(section(result.markdown, 'Ошибки').includes('тест не прошёл'))
  assert.equal(result.before, fixtureText().length)
  assert.equal(result.after, result.markdown.length)
})

test('сжатие убирает повторы сообщений и почти одинаковые выводы', () => {
  const events = [
    header(),
    userEvent(1, 'Сожми диалог и покажи итог.'),
    userEvent(3, 'Сожми диалог и покажи итог.'),
    userEvent(5, 'Сожми диалог и покажи итог. Пожалуйста!'),
    assistantEvent(7, 'Итог: всё готово.\n- пункт один\n- пункт два'),
    assistantEvent(9, 'Итог: всё готово.\n- пункт один\n- пункт два'),
  ]
  const result = compactText(fixtureText(events), { budget: DEFAULT_BUDGET })
  const task = section(result.markdown, 'Задача')
  assert.equal((task.match(/Сожми диалог и покажи итог/g) ?? []).length, 1)
  const done = section(result.markdown, 'Что сделано')
  assert.equal((done.match(/всё готово/g) ?? []).length, 1)
})

test('длинный вывод инструмента не попадает в выжимку целиком', () => {
  const lines = Array.from({ length: 80 }, (_, index) => `строка вывода ${index + 1}`)
  lines[40] = 'ERROR: диск переполнен'
  const events = [
    header(),
    toolCall(2, 'c1', 'pwsh', { command: 'df -h' }),
    toolResult(3, 'c1', lines.join('\n')),
  ]
  const result = compactText(fixtureText(events), { budget: DEFAULT_BUDGET })
  assert.ok(!result.markdown.includes('строка вывода 80'))
  assert.ok(result.markdown.includes('диск переполнен'))
})

test('из вывода инструмента берутся не больше трёх строк ошибок', () => {
  const errors = Array.from({ length: 8 }, (_, index) => `ERROR: сбой ${index + 1}`)
  const events = [
    header(),
    toolCall(2, 'c1', 'pwsh', { command: 'сломайся' }),
    toolResult(3, 'c1', errors.join('\n')),
  ]
  const result = compactText(fixtureText(events), { budget: DEFAULT_BUDGET })
  const errorsSection = section(result.markdown, 'Ошибки')
  assert.equal((errorsSection.match(/ERROR: сбой/g) ?? []).length, 3)
  assert.ok(errorsSection.includes('сбой 1'))
  assert.ok(!errorsSection.includes('сбой 4'))
})

test('подряд идущие вызовы схлопываются в «… ещё N шагов»', () => {
  const events = [
    header(),
    assistantEvent(1, 'Начинаю сборку.'),
    toolCall(2, 'c1', 'read', { file_path: 'a.js' }),
    toolCall(3, 'c2', 'read', { file_path: 'b.js' }),
    toolCall(4, 'c3', 'read', { file_path: 'c.js' }),
    toolCall(5, 'c4', 'read', { file_path: 'd.js' }),
    toolCall(6, 'c5', 'read', { file_path: 'e.js' }),
    assistantEvent(7, 'Итог: готово.'),
  ]
  const result = compactText(fixtureText(events), { budget: DEFAULT_BUDGET })
  assert.match(result.markdown, /… ещё 5 шагов/)
})

test('бюджет соблюдается на всех размерах', () => {
  const text = fixtureText()
  for (const budget of [MIN_BUDGET, 500, 900, 2000, 4000, DEFAULT_BUDGET]) {
    const result = compactText(text, { budget })
    assert.ok(
      result.markdown.length <= budget,
      `бюджет ${budget}: получилось ${result.markdown.length} символов`,
    )
    assert.equal(result.after, result.markdown.length)
    assert.equal(result.before, text.length)
  }
})

test('clampBudget приводит значение к допустимым границам', () => {
  assert.equal(clampBudget(undefined), DEFAULT_BUDGET)
  assert.equal(clampBudget('1200'), 1200)
  assert.equal(clampBudget(100), MIN_BUDGET)
  assert.equal(clampBudget(10_000_000), MAX_BUDGET)
  assert.equal(clampBudget(Number.NaN), DEFAULT_BUDGET)
})

test('пути и имена файлов извлекаются из текста и аргументов', () => {
  const paths = extractPaths([
    'Открой E:\\DeepSeek Harness\\plugins\\dsh-compact\\index.js и lib/compact.mjs',
    JSON.stringify({ file_path: 'C:\\Users\\Narzik\\.dsh\\settings.json' }),
    'ещё package.json и https://example.com/not-a-path',
  ])
  assert.ok(paths.some((path) => path.endsWith('index.js')))
  assert.ok(paths.some((path) => path.endsWith('compact.mjs')))
  assert.ok(paths.some((path) => path.endsWith('settings.json')))
  assert.ok(paths.some((path) => path === 'package.json'))
  assert.ok(!paths.some((path) => path.startsWith('https:')))
})

test('пустой журнал даёт выжимку с разделами, а не ошибку', () => {
  const result = compactText('', { budget: 1200 })
  for (const title of HEADINGS) assert.ok(result.markdown.includes(`## ${title}`))
  assert.ok(result.markdown.length <= 1200)
})

test('zstd-журнал распаковывается по кадрам', { skip: !ZSTD_AVAILABLE }, () => {
  const events = fixtureEvents()
  const groups = [events.slice(0, 1), events.slice(1, 6), events.slice(6)]
  const frames = groups.map((group) => zlib.zstdCompressSync(Buffer.from(
    `${group.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )))
  const bytes = Buffer.concat(frames)

  const text = decompressLog(bytes)
  assert.equal(parseJsonl(text).events.length, events.length)

  const result = compactLog(bytes, { budget: DEFAULT_BUDGET })
  assert.ok(result.markdown.includes('## Задача'))
  assert.equal(result.before, text.length)
  assert.ok(result.after <= DEFAULT_BUDGET)
})

test('обычный JSONL (без сжатия) читается как журнал', () => {
  const text = fixtureText()
  assert.equal(decompressLog(Buffer.from(text, 'utf8')), text)
})
