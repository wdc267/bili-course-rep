#!/usr/bin/env node
// B站课代表（bili-course-rep）独立应用：本地 HTTP + SSE 宿主，复用 dsh-video-coursemap 引擎。
// 不依赖 DeepSeek Harness；Node 24 + Python(python-docx) 即可运行。
import http from 'node:http'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const APP_DIR = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(APP_DIR, 'public')
const ENGINE_PATH = join(APP_DIR, 'engine', 'lib', 'index.js')
const CONFIG_PATH = join(APP_DIR, 'config.json')
const LOG_DIR = join(APP_DIR, 'logs')
const LOG_PATH = join(LOG_DIR, 'app.log')
const PID_PATH = join(APP_DIR, 'server.pid')
const ICON_PATH = join(APP_DIR, 'icon.ico')
const OLLAMA_BASE = 'http://127.0.0.1:11434'
const STARTUP_LNK = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'B站课代表.lnk')
const APP_VERSION = '1.3.0'

const DEFAULT_CONFIG = {
  enabled: true,
  pollIntervalMs: 15000,
  stablePolls: 2,
  onlyBilibili: true,
  outputDir: resolve(APP_DIR, '..', '课程知识地图'),
  port: 8765,
  autoWatch: true,
  autoStartWindows: false,
  skipInsufficientMaterial: true,
  minMaterialScore: 120,
  confirmBeforeGenerate: true,
  provider: { kind: 'auto', model: '', baseURL: '', apiKey: '', maxTokens: 4096 },
}

mkdirSync(LOG_DIR, { recursive: true })
function appendLog(level, msg) {
  try {
    const line = '[' + new Date().toISOString() + '] ' + level + ' ' + String(msg).replace(/\s+$/, '') + '\n'
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 2 * 1024 * 1024) renameSync(LOG_PATH, LOG_PATH + '.1')
    appendFileSync(LOG_PATH, line, 'utf8')
  } catch { /* 忽略 */ }
}
function logInfo(msg) { appendLog('INFO', msg) }
function logError(msg) { appendLog('ERROR', msg) }
console.log = (...a) => appendLog('ENGINE', a.join(' '))
console.error = (...a) => appendLog('ENGINE-ERR', a.map((x) => (x && x.stack) || x).join(' '))

function normalizeConfig(raw) {
  const out = structuredClone(DEFAULT_CONFIG)
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (raw[k] === undefined) continue
      if (k === 'provider' && raw.provider && typeof raw.provider === 'object') {
        out.provider = { ...out.provider, ...raw.provider }
      } else {
        out[k] = raw[k]
      }
    }
  }
  out.enabled = Boolean(out.enabled)
  out.onlyBilibili = Boolean(out.onlyBilibili)
  out.autoWatch = Boolean(out.autoWatch)
  out.autoStartWindows = Boolean(out.autoStartWindows)
  out.skipInsufficientMaterial = out.skipInsufficientMaterial !== false
  out.confirmBeforeGenerate = out.confirmBeforeGenerate !== false
  out.minMaterialScore = Math.max(0, Number(out.minMaterialScore) || 120)
  out.pollIntervalMs = Math.min(60000, Math.max(3000, Number(out.pollIntervalMs) || 15000))
  out.stablePolls = Math.min(3, Math.max(1, Number(out.stablePolls) || 2))
  out.port = Math.min(65535, Math.max(1024, Number(out.port) || 8765))
  out.outputDir = String(out.outputDir || DEFAULT_CONFIG.outputDir)
  const p = out.provider
  if (!['auto', 'ollama', 'deepseek', 'extractive'].includes(p.kind)) p.kind = 'auto'
  p.model = String(p.model || '')
  p.baseURL = String(p.baseURL || '')
  p.apiKey = String(p.apiKey || '')
  p.maxTokens = Math.min(8192, Math.max(256, Number(p.maxTokens) || 4096))
  return out
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch {
    return normalizeConfig(DEFAULT_CONFIG)
  }
}
function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  renameSync(tmp, CONFIG_PATH)
}

const runtime = {
  config: normalizeConfig(DEFAULT_CONFIG),
  engine: null,
  applyChain: Promise.resolve(),
  firstApply: true,
  paused: false,
  busy: false,
  busyTimer: null,
  pendingApply: false,
  events: [],
  clients: new Set(),
  summary: '',
  progress: '',
  lastDelivery: null,
  stats: { polls: 0, notes: 0, errors: 0, startedAt: Date.now() },
  provider: { requested: 'auto', active: 'extractive', model: '', ready: false, warning: '', models: [] },
  providerAt: 0,
  shuttingDown: false,
}
let httpServer = null

function safeFile(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note'
}
function paths() {
  const out = runtime.config.outputDir
  const stateDir = join(out, '.state')
  return {
    out,
    stateDir,
    stateJson: join(stateDir, 'state.json'),
    videosDir: join(stateDir, 'videos'),
    timelinesDir: join(stateDir, 'timelines'),
    lock: join(stateDir, 'watcher.lock'),
    manualDir: join(stateDir, 'manuals'),
  }
}
function readState() {
  try { return JSON.parse(readFileSync(paths().stateJson, 'utf8')) || {} } catch { return {} }
}
function readLock() {
  try { return JSON.parse(readFileSync(paths().lock, 'utf8')) } catch { return null }
}
function ensureDirs() {
  const p = paths()
  mkdirSync(p.out, { recursive: true })
  mkdirSync(p.stateDir, { recursive: true })
  mkdirSync(p.videosDir, { recursive: true })
  mkdirSync(p.manualDir, { recursive: true })
}

