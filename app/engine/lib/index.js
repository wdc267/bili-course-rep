/**
 * dsh-video-coursemap — 视频课程知识地图 Agent
 *
 * 定时观察 Windows 前台浏览器窗口，识别当前视频课程，按标题/关键词做
 * 学科分类，生成 Markdown + Mermaid 知识地图 / 学习手册。
 *
 * 行为：
 *  - 前台窗口是浏览器/视频客户端时，取其标题并剥离平台后缀；
 *  - 标题已处理过 → 静默；
 *  - 新标题（连续 stablePolls 次稳定）→ LLM 判定是否课程 + 学科分类；
 *  - 旧学科 → 追加到已有「学习手册.md」；新学科 → 新建学习手册；
 *  - 按标题反查 B 站视频，抓取简介/字幕/弹幕/评论，用于知识总结（失败静默降级）；
 *  - 非课程 → 静默忽略（记录到 seen，不再重复询问）。
 *
 * 纯插件、零运行时依赖、零 DSH 核心修改。
 */

import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)

export const name = 'dsh-video-coursemap'
export const inject = ['llm', 'tools', 'agents']

export const DEFAULTS = {
  enabled: true,
  pollIntervalMs: 15000, // 轮询间隔（毫秒）
  stablePolls: 2,        // 连续 N 次观察到同一新标题才处理（防标签切换抖动）
  outputDir: null,       // null → <用户目录>/课程知识地图
  provider: null,        // null → 使用默认模型
  model: null,
  maxTokens: 4096,
  titleMinLen: 4,
  fetchContent: true,    // 抓取 B 站简介/字幕/弹幕/评论用于总结（失败自动降级）
  onlyBilibili: true,    // 只处理 B 站视频（浏览器/客户端）
  deliverSession: true,  // 生成后自动新建 DSH 会话投递
  sessionCwd: null,      // 新会话工作目录；null → outputDir
  sessionTitlePrefix: '课程笔记',
  watcherRole: 'dsh',    // 轮询锁角色：dsh | standalone
  skipStartupDocx: false, // 重载引擎时跳过启动全量 Word 转换
  generatorLabel: 'DSH', // 写入 lastDelivery，UI 显示来源
  requireBilibiliMatch: true, // 只保存能匹配到 B 站视频的笔记（true=严格 B 站）
  skipInsufficientMaterial: true, // B 站可获取素材太少时不生成空泛笔记
  minMaterialScore: 120, // 简介/字幕字数 + 弹幕*10 + 评论*15
  confirmBeforeGenerate: true, // 检测到 B 站视频后先进入待确认队列，用户确认后再生成
  biliCookie: '', // B站登录 Cookie（SESSDATA）；留空则读 <outputDir>/.state/bili-auth.json
}

// 浏览器 / 视频客户端进程名（isBrowserProc 会统一转小写再去 .exe；中文名原样保留）
const BROWSER_PROCESSES = new Set([
  // 浏览器
  'chrome', 'msedge', 'edge', 'firefox', 'iexplore', 'opera', 'brave', 'chromium',
  'vivaldi', 'yandex', 'librewolf', 'waterfox',
  '360chrome', '360se', '360browser', 'qqbrowser', 'sogouexplorer', 'maxthon', 'ucbrowser', 'quark', '夸克',
  // 视频客户端（中文 + 英文进程名都覆盖）
  'bilibili', '哔哩哔哩',
  'douyin', '抖音', 'aweme',
  'kuaishou', '快手',
  'xigua', '西瓜视频',
  'youku', '优酷', 'iqiyi', '爱奇艺', 'pps',
  'qqlive', 'tencentvideo', '腾讯视频',
  'mgtv', '芒果tv', '芒果TV',
  'migu', '咪咕视频',
  'weishi', '微视',
  'sohuvideo', '搜狐视频', 'letv', '乐视',
  // 本地播放器
  'potplayer', 'vlc', 'mpv', 'kmplayer', 'mpc-hc', 'mpc-be',
])

// 标题末尾要剥离的平台/浏览器后缀（循环剥离，处理 "标题 - YouTube - Google Chrome"）
const TITLE_SUFFIXES = [
  ' - Google Chrome', ' - Microsoft Edge', ' - Mozilla Firefox',
  ' - Chromium', ' - Opera', ' - Brave', ' - Internet Explorer',
  ' - 谷歌浏览器', ' - 微软 Edge', ' - 火狐浏览器', ' - 360极速浏览器',
  '_哔哩哔哩_bilibili', '_哔哩哔哩', ' - 哔哩哔哩', ' - bilibili', '-bilibili', ' - Bilibili',
  ' - YouTube', ' - 优酷', ' - 爱奇艺', ' - 腾讯视频', ' - 芒果TV', ' - 抖音', ' - 快手', ' - 夸克', ' - Quark',
]

// 前台窗口标题读取脚本：结果写入文件，避免 stdout 编码问题（中文 GBK/UTF-8 差异）。
const POLL_PS1 = `param([string]$OutFile)
Add-Type -ErrorAction SilentlyContinue @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FGWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$h = [FGWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FGWin]::GetWindowText($h, $sb, 512)
$procId = 0
[void][FGWin]::GetWindowThreadProcessId($h, [ref]$procId)
$pname = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
$text = "TITLE=" + $sb.ToString() + "\`nPROC=" + $pname
[System.IO.File]::WriteAllText($OutFile, $text, (New-Object System.Text.UTF8Encoding($false)))
`

function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-video-coursemap: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error(`dsh-video-coursemap: 未知配置项 "${key}"`)
    config[key] = value
  }
  for (const key of ['pollIntervalMs', 'stablePolls', 'maxTokens', 'titleMinLen']) {
    const v = config[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`dsh-video-coursemap: ${key} 必须是正数`)
    }
  }
  if (typeof config.enabled !== 'boolean') throw new Error('dsh-video-coursemap: enabled 必须是布尔值')
  if (typeof config.fetchContent !== 'boolean') throw new Error('dsh-video-coursemap: fetchContent 必须是布尔值')
  if (typeof config.onlyBilibili !== 'boolean') throw new Error('dsh-video-coursemap: onlyBilibili 必须是布尔值')
  if (typeof config.deliverSession !== 'boolean') throw new Error('dsh-video-coursemap: deliverSession 必须是布尔值')
  for (const key of ['sessionCwd', 'sessionTitlePrefix']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`dsh-video-coursemap: ${key} 必须是 null 或非空字符串`)
    }
  }
  if (!['dsh', 'standalone'].includes(config.watcherRole)) {
    throw new Error('dsh-video-coursemap: watcherRole 必须是 dsh 或 standalone')
  }
  if (typeof config.skipStartupDocx !== 'boolean') {
    throw new Error('dsh-video-coursemap: skipStartupDocx 必须是布尔值')
  }
  if (typeof config.generatorLabel !== 'string' || config.generatorLabel.trim() === '') {
    throw new Error('dsh-video-coursemap: generatorLabel 必须是非空字符串')
  }
  if (typeof config.requireBilibiliMatch !== 'boolean') {
    throw new Error('dsh-video-coursemap: requireBilibiliMatch 必须是布尔值')
  }
  if (typeof config.skipInsufficientMaterial !== 'boolean') {
    throw new Error('dsh-video-coursemap: skipInsufficientMaterial 必须是布尔值')
  }
  if (typeof config.minMaterialScore !== 'number' || !Number.isFinite(config.minMaterialScore) || config.minMaterialScore < 0) {
    throw new Error('dsh-video-coursemap: minMaterialScore 必须是非负数')
  }
  if (typeof config.confirmBeforeGenerate !== 'boolean') {
    throw new Error('dsh-video-coursemap: confirmBeforeGenerate 必须是布尔值')
  }
  if (typeof config.biliCookie !== 'string') {
    throw new Error('dsh-video-coursemap: biliCookie 必须是字符串')
  }
  for (const key of ['provider', 'model']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new Error(`dsh-video-coursemap: ${key} 必须是 null 或非空字符串`)
    }
  }
  config.outputDir = config.outputDir ?? join(homedir(), '课程知识地图')
  config.sessionCwd = config.sessionCwd ?? config.outputDir
  config.sessionTitlePrefix = config.sessionTitlePrefix ?? '课程笔记'
  return config
}

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }) }

function atomicWrite(file, content) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp.${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function loadState(p) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

function saveState(p, s) { atomicWrite(p, JSON.stringify(s, null, 2) + '\n') }

function cleanTitle(raw) {
  let t = String(raw || '').trim()
  // 零宽字符（飞书标签页标题常见）先清掉，否则后缀匹配会失败
  t = t.replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
  // Edge 多标签页：窗口标题末尾是「和另外 N 个页面 - 个人 - Microsoft Edge」
  t = t.replace(/\s+和另外\s*\d+\s*个页面(?=\s*(?:-\s*|$))/i, '')
  // Edge 配置段：单标签也会带「 - 个人 - Microsoft Edge」，不清掉会导致 B 站搜索失败
  t = t.replace(/\s*-\s*(?:个人|工作|Personal|Work|InPrivate|\[InPrivate\]|Profile\s*\d+|配置\s*\d+)\s*-\s*Microsoft\s*Edge\s*$/i, '')
  let changed = true
  while (changed) {
    changed = false
    for (const suf of TITLE_SUFFIXES) {
      if (t.endsWith(suf)) { t = t.slice(0, -suf.length).trim(); changed = true }
    }
  }
  // 兜底：平台后缀剥离后仍残留的配置段（如「标题 - 个人」）
  t = t.replace(/\s*-\s*(?:个人|工作|Personal|Work|InPrivate|\[InPrivate\]|Profile\s*\d+|配置\s*\d+)\s*$/i, '')
  return t
}

// 本应用页面 / 悬浮窗的窗口标题：轮询时应跳过，且不打断稳定性计数
const APP_TITLE_RE = /^\s*(?:\(\d+\)\s*)?(?:课程笔记|B站课代表|课代表)\s*[·\-]/
function isAppTitle(raw) {
  return APP_TITLE_RE.test(String(raw || '').replace(/[\u200b-\u200f\u2060\ufeff]/g, ''))
}

function sanitizeSubject(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 60) || '未分类'
}

// 已有学科的一致性提示：同一关键词优先归入已存在学科，避免 LLM 每次命名漂移
const SUBJECT_HINTS = [
  [/(redis|mysql|数据库|sql|mongodb|postgres|索引)/i, '数据库'],
  [/(linux|ubuntu|centos|shell|操作系统|内核)/i, '操作系统'],
  [/(python|列表推导|django|flask)/i, 'Python编程'],
  [/(git|版本控制|github|gitlab)/i, '版本控制'],
  [/(deepseek harness|dsh|superagent|大模型|llm)/i, 'AI 工具'],
  [/(java|spring|后端)/i, '后端开发'],
  [/(前端|vue|react|css|html|javascript|typescript)/i, '前端开发'],
  [/(算法|数据结构|leetcode|动态规划)/i, '算法'],
  [/(数学|线代|微积分|概率)/i, '数学'],
  [/(英语|雅思|托福)/i, '英语'],
]
function canonicalSubject(title, existing) {
  const list = Array.isArray(existing) ? existing : []
  for (const [re, name] of SUBJECT_HINTS) {
    if (re.test(String(title || '')) && list.includes(name)) return name
  }
  return ''
}

function mermaidSafe(s) {
  return String(s || '').replace(/[()[\]{}|<>'"`\\/]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)
}

function parseJson(text) {
  if (!text) return null
  let t = String(text).trim()
  // 1) 直接解析
  try { return JSON.parse(t) } catch { /* 继续 */ }
  // 2) 剥离 markdown 代码块围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) {
    try { return JSON.parse(fence[1].trim()) } catch { /* 继续 */ }
  }
  // 3) 提取最外层 {} 对象
  const m = t.match(/\{[\s\S]*\}/)
  if (!m) return null
  const candidate = m[0]
  try { return JSON.parse(candidate) } catch { /* 继续 */ }
  // 4) 修复常见 LLM JSON 瑕疵：尾逗号、未加引号的键、单引号字符串值
  try {
    const fixed = candidate
      .replace(/,\s*([}\]])/g, '$1')                                    // 去尾逗号
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')  // 键加引号
      .replace(/:\s*'([^']*)'/g, ':"$1"')                               // 单引号值 → 双引号
    return JSON.parse(fixed)
  } catch { return null }
}

function resolveModel(ctx, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
      return { provider: sel.provider, model: sel.model }
    }
  } catch { /* 忽略 */ }
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const p of providers) {
      const mid = p.models?.[0]?.id ?? p.defaultModel ?? p.model
      if (p.id && mid) return { provider: p.id, model: mid }
    }
  } catch { /* 忽略 */ }
  return { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
}

async function callLlm(ctx, config, { system, messages, maxTokens, phase }) {
  const model = resolveModel(ctx, config)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('dsh-video-coursemap: LLM 调用超时')), 120000)
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages,
      maxTokens: maxTokens ?? config.maxTokens,
      signal: ac.signal,
    })
    let text = ''
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (phase === 'summary' && typeof ctx.emit === 'function') {
          try { ctx.emit('course-map:event', { type: 'summary_delta', text: chunk.text, at: Date.now() }) } catch { /* 忽略 */ }
        }
      }
    }
    return text
  } finally {
    clearTimeout(timer)
  }
}

const userMsg = (text) => ({ role: 'user', id: randomUUID(), content: [{ type: 'text', text }] })

// ---- B 站内容抓取（标题 → 搜索反查 → 视频信息/弹幕/评论） ----
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cachedBuvid3 = null
async function getBuvid3() {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } })
    const j = await r.json()
    cachedBuvid3 = j?.data?.b_3 || ''
  } catch { cachedBuvid3 = '' }
  return cachedBuvid3
}

// B站登录态：Cookie 可来自环境变量、插件配置或应用写入的共享文件
let activeBiliCookie = ''
let activeBiliAuthFile = ''

function normalizeBiliCookie(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, ' ').trim()
  s = s.replace(/^cookie\s*:\s*/i, '').trim()
  if (!s) return ''
  if (!s.includes('=')) s = 'SESSDATA=' + s
  return s.slice(0, 4096)
}

function getBiliCookie() {
  const env = process.env.BILI_SESSDATA || process.env.BILIBILI_SESSDATA || ''
  if (env) return { cookie: normalizeBiliCookie(env), source: 'env' }
  if (activeBiliCookie) return { cookie: normalizeBiliCookie(activeBiliCookie), source: 'config' }
  if (activeBiliAuthFile) {
    try {
      const j = JSON.parse(readFileSync(activeBiliAuthFile, 'utf8'))
      if (j && j.cookie) return { cookie: normalizeBiliCookie(j.cookie), source: 'file' }
    } catch { /* 忽略 */ }
  }
  return { cookie: '', source: '' }
}

function biliApiHost(url) {
  try {
    const host = new URL(url).hostname
    return host === 'api.bilibili.com' || host === 'www.bilibili.com'
  } catch { return false }
}

async function biliFetch(url, { json = true, timeoutMs = 10000, retries = 2, withCookie = true } = {}) {
  const buvid3 = await getBuvid3()
  const auth = getBiliCookie()
  const cookie = withCookie && biliApiHost(url)
    ? [buvid3 && !/buvid3=/i.test(auth.cookie) ? 'buvid3=' + buvid3 : '', auth.cookie].filter(Boolean).join('; ')
    : ''
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          'Referer': 'https://www.bilibili.com/',
          'Accept': 'application/json, text/plain, */*',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        signal: ac.signal,
      })
      if (res.status === 412) throw new Error('HTTP 412')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      return json ? JSON.parse(text) : text
    } catch (e) {
      lastErr = e
      if (attempt < retries) await sleep(1500 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

// WBI 签名（player/wbi/v2、conclusion/get 需要）
const WBI_MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
function buildWbiQuery(params, mixinKey, wts = Math.floor(Date.now() / 1000)) {
  const p = { ...params, wts }
  const query = Object.keys(p).sort()
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, '')))
    .join('&')
  const w_rid = createHash('md5').update(query + mixinKey).digest('hex')
  return query + '&w_rid=' + w_rid
}
let biliNavCache = { key: '', at: 0, data: null }
async function getBiliNav(force = false) {
  const auth = getBiliCookie()
  const key = auth.cookie
  if (!force && biliNavCache.data && biliNavCache.key === key && Date.now() - biliNavCache.at < 5 * 60 * 1000) return biliNavCache.data
  try {
    const j = await biliFetch('https://api.bilibili.com/x/web-interface/nav')
    const d = j?.data || {}
    const img = String(d?.wbi_img?.img_url || '')
    const sub = String(d?.wbi_img?.sub_url || '')
    const base = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0]
    const orig = base(img) + base(sub)
    const mixinKey = orig.length >= 64 ? WBI_MIXIN_TAB.map((i) => orig[i]).join('').slice(0, 32) : ''
    const data = { isLogin: Boolean(d?.isLogin), mid: d?.mid || 0, uname: d?.uname || '', mixinKey, wbiKeysAt: Date.now() }
    biliNavCache = { key, at: Date.now(), data }
    return data
  } catch {
    return null
  }
}

function subtitleIsAi(t) {
  const lan = String(t?.lan || '').toLowerCase()
  const doc = String(t?.lan_doc || '')
  return lan.startsWith('ai-') || /自动生成|auto/i.test(doc)
}
function subtitleRank(t) {
  const lan = String(t?.lan || '').toLowerCase()
  if (lan === 'zh-hans' || lan === 'zh-cn' || lan === 'zh') return 100
  if (lan === 'zh-tw' || lan === 'zh-hk') return 90
  if (lan === 'ai-zh') return 80
  if (lan.startsWith('ai-')) return 60
  if (lan.startsWith('en') || lan === 'ai-en') return 40
  return 10
}
function rankSubtitleTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((t) => t && t.subtitle_url)
    .slice()
    .sort((a, b) => subtitleRank(b) - subtitleRank(a))
}
function flattenSubtitleBody(body) {
  const items = (Array.isArray(body) ? body : [])
    .map((b) => ({ from: Number(b?.from ?? b?.start_timestamp ?? 0) || 0, to: Number(b?.to ?? b?.end_timestamp ?? 0) || 0, content: String(b?.content || '').trim() }))
    .filter((b) => b.content)
  const out = []
  let prevEnd = -1
  for (const b of items) {
    if (out.length && b.from - prevEnd > 4) out.push('\n')
    out.push(b.content)
    prevEnd = Math.max(prevEnd, b.to)
  }
  return out.join(' ').replace(/[ \t]+/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim()
}
// 字幕覆盖范围：B站有时只返回试看/前几分钟的一条轨（或服务端临时截断），
// 用最后一条时间戳 / 视频时长判断覆盖度，避免拿半截字幕生成半截笔记。
function subtitleSpan(body) {
  const cues = Array.isArray(body) ? body : []
  let from = Infinity
  let to = 0
  let count = 0
  for (const b of cues) {
    const f = Number(b?.from ?? b?.start_timestamp ?? 0) || 0
    const t = Number(b?.to ?? b?.end_timestamp ?? 0) || 0
    if (!String(b?.content || '').trim() && !t) continue
    count += 1
    if (f < from) from = f
    if (t > to) to = t
  }
  return { count, from: Number.isFinite(from) ? from : 0, to }
}

// 保留时间戳的字幕条目（用于网站上的「字幕时间线」，不进笔记）
function subtitleCues(body) {
  return (Array.isArray(body) ? body : [])
    .map((b) => ({
      from: Number(b?.from ?? b?.start_timestamp ?? 0) || 0,
      to: Number(b?.to ?? b?.end_timestamp ?? 0) || 0,
      text: String(b?.content || '').trim(),
    }))
    .filter((c) => c.text)
}

// 把带时间戳的字幕合并成「逻辑段落」：先按 4 秒以上的停顿切成小段，
// 再按目标时长合并成约 3~4 分钟一段，供网站按段展示并跳转视频。
function buildTimeline(cues, opts = {}) {
  const target = Number(opts.targetSeconds) || 210
  const maxSegments = Number(opts.maxSegments) || 30
  const maxBlock = 45 // 先把字幕切成不超过 45 秒的小块，避免整段话没有任何标点时无法细分
  const items = Array.isArray(cues) ? cues.filter((c) => c && c.text) : []
  if (!items.length) return []
  const paras = []
  let cur = null
  for (const c of items) {
    if (!cur) cur = { start: c.from, end: c.to, last: c.to, texts: [c.text] }
    else if (c.from - cur.last > 4 || c.to - cur.start > maxBlock) { paras.push(cur); cur = { start: c.from, end: c.to, last: c.to, texts: [c.text] } }
    else { cur.texts.push(c.text); cur.end = c.to; cur.last = c.to }
  }
  if (cur) paras.push(cur)
  const segs = []
  let seg = null
  for (const p of paras) {
    if (!seg) { seg = { start: p.start, end: p.end, paras: [p.texts.join(' ')] }; continue }
    const dur = seg.end - seg.start
    const gap = p.start - seg.end
    if (dur >= target || (dur >= target * 0.7 && gap >= 6)) {
      segs.push(seg)
      seg = { start: p.start, end: p.end, paras: [p.texts.join(' ')] }
    } else {
      seg.end = p.end
      seg.paras.push(p.texts.join(' '))
    }
  }
  if (seg) segs.push(seg)
  let out = segs.map((s) => ({ start: Math.round(s.start), end: Math.round(s.end), text: s.paras.join('\n') }))
  while (out.length > maxSegments) {
    const merged = []
    for (let i = 0; i < out.length; i += 2) {
      if (i + 1 >= out.length) { merged.push(out[i]); break }
      merged.push({ start: out[i].start, end: out[i + 1].end, text: out[i].text + '\n' + out[i + 1].text })
    }
    out = merged
  }
  return out
}

function fmtClock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return (h > 0 ? String(h) + ':' : '') + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
}

function fallbackSegmentTitle(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  const first = s.split(/[。！？!?；;]/)[0] || s
  return first.slice(0, 18).trim() || '（无标题）'
}

// 给每段字幕起一个小标题（一次 LLM 调用；失败就用首句兜底）
async function labelTimelineSegments(ctx, config, videoTitle, segments) {
  const titles = segments.map((s) => fallbackSegmentTitle(s.text))
  if (!segments.length) return titles
  // 思考型模型的 reasoning 计入 maxTokens，预算太小会返回空正文，这里给足并允许重试一次
  const tokenBudget = Math.max(6000, Number(config.maxTokens) || 0)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lines = segments.map((s, i) => (i + 1) + '. [' + fmtClock(s.start) + '] ' + String(s.text).slice(0, 120)).join('\n')
      const extra = attempt === 0 ? '' : '\n（上一次没有输出有效的 JSON 数组，请严格只输出数组本身。）'
      const user = `下面是视频《${videoTitle}》按时间切分出的 ${segments.length} 段字幕开头。请给每段起一个 10~14 个汉字的小标题，说明这一段在讲什么（用于在网站上定位视频内容）。\n只返回一个 JSON 字符串数组（顺序与输入一致，如 ["标题1","标题2"]），不要任何解释、不要代码块、不要序号。${extra}\n\n${lines}`
      const text = await callLlm(ctx, config, { system: '你是视频章节编辑，善于用短标题概括一段内容。', messages: [userMsg(user)], maxTokens: tokenBudget, phase: 'timeline' })
      if (!text || isOfflineFallbackText(text)) continue
      const m = String(text).match(/\[[\s\S]*\]/)
      if (!m) continue
      const arr = JSON.parse(m[0])
      if (!Array.isArray(arr) || !arr.length) continue
      for (let i = 0; i < segments.length; i++) {
        const t = typeof arr[i] === 'string' ? arr[i].replace(/[#*`"“”]/g, '').trim() : ''
        if (t) titles[i] = t.slice(0, 20)
      }
      return titles
    } catch { /* 用首句兜底 */ }
  }
  return titles
}

async function fetchSubtitleText(track, opts = {}) {
  let u = String(track?.subtitle_url || '')
  if (!u) return { text: '', reason: 'empty-url' }
  if (u.startsWith('//')) u = 'https:' + u
  let best = { text: '', reason: 'empty-body' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 同一 URL 可能被 CDN 缓存成半截内容，重抓时带时间戳参数绕过缓存
      const bust = opts.bust || attempt > 0
      const url = bust ? u + (u.includes('?') ? '&' : '?') + '_t=' + Date.now() : u
      const data = await biliFetch(url, { json: true, withCookie: false })
      const text = flattenSubtitleBody(data?.body)
      const span = subtitleSpan(data?.body)
      if (text.length > best.text.length) best = { text, ...span, cues: subtitleCues(data?.body) }
      if (text.length >= 20) break
    } catch { /* 重试 */ }
    if (attempt === 0) await sleep(800)
  }
  return best
}
async function fetchPlayerTracks(aid, cid, nav) {
  const urls = []
  if (aid && cid) {
    if (nav?.mixinKey) urls.push('https://api.bilibili.com/x/player/wbi/v2?' + buildWbiQuery({ aid, cid }, nav.mixinKey))
    urls.push('https://api.bilibili.com/x/player/v2?aid=' + encodeURIComponent(aid) + '&cid=' + encodeURIComponent(cid))
  }
  for (const u of urls) {
    try {
      const j = await biliFetch(u)
      if (j?.code === 0) {
        const tracks = j?.data?.subtitle?.subtitles
        if (Array.isArray(tracks) && tracks.length) return tracks
      }
    } catch { /* 换下一个 */ }
  }
  return []
}
async function fetchPlayerSubtitle(aid, cid, nav, duration = 0) {
  let tracks = []
  let best = null
  const okCoverage = (c) => !duration || (c && c.coverage >= 0.9)
  for (let round = 0; round < 3; round++) {
    const roundTracks = await fetchPlayerTracks(aid, cid, nav)
    if (roundTracks.length) tracks = roundTracks
    if (!tracks.length) { await sleep(1500 * (round + 1)); continue }
    // 只试排名最靠前的几条中文轨，避免 8 条多语言字幕全量下载；后续轮次带缓存参数重抓
    for (const t of rankSubtitleTracks(tracks).slice(0, 3)) {
      const r = await fetchSubtitleText(t, { bust: round > 0 })
      if (!r.text) continue
      const coverage = duration > 0 ? Math.min(1, (r.to || 0) / duration) : 0
      const cand = { text: r.text, track: t, ai: subtitleIsAi(t), tracks: tracks.length, count: r.count || 0, from: r.from || 0, to: r.to || 0, coverage, cues: r.cues || [] }
      if (!best || cand.text.length > best.text.length) best = cand
      if (okCoverage(cand)) return cand
    }
    if (best && (best.coverage >= 0.5 || (!duration && best.text.length >= 2000))) break
    await sleep(1500 * (round + 1))
  }
  return best || { text: '', track: null, ai: false, tracks: tracks.length, coverage: 0 }
}
async function fetchConclusion(aid, bvid, cid, upMid, nav) {
  const auth = getBiliCookie()
  if (!auth.cookie) return { reason: 'need-login' }
  if (!nav?.mixinKey) return { reason: 'wbi-unavailable' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const q = buildWbiQuery({ bvid, cid, ...(upMid ? { up_mid: upMid } : {}) }, nav.mixinKey)
      const j = await biliFetch('https://api.bilibili.com/x/web-interface/view/conclusion/get?' + q)
      if (j?.code === -101) return { reason: 'need-login' }
      const d = j?.data || {}
      if (d.code === 0) {
        const mr = d.model_result || {}
        const parts = (Array.isArray(mr.subtitle) ? mr.subtitle : []).flatMap((s) => Array.isArray(s?.part_subtitle) ? s.part_subtitle : [])
        const subtitle = flattenSubtitleBody(parts)
        const span = subtitleSpan(parts)
        const outline = (Array.isArray(mr.outline) ? mr.outline : [])
          .map((o) => [String(o?.title || '').trim(), ...(Array.isArray(o?.part_outline) ? o.part_outline.map((p) => String(p?.content || '').trim()) : [])].filter(Boolean).join('；'))
          .filter(Boolean).join('\n')
        return { subtitle, to: span.to, count: span.count, cues: subtitleCues(parts), summary: String(mr.summary || '').trim(), outline, queued: false }
      }
      const queued = String(d.stid) === '0'
      if (d.code === 1 && queued && attempt === 0) { await sleep(4000); continue }
      return { reason: d.code === 1 ? (queued ? 'queued' : 'no-speech') : 'unsupported', queued }
    } catch (e) {
      if (attempt === 0) { await sleep(2000); continue }
      return { reason: 'error:' + ((e?.message) || e) }
    }
  }
  return { reason: 'queued', queued: true }
}

function stripHtml(s) { return String(s || '').replace(/<[^>]+>/g, '').trim() }

function materialScore(content) {
  if (!content) return 0
  return (content.desc?.length || 0) + (content.transcript?.length || 0) + (content.aiSummary?.length || 0) + (content.outline?.length || 0) +
    (content.danmaku?.length || 0) * 10 + (content.comments?.length || 0) * 15
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

function normTitle(s) { return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '') }

// B 站内容判定：标题或前台进程带平台名
function isBiliTitle(raw, proc) {
  if (/哔哩哔哩|bilibili/i.test(String(raw || ''))) return true
  return /^(bilibili|哔哩哔哩)$/i.test(String(proc || '').replace(/\.exe$/i, '').trim())
}

// 清洗后仍是 B 站首页/搜索/动态页，不是具体视频
function isBiliHubPage(title) {
  const t = String(title || '').trim()
  if (!t) return true
  if (t.includes('哔哩哔哩')) return true
  return /^bilibili\b/i.test(t)
}

function titleKey(title) { return 'title:' + normTitle(title) }
function bvidKey(bvid) { return bvid ? 'bvid:' + String(bvid).trim() : null }

function titleSimilar(a, b) {
  const na = normTitle(a); const nb = normTitle(b)
  if (!na || !nb) return 0
  if (na.includes(nb) || nb.includes(na)) return 1
  const bigrams = (s) => { const m = new Set(); for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2)); return m }
  const A = bigrams(na); const B = bigrams(nb)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