// B站登录态：与 DSH 插件共享 .state/bili-auth.json；只在本机保存，不通过接口回显
function biliAuthPath() { return join(paths().stateDir, 'bili-auth.json') }
function normalizeBiliCookie(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ').trim()
  s = s.replace(/^cookie\s*:\s*/i, '').trim()
  if (!s) return ''
  if (!s.includes('=')) s = 'SESSDATA=' + s
  return s.slice(0, 4096)
}
function readBiliCookie() {
  const env = process.env.BILI_SESSDATA || process.env.BILIBILI_SESSDATA || ''
  if (env) return { cookie: normalizeBiliCookie(env), source: 'env' }
  try {
    const j = JSON.parse(readFileSync(biliAuthPath(), 'utf8'))
    if (j && j.cookie) return { cookie: normalizeBiliCookie(j.cookie), source: 'file' }
  } catch { /* 忽略 */ }
  return { cookie: '', source: '' }
}
function writeBiliCookie(raw) {
  const cookie = normalizeBiliCookie(raw)
  if (!cookie) return false
  const file = biliAuthPath()
  const tmp = file + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify({ cookie, updatedAt: Date.now() }, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return true
}
function clearBiliCookie() {
  try { if (existsSync(biliAuthPath())) unlinkSync(biliAuthPath()) } catch { /* 忽略 */ }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}
function broadcast(payload) {
  const data = 'data: ' + JSON.stringify(payload) + '\n\n'
  for (const res of runtime.clients) {
    try { res.write(data) } catch { /* 忽略 */ }
  }
}
function pushEvent(evt) {
  runtime.events.push(evt)
  if (runtime.events.length > 200) runtime.events.shift()
}
function armBusyTimer() {
  if (runtime.busyTimer) clearTimeout(runtime.busyTimer)
  runtime.busyTimer = setTimeout(() => {
    if (runtime.busy) {
      runtime.busy = false
      broadcast({ type: 'busy-timeout' })
      maybeApplyPending()
    }
  }, 300000)
}
function clearBusyTimer() {
  if (runtime.busyTimer) { clearTimeout(runtime.busyTimer); runtime.busyTimer = null }
}
function maybeApplyPending() {
  if (runtime.pendingApply && !runtime.busy) {
    runtime.pendingApply = false
    setTimeout(() => { applyEngine().catch(() => {}) }, 200)
  }
}

function handleEngineEvent(p) {
  if (!p || typeof p !== 'object') return
  const evt = { ...p, at: p.at || Date.now(), id: randomUUID().slice(0, 8) }
  if (p.type === 'poll') {
    runtime.stats.polls += 1
    const last = runtime.events[runtime.events.length - 1]
    const same = last && last.type === 'poll' && last.verdict === evt.verdict && last.proc === evt.proc &&
      (last.title || last.raw || '') === (evt.title || evt.raw || '')
    if (same) {
      last.at = evt.at
      last.count = (last.count || 1) + 1
      broadcast({ ...evt, count: last.count, deduped: true })
    } else {
      evt.count = 1
      pushEvent(evt)
      broadcast(evt)
    }
    return
  }
  if (p.type === 'process_start') { runtime.busy = true; runtime.summary = ''; runtime.progress = ''; armBusyTimer() }
  if (p.type === 'summary_start') { runtime.busy = true; runtime.summary = ''; runtime.progress = ''; armBusyTimer() }
  if (p.type === 'summary_progress') {
    runtime.busy = true
    runtime.progress = String(p.message || '')
    armBusyTimer()
    broadcast(evt)
    return
  }
  if (p.type === 'summary_delta') {
    runtime.summary += String(p.text || '')
    broadcast(evt)
    return
  }
  if (p.type === 'summary_done') {
    runtime.busy = false
    runtime.progress = ''
    runtime.lastDelivery = p
    runtime.stats.notes += 1
    clearBusyTimer()
  }
  if (p.type === 'skip') { runtime.busy = false; runtime.progress = ''; clearBusyTimer() }
  if (p.type === 'error') { runtime.busy = false; runtime.progress = ''; runtime.stats.errors += 1; clearBusyTimer() }
  if (p.type === 'confirm_request' || p.type === 'confirm_update') { runtime.busy = false; clearBusyTimer() }
  if (p.type === 'note_deleted') {
    if (runtime.lastDelivery && runtime.lastDelivery.title === p.title) runtime.lastDelivery = null
    runtime.summary = ''
  }
  pushEvent(evt)
  broadcast(evt)
  maybeApplyPending()
}

let engineModulePromise = null
async function loadEngineModule() {
  if (!engineModulePromise) engineModulePromise = import(pathToFileURL(ENGINE_PATH).href)
  return engineModulePromise
}

function createFakeCtx() {
  const disposers = new Map()
  const tools = new Map()
  const ctx = {
    effect(fn, label) {
      try {
        const d = fn()
        if (typeof d === 'function') disposers.set(String(label || ('effect-' + disposers.size)), d)
        return d || (() => {})
      } catch (e) {
        logError('effect ' + String(label) + ' 失败：' + ((e && e.message) || e))
        return () => {}
      }
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'standalone', model: runtime.provider.model || 'standalone' }) }
      }
      return undefined
    },
    llm: { stream: (opts) => providerStream(opts) },
    emit(event, payload) {
      if (event === 'course-map:event') handleEngineEvent(payload)
    },
  }
  return { ctx, disposers, tools }
}

function disposeEngine() {
  const e = runtime.engine
  if (!e) return
  for (const d of e.disposers.values()) {
    try { d() } catch { /* 忽略 */ }
  }
  e.disposers.clear()
  e.tools.clear()
  runtime.engine = null
}