async function searchBili(title) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(title)
  const data = await biliFetch(url)
  if (data?.code !== 0) throw new Error('bili search code ' + data?.code)
  const results = (data?.data?.result ?? []).filter((r) => r?.bvid)
  if (!results.length) return null
  // 窗口标题可能被截断：前 5 条里取相似度最高且达到阈值的
  let best = null
  let bestScore = 0
  for (const r of results.slice(0, 5)) {
    const clean = stripHtml(r.title)
    const score = titleSimilar(title, clean)
    if (score > bestScore) { bestScore = score; best = { r, clean } }
  }
  if (!best || bestScore < 0.5) return null
  return {
    bvid: best.r.bvid,
    aid: best.r.aid,
    title: best.clean,
    desc: stripHtml(best.r.description || ''),
    tags: String(best.r.tag || '').split(',').map((s) => s.trim()).filter(Boolean),
  }
}

async function viewBili(bvid) {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid))
  if (data?.code !== 0) throw new Error('bili view code ' + data?.code)
  const d = data?.data ?? {}
  return {
    aid: d.aid,
    cid: d.cid ?? d.pages?.[0]?.cid,
    duration: Number(d.duration) || 0,
    pages: Array.isArray(d.pages) ? d.pages.length : 1,
    desc: d.desc || '',
    owner: d.owner?.name || '',
    ownerMid: d.owner?.mid || 0,
    stat: d.stat || {},
    subtitle: d.subtitle?.list ?? [],
  }
}

async function fetchDanmaku(cid) {
  if (!cid) return []
  const xml = await biliFetch('https://comment.bilibili.com/' + cid + '.xml', { json: false })
  const items = []
  const re = /<d[^>]*>([\s\S]*?)<\/d>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const t = decodeXml(m[1]).trim()
    if (!t) continue
    if (t.startsWith('[') && t.endsWith(']')) continue // 高级弹幕 JSON
    items.push(t)
  }
  const seen = new Set()
  return items.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true }).slice(0, 150)
}

async function fetchComments(aid) {
  if (!aid) return []
  const data = await biliFetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&sort=2&ps=20&pn=1')
  if (data?.code !== 0) throw new Error('bili reply code ' + data?.code)
  return (data?.data?.replies ?? []).map((r) => String(r?.content?.message || '').trim()).filter(Boolean).slice(0, 20)
}

async function fetchBiliContent(title) {
  const s = await searchBili(title)
  if (!s) return null
  let view = null
  try { view = await viewBili(s.bvid) } catch { /* 忽略 */ }
  const cid = view?.cid
  const aid = view?.aid || s.aid
  const nav = await getBiliNav()
  const auth = getBiliCookie()
  const loginState = !auth.cookie ? 'none' : (nav ? (nav.isLogin ? 'ok' : 'invalid') : 'unknown')
  const [danmaku, comments] = await Promise.allSettled([
    cid ? fetchDanmaku(cid) : Promise.resolve([]),
    aid ? fetchComments(aid) : Promise.resolve([]),
  ])
  let player = { text: '', track: null, ai: false, tracks: 0, coverage: 0 }
  try { player = await fetchPlayerSubtitle(aid, cid, nav, view?.duration || 0) } catch { /* 忽略 */ }
  let ai = null
  if (!player.text) {
    try { ai = await fetchConclusion(aid, s.bvid, cid, view?.ownerMid, nav) } catch { /* 忽略 */ }
  }
  const duration = Number(view?.duration) || 0
  const transcript = player.text || ai?.subtitle || ''
  const subtitleSource = player.text ? (player.ai ? 'AI字幕' : '人工字幕') : (ai?.subtitle ? 'AI摘要字幕' : '无字幕')
  const subtitleLang = player.track?.lan_doc || player.track?.lan || (ai?.subtitle ? 'AI摘要' : '')
  const coverage = player.text
    ? (duration > 0 ? Math.min(1, (player.to || 0) / duration) : 0)
    : (ai?.subtitle && duration > 0 ? Math.min(1, (ai.to || 0) / duration) : 0)
  let subtitleNote = ''
  if (!transcript) {
    if (loginState === 'none') subtitleNote = '未登录 B站：字幕接口需要登录态（SESSDATA）'
    else if (loginState === 'invalid') subtitleNote = 'B站登录态失效，请更新 Cookie'
    else if (loginState === 'unknown') subtitleNote = '无法验证 B站登录态（网络或风控），已尝试读取字幕'
    else if (ai?.reason === 'queued' || ai?.queued) subtitleNote = '已请求 B站生成 AI 字幕/摘要，稍后点「重新检测」'
    else if (ai?.reason === 'no-speech' || ai?.reason === 'unsupported') subtitleNote = 'B站未识别到语音或该视频不支持 AI 字幕'
    else subtitleNote = 'B站没有返回可用字幕轨道（可能视频无字幕/未生成 AI 字幕）'
  } else if (coverage > 0 && coverage < 0.85) {
    subtitleNote = '字幕只覆盖前 ' + Math.round(coverage * 100) + '%（约 ' + Math.round((player.to || 0) / 60) + '/' + Math.round(duration / 60) + ' 分钟），已重试仍不完整；笔记只基于已有部分'
  }
  return {
    bvid: s.bvid,
    aid,
    cid,
    title: s.title,
    duration,
    desc: String(view?.desc || s.desc || '').trim(),
    tags: s.tags || [],
    owner: view?.owner || '',
    ownerMid: view?.ownerMid || 0,
    stat: view?.stat || {},
    transcript,
    subtitleSource,
    subtitleLang,
    subtitleTracks: player.tracks || 0,
    subtitleCount: player.count || 0,
    subtitleCoverage: coverage,
    needLogin: loginState !== 'ok',
    loginState,
    aiQueued: Boolean(ai?.queued || ai?.reason === 'queued'),
    subtitleNote,
    cues: (player.text ? player.cues : ai?.cues) || [],
    aiSummary: String(ai?.summary || '').trim(),
    outline: String(ai?.outline || '').trim(),
    danmaku: danmaku.status === 'fulfilled' ? danmaku.value : [],
    comments: comments.status === 'fulfilled' ? comments.value : [],
  }
}

async function classify(ctx, config, title, existingSubjects) {
  const system = '你是视频内容分类助手。判断一个「浏览器当前标题」是否值得整理成知识地图，并归类到学科。'
  const user = `浏览器当前标题：${JSON.stringify(title)}
已有学科列表：${JSON.stringify(existingSubjects)}

只返回一个合法 JSON 对象（不要任何多余文字、不要 markdown 代码块、不要尾逗号），格式：
{"isCourse":true,"subject":"学科名","title":"清洗后的视频标题","keywords":["关键词1","关键词2"]}

规则：
- isCourse 填 true 的「有知识含量」内容：课程、教程、教学、科普、纪录片、开箱测评、知识分享、技能讲解、历史/文化/科技解读等。
- isCourse 填 false 的「无知识含量」内容：纯音乐、纯搞笑段子、无解说游戏实况、直播聊天、新闻播报、普通网页、搜索页、社交页、邮箱、工作软件等。
- 若该视频属于已有学科之一，subject 必须与列表里某个已有名字完全一致；否则给一个简洁的新学科名（中文，≤8 字，如 机器学习/前端开发/英语/历史/数学/算法/美食测评）。
- title 为去掉浏览器与平台后缀后的纯视频标题。
- keywords 为 3~6 个核心知识点关键词。`
  let text = await callLlm(ctx, config, { system, messages: [userMsg(user)], maxTokens: 1500, phase: 'classify' })
  let cls = parseJson(text)
  if (!cls) {
    // 解析失败重试一次：强调只输出合法 JSON
    const retry = user + '\n\n（注意：上一次你的回复无法被解析。请严格只输出一个合法 JSON 对象本身，前后不要任何解释文字、不要 markdown 代码块、不要尾逗号。）'
    text = await callLlm(ctx, config, { system, messages: [userMsg(retry)], maxTokens: 1500, phase: 'classify' })
    cls = parseJson(text)
  }
  return cls
}

// 独立应用在「模型返回空内容」时会注入离线抽取的兜底文本，不能当成模型输出使用
function isOfflineFallbackText(s) {
  return /离线抽取模式|仅基于简介\/标签\/弹幕\/评论做结构化整理/.test(String(s || ''))
}