function pauseEngine() {
  const e = runtime.engine
  runtime.paused = true
  if (!e) return
  const label = 'dsh-video-coursemap: poll timer'
  const d = e.disposers.get(label)
  if (typeof d === 'function') {
    try { d() } catch { /* 忽略 */ }
    e.disposers.delete(label)
  }
  broadcast({ type: 'status', enabled: false, paused: true })
}

async function applyEngine() {
  runtime.applyChain = runtime.applyChain.then(async () => {
    if (runtime.shuttingDown) return
    const mod = await loadEngineModule()
    const wasPaused = runtime.paused
    disposeEngine()
    const fake = createFakeCtx()
    runtime.engine = fake
    runtime.config = normalizeConfig(runtime.config)
    const shouldPause = runtime.paused || !runtime.config.enabled
    ensureDirs()
    mod.apply(fake.ctx, {
      enabled: true,
      pollIntervalMs: runtime.config.pollIntervalMs,
      stablePolls: runtime.config.stablePolls,
      outputDir: runtime.config.outputDir,
      provider: 'standalone',
      model: 'standalone',
      maxTokens: runtime.config.provider.maxTokens,
      fetchContent: true,
      onlyBilibili: runtime.config.onlyBilibili,
      deliverSession: false,
      skipInsufficientMaterial: runtime.config.skipInsufficientMaterial,
      minMaterialScore: runtime.config.minMaterialScore,
      confirmBeforeGenerate: runtime.config.confirmBeforeGenerate,
      sessionCwd: runtime.config.outputDir,
      watcherRole: 'standalone',
      skipStartupDocx: !runtime.firstApply,
      generatorLabel: '独立引擎',
    })
    runtime.firstApply = false
    runtime.paused = false
    if (shouldPause) pauseEngine()
    logInfo('engine applied interval=' + runtime.config.pollIntervalMs + ' paused=' + runtime.paused)
    broadcast({ type: 'engine', status: 'ready', intervalMs: runtime.config.pollIntervalMs, paused: runtime.paused })
  }).catch((e) => {
    logError('applyEngine 失败：' + ((e && e.stack) || e))
    broadcast({ type: 'error', message: '引擎启动失败：' + ((e && e.message) || e) })
  })
  return runtime.applyChain
}

async function getOllamaModels(force) {
  if (!force && runtime.providerAt && Date.now() - runtime.providerAt < 30000) return runtime.provider.models || []
  let models = []
  try {
    const r = await fetch(OLLAMA_BASE + '/api/tags', { signal: AbortSignal.timeout(2500) })
    if (r.ok) {
      const j = await r.json()
      models = (j.models || []).map((m) => m.name).filter(Boolean)
    }
  } catch { models = [] }
  runtime.provider.models = models
  runtime.providerAt = Date.now()
  return models
}

async function resolveProvider(force) {
  const p = runtime.config.provider
  const key = p.apiKey || process.env.DEEPSEEK_API_KEY || ''
  const kind = p.kind
  let info
  if (kind === 'extractive') {
    info = { requested: 'extractive', active: 'extractive', model: '', ready: true, warning: '离线抽取模式' }
  } else if (kind === 'ollama') {
    const models = await getOllamaModels(force)
    info = models.length
      ? { requested: 'ollama', active: 'ollama', model: p.model || models[0], ready: true, models, warning: '' }
      : { requested: 'ollama', active: 'extractive', model: '', ready: false, models: [], warning: 'Ollama 没有已安装模型，已降级为离线抽取' }
  } else if (kind === 'deepseek') {
    info = key
      ? { requested: 'deepseek', active: 'deepseek', model: (p.model && /^deepseek/i.test(p.model)) ? p.model : 'deepseek-chat', ready: true, warning: '' }
      : { requested: 'deepseek', active: 'extractive', model: '', ready: false, warning: '未配置 DeepSeek API Key，已降级为离线抽取' }
  } else {
    const models = await getOllamaModels(force)
    if (key) info = { requested: 'auto', active: 'deepseek', model: (p.model && /^deepseek/i.test(p.model)) ? p.model : 'deepseek-chat', ready: true, warning: '' }
    else if (models.length) info = { requested: 'auto', active: 'ollama', model: p.model || models[0], ready: true, models, warning: '' }
    else info = { requested: 'auto', active: 'extractive', model: '', ready: true, models: [], warning: '未配置模型/Key，使用离线抽取' }
  }
  runtime.provider = { ...runtime.provider, ...info }
  return runtime.provider
}

function toOpenAiMessages(opts) {
  const out = []
  if (opts.system) out.push({ role: 'system', content: String(opts.system) })
  for (const m of opts.messages || []) {
    const text = Array.isArray(m.content)
      ? m.content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n')
      : String(m.content || '')
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: text })
  }
  return out
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
async function* chunkText(text, size) {
  const s = String(text || '')
  for (let i = 0; i < s.length; i += size) {
    yield { type: 'text-delta', text: s.slice(i, i + size) }
    await sleep(6)
  }
}
async function* openAiStream(base, model, key, opts) {
  const url = base.replace(/\/$/, '') + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (key) headers.Authorization = 'Bearer ' + key
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: toOpenAiMessages(opts),
      stream: true,
      max_tokens: opts.maxTokens || 4096,
      temperature: 0.4,
    }),
    signal: opts.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error('LLM HTTP ' + res.status + '：' + body.slice(0, 300))
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const j = JSON.parse(data)
        const delta = (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''
        if (delta) yield { type: 'text-delta', text: delta }
      } catch { /* 忽略 */ }
    }
  }
}
async function* ollamaNativeStream(model, opts) {
  const res = await fetch(OLLAMA_BASE + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: toOpenAiMessages(opts), stream: true, options: { num_ctx: 8192, num_predict: Math.max(512, Math.min(opts.maxTokens || 4096, 2048)), temperature: 0.3 } }),
    signal: opts.signal,
  })
  if (!res.ok) throw new Error('Ollama HTTP ' + res.status)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        const j = JSON.parse(line)
        const delta = (j.message && j.message.content) || ''
        if (delta) yield { type: 'text-delta', text: delta }
        if (j.done) return
      } catch { /* 忽略 */ }
    }
  }
}
async function* providerStream(opts) {
  const active = await resolveProvider(false)
  if (active.active === 'extractive') {
    const text = buildExtractive(opts)
    yield* chunkText(text, 48)
    return
  }
  let produced = false
  try {
    let source
    if (active.active === 'ollama') {
      source = ollamaNativeStream(active.model, opts)
    } else {
      const base = runtime.config.provider.baseURL || 'https://api.deepseek.com/v1'
      const key = runtime.config.provider.apiKey || process.env.DEEPSEEK_API_KEY || ''
      source = openAiStream(base, active.model, key, opts)
    }
    for await (const c of source) {
      if (c && c.text) produced = true
      yield c
    }
  } catch (e) {
    logError('LLM 调用失败 ' + active.active + '：' + ((e && e.stack) || e))
    if (produced) throw e
  }
  if (!produced) {
    // 模型返回空内容（常见于思考模型把 token 全用在 reasoning 上）：降级离线抽取，保证一定有笔记
    logError('LLM 返回空内容，降级离线抽取：' + active.active)
    yield* chunkText(buildExtractive(opts), 48)
  }
}