// 笔记标题：取模型输出的第一行标题（根据内容概括、约 20 字），去掉正文里的重复标题；
// 模型若照抄视频原标题，则退回原标题，避免标题和内容对不上。
function splitNoteTitle(md, fallbackTitle) {
  const s = String(md || '').replace(/^\s+/, '')
  const m = s.match(/^(#{1,3})[ \t]+(.+?)[ \t]*\r?\n/)
  if (!m) return { title: fallbackTitle, body: s }
  const body = s.slice(m[0].length).replace(/^\s+/, '')
  let t = m[2].replace(/[*_`#>\[\]]/g, '').replace(/\s+/g, ' ').trim()
  if (!t) return { title: fallbackTitle, body }
  if (normTitle(t) === normTitle(fallbackTitle)) return { title: fallbackTitle, body }
  if (t.length > 26) t = t.slice(0, 20) + '…'
  return { title: t, body }
}

function splitTranscript(text, target = 3200, maxChunks = 14) {
  const s = String(text || '').trim()
  if (!s) return []
  const rough = Math.ceil(s.length / Math.max(1, target))
  const size = rough > maxChunks ? Math.ceil(s.length / maxChunks) : target
  const chunks = []
  let i = 0
  while (i < s.length) {
    let end = Math.min(s.length, i + size)
    if (end < s.length) {
      const win = s.slice(Math.max(i, end - 500), end + 240)
      const marks = ['\n', '。', '！', '？', '；', '. ']
      let cut = -1
      for (const m of marks) cut = Math.max(cut, win.lastIndexOf(m))
      if (cut > 120) end = Math.max(i, end - 500) + cut + 1
    }
    chunks.push(s.slice(i, end).trim())
    i = end
  }
  return chunks.filter(Boolean)
}

async function generate(ctx, config, { title, subject, keywords, content }) {
  const system = '你是学习笔记整理专家，为视频课程生成「知识地图」Markdown 笔记。'
  // 思考型模型（如 deepseek-v4-flash）的 reasoning 也计入 maxTokens，预算太小会返回空正文
  const summaryTokens = Math.max(8000, Number(config.maxTokens) || 0)
  let srcBlock = ''
  let coverageHint = ''
  if (content) {
    const parts = []
    const transcript = String(content.transcript || '')
    if (content.duration) parts.push('【视频信息】时长约 ' + Math.max(1, Math.round(content.duration / 60)) + ' 分钟' + (content.duration >= 60 ? '（' + Math.round(content.duration) + ' 秒）' : ''))
    if (content.desc) parts.push('【视频简介】\n' + content.desc.slice(0, 1800))
    if (content.tags?.length) parts.push('【视频标签】\n' + content.tags.join('、'))
    if (transcript.length && transcript.length <= 7000) {
      parts.push('【字幕/讲解文本（' + (content.subtitleSource || '字幕') + '，全文 ' + transcript.length + ' 字）】\n' + transcript)
    } else if (transcript.length) {
      // 长字幕：先分段提炼要点（覆盖全片），再由要点汇总成笔记，避免只看到开头几千字
      const chunks = splitTranscript(transcript, 3200, 14)
      const segs = []
      const mapTokens = Math.max(6000, Number(config.maxTokens) || 0)
      for (let i = 0; i < chunks.length; i++) {
        try {
          ctx.emit?.('course-map:event', { type: 'summary_progress', stage: 'map', index: i + 1, total: chunks.length, message: '正在分段整理字幕 ' + (i + 1) + '/' + chunks.length + '（全片 ' + transcript.length + ' 字）', at: Date.now() })
        } catch { /* 忽略 */ }
        const segUser = `下面是课程视频《${title}》字幕的第 ${i + 1}/${chunks.length} 段（按播放顺序，全片共 ${chunks.length} 段）。请只整理本段实际讲到的内容：
- 输出 6~10 条 Markdown 无序列表（以「- 」开头），每条 1~2 句
- 保留命令、配置项、参数、数字、例子、易错点等具体信息
- 不要写导语/总结，不要补充本段没讲的通用知识，不要评价
- 只输出列表本身，不要标题、不要代码块

【本段字幕】
${chunks[i]}`
        let seg = ''
        // 思考型模型会把 maxTokens 全花在 reasoning 上导致正文为空，这里给足预算并允许一次重试
        for (let attempt = 0; attempt < 2; attempt++) {
          const user = attempt === 0
            ? segUser
            : segUser + '\n\n（上一次没有输出正文。请直接输出 6~10 条要点列表，不要任何思考过程或说明。）'
          const text = await callLlm(ctx, config, { system: '你是严谨的课程字幕整理助手，只做要点提取，不编造。', messages: [userMsg(user)], maxTokens: mapTokens, phase: 'map' })
          seg = String(text || '').trim()
          if (seg && !isOfflineFallbackText(seg)) break
          seg = ''
        }
        if (!seg) {
          try {
            ctx.emit?.('course-map:event', { type: 'summary_progress', stage: 'map', index: i + 1, total: chunks.length, message: '第 ' + (i + 1) + ' 段提炼失败，已改用原文片段', at: Date.now() })
          } catch { /* 忽略 */ }
          seg = '- ' + chunks[i].slice(0, 1400)
        }
        segs.push('【第 ' + (i + 1) + ' 段（约第 ' + Math.round((i / chunks.length) * 100) + '%–' + Math.round(((i + 1) / chunks.length) * 100) + '% 处）】\n' + seg)
      }
      parts.push('【字幕分段时间摘要（覆盖全片 ' + chunks.length + ' 段，按播放顺序）】\n' + segs.join('\n\n'))
      coverageHint = '注意：上面的字幕摘要按时间段覆盖整段视频（共 ' + chunks.length + ' 段），「核心知识点」必须覆盖全片流程，后段讲到的内容（配置、插件、示例、问题排查等）也要写进笔记，不要只写开头。'
    }
    if (content.subtitleNote && /只覆盖|不完整/.test(content.subtitleNote)) {
      coverageHint += (coverageHint ? ' ' : '') + '字幕本身不完整（' + content.subtitleNote + '），缺失部分不要编造，可标注“（字幕未覆盖）”。'
    }
    if (content.aiSummary) parts.push('【B站AI视频摘要】\n' + content.aiSummary.slice(0, 1600))
    if (content.outline) parts.push('【B站AI分段提纲】\n' + content.outline.slice(0, 1600))
    if (content.danmaku?.length) parts.push('【弹幕（节选 ' + content.danmaku.length + ' 条）】\n' + content.danmaku.slice(0, 150).join('\n'))
    if (content.comments?.length) parts.push('【评论区热评（节选 ' + content.comments.length + ' 条）】\n' + content.comments.slice(0, 20).join('\n'))
    if (parts.length) srcBlock = '\n\n已抓取到以下视频真实内容/弹幕/评论，请基于它们总结（不要凭空编造）：\n\n' + parts.join('\n\n')
  }
  const user = `视频标题：${title}
学科：${subject}
关键词：${keywords.join('、')}${srcBlock}

只返回 Markdown（不要任何解释、不要首尾多余说明）。笔记正文只看核心知识点，必须用多级标题分章节，不要把所有内容堆在一个标题下。结构如下：

# 标题（根据整篇笔记概括，20 个汉字以内，不要照抄视频原标题）

## 一、章节标题（按讲解顺序分 4~8 章）
### 主题标题
- 要点（1~3 句）
- 要点

### 主题标题
- 要点

## 二、章节标题
### 主题标题
- 要点

要求：${content ? '优先引用素材中的具体术语、命令、步骤、数字和例子；尽量覆盖视频的完整流程（概念→步骤→配置→常见问题→例子）。素材没有直接说明、但属于该主题的基础知识可以补充，必须在条目末尾标注“（通用知识补充）”；素材里的争论、玩梗、明显错误不要当结论。总共 10~16 个主题（每个主题 2~4 条要点），不要只写 1~3 条，不要重复；素材实在不足时明确写“素材不足”；不要改写素材里的术语（素材说“链表”就不要写成“单向/双向链表”，素材说“B+树”就不要写成“平衡二叉树”），不要下素材没有的效率高低结论。' : '基于标题与关键词合理推断；素材不足时明确说明。'}${coverageHint ? '\n\n' + coverageHint : ''}

笔记里**只保留核心知识点**（章节 + 主题 + 要点）：
- 不要输出元数据（学科/关键词/视频/来源/素材/生成时间），不要一句话简介，不要弹幕与评论讨论，不要思维导图/mermaid，不要原始字幕或弹幕原文。
- 章节标题用「一、二、三…」编号，用二级标题（##）；主题用三级标题（###）；要点用「- 」列表。
- 全部用中文。第一行「# 标题」必须由你根据整篇笔记概括（20 个汉字以内、能一眼看懂这篇笔记讲什么），不要照抄视频原标题；正文里不要再重复视频完整标题。`
  function topicStats(text) {
    const s = String(text || '')
    const chapters = (s.match(/^##\s+/gm) || []).length
    const topics = (s.match(/^###\s+/gm) || []).length
    const bullets = (s.match(/^\s*(?:[-*]|\d+\.)\s+/gm) || []).length
    return { chapters, topics, bullets, length: s.trim().length }
  }
  function coreThin(text) {
    const st = topicStats(text)
    // 少于 3 章或 6 个主题视为「没分级/太单薄」，触发重写
    return st.chapters < 3 || st.topics < 6 || st.bullets < 12
  }
  let md = await callLlm(ctx, config, { system, messages: [userMsg(user)], maxTokens: summaryTokens, phase: 'summary' })
  if (content && coreThin(md)) {
    const retry = user + `\n\n上一版笔记不合格：要么内容太少，要么没有分章节。请重写并严格满足：
- 至少 4 个二级章节（## 一、…）+ 至少 8 个三级主题（### …），每个主题 2~4 条要点；
- 只写核心知识点，不要元数据、简介、弹幕评论、思维导图；覆盖视频的流程、命令、配置、常见问题和例子；素材没有直接说明的可补充通用知识，但条目末尾标注“（通用知识补充）”。`
    const md2 = await callLlm(ctx, config, { system, messages: [userMsg(retry)], maxTokens: summaryTokens, phase: 'summary' })
    if (String(md2 || '').trim().length > String(md || '').trim().length) md = md2
  }
  if (content && coreThin(md)) {
    const extra = []
    if (content.desc) extra.push('**视频简介**：' + content.desc.slice(0, 800))
    const details = (content.danmaku || []).filter((x) => /\d|命令|io|页|表|索引|步骤|配置|安装|使用|根|叶/i.test(String(x))).slice(0, 12)
    if (details.length) extra.push('**弹幕/评论中的具体信息**\n- ' + details.join('\n- '))
    if (content.comments?.length) extra.push('**热评**\n- ' + content.comments.slice(0, 5).join('\n- '))
    if (extra.length) md = String(md || '').trim() + '\n\n### 补充细节\n\n' + extra.join('\n\n')
  }
  // 规范化 qwen 常见的缩进错误：要点统一缩进一级
  md = String(md || '')
    .replace(/^[ \t]*(?:[-*]|\d+\.)\s+\*\*主题([0-9一二三四五六七八九十]+)/gm, '- **主题$1')
    .replace(/^[ \t]*[-*]\s+(要点|步骤|命令|示例|注意|说明)[：:]/gm, '  - $1：')
    // 笔记只保留核心知识点：兜底删掉模型有时仍会带上的思维导图 / 原始素材 / 弹幕讨论 / 简介 / 元数据
    .replace(/\n#{2,3}[ \t]*思维导图[\s\S]*?(?=\n#{2,3}[ \t]|\s*$)/g, '')
    .replace(/\n#{2,3}[ \t]*(?:原始素材|弹幕与评论讨论焦点)[^\n]*\n[\s\S]*$/g, '')
    .replace(/^(?:[ \t]*[-*][ \t]*(?:学科|关键词|视频|来源|素材|生成时间|字幕提示)[:：].*\r?\n?)+/gm, '')
    .replace(/^>[ \t].*(?:\r?\n)?/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return md
}

// 插件自身目录（file: 安装后整个目录被复制，scripts/md2docx.py 就在其中）
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const MD2DOCX_PATH = join(PLUGIN_DIR, 'scripts', 'md2docx.py')

/** 找一个可用的 Python（优先 DSH 捆绑运行时，其次 PATH）。 */
function findPython() {
  const cands = []
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const rt of readdirSync(runtimesDir)) {
      cands.push(join(runtimesDir, rt, 'dependencies', 'python', 'python.exe'))
    }
  } catch { /* 忽略 */ }
  cands.push('python', 'python3')
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { timeout: 8000, windowsHide: true })
      if (r.status === 0) return c
    } catch { /* 忽略 */ }
  }
  return 'python'
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  activeBiliCookie = normalizeBiliCookie(config.biliCookie)
  activeBiliAuthFile = join(config.outputDir, '.state', 'bili-auth.json')
  ensureDir(config.outputDir)
  const stateDir = join(config.outputDir, '.state')
  ensureDir(stateDir)
  const statePath = join(stateDir, 'state.json')
  const pollTag = String(config.watcherRole || 'dsh')
  const ps1Path = join(stateDir, `poll-${pollTag}.ps1`)
  const pollOutPath = join(stateDir, `poll-out-${pollTag}.txt`)
  const manualsDir = join(stateDir, 'manuals')
  ensureDir(manualsDir)
  const pythonPath = findPython()
  writeFileSync(ps1Path, POLL_PS1, 'utf8')

  const state = loadState(statePath)
  if (!state.subjects || typeof state.subjects !== 'object') state.subjects = {}
  if (!state.seen || typeof state.seen !== 'object') state.seen = {}
  if (!state.ignored || typeof state.ignored !== 'object') state.ignored = {}
  if (!Array.isArray(state.pending)) state.pending = []
  if (!state.seenReconciled || typeof state.seenReconciled !== 'object') state.seenReconciled = {}
  if (typeof state.revision !== 'number') state.revision = 0
  if (typeof state.lastTitle !== 'string') state.lastTitle = ''
  if (typeof state.lastRunAt !== 'number') state.lastRunAt = 0
  if (!state.lastCandidate || typeof state.lastCandidate !== 'object' || typeof state.lastCandidate.title !== 'string') state.lastCandidate = null
  const pendingPrep = new Map()
  function saveStateNow() {
    state.revision = (Number(state.revision) || 0) + 1
    state.updatedAt = Date.now()
    saveState(statePath, state)
    return state.revision
  }
  function backupState(reason) {
    try {
      if (!existsSync(statePath)) return ''
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const dest = join(stateDir, `state.json.bak-${stamp}${reason ? '-' + reason : ''}`)
      copyFileSync(statePath, dest)
      return dest
    } catch { return '' }
  }
  function syncPendingPrep() {
    const ids = new Set((state.pending || []).map((p) => String(p.id)))
    for (const id of pendingPrep.keys()) if (!ids.has(id)) pendingPrep.delete(id)
  }

  // 调试日志：写到 .state/poll.log，便于排查「为何没生成」
  const logPath = join(stateDir, 'poll.log')
  function logLine(msg) {
    try { appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8') } catch { /* 忽略 */ }
  }
  const emit = (payload) => {
    try { ctx.emit?.('course-map:event', { at: Date.now(), ...payload }) } catch { /* 忽略 */ }
  }

  let lastLogKey = ''
  function logObservation(proc, title) {
    const key = `${proc}|${title}`
    if (key === lastLogKey) return
    lastLogKey = key
    logLine(`fg proc=${proc} title=${JSON.stringify(title)}`)
  }

  let debounce = null   // { title, count } — 稳定性去抖
  let running = false  // 处理中互斥
  let runningTitle = '' // 正在处理的视频标题（用于「立即提取」避免重复触发）

  // ---- 双宿主互斥锁：DSH 插件 与 独立桌面应用 只能有一个在轮询 ----
  const lockPath = join(stateDir, 'watcher.lock')
  function readLock() {
    try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null }
  }
  function pidAlive(pid) {
    try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
  }
  function otherWatcherActive() {
    const l = readLock()
    if (!l || !l.pid || l.pid === process.pid) return false
    if (Date.now() - Number(l.at ?? 0) > 30000) return false
    return pidAlive(l.pid)
  }
  function shouldYield() {
    return config.watcherRole !== 'standalone' && otherWatcherActive()
  }
  function writeLock() {
    if (config.watcherRole !== 'standalone' && otherWatcherActive()) return false
    try {
      atomicWrite(lockPath, JSON.stringify({ pid: process.pid, role: config.watcherRole, at: Date.now() }, null, 2) + '\n')
      return true
    } catch { return false }
  }
  function removeLock() {
    const l = readLock()
    if (l && l.pid === process.pid) {
      try { unlinkSync(lockPath) } catch { /* 忽略 */ }
    }
  }
  function syncFromDisk() {
    const disk = loadState(statePath)
    if (!disk || typeof disk !== 'object') return
    const diskRev = Number(disk.revision) || 0
    const myRev = Number(state.revision) || 0
    if (diskRev > myRev) {
      for (const k of Object.keys(state)) delete state[k]
      Object.assign(state, disk)
      if (!state.subjects || typeof state.subjects !== 'object') state.subjects = {}
      if (!state.seen || typeof state.seen !== 'object') state.seen = {}
      if (!state.ignored || typeof state.ignored !== 'object') state.ignored = {}
      if (!Array.isArray(state.pending)) state.pending = []
      if (!state.seenReconciled || typeof state.seenReconciled !== 'object') state.seenReconciled = {}
      if (typeof state.lastTitle !== 'string') state.lastTitle = ''
      if (typeof state.lastRunAt !== 'number') state.lastRunAt = 0
      syncPendingPrep()
      return
    }
    if (disk.seen && typeof disk.seen === 'object') {
      for (const [k, v] of Object.entries(disk.seen)) {
        if (typeof v === 'number' && (!(k in state.seen) || v > state.seen[k])) state.seen[k] = v
      }
    }
    if (disk.subjects && typeof disk.subjects === 'object') {
      for (const [name, d] of Object.entries(disk.subjects)) {
        if (!state.subjects[name]) { state.subjects[name] = d; continue }
        const cur = state.subjects[name]
        if (!Array.isArray(cur.videos)) cur.videos = []
        for (const v of d?.videos ?? []) if (!cur.videos.includes(v)) cur.videos.push(v)
      }
    }
    if (disk.lastDelivery && !state.lastDelivery) state.lastDelivery = disk.lastDelivery
  }

  async function pollForeground() {
    try {
      await execFileP('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', ps1Path, '-OutFile', pollOutPath,
      ], { timeout: 8000, windowsHide: true })
      const txt = readFileSync(pollOutPath, 'utf8').replace(/^\uFEFF/, '')
      const title = (txt.match(/^TITLE=(.*)$/m)?.[1] ?? '').trim()
      const proc = (txt.match(/^PROC=(.*)$/m)?.[1] ?? '').trim()
      return { title, proc }
    } catch { return null }
  }

  function isBrowserProc(proc) {
    return BROWSER_PROCESSES.has(String(proc || '').toLowerCase().replace(/\.exe$/i, ''))
  }

  // 「立即提取」兜底：枚举所有带标题的窗口，找一个 B 站视频窗口。
  // 前台已经是本应用/编辑器时也能直接提取，不必等下一轮轮询把视频切回前台。
  async function findBiliWindow() {
    try {
      const cmd = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -match 'bilibili' } | Select-Object -First 3 | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }"
      const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 15000, windowsHide: true })
      const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      for (const line of lines) {
        const idx = line.indexOf('|')
        if (idx <= 0) continue
        const proc = line.slice(0, idx).trim()
        const title = line.slice(idx + 1).trim()
        if (!title) continue
        const clean = cleanTitle(title)
        if (isAppTitle(title) || isAppTitle(clean)) continue
        if (isBiliHubPage(clean) || clean.length < config.titleMinLen) continue
        return { title: clean, rawTitle: title, proc }
      }
    } catch { /* 忽略 */ }
    return null
  }

  const subjectDir = (subject) => join(config.outputDir, subject)
  const manualMdPath = (subject) => join(manualsDir, `${subject}.md`)             // 内部 Markdown 源
  const manualDocxPath = (subject) => join(subjectDir(subject), '学习手册.docx')   // 对外 Word 文档
  const indexMdPath = () => join(manualsDir, 'index.md')
  const videosDir = join(stateDir, 'videos')
  ensureDir(videosDir)
  const lastDeliveryPath = join(stateDir, 'last-delivery.json')
  const safeFile = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || ('note-' + Date.now())
  const videoMdPath = (title) => join(videosDir, safeFile(title) + '.md')
  const videoDocxPath = (subject, title) => join(subjectDir(subject), safeFile(title) + '.docx')
  const videoExportMdPath = (subject, title) => join(subjectDir(subject), safeFile(title) + '.md')
  // 笔记元数据（学科/BV/字数/弹幕数…）：不写进笔记正文，单独存一份，供去重、删除和页面展示
  const notesMetaDir = join(stateDir, 'notes')
  ensureDir(notesMetaDir)
  const noteMetaPath = (title) => join(notesMetaDir, safeFile(title) + '.json')
  function readNoteMeta(title) {
    try { return JSON.parse(readFileSync(noteMetaPath(title), 'utf8')) } catch { return null }
  }
  function findExistingByBvid(bvid) {
    if (!bvid) return null
    for (const [subject, d] of Object.entries(state.subjects)) {
      for (const t of d.videos || []) {
        const meta = readNoteMeta(t)
        if (meta && meta.bvid === bvid) return { subject, title: t }
        try { if (readFileSync(videoMdPath(t), 'utf8').includes(bvid)) return { subject, title: t } } catch { /* 忽略 */ }
      }
    }
    return null
  }

  // ---- 删除笔记后自愈：归档里已删除、且当前不在架的笔记，清掉 seen，允许重新检测 ----
  function noteLiveByTitle(title) {
    const n = normTitle(title)
    if (!n) return false
    for (const d of Object.values(state.subjects)) {
      for (const t of d.videos || []) if (normTitle(t) === n) return true
    }
    return false
  }
  function deletedArchiveEntries() {
    const base = join(config.outputDir, '_archive', 'deleted')
    const out = []
    if (!existsSync(base)) return out
    let stamps = []
    try { stamps = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return out }
    for (const stamp of stamps) {
      let subjects = []
      try { subjects = readdirSync(join(base, stamp.name), { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { continue }
      for (const sub of subjects) {
        let files = []
        try { files = readdirSync(join(base, stamp.name, sub.name), { withFileTypes: true }) } catch { continue }
        for (const f of files) {
          if (!f.isFile() || !/\.md$/i.test(f.name)) continue
          const title = f.name.replace(/\.md$/i, '')
          // 学科手册（<学科>.md / 学习手册.md）不是视频笔记，跳过
          if (!title || title === '学习手册' || title === sub.name) continue
          let bvid = ''
          try { bvid = (readFileSync(join(base, stamp.name, sub.name, f.name), 'utf8').match(/B站\s*(BV[0-9A-Za-z]+)/) || [])[1] || '' } catch { /* 忽略 */ }
          out.push({ key: stamp.name + '/' + sub.name + '/' + f.name, title, bvid })
        }
      }
    }
    return out
  }
  function reconcileDeletedSeen() {
    const items = deletedArchiveEntries()
    if (!items.length) return 0
    let cleared = 0
    let marked = 0
    for (const { key, title, bvid } of items) {
      // 每个归档只对账一次：之后用户「跳过」写入的 seen 不会被再次清掉
      if (state.seenReconciled[key]) continue
      if (!noteLiveByTitle(title) && !(bvid && findExistingByBvid(bvid))) {
        cleared += clearSeenForNoteTitle(title, bvid)
      }
      state.seenReconciled[key] = Date.now()
      marked += 1
    }
    if (marked) {
      backupState('reconcile-seen')
      saveStateNow()
      logLine('reconcile deleted seen cleared=' + cleared + ' marked=' + marked)
    }
    return cleared
  }
  reconcileDeletedSeen()
  if (typeof state.lastDelivery !== 'object' || state.lastDelivery === null) state.lastDelivery = null

  function writeProgressMd() {
    const lines = ['# 视频课程学习进度', '', '> 自动生成 · 最后更新 ' + new Date().toLocaleString('zh-CN', { hour12: false }), '', '| 学科 | 视频 | Word 文档 |', '| --- | --- | --- |']
    for (const [subject, d] of Object.entries(state.subjects)) {
      for (const v of d.videos ?? []) {
        const rel = subject + '/' + safeFile(v) + '.docx'
        lines.push('| ' + subject + ' | ' + v + ' | ' + (existsSync(videoDocxPath(subject, v)) ? rel : '—') + ' |')
      }
    }
    lines.push('')
    try { atomicWrite(join(config.outputDir, '学习进度.md'), lines.join('\n')) } catch (e) { logLine('progress write error msg=' + (e?.message ?? e)) }
  }

  function writeLastDelivery(info) {
    state.lastDelivery = info
    try { atomicWrite(lastDeliveryPath, JSON.stringify(info, null, 2) + '\n') } catch (e) { logLine('delivery state error msg=' + (e?.message ?? e)) }
  }

  // 新会话投递：与 memory-evolve 的 de_session 同款路径（agents.create + 预设挂载 + followup）
  function buildDeliveryPrompt(info) {
    const keywords = (info.keywords ?? []).join('、')
    return [
      '你被「视频课程实时笔记」应用自动唤起：用户正在看 B 站课程《' + info.title + '》，知识总结与 Word 笔记已生成。',
      '学科：' + info.subject + '；关键词：' + keywords,
      'Markdown 笔记：' + info.mdPath,
      'Word 文档：' + (info.docxPath || '（生成失败，见 Markdown）'),
      '',
      '请依次完成：',
      '1）用 read 读取 ' + info.mdPath + '；',
      '2）用 memory 一次调用写两条记忆：target=project（学科、视频、文档绝对路径、3 个核心知识点）与 target=daily（本视频学习进展 1 行）；',
      '3）在对话里用 5~8 句中文总结核心知识点，以及弹幕/评论里观众关注的重点，并说明文档保存位置；',
      '4）用 present 把 ' + (info.docxPath || info.mdPath) + ' 附到对话，description 写「' + info.subject + ' · ' + info.title + '」。',
      '',
      '不要重新抓取、不要重新生成文档；present 失败就把文档绝对路径告诉用户。',
    ].join('\n')
  }

  async function spawnDeliverySession(info) {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') throw new Error('agents 服务不可用')
    const sessionId = 'session-' + randomUUID()
    let presetSetup = null
    try {
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
        const resolved = await presets.resolve()
        const presetId = String(resolved?.id ?? '').trim()
        if (presetId) {
          presetSetup = { id: presetId, setup: async (agentCtx) => { await presets.mount(agentCtx, presetId) } }
        }
      }
    } catch (e) { logLine('preset resolve error msg=' + (e?.message ?? e)) }
    const cwd = config.sessionCwd || config.outputDir
    let agentOptions = {}
    let seed
    try {
      const model = resolveModel(ctx, config)
      if (model && typeof model.provider === 'string' && typeof model.model === 'string') {
        agentOptions = { provider: model.provider, model: model.model }
        // DSH 新会话没有历史 request/header 时，首回合可能拿不到 {{model}}；
        // 与 memory-evolve de_session 同款：用 seed 写入首条 request/header。
        seed = [{
          type: 'request/header',
          seq: 0,
          time: Date.now(),
          data: { header: { config: { provider: model.provider, model: model.model } }, reason: 'initial' },
        }]
      }
    } catch { /* 忽略，DSH 会用默认模型 */ }
    const handle = await agents.create({
      sessionId,
      agentOptions,
      meta: {
        ...(cwd ? { cwd } : {}),
        ...(presetSetup ? { agentPreset: presetSetup.id } : {}),
      },
      ...(presetSetup ? { setup: presetSetup.setup } : {}),
      ...(seed ? { seed } : {}),
    })
    const promptText = buildDeliveryPrompt(info)
    const sendFollowup = () => handle.agent.followup({ role: 'user', id: randomUUID(), content: [{ type: 'text', text: promptText }] })
    logLine('delivery handle status=' + (handle.agent && handle.agent.status) + ' hasFollowup=' + (handle.agent && typeof handle.agent.followup))
    sendFollowup()
    logLine('delivery followup sent status=' + (handle.agent && handle.agent.status))
    // 兜底：若 1.5s 后 agent 仍是 idle（首条 followup 在预设挂载期间丢失），再唤醒一次
    setTimeout(() => {
      try {
        logLine('delivery status later=' + (handle.agent && handle.agent.status))
        if (handle.agent && handle.agent.status === 'idle') {
          sendFollowup()
          logLine('delivery followup retried')
        }
      } catch { /* 忽略 */ }
    }, 1500)
    try {
      const titleSvc = ctx.get('sessionTitle')
      if (titleSvc && typeof titleSvc.rename === 'function' && handle.agent.session) {
        titleSvc.rename(handle.agent.session, (config.sessionTitlePrefix + ' · ' + info.title).slice(0, 80))
      }
    } catch (e) { logLine('session title error msg=' + (e?.message ?? e)) }
    try {
      const registry = ctx.get('workspaceRegistry')
      if (registry && cwd && typeof registry.resolveByPath === 'function') {
        let ws = await registry.resolveByPath(cwd)
        if (!ws && typeof registry.create === 'function') ws = await registry.create(cwd)
        if (ws && typeof ws.attachSession === 'function') await ws.attachSession(sessionId)
      }
    } catch (e) { logLine('workspace attach error msg=' + (e?.message ?? e)) }
    return sessionId
  }

  function createSubjectManual(subject) {
    const header = `# ${subject} 学习手册\n\n<!-- OVERVIEW_START -->\n## 学科总览\n\`\`\`mermaid\nmindmap\n  root((${mermaidSafe(subject)}))\n\`\`\`\n<!-- OVERVIEW_END -->\n`
    atomicWrite(manualMdPath(subject), header)
  }

  function buildOverviewBlock(subject) {
    const videos = state.subjects[subject]?.videos ?? []
    const lines = ['```mermaid', 'mindmap', `  root((${mermaidSafe(subject)}))`]
    for (const v of videos) lines.push(`    ${mermaidSafe(v)}`)
    lines.push('```')
    return `<!-- OVERVIEW_START -->\n## 学科总览\n${lines.join('\n')}\n<!-- OVERVIEW_END -->`
  }

  function regenerateOverview(subject) {
    const p = manualMdPath(subject)
    let text = readFileSync(p, 'utf8')
    const start = text.indexOf('<!-- OVERVIEW_START -->')
    const end = text.indexOf('<!-- OVERVIEW_END -->')
    if (start === -1 || end === -1) return
    text = text.slice(0, start) + buildOverviewBlock(subject) + text.slice(end + '<!-- OVERVIEW_END -->'.length)
    atomicWrite(p, text)
  }

  function appendVideo(subject, title, md) {
    const p = manualMdPath(subject)
    const text = readFileSync(p, 'utf8').replace(/\s+$/, '') + `\n\n---\n\n${md}\n`
    atomicWrite(p, text)
  }

  // 以「单视频 Markdown」为唯一事实源重建学科手册，保证只含当前 state 里的 B 站视频，且重复生成不会追加重复章节
  function rebuildSubjectManual(subject) {
    const d = state.subjects[subject]
    if (!d) return false
    const videos = Array.isArray(d.videos) ? d.videos : []
    const header = `# ${subject} 学习手册\n\n${buildOverviewBlock(subject)}\n`
    const sections = []
    for (const v of videos) {
      let md = ''
      try { md = readFileSync(videoMdPath(v), 'utf8') } catch { md = '' }
      if (!md) continue
      // 单视频笔记现在就是「# 标题 + 核心知识点」，元数据已挪到 .state/notes/*.json
      const title = ((md.match(/^#\s+(.+)$/m) || [])[1] || v).trim()
      const body = md.replace(/^#\s+.+(?:\r?\n)?/m, '').trim()
      if (body) sections.push('---\n\n## ' + title + '\n\n' + body)
    }
    if (!sections.length) return false
    atomicWrite(manualMdPath(subject), header + '\n' + sections.join('\n\n') + '\n')
    try { convertToDocx(manualMdPath(subject), manualDocxPath(subject)) } catch (e) { logLine('manual docx error subject=' + JSON.stringify(subject) + ' msg=' + (e?.message ?? e)) }
    return true
  }

  // 用捆绑 Python + python-docx 把 Markdown 转成 Word（.docx）
  function convertToDocx(mdPath, docxPath) {
    ensureDir(dirname(docxPath))
    const r = spawnSync(pythonPath, [MD2DOCX_PATH, mdPath, docxPath], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`md2docx 转换失败（${pythonPath}）：${String(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
    }
  }

  function convertSubject(subject) {
    convertToDocx(manualMdPath(subject), manualDocxPath(subject))
  }

  function regenerateIndex() {
    const subjects = Object.keys(state.subjects)
    const lines = ['# 视频课程知识地图', '', `> 自动生成 · 最后更新 ${new Date().toLocaleString('zh-CN', { hour12: false })}`, '', '## 学科总览', '```mermaid', 'mindmap', '  root((课程知识地图))']
    for (const s of subjects) lines.push(`    ${mermaidSafe(s)}`)
    lines.push('```', '', '## 学科列表')
    if (subjects.length === 0) lines.push('（暂无，开始观看视频课程后会自动生成）')
    for (const s of subjects) {
      const n = state.subjects[s]?.videos?.length ?? 0
      lines.push(`- ${s} — ${n} 个视频 → 「${s}/学习手册.docx」`)
    }
    lines.push('')
    const mdPath = indexMdPath()
    atomicWrite(mdPath, lines.join('\n'))
    try { convertToDocx(mdPath, join(config.outputDir, '课程总览.docx')) } catch (e) { logLine('index docx error msg=' + (e?.message ?? e)) }
  }

  // 启动时：迁移旧版 .md 源（<subject>/学习手册.md → .state/manuals/），并为已有学科重新生成 Word
  function migrateLegacyMd(subject) {
    const newPath = manualMdPath(subject)
    if (existsSync(newPath)) return
    const oldPath = join(subjectDir(subject), '学习手册.md')
    if (existsSync(oldPath)) {
      ensureDir(dirname(newPath))
      renameSync(oldPath, newPath)
    }
  }
  try {
    if (!config.skipStartupDocx) {
      for (const subject of Object.keys(state.subjects)) {
        migrateLegacyMd(subject)
        rebuildSubjectManual(subject)
      }
      if (Object.keys(state.subjects).length > 0) { regenerateIndex(); writeProgressMd() }
    }
  } catch (error) {
    logLine(`startup docx error msg=${error?.message ?? error}`)
    console.error('[dsh-video-coursemap] 启动时生成 Word 失败：', error)
  }

  function markSeen(title, bvid, clean) {
    const keys = [titleKey(title), title, ...(clean ? [titleKey(clean), clean] : []), ...(bvid ? [bvidKey(bvid)] : [])].filter(Boolean)
    const now = Date.now()
    for (const k of keys) state.seen[k] = now
  }
  // 清掉某个视频的全部去重记录：同时覆盖 title:*、原始标题（可能带空格/标点差异）和 BV 号
  function clearSeenForNoteTitle(title, bvid) {
    const n = normTitle(title)
    if (!n) return 0
    // 窗口标题可能比笔记标题短（截断）或长（多一段副标题），按前缀差异也算同一视频
    const variant = (a) => {
      if (!a) return false
      if (a === n) return true
      const short = a.length <= n.length ? a : n
      const long = a.length <= n.length ? n : a
      return short.length >= 8 && long.startsWith(short)
    }
    let cleared = 0
    for (const key of Object.keys(state.seen)) {
      let hit = false
      if (bvid && key === bvidKey(bvid)) hit = true
      else if (key.startsWith('title:')) hit = variant(normTitle(key.slice(6)))
      else if (!key.startsWith('bvid:')) hit = variant(normTitle(key))
      if (hit) { delete state.seen[key]; cleared += 1 }
    }
    return cleared
  }
  function isIgnoredTitle(title) {
    if (!state.ignored) return false
    return Boolean(state.ignored[titleKey(title)] || state.ignored[String(title)])
  }
  function isIgnoredBvid(bvid) {
    return Boolean(bvid && state.ignored && state.ignored[bvidKey(bvid)])
  }
  function addIgnored(entry) {
    if (!state.ignored) state.ignored = {}
    const now = Date.now()
    for (const k of [bvidKey(entry.bvid), titleKey(entry.rawTitle), titleKey(entry.title), entry.rawTitle, entry.title].filter(Boolean)) {
      state.ignored[k] = { title: entry.title || entry.rawTitle, at: now }
    }
    const keys = Object.keys(state.ignored)
    if (keys.length > 300) {
      const sorted = keys.sort((a, b) => (state.ignored[a]?.at ?? 0) - (state.ignored[b]?.at ?? 0))
      for (const k of sorted.slice(0, keys.length - 300)) delete state.ignored[k]
    }
  }
  function pendingMatchesTitle(title) {
    const k = titleKey(title)
    return (state.pending || []).find((p) => titleKey(p.rawTitle) === k || titleKey(p.title) === k || p.rawTitle === title)
  }
  function removePendingByTitle(title) {
    const k = titleKey(title)
    const before = state.pending.length
    state.pending = state.pending.filter((p) => !(titleKey(p.rawTitle) === k || titleKey(p.title) === k || p.rawTitle === title))
    syncPendingPrep()
    return before !== state.pending.length
  }
  function emitContent(content, fallbackTitle) {
    emit({
      type: 'content',
      title: content?.title || fallbackTitle,
      bvid: content?.bvid ?? '',
      danmaku: content?.danmaku?.length ?? 0,
      comments: content?.comments?.length ?? 0,
      tags: content?.tags?.length ?? 0,
      transcript: content?.transcript?.length ?? 0,
      subtitleSource: content?.subtitleSource || '无字幕',
      subtitleCoverage: content?.subtitleCoverage || 0,
      duration: content?.duration || 0,
      needLogin: Boolean(content?.needLogin),
      aiQueued: Boolean(content?.aiQueued),
      subtitleNote: content?.subtitleNote || '',
    })
  }

  async function analyzeTitle(title, { silent = false } = {}) {
    if (!silent) emit({ type: 'process_start', title })
    const existing = Object.keys(state.subjects)
    const cls = await classify(ctx, config, title, existing)
    logLine('classify title=' + JSON.stringify(title) + ' result=' + JSON.stringify(cls))
    if (!silent) emit({
      type: 'classify',
      title,
      isCourse: cls ? cls.isCourse !== false : false,
      subject: cls?.subject ?? '',
      keywords: Array.isArray(cls?.keywords) ? cls.keywords : [],
    })
    if (!cls || cls.isCourse === false) {
      markSeen(title)
      state.lastTitle = title
      pruneSeen()
      saveStateNow()
      emit({ type: 'skip', title, reason: 'non-course' })
      return { ok: true, isCourse: false, skipped: true, title, message: '已忽略非课程内容：' + title }
    }
    const keywords = (Array.isArray(cls.keywords) ? cls.keywords : []).map(String).filter(Boolean)
    let content = null
    if (config.fetchContent) {
      try {
        content = await fetchBiliContent(title)
        if (content?.tags?.length) {
          for (const t of content.tags) if (t && !keywords.includes(t) && keywords.length < 10) keywords.push(t)
        }
        logLine('bili content title=' + JSON.stringify(title) + ' bvid=' + (content?.bvid ?? 'none') + ' danmaku=' + (content?.danmaku?.length ?? 0) + ' comments=' + (content?.comments?.length ?? 0) + ' transcript=' + (content?.transcript?.length || 0) + ' source=' + (content?.subtitleSource || '') + ' login=' + (content?.loginState || ''))
        if (!silent) emitContent(content, title)
      } catch (e) {
        logLine('bili fetch error title=' + JSON.stringify(title) + ' msg=' + (e?.message ?? e))
      }
    }
    const existingVideo = content?.bvid ? findExistingByBvid(content.bvid) : null
    const clean = existingVideo?.title || title
    const hint = canonicalSubject(clean, existing)
    const subject = sanitizeSubject(existingVideo?.subject || hint || cls.subject)
    return { ok: true, isCourse: true, rawTitle: title, clean, subject, keywords, content, existingVideo, score: materialScore(content) }
  }

  async function commitTitle(prep, { force = false, emitStart = false, ignoreForce = false } = {}) {
    const title = prep.rawTitle
    const clean = prep.clean
    const subject = prep.subject
    const keywords = prep.keywords
    const content = prep.content
    if (emitStart) {
      emit({ type: 'process_start', title })
      emit({ type: 'classify', title, isCourse: true, subject, keywords })
      if (content) emitContent(content, title)
    }
    emit({ type: 'summary_start', title: clean, subject, keywords })
    if (config.requireBilibiliMatch && !content?.bvid) {
      markSeen(title, null, clean)
      state.lastTitle = title
      pruneSeen()
      saveStateNow()
      emit({ type: 'skip', title: clean, reason: 'no-bilibili' })
      logLine('skip no-bilibili title=' + JSON.stringify(clean))
      return { ok: false, isCourse: false, title, message: '未匹配到 B 站视频，已跳过：' + clean }
    }
    if (!force && config.skipInsufficientMaterial && prep.score < config.minMaterialScore) {
      markSeen(title, content?.bvid, clean)
      state.lastTitle = title
      pruneSeen()
      saveStateNow()
      emit({ type: 'skip', title: clean, reason: 'insufficient-content', score: prep.score })
      logLine('skip insufficient-content title=' + JSON.stringify(clean) + ' score=' + prep.score)
      return { ok: false, isCourse: false, title, message: 'B 站可获取素材不足（简介/字幕/弹幕/评论），已跳过：' + clean }
    }
    if (!force && !ignoreForce && content?.bvid && isIgnoredBvid(content.bvid)) {
      markSeen(title, content.bvid, clean)
      state.lastTitle = title
      pruneSeen()
      saveStateNow()
      emit({ type: 'skip', title: clean, reason: 'ignored' })
      return { ok: false, isCourse: false, title, message: '该视频已加入忽略名单：' + clean }
    }
    const md = await generate(ctx, config, { title: clean, subject, keywords, content })
    const isNew = !state.subjects[subject]
    if (isNew) {
      state.subjects[subject] = { createdAt: Date.now(), videos: [] }
      createSubjectManual(subject)
    }

    // 笔记标题：用模型根据内容概括的短标题（≤20 字），视频原标题只作为来源信息
    const note = splitNoteTitle(md, clean)
    const noteTitle = note.title
    const noteBody = note.body

    // 字幕时间线：只给网站看（按逻辑段落 + 时间戳），不进笔记
    const timeline = buildTimeline(Array.isArray(content?.cues) ? content.cues : [])
    if (timeline.length) {
      const titles = await labelTimelineSegments(ctx, config, clean, timeline)
      timeline.forEach((seg, i) => { seg.title = titles[i] || fallbackSegmentTitle(seg.text) })
    }
    const timelinePath = join(stateDir, 'timelines', safeFile(clean) + '.json')
    try {
      if (timeline.length) {
        atomicWrite(timelinePath, JSON.stringify({
          title: clean, noteTitle, bvid: content?.bvid || '', duration: content?.duration || 0,
          generatedAt: Date.now(), segments: timeline,
        }, null, 2))
      }
    } catch (e) { logLine('timeline write error title=' + JSON.stringify(clean) + ' msg=' + (e?.message ?? e)) }

    // 单视频 Markdown + Word：只有标题 + 核心知识点，元数据放 .state/notes/<视频>.json
    const mdPath = videoMdPath(clean)
    const subtitleLabel = content?.subtitleSource || (content?.transcript ? '字幕' : '无字幕')
    const mdText = ['# ' + noteTitle, '', noteBody, ''].join('\n')
    const noteMeta = {
      title: clean,
      noteTitle,
      subject,
      keywords,
      bvid: content?.bvid || '',
      duration: content?.duration || 0,
      descChars: content?.desc?.length || 0,
      danmaku: content?.danmaku?.length || 0,
      comments: content?.comments?.length || 0,
      tags: content?.tags?.length || 0,
      transcript: content?.transcript?.length || 0,
      subtitleSource: subtitleLabel,
      subtitleCoverage: content?.subtitleCoverage || 0,
      subtitleNote: content?.subtitleNote || '',
      generatedAt: Date.now(),
    }
    try { atomicWrite(noteMetaPath(clean), JSON.stringify(noteMeta, null, 2)) } catch (e) { logLine('note meta write error msg=' + (e?.message ?? e)) }
    try { atomicWrite(mdPath, mdText) } catch (e) { logLine('video md write error msg=' + (e?.message ?? e)) }
    // 同步一份 Markdown 到学科目录，方便直接取用/导入其它工具
    const exportMdPath = videoExportMdPath(subject, clean)
    try { atomicWrite(exportMdPath, mdText) } catch (e) { logLine('export md write error msg=' + (e?.message ?? e)) }
    const docxPath = videoDocxPath(subject, clean)
    let docxOk = false
    try { convertToDocx(mdPath, docxPath); docxOk = true } catch (e) { logLine('video docx error title=' + JSON.stringify(clean) + ' msg=' + (e?.message ?? e)) }

    if (!state.subjects[subject].videos.includes(clean)) state.subjects[subject].videos.push(clean)
    rebuildSubjectManual(subject)
    regenerateIndex()
    writeProgressMd()

    const info = {
      title: clean,
      noteTitle,
      subject,
      keywords,
      mdPath,
      docxPath: docxOk ? docxPath : null,
      docxOk,
      bvid: content?.bvid ?? null,
      danmaku: content?.danmaku?.length ?? 0,
      comments: content?.comments?.length ?? 0,
      tags: content?.tags?.length ?? 0,
      transcript: content?.transcript?.length ?? 0,
      subtitleSource: subtitleLabel,
      subtitleCoverage: content?.subtitleCoverage ?? 0,
      duration: content?.duration ?? 0,
      timelineSegments: timeline.length,
      at: Date.now(),
      sessionId: null,
      generator: config.generatorLabel,
    }
    writeLastDelivery(info)
    emit({
      type: 'summary_done',
      title: clean,
      noteTitle,
      subject,
      keywords,
      bvid: info.bvid,
      danmaku: info.danmaku,
      comments: info.comments,
      tags: info.tags,
      transcript: info.transcript,
      subtitleSource: info.subtitleSource,
      subtitleCoverage: info.subtitleCoverage,
      duration: info.duration,
      timelineSegments: info.timelineSegments,
      docxPath: info.docxPath,
      mdPath: info.mdPath,
      docxOk: info.docxOk,
      generator: info.generator,
    })
    if (config.deliverSession) {
      try {
        info.sessionId = await spawnDeliverySession(info)
        logLine('delivery spawned session=' + info.sessionId + ' title=' + JSON.stringify(clean))
      } catch (e) {
        logLine('delivery session error title=' + JSON.stringify(clean) + ' msg=' + (e?.message ?? e))
      }
      writeLastDelivery(info)
    }

    markSeen(title, content?.bvid, clean)
    state.lastTitle = title
    state.lastRunAt = Date.now()
    pruneSeen()
    saveStateNow()
    console.log('[dsh-video-coursemap] ' + (isNew ? '新学科' : '更新学科') + '「' + subject + '」 ← ' + clean)
    return {
      ok: true,
      isCourse: true,
      subject,
      title: clean,
      bvid: info.bvid,
      docxPath: info.docxPath,
      sessionId: info.sessionId,
      message: '已生成「' + subject + ' · ' + clean + '」知识笔记' + (info.sessionId ? '，已新建会话投递' : '') + '。输出目录：' + config.outputDir,
    }
  }

  function pendingMeta(rawTitle, prep) {
    const content = prep.content
    const score = materialScore(content)
    return {
      id: randomUUID().slice(0, 8),
      rawTitle,
      title: prep.clean,
      subject: prep.subject,
      keywords: (prep.keywords || []).slice(0, 8),
      bvid: content?.bvid || '',
      biliTitle: content?.title || '',
      descChars: content?.desc?.length || 0,
      transcriptChars: content?.transcript?.length || 0,
      subtitleSource: content?.subtitleSource || '无字幕',
      subtitleCoverage: content?.subtitleCoverage || 0,
      duration: content?.duration || 0,
      needLogin: Boolean(content?.needLogin),
      aiQueued: Boolean(content?.aiQueued),
      danmaku: content?.danmaku?.length || 0,
      comments: content?.comments?.length || 0,
      tags: content?.tags?.length || 0,
      score,
      insufficient: Boolean(config.skipInsufficientMaterial && score < config.minMaterialScore),
      at: Date.now(),
    }
  }
  function upsertPending(rawTitle, prep) {
    const existing = (state.pending || []).find((p) => (prep.content?.bvid && p.bvid === prep.content.bvid) || titleKey(p.rawTitle) === titleKey(rawTitle) || titleKey(p.title) === titleKey(prep.clean))
    const meta = pendingMeta(rawTitle, prep)
    if (existing) {
      meta.id = existing.id
      meta.at = existing.at || meta.at
      Object.assign(existing, meta)
      pendingPrep.set(existing.id, prep)
      return existing
    }
    state.pending.unshift(meta)
    if (state.pending.length > 12) state.pending.length = 12
    pendingPrep.set(meta.id, prep)
    return meta
  }
  async function resolvePending(idOrTitle, decision) {
    let waited = 0
    while (running && waited < 90000) { await sleep(1000); waited += 1000 }
    if (running) return { ok: false, message: '已有处理任务进行中，请稍后再试' }
    syncFromDisk()
    const key = String(idOrTitle || '').trim()
    if (!key) return { ok: false, message: '请提供待确认视频的 id 或标题' }
    const idx = state.pending.findIndex((p) => String(p.id) === key || p.rawTitle === key || p.title === key || titleKey(p.rawTitle) === titleKey(key) || titleKey(p.title) === titleKey(key))
    if (idx < 0) return { ok: false, message: '没有找到待确认的视频：' + key }
    const entry = state.pending[idx]
    if (decision === 'refresh') {
      emit({ type: 'confirm_prepare', title: entry.rawTitle })
      const prep = await analyzeTitle(entry.rawTitle, { silent: true })
      if (prep.skipped) {
        state.pending.splice(idx, 1)
        pendingPrep.delete(entry.id)
        saveStateNow()
        emit({ type: 'confirm_resolved', id: entry.id, status: 'skipped', title: entry.title })
        return { ok: true, status: 'skipped', title: entry.title, message: '已跳过：' + entry.title }
      }
      const meta = pendingMeta(entry.rawTitle, prep)
      meta.id = entry.id
      meta.at = entry.at
      Object.assign(entry, meta)
      pendingPrep.set(entry.id, prep)
      saveStateNow()
      emit({ type: 'confirm_update', ...meta })
      return { ok: true, status: 'refreshed', id: entry.id, title: entry.title, subject: entry.subject, ...meta, message: '已重新检测：' + entry.title + '；字幕 ' + meta.transcriptChars + ' 字（' + meta.subtitleSource + '）' }
    }
    state.pending.splice(idx, 1)
    const cached = pendingPrep.get(entry.id)
    pendingPrep.delete(entry.id)
    saveStateNow()
    if (decision === 'generate') {
      emit({ type: 'confirm_resolved', id: entry.id, status: 'generating', title: entry.title })
      let result
      if (cached) {
        running = true
        try { result = await commitTitle(cached, { force: true, emitStart: true }) } catch (e) {
          logLine('confirm generate error title=' + JSON.stringify(entry.title) + ' msg=' + (e?.message ?? e))
          emit({ type: 'error', title: entry.title, message: String(e?.message ?? e) })
          return { ok: false, message: '生成失败：' + (e?.message ?? e) }
        } finally {
          running = false
        }
      } else {
        result = await processTitle(entry.rawTitle, { skipConfirm: true, force: true })
      }
      return { ...result, status: 'generated' }
    }
    if (decision === 'skip' || decision === 'ignore') {
      markSeen(entry.rawTitle, entry.bvid, entry.title)
      if (decision === 'ignore') addIgnored(entry)
      state.lastTitle = entry.rawTitle
      saveStateNow()
      emit({ type: 'confirm_resolved', id: entry.id, status: 'skipped', title: entry.title, decision })
      emit({ type: 'skip', title: entry.title, reason: decision === 'ignore' ? 'ignored' : 'user-skipped' })
      return { ok: true, status: 'skipped', title: entry.title, message: (decision === 'ignore' ? '已忽略并加入忽略名单：' : '已跳过：') + entry.title }
    }
    return { ok: false, message: 'decision 必须是 generate/skip/ignore/refresh' }
  }

  function stageAndRemove(files, destDir) {
    const staged = []
    ensureDir(destDir)
    try {
      for (const src of files) {
        if (!existsSync(src)) continue
        const name = String(src).split(/[\\/]/).pop()
        let dest = join(destDir, name)
        if (existsSync(dest)) dest = join(destDir, Date.now() + '-' + name)
        copyFileSync(src, dest)
        staged.push({ src, dest })
      }
    } catch (e) {
      throw new Error('复制到归档失败：' + (e?.message ?? e))
    }
    const removed = []
    try {
      for (const s of staged) {
        unlinkSync(s.src)
        removed.push(s)
      }
    } catch (e) {
      for (const s of removed) {
        try { copyFileSync(s.dest, s.src) } catch { /* 尽力恢复 */ }
      }
      throw new Error('文件被占用，请关闭 Word 后重试：' + (e?.message ?? e))
    }
    return staged.map((s) => s.dest)
  }
  function purgeFile(src) {
    if (!existsSync(src)) return
    try { unlinkSync(src) } catch (e) { throw new Error('文件被占用，请关闭 Word 后重试：' + src + '（' + (e?.message ?? e) + '）') }
  }
  function findNoteEntry(title, subject) {
    const q = String(title || '').trim()
    if (!q) return null
    const matches = []
    for (const [sub, d] of Object.entries(state.subjects)) {
      for (const t of d.videos || []) {
        if (String(t) === q) matches.push({ subject: sub, title: t, exact: true })
        else if (String(t).includes(q) || q.includes(String(t))) matches.push({ subject: sub, title: t, exact: false })
      }
    }
    if (!matches.length) return null
    const scoped = subject ? matches.filter((m) => m.subject === subject) : matches
    const pool = scoped.length ? scoped : matches
    const exact = pool.filter((m) => m.exact)
    if (exact.length === 1) return exact[0]
    if (pool.length === 1) return pool[0]
    return { ambiguous: true, matches: pool }
  }
  function deleteNote({ title, subject, mode = 'archive' } = {}) {
    if (running) return { ok: false, message: '正在生成笔记，请稍后再删除' }
    if (otherWatcherActive()) return { ok: false, message: '另一个宿主正在监视，请在 B站课代表 应用里删除' }
    syncFromDisk()
    const found = findNoteEntry(title, subject)
    if (!found) return { ok: false, message: '没有找到这条笔记：' + (title || '') }
    if (found.ambiguous) return { ok: false, message: '匹配到多条笔记，请指定学科：' + found.matches.map((m) => m.subject + ' / ' + m.title).join('；') }
    const sub = found.subject
    const noteTitle = found.title
    backupState('delete')
    // 删除后要清掉 seen，否则同一视频重播会被当成「已处理」永远不再询问
    let noteBvid = readNoteMeta(noteTitle)?.bvid || ''
    if (!noteBvid) {
      try { noteBvid = (readFileSync(videoMdPath(noteTitle), 'utf8').match(/\b(BV[0-9A-Za-z]{8,})/) || [])[1] || '' } catch { /* 忽略 */ }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const archiveDir = join(config.outputDir, '_archive', 'deleted', stamp, safeFile(sub))
    const archived = []
    try {
      const d = state.subjects[sub]
      const remainingVideos = (d?.videos || []).filter((v) => v !== noteTitle)
      // 学科目录里的 Markdown 是 .state/videos 那份的导出副本，归档一份即可，避免重复
      const exportMd = videoExportMdPath(sub, noteTitle)
      const timelineFile = join(stateDir, 'timelines', safeFile(noteTitle) + '.json')
      const files = [videoMdPath(noteTitle), videoDocxPath(sub, noteTitle), timelineFile, noteMetaPath(noteTitle)]
      if (remainingVideos.length === 0) files.push(manualDocxPath(sub), manualMdPath(sub))
      if (mode === 'purge') {
        for (const f of [...files, exportMd]) purgeFile(f)
      } else {
        archived.push(...stageAndRemove(files, archiveDir))
        try { if (existsSync(exportMd)) unlinkSync(exportMd) } catch { /* 导出副本删不掉不影响删除 */ }
      }
      if (d) d.videos = remainingVideos
      if (d && remainingVideos.length === 0) delete state.subjects[sub]
      if (remainingVideos.length === 0) {
        try {
          const dir = subjectDir(sub)
          if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir)
        } catch { /* 目录非空或无法删除，忽略 */ }
      }
      state.pending = (state.pending || []).filter((p) => titleKey(p.rawTitle) !== titleKey(noteTitle) && titleKey(p.title) !== titleKey(noteTitle))
      syncPendingPrep()
      clearSeenForNoteTitle(noteTitle, noteBvid)
      // 该归档已由本次删除处理过；启动对账不要再清一次，否则用户「跳过」后会被反复询问
      state.seenReconciled[stamp + '/' + safeFile(sub) + '/' + safeFile(noteTitle) + '.md'] = Date.now()
      if (state.lastDelivery && state.lastDelivery.title === noteTitle) {
        state.lastDelivery = null
        try { if (existsSync(lastDeliveryPath)) unlinkSync(lastDeliveryPath) } catch { /* 忽略 */ }
      }
      saveStateNow()
    } catch (e) {
      return { ok: false, message: '删除失败：' + (e?.message ?? e) }
    }
    try {
      if (state.subjects[sub]) rebuildSubjectManual(sub)
      regenerateIndex()
      writeProgressMd()
    } catch (e) {
      logLine('delete rebuild error subject=' + JSON.stringify(sub) + ' msg=' + (e?.message ?? e))
    }
    const remaining = state.subjects[sub]?.videos?.length || 0
    emit({ type: 'note_deleted', title: noteTitle, subject: sub, archivedTo: archived.length ? archiveDir : '', remaining })
    logLine('note deleted title=' + JSON.stringify(noteTitle) + ' subject=' + JSON.stringify(sub) + ' archived=' + archived.length + ' remaining=' + remaining)
    return {
      ok: true,
      title: noteTitle,
      subject: sub,
      archivedTo: archived.length ? archiveDir : '',
      remaining,
      message: '已删除「' + sub + ' · ' + noteTitle + '」' + (archived.length ? '，文件已移入 ' + archiveDir : '') + (remaining ? '' : '；该学科已无视频，已移除'),
    }
  }

  async function probeTitle(rawTitle) {
    let title = rawTitle ? cleanTitle(rawTitle) : ''
    if (!title) {
      const fg = await pollForeground()
      if (!fg) return { ok: false, message: '无法读取前台窗口' }
      title = cleanTitle(fg.title)
      if (!title) return { ok: false, message: '当前前台窗口没有可用标题' }
    }
    let content = null
    try { content = await fetchBiliContent(title) } catch (e) { return { ok: false, title, message: '抓取失败：' + (e?.message ?? e) } }
    if (!content) return { ok: false, title, message: '未匹配到 B 站视频：' + title }
    const coveragePct = content.subtitleCoverage > 0 ? Math.round(content.subtitleCoverage * 100) + '%' : ''
    const message = [
      '标题：' + (content.title || title),
      'B站：' + content.bvid + (content.duration ? '（' + Math.round(content.duration / 60) + ' 分钟）' : ''),
      '字幕：' + (content.transcript ? content.transcript.length + ' 字（' + content.subtitleSource + (coveragePct ? '，覆盖 ' + coveragePct : '') + '）' : '无（' + content.subtitleNote + '）'),
      '登录态：' + (content.loginState === 'ok' ? '已登录' : (content.loginState === 'invalid' ? 'Cookie 失效' : (content.loginState === 'unknown' ? '无法验证' : '未配置 Cookie'))),
      content.aiQueued ? 'B站 AI 字幕/摘要：已加入生成队列，稍后再点“重新检测”' : '',
      content.subtitleNote && content.transcript ? '提示：' + content.subtitleNote : '',
      '弹幕 ' + content.danmaku.length + ' 条 · 评论 ' + content.comments.length + ' 条 · 简介 ' + content.desc.length + ' 字',
    ].filter(Boolean).join('\n')
    return {
      ok: true,
      title: content.title || title,
      bvid: content.bvid,
      subtitleSource: content.subtitleSource,
      transcriptChars: content.transcript.length,
      subtitleCoverage: content.subtitleCoverage || 0,
      duration: content.duration || 0,
      needLogin: Boolean(content.needLogin),
      loginState: content.loginState,
      aiQueued: Boolean(content.aiQueued),
      subtitleNote: content.subtitleNote || '',
      danmaku: content.danmaku.length,
      comments: content.comments.length,
      descChars: content.desc.length,
      message,
    }
  }

  async function processTitle(title, opts = {}) {
    if (running) return { ok: false, message: '已有处理任务进行中' }
    running = true
    runningTitle = title
    try {
      syncFromDisk()
      if (!opts.force && !opts.skipConfirm && isIgnoredTitle(title)) {
        markSeen(title)
        state.lastTitle = title
        saveStateNow()
        emit({ type: 'skip', title, reason: 'ignored' })
        return { ok: false, isCourse: false, title, message: '该视频已加入忽略名单：' + title }
      }
      if (opts.skipConfirm) removePendingByTitle(title)
      if (!opts.skipConfirm) {
        const existingPending = pendingMatchesTitle(title)
        if (existingPending) {
          emit({ type: 'confirm_request', ...existingPending })
          return { ok: true, pending: true, title: existingPending.title, subject: existingPending.subject, bvid: existingPending.bvid, message: '该视频已在待确认列表：' + existingPending.title }
        }
      }
      const confirmMode = Boolean(config.confirmBeforeGenerate) && !opts.skipConfirm
      if (confirmMode) emit({ type: 'confirm_prepare', title })
      const prep = await analyzeTitle(title, { silent: confirmMode })
      if (prep.skipped) return prep
      if (!opts.force && !opts.skipConfirm && prep.content?.bvid && isIgnoredBvid(prep.content.bvid)) {
        markSeen(title, prep.content.bvid, prep.clean)
        state.lastTitle = title
        pruneSeen()
        saveStateNow()
        emit({ type: 'skip', title: prep.clean, reason: 'ignored' })
        return { ok: false, isCourse: false, title, message: '该视频已加入忽略名单：' + prep.clean }
      }
      if (confirmMode) {
        if (config.requireBilibiliMatch && !prep.content?.bvid) {
          markSeen(title, null, prep.clean)
          state.lastTitle = title
          pruneSeen()
          saveStateNow()
          emit({ type: 'skip', title: prep.clean, reason: 'no-bilibili' })
          return { ok: false, isCourse: false, title, message: '未匹配到 B 站视频，已跳过：' + prep.clean }
        }
        const meta = upsertPending(title, prep)
        saveStateNow()
        emit({ type: 'confirm_request', ...meta })
        logLine('confirm pending title=' + JSON.stringify(meta.title) + ' bvid=' + (meta.bvid || 'none') + ' subtitle=' + meta.subtitleSource + ' ' + meta.transcriptChars)
        return { ok: true, pending: true, title: meta.title, subject: meta.subject, bvid: meta.bvid, message: '检测到 B 站视频，等待确认：' + meta.title }
      }
      return await commitTitle(prep, { force: Boolean(opts.force), ignoreForce: Boolean(opts.skipConfirm) })
    } catch (error) {
      logLine('error title=' + JSON.stringify(title) + ' msg=' + (error?.message ?? error))
      console.error('[dsh-video-coursemap] 处理失败（不影响后续轮询）：', error)
      emit({ type: 'error', title, message: String(error?.message ?? error) })
      return { ok: false, message: '处理失败：' + (error?.message ?? error) }
    } finally {
      running = false
      runningTitle = ''
    }
  }
  function pruneSeen() {
    const keys = Object.keys(state.seen)
    if (keys.length <= 500) return
    const sorted = keys.sort((a, b) => (state.seen[a] ?? 0) - (state.seen[b] ?? 0))
    for (const k of sorted.slice(0, keys.length - 500)) delete state.seen[k]
  }

  async function observeOnce() {
    if (!config.enabled) return
    if (shouldYield()) {
      emit({ type: 'poll', verdict: 'yield' })
      return
    }
    syncFromDisk()
    const fg = await pollForeground()
    if (!fg) {
      emit({ type: 'poll', verdict: 'no-window' })
      return
    }
    logObservation(fg.proc, fg.title)
    const title = cleanTitle(fg.title)
    let verdict = 'candidate'
    if (isAppTitle(fg.title) || isAppTitle(title)) verdict = 'self'
    else if (!isBrowserProc(fg.proc)) verdict = 'not-browser'
    else if (config.onlyBilibili && !isBiliTitle(fg.title, fg.proc)) verdict = 'not-bilibili'
    else if (title.length < config.titleMinLen) verdict = 'short'
    else if (isBiliHubPage(title)) verdict = 'hub'
    else if (isIgnoredTitle(title)) verdict = 'ignored'
    else if (pendingMatchesTitle(title)) verdict = 'pending'
    else if (Object.hasOwn(state.seen, titleKey(title)) || Object.hasOwn(state.seen, title)) verdict = 'seen'
    emit({ type: 'poll', proc: fg.proc, raw: fg.title, title, verdict, pending: debounce?.count ?? 0 })
    if (verdict === 'candidate' || verdict === 'seen' || verdict === 'pending') {
      // 记住最近一次真实检测到的 B 站视频：用户点「立即提取」时前台通常已经切到本应用页面，
      // 这时用这个标题兜底，不用干等下一轮轮询。
      const prev = state.lastCandidate
      if (!prev || prev.title !== title) {
        state.lastCandidate = { title, rawTitle: fg.title, proc: fg.proc, at: Date.now() }
        try { saveStateNow() } catch { /* 忽略 */ }
      }
    }
    if (verdict !== 'candidate') {
      // 本应用页面/悬浮窗获得焦点时不打断「连续 N 次稳定」计数
      if (verdict !== 'self') debounce = null
      return
    }
    logLine('browser proc=' + fg.proc + ' cleaned=' + JSON.stringify(title))
    if (!debounce || debounce.title !== title) debounce = { title, count: 1 }
    else debounce.count += 1
    if (debounce.count >= config.stablePolls) {
      const t = debounce.title
      debounce = null
      await processTitle(t)
    }
  }

  // 状态查看工具
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_status',
    description: '查看「视频课程知识地图 Agent」的运行状态：是否启用、输出目录、已分类学科与视频数、最近观察到的标题与最近一次投递。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, enabled: { type: 'boolean' },
          outputDir: { type: 'string' }, lastTitle: { type: 'string' },
          lastRunAt: { type: 'integer' },
          pending: { type: 'integer' }, ignored: { type: 'integer' },
          biliCookieSet: { type: 'boolean' },
          subjects: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { subject: { type: 'string' }, videos: { type: 'integer' } }, required: ['subject', 'videos'] } },
          lastDelivery: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, subject: { type: 'string' }, docxPath: { type: 'string' }, sessionId: { type: 'string' }, at: { type: 'integer' } }, required: ['title', 'subject'] },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute() {
      const subjects = Object.entries(state.subjects).map(([subject, d]) => ({ subject, videos: d.videos?.length ?? 0 }))
      const ld = state.lastDelivery
      const message = [
        '视频课程知识地图 Agent 状态：',
        '- 启用：' + config.enabled,
        '- 输出目录：' + config.outputDir,
        '- 学科数：' + subjects.length,
        ...subjects.map((s) => '  · ' + s.subject + '（' + s.videos + ' 个视频）'),
        '- 最近观察：' + (state.lastTitle || '（无）'),
        '- 待确认：' + (state.pending?.length || 0) + ' 条' + (state.pending?.length ? '（course_map_pending 查看，course_map_confirm 处理）' : ''),
        '- 忽略名单：' + Object.keys(state.ignored || {}).length + ' 条',
        '- B站登录：' + (getBiliCookie().cookie ? '已配置' : '未配置（AI 字幕可能为空）'),
        '- 最近投递：' + (ld?.title ? (ld.subject ? ld.subject + ' · ' : '') + ld.title + (ld.sessionId ? '（会话 ' + ld.sessionId + '）' : '（未建会话）') : '（无）'),
      ].join('\n')
      return {
        ok: true,
        enabled: config.enabled,
        outputDir: config.outputDir,
        lastTitle: state.lastTitle,
        lastRunAt: state.lastRunAt,
        pending: state.pending?.length || 0,
        ignored: Object.keys(state.ignored || {}).length,
        biliCookieSet: Boolean(getBiliCookie().cookie),
        subjects,
        ...(ld?.title ? { lastDelivery: { title: ld.title, subject: ld.subject ?? '', docxPath: ld.docxPath ?? '', sessionId: ld.sessionId ?? '', at: ld.at ?? 0 } } : {}),
        message,
      }
    },
  }), 'dsh-video-coursemap: status tool')

  // 手动扫描工具
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_scan',
    description: '立即执行一次前台窗口观察与知识地图生成（绕过轮询间隔，便于测试或手动触发）；可传 title 直接指定要处理的视频标题。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：直接指定要处理的视频标题（跳过前台窗口读取，便于测试/手动输入）' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, message: { type: 'string' },
          isCourse: { type: 'boolean' }, subject: { type: 'string' },
          title: { type: 'string' }, bvid: { type: 'string' },
          docxPath: { type: 'string' }, sessionId: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      if (!config.enabled) return { ok: false, message: 'Agent 未启用（config.enabled=false）' }
      let title = null
      let fallbackNote = ''
      if (args && typeof args.title === 'string' && args.title.trim()) {
        title = cleanTitle(args.title)
      } else {
        // 点「立即提取」时前台往往已经是本应用页面/别的软件，这里允许回退到最近一次
        // 真实检测到的 B 站视频，不必等下一轮轮询（默认 15~30 秒）重新识别。
        const fg = await pollForeground()
        const cleaned = fg ? cleanTitle(fg.title) : ''
        const usable = Boolean(fg) && isBrowserProc(fg.proc) &&
          (!config.onlyBilibili || isBiliTitle(fg.title, fg.proc)) &&
          cleaned.length >= config.titleMinLen &&
          !isBiliHubPage(cleaned) &&
          !isAppTitle(cleaned) && !isAppTitle(fg.title)
        if (usable) {
          title = cleaned
        } else {
          // 前台不是视频时：先找任意 B 站窗口，再退到「最近检测到的视频」
          const win = await findBiliWindow()
          if (win) {
            title = win.title
            fallbackNote = '（前台不是 B 站视频，已从浏览器窗口提取「' + title + '」）'
            logLine('scan fallback to window title=' + JSON.stringify(title) + ' proc=' + win.proc)
          } else {
            const c = state.lastCandidate
            const fresh = c && c.title && Date.now() - Number(c.at || 0) <= 45 * 60 * 1000
            if (fresh) {
              title = c.title
              fallbackNote = '（前台不是可识别的 B 站视频，已使用最近检测到的「' + title + '」）'
              logLine('scan fallback to lastCandidate title=' + JSON.stringify(title) + ' fg=' + JSON.stringify(fg?.title || ''))
            }
          }
        }
        if (!title) {
          const why = !fg ? '无法读取前台窗口' : (!isBrowserProc(fg.proc) ? '前台窗口不是浏览器/视频客户端（进程 ' + (fg.proc || '未知') + '）' : '当前前台不是 B 站视频')
          return { ok: false, message: why + '，也没有最近 45 分钟内检测到的 B 站视频；请切到视频页面再点「立即提取」' }
        }
      }
      if (running && runningTitle && titleKey(runningTitle) === titleKey(title)) {
        return { ok: true, title, message: '正在处理「' + title + '」，请稍候（不用重复点「立即提取」）' }
      }
      let waited = 0
      while (running && waited < 90000) { await sleep(1000); waited += 1000 }
      if (running) return { ok: false, message: '已有处理任务在进行中，请稍后再试' }
      const result = await processTitle(title, { skipConfirm: true })
      return {
        ok: result.ok,
        message: (result.message || '') + (fallbackNote && result.ok ? '\n' + fallbackNote : ''),
        ...(result.isCourse !== undefined ? { isCourse: result.isCourse } : {}),
        ...(result.subject ? { subject: result.subject } : {}),
        ...(result.title ? { title: result.title } : {}),
        ...(result.bvid ? { bvid: result.bvid } : {}),
        ...(result.docxPath ? { docxPath: result.docxPath } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      }
    },
  }), 'dsh-video-coursemap: scan tool')

  // 手动投递：任何会话都能取回最近笔记并 present
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_deliver',
    description: '取回最近一次（或按标题匹配）课程笔记：返回学科、Markdown 全文与 Word 路径，供当前会话总结并用 present 附上 Word。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：按视频标题关键字匹配已生成的笔记' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { ok: { type: 'boolean' }, subject: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' }, docxPath: { type: 'string' }, message: { type: 'string' } },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      const q = String(args?.title ?? '').trim()
      let info = state.lastDelivery || null
      if (q) {
        let hit = null
        let hitSubject = ''
        for (const [subject, d] of Object.entries(state.subjects)) {
          for (const v of d.videos ?? []) {
            if (String(v).includes(q) || q.includes(String(v))) { hit = v; hitSubject = subject; break }
          }
          if (hit) break
        }
        if (!hit) return { ok: false, message: '没有匹配「' + q + '」的视频笔记' }
        const same = state.lastDelivery && state.lastDelivery.title === hit ? state.lastDelivery : null
        info = same || { title: hit, subject: hitSubject, mdPath: videoMdPath(hit), docxPath: videoDocxPath(hitSubject, hit), at: 0 }
      }
      if (!info || !info.title) return { ok: false, message: '还没有生成过课程笔记' }
      let markdown = ''
      try { markdown = readFileSync(info.mdPath, 'utf8') } catch { /* 忽略 */ }
      const docxPath = info.docxPath && existsSync(info.docxPath) ? info.docxPath : ''
      return {
        ok: true,
        subject: info.subject ?? '',
        title: info.title,
        markdown: markdown.slice(0, 12000),
        docxPath,
        message: '最近笔记：' + (info.subject ? '「' + info.subject + '」' : '') + info.title + '\nWord：' + (docxPath || '（无，未生成成功）') + '\nMarkdown：' + info.mdPath,
      }
    },
  }), 'dsh-video-coursemap: deliver tool')

  // 待确认队列：列出检测到但尚未生成的 B 站视频
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_pending',
    description: '列出「检测到 B 站视频但尚未生成笔记」的待确认列表；用 course_map_confirm 生成/跳过/忽略。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, count: { type: 'integer' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string' }, title: { type: 'string' }, rawTitle: { type: 'string' },
                subject: { type: 'string' }, bvid: { type: 'string' }, transcriptChars: { type: 'integer' },
                subtitleSource: { type: 'string' }, needLogin: { type: 'boolean' }, aiQueued: { type: 'boolean' },
                danmaku: { type: 'integer' }, comments: { type: 'integer' }, score: { type: 'number' },
                insufficient: { type: 'boolean' }, at: { type: 'integer' },
              },
              required: ['id', 'title'],
            },
          },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute() {
      syncFromDisk()
      const items = (state.pending || []).map((p) => ({
        id: String(p.id || ''),
        title: String(p.title || p.rawTitle || ''),
        rawTitle: String(p.rawTitle || ''),
        subject: String(p.subject || ''),
        bvid: String(p.bvid || ''),
        transcriptChars: Number(p.transcriptChars) || 0,
        subtitleSource: String(p.subtitleSource || '无字幕'),
        needLogin: Boolean(p.needLogin),
        aiQueued: Boolean(p.aiQueued),
        danmaku: Number(p.danmaku) || 0,
        comments: Number(p.comments) || 0,
        score: Number(p.score) || 0,
        insufficient: Boolean(p.insufficient),
        at: Number(p.at) || 0,
      }))
      const message = items.length
        ? ['待确认视频（' + items.length + ' 条）：', ...items.map((p, i) => (i + 1) + '. ' + p.title + '｜' + (p.subject || '未分类') + '｜' + (p.bvid || '无BV') + '｜字幕 ' + p.transcriptChars + ' 字（' + p.subtitleSource + '）' + (p.insufficient ? '｜素材偏少' : '') + (p.needLogin ? '｜未登录B站' : '') + '｜id=' + p.id)].join('\n')
        : '当前没有待确认视频。检测到新的 B 站视频后会先进入这里。'
      return { ok: true, count: items.length, items, message }
    },
  }), 'dsh-video-coursemap: pending tool')

  // 确认/跳过/忽略/重新检测
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_confirm',
    description: '处理待确认的 B 站视频：decision=generate 生成笔记，skip 跳过本次，ignore 跳过并加入忽略名单，refresh 重新抓取字幕/素材。可用 id 或标题定位。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '待确认条目的 id（course_map_pending 返回）' },
        title: { type: 'string', description: '或按视频标题匹配' },
        decision: { type: 'string', enum: ['generate', 'skip', 'ignore', 'refresh'], description: 'generate=生成，skip=跳过，ignore=跳过且不再询问，refresh=重新检测字幕' },
      },
      required: ['decision'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, status: { type: 'string' }, title: { type: 'string' },
          subject: { type: 'string' }, bvid: { type: 'string' }, docxPath: { type: 'string' },
          sessionId: { type: 'string' }, message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      if (otherWatcherActive()) return { ok: false, message: 'B站课代表应用正在监视，请在应用页面的“待确认的视频”里操作。' }
      if (!['generate', 'skip', 'ignore', 'refresh'].includes(args?.decision)) return { ok: false, message: 'decision 必须是 generate/skip/ignore/refresh' }
      const key = String(args?.id || args?.title || '').trim()
      if (!key) return { ok: false, message: '请提供待确认条目的 id 或标题' }
      const r = await resolvePending(key, args.decision)
      return {
        ok: Boolean(r.ok), status: r.status || '', title: r.title || '', subject: r.subject || '',
        bvid: r.bvid || '', docxPath: r.docxPath || '', sessionId: r.sessionId || '',
        message: r.message || (r.ok ? '已处理' : '处理失败'),
      }
    },
  }), 'dsh-video-coursemap: confirm tool')

  // 删除笔记（默认移入 _archive/deleted，可找回）
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_delete',
    description: '删除一条课程笔记：从学科/历史中移除，默认把 Markdown/Word 移入 _archive/deleted，可找回；mode=purge 时直接删除文件。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '笔记标题（可部分匹配）' },
        subject: { type: 'string', description: '可选：学科名，重名时用于精确定位' },
        mode: { type: 'string', enum: ['archive', 'purge'], description: 'archive=移入归档（默认），purge=直接删除' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, title: { type: 'string' }, subject: { type: 'string' },
          archivedTo: { type: 'string' }, remaining: { type: 'integer' }, message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      const r = deleteNote({ title: String(args?.title || '').trim(), subject: args?.subject ? String(args.subject) : undefined, mode: args?.mode === 'purge' ? 'purge' : 'archive' })
      return {
        ok: Boolean(r.ok), title: r.title || '', subject: r.subject || '', archivedTo: r.archivedTo || '',
        remaining: Number(r.remaining) || 0, message: r.message || (r.ok ? '已删除' : '删除失败'),
      }
    },
  }), 'dsh-video-coursemap: delete tool')

  // 只读检测：BV / 字幕 / 登录态，不生成笔记
  ctx.effect(() => ctx.tools.register({
    name: 'course_map_probe',
    description: '检测一个视频标题对应的 B 站视频与字幕（含 AI 字幕）可用性：返回 BV、字幕来源/字数、登录态、AI 是否入队，不生成笔记。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '可选：视频标题；留空则读取当前前台窗口' },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, title: { type: 'string' }, bvid: { type: 'string' },
          subtitleSource: { type: 'string' }, transcriptChars: { type: 'integer' },
          subtitleCoverage: { type: 'number' }, duration: { type: 'integer' },
          needLogin: { type: 'boolean' }, loginState: { type: 'string' }, aiQueued: { type: 'boolean' },
          subtitleNote: { type: 'string' }, danmaku: { type: 'integer' }, comments: { type: 'integer' },
          descChars: { type: 'integer' }, message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: (_a, v) => [{ type: 'text', text: v.message ?? '' }],
    },
    async execute(args) {
      const r = await probeTitle(String(args?.title || '').trim())
      return {
        ok: Boolean(r.ok), title: r.title || '', bvid: r.bvid || '', subtitleSource: r.subtitleSource || '',
        transcriptChars: Number(r.transcriptChars) || 0, subtitleCoverage: Number(r.subtitleCoverage) || 0,
        duration: Number(r.duration) || 0,
        needLogin: Boolean(r.needLogin), loginState: r.loginState || '',
        aiQueued: Boolean(r.aiQueued), subtitleNote: r.subtitleNote || '', danmaku: Number(r.danmaku) || 0,
        comments: Number(r.comments) || 0, descChars: Number(r.descChars) || 0, message: r.message || (r.ok ? '检测完成' : '检测失败'),
      }
    },
  }), 'dsh-video-coursemap: probe tool')

  // 轮询定时器（同时维护 watcher.lock：DSH 与独立应用互斥）
  ctx.effect(() => {
    writeLock()
    const hb = setInterval(() => { writeLock() }, 5000)
    const id = setInterval(() => { observeOnce().catch((e) => console.error('[dsh-video-coursemap] 观察异常：', e)) }, config.pollIntervalMs)
    return () => { clearInterval(id); clearInterval(hb); removeLock() }
  }, 'dsh-video-coursemap: poll timer')

  console.log(`[dsh-video-coursemap] 已启动：每 ${config.pollIntervalMs}ms 轮询前台窗口，输出目录 ${config.outputDir}`)
  emit({ type: 'ready', outputDir: config.outputDir, role: config.watcherRole, intervalMs: config.pollIntervalMs })
}

// 内部测试出口（不参与 DSH 工具面）
export const __courseMapTest = {
  cleanTitle, isAppTitle, isBiliTitle, isBiliHubPage, titleKey, bvidKey, titleSimilar,
  searchBili, fetchBiliContent, materialScore, splitTranscript, subtitleSpan, generate, isOfflineFallbackText, splitNoteTitle,
  buildTimeline, subtitleCues, fmtClock,
  normalizeBiliCookie, buildWbiQuery, rankSubtitleTracks, subtitleIsAi, flattenSubtitleBody,
}