// ---- 离线抽取（没有模型/Key 时的降级总结） ----
const SUBJECT_RULES = [
  [/redis|mysql|数据库|sql|mongodb|postgres/i, '数据库'],
  [/前端|vue|react|css|html|javascript|typescript|vite/i, '前端开发'],
  [/java|spring|后端|python|golang|go 语言|node\.?js|django/i, '后端开发'],
  [/算法|数据结构|leetcode|排序|动态规划|递归|图论/i, '算法'],
  [/机器学习|深度学习|神经网络|大模型|llm|人工智能|pytorch|tensorflow|transformer/i, '人工智能'],
  [/dsh|deepseek harness|superagent|harness|agent 智能体/i, 'AI 工具'],
  [/数学|高数|线代|线性代数|概率|微积分|矩阵|统计/i, '数学'],
  [/英语|雅思|托福|四级|六级|考研英语|语法|单词/i, '英语'],
  [/历史|王朝|近代史|世界史|三国/i, '历史'],
  [/物理|力学|电磁|量子|光学/i, '物理'],
  [/化学|有机|无机|反应/i, '化学'],
  [/经济|金融|投资|理财|会计|宏观|微观/i, '经济金融'],
  [/设计|ps|ui|ux|配色|摄影|剪辑|ae|pr/i, '设计'],
  [/职场|面试|简历|沟通|管理|效率/i, '职场'],
]
function extractUserText(opts) {
  const arr = opts.messages || []
  return arr.map((m) => (Array.isArray(m.content) ? m.content.map((c) => (c && c.text) || '').join('\n') : String(m.content || ''))).join('\n')
}
function extractTitle(text) {
  const m = text.match(/浏览器当前标题：("(?:[^"\\]|\\.)*")/)
  if (m) { try { return JSON.parse(m[1]) } catch { /* 忽略 */ } }
  const t = text.match(/视频标题：([^\n]+)/)
  return t ? t[1].trim() : ''
}
function splitTopics(title) {
  let text = String(title || '')
  text = text.replace(/[【\[（(][^】\]）)]{0,24}[】\]）)]/g, ' ')
  text = text.replace(/[，,。！？!?、：:；;|/\\\-—–_~·]+/g, ' ')
  const stop = /^(视频|教程|课程|全集|完整版|高清|最新|入门|基础|详解|讲解|分享)$/
  const out = []
  for (let t of text.split(/\s+/)) {
    t = t.replace(/^[^\w\u4e00-\u9fa5]+|[^\w\u4e00-\u9fa5]+$/g, '').trim()
    if (!t || t.length < 2 || stop.test(t)) continue
    if (!out.includes(t)) out.push(t.length > 16 ? t.slice(0, 16) : t)
  }
  return out.slice(0, 8)
}
function detectSubject(title, existing) {
  const hit = (existing || []).find((s) => s && title.includes(s))
  if (hit) return hit
  for (const [re, name] of SUBJECT_RULES) if (re.test(title)) return name
  return '通识'
}
function extractiveClassify(opts) {
  const text = extractUserText(opts)
  const title = extractTitle(text) || '未命名视频'
  const existingMatch = text.match(/已有学科列表：(\[[\s\S]*?\])/)
  let existing = []
  try { existing = existingMatch ? JSON.parse(existingMatch[1]) : [] } catch { existing = [] }
  const fun = /(纯音乐|音乐|搞笑|沙雕|鬼畜|直播|游戏实况|新闻联播|广告|带货|vlog|日常vlog)/i.test(title)
  const study = /(教程|讲解|课程|入门|基础|原理|学习|面试|科普|分析|实战|安装|配置|从零|详解)/.test(title)
  const isCourse = study || !fun
  const subject = detectSubject(title, existing)
  const stop = new Set(['视频', '教程', '课程', '讲解', '基础', '入门', '全集', '完整版', '高清', '最新'])
  let keywords = splitTopics(title).filter((s) => !stop.has(s))
  if (keywords.length < 3) keywords = keywords.concat(splitTopics(subject))
  keywords = Array.from(new Set(keywords)).slice(0, 6)
  return JSON.stringify({ isCourse, subject, title, keywords })
}
function section(text, name) {
  const marker = '【' + name
  const i = text.indexOf(marker)
  if (i < 0) return ''
  const lineEnd = text.indexOf('\n', i)
  if (lineEnd < 0) return ''
  const start = lineEnd + 1
  const next = text.indexOf('\n\n', start)
  return text.slice(start, next < 0 ? undefined : next).trim()
}
function splitSentences(s) {
  return String(s || '').split(/[。！？!?\n]+/).map((x) => x.trim()).filter((x) => x.length >= 6).slice(0, 12)
}
function mermaidText(s) {
  return String(s || '').replace(/[()[\]{}|<>'"\u0060\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50)
}
function extractiveSummary(opts) {
  const text = extractUserText(opts)
  const title = extractTitle(text) || '课程笔记'
  const subjectMatch = text.match(/^学科：([^\n]+)/m)
  const subject = subjectMatch ? subjectMatch[1].trim() : '通识'
  const kwMatch = text.match(/^关键词：([^\n]+)/m)
  const keywords = kwMatch ? kwMatch[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : splitTopics(title).slice(0, 5)
  const desc = section(text, '视频简介')
  const tags = section(text, '视频标签')
  const transcript = section(text, '字幕/讲解文本')
  const danmaku = section(text, '弹幕')
  const comments = section(text, '评论区热评')
  const sentences = splitSentences(desc || transcript)
  const intro = sentences[0] || ('本视频围绕「' + title + '」展开，属于' + subject + '方向的内容。')
  const points = []
  const topics = (keywords.length ? keywords : splitTopics(title)).slice(0, 5)
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i]
    const detail = sentences[i] || ('围绕「' + t + '」梳理概念、流程与常见用法。')
    const detail2 = sentences[i + topics.length] || ('结合视频内容理解「' + t + '」在实际场景中的作用。')
    points.push('- **' + t + '**\n  - ' + detail + '\n  - ' + detail2)
  }
  if (points.length === 0) points.push('- **' + title + '**\n  - 视频内容要点待补充')
  const danmakuLines = danmaku.split('\n').map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 8)
  const commentLines = comments.split('\n').map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 5)
  const focus = []
  if (danmakuLines.length) focus.push('- 弹幕关注：' + danmakuLines.slice(0, 3).join('；'))
  if (commentLines.length) focus.push('- 评论讨论：' + commentLines.slice(0, 2).join('；'))
  if (!focus.length) focus.push('- 暂未抓取到弹幕/评论，可在联网后重试')
  const branch = topics.slice(0, 4).map((t) => '    ' + mermaidText(t)).join('\n')
  const tagLine = tags ? '\n\n> 标签：' + tags : ''
  return [
    '## ' + title,
    '',
    '> ' + intro + tagLine,
    '',
    '### 核心知识点',
    points.join('\n'),
    '',
    '### 弹幕与评论讨论焦点',
    focus.join('\n'),
    '',
    '### 思维导图',
    '\u0060\u0060\u0060mermaid',
    'mindmap',
    '  root((' + mermaidText(title) + '))',
    branch,
    '\u0060\u0060\u0060',
    '',
    '*（离线抽取模式：未配置 LLM，仅基于简介/标签/弹幕/评论做结构化整理）*',
  ].join('\n')
}
function buildExtractive(opts) {
  return /分类助手/.test(String(opts.system || '')) ? extractiveClassify(opts) : extractiveSummary(opts)
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }
function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname
  if (rel === '/favicon.ico') {
    if (!existsSync(ICON_PATH)) { res.writeHead(204); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-cache' })
    createReadStream(ICON_PATH).pipe(res)
    return
  }
  const full = resolve(PUBLIC_DIR, '.' + rel)
  const r = relative(PUBLIC_DIR, full)
  if (!r || r.startsWith('..') || r.includes('..\\') || r.includes('../')) { res.writeHead(403); res.end('forbidden'); return }
  if (!existsSync(full) || !statSync(full).isFile()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  createReadStream(full).pipe(res)
}
function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolvePromise({})
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(new Error('JSON 解析失败')) }
    })
    req.on('error', reject)
  })
}
function inside(root, p) {
  const r = relative(root, p)
  return Boolean(r) && !r.startsWith('..') && !r.includes('..\\') && !r.includes('../')
}
function findNote(title) {
  const q = String(title || '').trim()
  if (!q) return null
  const st = readState()
  for (const [subject, d] of Object.entries(st.subjects || {})) {
    for (const t of d.videos || []) {
      if (String(t) === q || String(t).includes(q) || q.includes(String(t))) {
        const mdPath = join(paths().videosDir, safeFile(t) + '.md')
        const docxPath = join(paths().out, subject, safeFile(t) + '.docx')
        const timelinePath = join(paths().timelinesDir, safeFile(t) + '.json')
        return { title: t, subject, mdPath, docxPath, timelinePath, hasWord: existsSync(docxPath) }
      }
    }
  }
  return null
}
function subjectList(st) {
  return Object.entries(st.subjects || {}).map(([subject, d]) => {
    const videos = d.videos || []
    return { subject, videos: videos.length, latest: videos[videos.length - 1] || '' }
  })
}
function historyList() {
  const st = readState()
  const out = paths().out
  const items = []
  for (const [subject, d] of Object.entries(st.subjects || {})) {
    for (const t of d.videos || []) {
      const mdPath = join(paths().videosDir, safeFile(t) + '.md')
      const docxPath = join(out, subject, safeFile(t) + '.docx')
      let mtime = 0
      try { mtime = statSync(docxPath).mtimeMs } catch { try { mtime = statSync(mdPath).mtimeMs } catch { /* 忽略 */ } }
      const ld = st.lastDelivery
      items.push({
        title: t,
        subject,
        hasWord: existsSync(docxPath),
        mtime,
        generator: ld && ld.title === t ? (ld.generator || '') : '',
      })
    }
  }
  return items.sort((a, b) => b.mtime - a.mtime)
}
function lastPollEvent() {
  for (let i = runtime.events.length - 1; i >= 0; i--) {
    const e = runtime.events[i]
    if (e && e.type === 'poll') {
      return { at: Number(e.at) || 0, verdict: String(e.verdict || ''), proc: String(e.proc || ''), title: String(e.title || ''), raw: String(e.raw || ''), count: Number(e.count) || 1 }
    }
  }
  return null
}
async function buildState() {
  const cfg = runtime.config
  const st = readState()
  const lock = readLock()
  const bili = readBiliCookie()
  const info = await resolveProvider(false)
  const totalVideos = Object.values(st.subjects || {}).reduce((n, d) => n + ((d && d.videos && d.videos.length) || 0), 0)
  const pending = (Array.isArray(st.pending) ? st.pending : []).slice(0, 12).map((p) => ({
    id: String(p?.id || ''),
    title: String(p?.title || p?.rawTitle || ''),
    rawTitle: String(p?.rawTitle || ''),
    subject: String(p?.subject || ''),
    bvid: String(p?.bvid || ''),
    biliTitle: String(p?.biliTitle || ''),
    transcriptChars: Number(p?.transcriptChars) || 0,
    subtitleSource: String(p?.subtitleSource || '无字幕'),
    subtitleCoverage: Number(p?.subtitleCoverage) || 0,
    duration: Number(p?.duration) || 0,
    needLogin: Boolean(p?.needLogin),
    aiQueued: Boolean(p?.aiQueued),
    danmaku: Number(p?.danmaku) || 0,
    comments: Number(p?.comments) || 0,
    tags: Number(p?.tags) || 0,
    score: Number(p?.score) || 0,
    insufficient: Boolean(p?.insufficient),
    at: Number(p?.at) || 0,
  }))
  let currentSummary = runtime.summary
  if (!currentSummary && st.lastDelivery && st.lastDelivery.mdPath) {
    try {
      const raw = readFileSync(st.lastDelivery.mdPath, 'utf8')
      // 笔记结构：H1 标题 + 元数据行（- 开头）+ 空行 + 正文（从「> 一句话简介」开始）
      const lines = raw.split(/\r?\n/)
      // 笔记结构：H1 标题 + 空行 + 正文（章节/要点），页面只展示正文
      const h1 = lines.findIndex((ln) => /^#\s+/.test(ln))
      currentSummary = h1 >= 0 ? lines.slice(h1 + 1).join('\n').trim() : raw
    } catch { /* 忽略 */ }
  }
  return {
    ok: true,
    enabled: Boolean(cfg.enabled),
    paused: runtime.paused,
    busy: runtime.busy,
    progress: runtime.progress,
    intervalMs: cfg.pollIntervalMs,
    stablePolls: cfg.stablePolls,
    onlyBilibili: cfg.onlyBilibili,
    autoWatch: cfg.autoWatch,
    autoStartWindows: existsSync(STARTUP_LNK),
    skipInsufficientMaterial: cfg.skipInsufficientMaterial,
    minMaterialScore: cfg.minMaterialScore,
    confirmBeforeGenerate: cfg.confirmBeforeGenerate,
    biliCookieSet: Boolean(bili.cookie),
    biliCookieSource: bili.source,
    pending,
    ignoredCount: Object.keys(st.ignored || {}).length,
    outputDir: cfg.outputDir,
    provider: {
      requested: cfg.provider.kind,
      active: info.active,
      model: info.model,
      ready: info.ready,
      warning: info.warning || '',
      models: info.models || [],
      apiKeySet: Boolean(cfg.provider.apiKey || process.env.DEEPSEEK_API_KEY),
      apiKeySource: cfg.provider.apiKey ? 'config' : (process.env.DEEPSEEK_API_KEY ? 'env' : ''),
      baseURL: cfg.provider.baseURL || '',
    },
    lock: lock ? { role: lock.role || '', pid: lock.pid || 0, mine: lock.pid === process.pid, at: lock.at || 0, stale: Date.now() - Number(lock.at || 0) > 30000 } : null,
    subjects: subjectList(st),
    lastDelivery: st.lastDelivery || runtime.lastDelivery,
    lastPoll: lastPollEvent(),
    stats: { ...runtime.stats, notes: Math.max(runtime.stats.notes, totalVideos) },
    currentSummary,
    recentEvents: runtime.events.slice(-80),
    app: { port: cfg.port, pid: process.pid, startedAt: runtime.stats.startedAt, version: APP_VERSION, engine: ENGINE_PATH },
  }
}

async function testProvider() {
  const active = await resolveProvider(true)
  if (active.active === 'extractive') return { ok: true, active: 'extractive', message: '离线抽取可用；配置 Ollama 模型或 API Key 可获得更好的总结' }
  const started = Date.now()
  try {
    const opts = { system: '只回复 OK', messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }], maxTokens: 8, signal: AbortSignal.timeout(20000) }
    for await (const c of providerStream(opts)) { if (c.text) break }
    return { ok: true, active: active.active, model: active.model, latencyMs: Date.now() - started, message: '连接成功' }
  } catch (e) {
    return { ok: false, active: active.active, model: active.model, latencyMs: Date.now() - started, message: '连接失败：' + ((e && e.message) || e) }
  }
}

function setAutoStart(enabled) {
  const script = join(APP_DIR, 'install-shortcut.ps1')
  if (!existsSync(script)) return { ok: false, message: '缺少 install-shortcut.ps1' }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, enabled ? '-Startup' : '-RemoveStartup'], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
  return { ok: r.status === 0, message: (r.stderr || r.stdout || '').trim().slice(0, 500) }
}

async function handleApi(req, res, url) {
  const p = url.pathname
  if (p === '/api/health') return sendJson(res, 200, { ok: true, version: APP_VERSION, pid: process.pid })
  if (p === '/api/state') return sendJson(res, 200, await buildState())
  if (p === '/api/history') return sendJson(res, 200, { ok: true, items: historyList() })
  if (p === '/api/providers/models') {
    const models = await getOllamaModels(true)
    return sendJson(res, 200, { ok: true, models })
  }
  if (p === '/api/note') {
    const item = findNote(url.searchParams.get('title') || '')
    if (!item) return sendJson(res, 404, { ok: false, message: '没有找到这条笔记' })
    let markdown = ''
    try { markdown = readFileSync(item.mdPath, 'utf8') } catch { markdown = '' }
    const noteTitle = ((markdown.match(/^#\s+(.+)$/m) || [])[1] || '').trim()
    return sendJson(res, 200, { ok: true, title: item.title, noteTitle, subject: item.subject, markdown, docxPath: item.hasWord ? item.docxPath : '', hasWord: item.hasWord, hasTimeline: existsSync(item.timelinePath) })
  }
  // 字幕时间线（只在网站上看，不写进笔记）
  if (p === '/api/timeline') {
    const item = findNote(url.searchParams.get('title') || '')
    if (!item) return sendJson(res, 404, { ok: false, message: '没有找到这条笔记' })
    if (!existsSync(item.timelinePath)) return sendJson(res, 404, { ok: false, message: '这条笔记还没有时间线（重新生成后自动生成）' })
    try {
      const data = JSON.parse(readFileSync(item.timelinePath, 'utf8'))
      return sendJson(res, 200, { ok: true, title: item.title, noteTitle: data.noteTitle || '', bvid: data.bvid || '', duration: data.duration || 0, segments: Array.isArray(data.segments) ? data.segments : [] })
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: '时间线读取失败：' + ((e && e.message) || e) })
    }
  }
  if (p === '/api/download') {
    const item = findNote(url.searchParams.get('title') || '')
    if (!item) return sendJson(res, 404, { ok: false, message: '没有找到这条笔记' })
    const format = url.searchParams.get('format') === 'md' ? 'md' : 'docx'
    if (format === 'md') {
      // 优先用学科目录里的导出副本（引擎会同步），其次用 .state/videos 里的源文件
      const exportPath = join(paths().out, item.subject, safeFile(item.title) + '.md')
      const abs = [exportPath, item.mdPath].find((f) => f && existsSync(resolve(f)))
      if (!abs) return sendJson(res, 404, { ok: false, message: 'Markdown 尚未生成' })
      const resolved = resolve(abs)
      if (!inside(paths().out, resolved)) return sendJson(res, 403, { ok: false, message: '路径不允许' })
      const name = safeFile(item.title) + '.md'
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
        'Cache-Control': 'no-store',
      })
      createReadStream(resolved).pipe(res)
      return
    }
    if (!item.hasWord) return sendJson(res, 404, { ok: false, message: 'Word 尚未生成' })
    const abs = resolve(item.docxPath)
    if (!inside(paths().out, abs)) return sendJson(res, 403, { ok: false, message: '路径不允许' })
    const name = safeFile(item.title) + '.docx'
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(name),
      'Cache-Control': 'no-store',
    })
    createReadStream(abs).pipe(res)
    return
  }
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    runtime.clients.add(res)
    const hello = { type: 'hello', state: await buildState() }
    res.write('data: ' + JSON.stringify(hello) + '\n\n')
    const ka = setInterval(() => { try { res.write(': keepalive\n\n') } catch { /* 忽略 */ } }, 25000)
    req.on('close', () => { clearInterval(ka); runtime.clients.delete(res) })
    return
  }
  if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: 'method not allowed' })
  let body = {}
  try { body = await readBody(req) } catch (e) { return sendJson(res, 400, { ok: false, message: (e && e.message) || 'bad body' }) }

  if (p === '/api/settings') {
    const before = runtime.config
    const next = normalizeConfig({ ...before, ...body, provider: { ...before.provider, ...(body.provider || {}) } })
    runtime.config = next
    try { saveConfig(next) } catch (e) { logError('save config 失败：' + ((e && e.message) || e)) }
    try { ensureDirs() } catch { /* 忽略 */ }
    let biliChanged = false
    if (body.clearBiliCookie) {
      clearBiliCookie()
      biliChanged = true
    } else if (typeof body.biliCookie === 'string' && body.biliCookie.trim()) {
      biliChanged = writeBiliCookie(body.biliCookie)
    }
    if (body.autoStartWindows !== undefined) {
      const r = setAutoStart(next.autoStartWindows)
      if (!r.ok) logError('autostart 设置失败：' + r.message)
    }
    const engineChanged = ['pollIntervalMs', 'stablePolls', 'onlyBilibili', 'outputDir', 'enabled', 'autoWatch', 'confirmBeforeGenerate'].some((k) => next[k] !== before[k])
    const providerChanged = JSON.stringify(next.provider) !== JSON.stringify(before.provider)
    if (providerChanged) { await resolveProvider(true); broadcast({ type: 'provider', provider: runtime.provider }) }
    if (!next.enabled) {
      pauseEngine()
    } else if (engineChanged) {
      if (runtime.busy) runtime.pendingApply = true
      else { runtime.paused = false; await applyEngine() }
    }
    if (biliChanged) broadcast({ type: 'bili-auth', set: Boolean(readBiliCookie().cookie), source: readBiliCookie().source })
    broadcast({ type: 'settings', intervalMs: next.pollIntervalMs, enabled: next.enabled })
    return sendJson(res, 200, { ok: true, state: await buildState() })
  }
  if (p === '/api/scan') {
    await runtime.applyChain
    const tool = runtime.engine && runtime.engine.tools.get('course_map_scan')
    if (!tool) return sendJson(res, 503, { ok: false, message: '引擎尚未就绪' })
    const result = await tool.execute({ title: typeof body.title === 'string' ? body.title : undefined })
    return sendJson(res, 200, result)
  }
  if (p === '/api/confirm') {
    await runtime.applyChain
    const tool = runtime.engine && runtime.engine.tools.get('course_map_confirm')
    if (!tool) return sendJson(res, 503, { ok: false, message: '引擎尚未就绪' })
    const decision = String(body.decision || '')
    if (!['generate', 'skip', 'ignore', 'refresh'].includes(decision)) return sendJson(res, 400, { ok: false, message: 'decision 必须是 generate/skip/ignore/refresh' })
    const key = String(body.id || body.title || '').trim()
    if (!key) return sendJson(res, 400, { ok: false, message: '请提供待确认条目的 id 或标题' })
    const result = await tool.execute({ id: key, title: key, decision })
    return sendJson(res, result && result.ok ? 200 : 404, result)
  }
  if (p === '/api/note/delete') {
    await runtime.applyChain
    const tool = runtime.engine && runtime.engine.tools.get('course_map_delete')
    if (!tool) return sendJson(res, 503, { ok: false, message: '引擎尚未就绪' })
    const title = String(body.title || '').trim()
    if (!title) return sendJson(res, 400, { ok: false, message: '请提供笔记标题' })
    const result = await tool.execute({ title, subject: body.subject ? String(body.subject) : undefined, mode: body.mode === 'purge' ? 'purge' : 'archive' })
    return sendJson(res, result && result.ok ? 200 : 404, result)
  }
  if (p === '/api/bili/test') {
    await runtime.applyChain
    const tool = runtime.engine && runtime.engine.tools.get('course_map_probe')
    if (!tool) return sendJson(res, 503, { ok: false, message: '引擎尚未就绪' })
    const result = await tool.execute({ title: typeof body.title === 'string' ? body.title : undefined })
    return sendJson(res, 200, result)
  }
  if (p === '/api/provider/test') return sendJson(res, 200, await testProvider())
  if (p === '/api/open') {
    const title = String(body.title || '')
    const item = title ? findNote(title) : null
    let target = paths().out
    if (item) target = item.hasWord ? item.docxPath : paths().out
    const abs = resolve(target)
    if (!inside(paths().out, abs)) return sendJson(res, 403, { ok: false, message: '路径不允许' })
    try {
      spawn('explorer.exe', [abs], { detached: true, stdio: 'ignore' }).unref()
      return sendJson(res, 200, { ok: true })
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: (e && e.message) || '打开失败' })
    }
  }
  if (p === '/api/autostart') {
    const r = setAutoStart(Boolean(body.enabled))
    return sendJson(res, 200, { ok: r.ok, enabled: existsSync(STARTUP_LNK), message: r.message })
  }
  if (p === '/api/shutdown') {
    sendJson(res, 200, { ok: true })
    setTimeout(() => shutdown(), 120)
    return
  }
  return sendJson(res, 404, { ok: false, message: 'unknown api' })
}

function shutdown() {
  if (runtime.shuttingDown) return
  runtime.shuttingDown = true
  logInfo('shutdown requested')
  disposeEngine()
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH) } catch { /* 忽略 */ }
  try { if (httpServer) httpServer.close() } catch { /* 忽略 */ }
  setTimeout(() => process.exit(0), 200)
}

function main() {
  runtime.config = loadConfig()
  ensureDirs()
  if (!existsSync(CONFIG_PATH)) { try { saveConfig(runtime.config) } catch { /* 忽略 */ } }
  writeFileSync(PID_PATH, String(process.pid), 'utf8')
  logInfo('starting port=' + runtime.config.port + ' output=' + runtime.config.outputDir)

  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        logError('api ' + url.pathname + ' 失败：' + ((e && e.stack) || e))
        if (!res.headersSent) sendJson(res, 500, { ok: false, message: (e && e.message) || 'internal error' })
        else try { res.end() } catch { /* 忽略 */ }
      })
      return
    }
    serveStatic(url.pathname, res)
  })
  httpServer.on('error', (e) => {
    logError('HTTP 错误：' + ((e && e.message) || e))
    if (e && e.code === 'EADDRINUSE') {
      console.error('端口 ' + runtime.config.port + ' 已被占用')
      process.exit(2)
    }
  })
  httpServer.listen(runtime.config.port, '127.0.0.1', () => {
    logInfo('listening http://127.0.0.1:' + runtime.config.port)
    console.log('[app] listening on ' + runtime.config.port)
  })
  applyEngine().then(() => {
    if (!runtime.config.autoWatch) pauseEngine()
    resolveProvider(true).catch(() => {})
  }).catch(() => {})
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('uncaughtException', (e) => { logError('uncaught: ' + ((e && e.stack) || e)) })
  process.on('unhandledRejection', (e) => { logError('unhandled: ' + ((e && e.stack) || e)) })
}

main()
