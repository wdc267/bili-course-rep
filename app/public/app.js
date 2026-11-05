(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }
  var state = {
    data: null,
    online: false,
    everOnline: false,
    healthFailed: false,
    events: [],
    filter: 'all',
    subjectFilter: '',
    autoScroll: true,
    summaryText: '',
    title: '',
    noteTitle: '',
    subject: '',
    keywords: [],
    meta: null,
    docx: false,
    generator: '',
    phase: 0,
    progressText: '',
    lastPollAt: 0,
    lastVerdict: '',
    lastPollProc: '',
    lastPollTitle: '',
    lastPollRaw: '',
    identifying: null,
    timeline: null,
    timelineFor: '',
    intervalMs: 15000,
    history: [],
    pending: [],
    renderQueued: false,
    sse: null,
    clearKey: false,
    clearBiliCookie: false,
    pipWin: null,
    pipBuilt: false,
    pipBaseSig: '',
    pipPendSig: '',
    pipSumText: '',
  }

  function pad(n) { return n < 10 ? '0' + n : String(n) }
  function fmtTime(at) {
    var d = new Date(at || Date.now())
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  }
  function fmtDate(ms) {
    if (!ms) return ''
    var d = new Date(ms)
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    })
  }
  function toast(msg, kind) {
    var el = $('toast')
    el.textContent = msg
    el.className = 'toast show ' + (kind || '')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { el.className = 'toast' }, 3600)
  }
  function api(path, options) {
    var opts = options || {}
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {})
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status))
        return j
      })
    })
  }

  // ---- SSE ----
  function connectSSE() {
    if (state.sse) state.sse.close()
    var es = new EventSource('/api/events')
    state.sse = es
    es.onopen = function () { state.online = true; state.everOnline = true; renderStatus(); renderOffline() }
    es.onerror = function () { state.online = false; renderStatus(); renderOffline() }
    es.onmessage = function (ev) {
      var d
      try { d = JSON.parse(ev.data) } catch (e) { return }
      onEvent(d)
    }
  }

  function onEvent(d) {
    try { handleEvent(d) } finally { scheduleFloat() }
  }

  function handleEvent(d) {
    if (!d || !d.type) return
    if (d.type === 'hello') {
      if (d.state) { applyState(d.state, true); renderAll() }
      return
    }
    if (d.type === 'poll') {
      state.lastPollAt = d.at || Date.now()
      state.lastVerdict = d.verdict || ''
      state.lastPollProc = d.proc || ''
      state.lastPollTitle = d.title || d.raw || ''
      state.lastPollRaw = d.raw || ''
      addEvent(d)
      updateNow(d)
      return
    }
    if (d.type === 'process_start') {
      state.title = d.title || state.title
      state.noteTitle = ''
      state.timeline = null
      state.timelineFor = ''
      renderTimeline()
      state.subject = ''
      state.keywords = []
      state.meta = null
      state.summaryText = ''
      state.docx = false
      state.generator = ''
      state.phase = 1
      showSummary()
      renderSummary()
      return
    }
    if (d.type === 'classify') {
      state.subject = d.subject || state.subject
      state.keywords = d.keywords || []
      if (d.isCourse === false) state.phase = 0
      renderSummary()
      return
    }
    if (d.type === 'content') { state.meta = d; renderSummary(); return }
    if (d.type === 'summary_start') {
      state.phase = 2
      state.summaryText = ''
      state.progressText = ''
      showSummary()
      renderSummary()
      return
    }
    if (d.type === 'summary_progress') {
      state.progressText = d.message || (d.index && d.total ? ('正在整理字幕 ' + d.index + '/' + d.total) : '正在整理字幕…')
      state.phase = 2
      // 分段整理阶段还没有最终总结，清掉上一条笔记，避免把旧内容当成新进度显示
      state.summaryText = ''
      showSummary()
      renderSummary()
      return
    }
    if (d.type === 'summary_delta') {
      state.summaryText += d.text || ''
      state.phase = 3
      scheduleMarkdown()
      return
    }
    if (d.type === 'summary_done') {
      state.phase = 4
      state.progressText = ''
      state.title = d.title || state.title
      state.noteTitle = d.noteTitle || ''
      state.subject = d.subject || state.subject
      state.keywords = d.keywords || state.keywords
      state.docx = !!d.docxOk
      state.generator = d.generator || ''
      state.meta = { bvid: d.bvid || '', danmaku: d.danmaku || 0, comments: d.comments || 0, tags: d.tags || 0, transcript: d.transcript || 0, subtitleSource: d.subtitleSource || '', subtitleCoverage: d.subtitleCoverage || 0 }
      showSummary()
      renderSummary()
      loadTimeline(state.title, true)
      refreshQuiet()
      loadHistory()
      return
    }
    if (d.type === 'confirm_prepare') {
      state.identifying = { title: d.title || '', at: d.at || Date.now() }
      renderPending()
      renderStatus()
      toast('正在识别视频，稍后进入待确认…')
      return
    }
    if (d.type === 'confirm_request' || d.type === 'confirm_update') {
      state.identifying = null
      upsertPending(d)
      renderPending()
      renderStatus()
      if (d.type === 'confirm_request') {
        toast('检测到 B 站视频，等待确认：' + (d.title || d.rawTitle || ''), 'warn')
        var sec = $('pendingSection')
        if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
      return
    }
    if (d.type === 'confirm_resolved') {
      state.identifying = null
      removePending(d.id)
      renderPending()
      renderStatus()
      if (d.status === 'skipped') toast('已跳过：' + (d.title || ''), 'warn')
      if (d.status === 'generating') toast('开始生成：' + (d.title || ''), 'ok')
      return
    }
    if (d.type === 'note_deleted') {
      removePendingByTitle(d.title)
      renderPending()
      if (state.title && d.title && state.title === d.title) clearSummary()
      toast('已删除笔记：' + (d.title || ''), 'ok')
      loadHistory()
      refreshQuiet()
      return
    }
    if (d.type === 'skip') {
      state.phase = 0
      state.identifying = null
      renderPending()
      renderStatus()
      var reason = d.reason === 'no-bilibili' ? '未匹配到 B 站视频'
        : (d.reason === 'insufficient-content' ? 'B 站可获取素材不足'
        : (d.reason === 'non-course' ? '非课程内容'
        : (d.reason === 'ignored' ? '已在忽略名单'
        : (d.reason === 'user-skipped' ? '已手动跳过' : (d.reason || '未识别')))))
      toast('已跳过：' + reason, 'warn')
      return
    }
    if (d.type === 'error') {
      state.phase = 5
      state.progressText = ''
      state.identifying = null
      renderPending()
      renderStatus()
      toast('处理失败：' + (d.message || '未知错误'), 'err')
      renderSummary()
      return
    }
    if (d.type === 'ready' || d.type === 'engine' || d.type === 'settings' || d.type === 'provider' || d.type === 'bili-auth') {
      refreshQuiet()
      return
    }
    if (d.type === 'busy-timeout') { refreshQuiet(); return }
  }

  function addEvent(d) {
    if (d.type === 'poll') {
      var last = state.events.length ? state.events[state.events.length - 1] : null
      if (last && last.type === 'poll' && last.verdict === d.verdict && last.proc === d.proc &&
          (last.title || last.raw || '') === (d.title || d.raw || '')) {
        last.at = d.at || Date.now()
        last.count = d.count || ((last.count || 1) + 1)
        renderLog()
        return
      }
      d.count = d.count || 1
    }
    state.events.push(d)
    if (state.events.length > 200) state.events.shift()
    renderLog()
  }

  // ---- data ----
  function applyState(s, replaceEvents) {
    if (!s) return
    state.data = s
    state.intervalMs = s.intervalMs || state.intervalMs
    if (replaceEvents && Array.isArray(s.recentEvents)) {
      state.events = s.recentEvents.slice(-200)
      var lastPoll = null
      for (var i = state.events.length - 1; i >= 0; i--) {
        if (state.events[i].type === 'poll') { lastPoll = state.events[i]; break }
      }
      if (lastPoll) { state.lastPollAt = lastPoll.at || state.lastPollAt; updateNow(lastPoll) }
    }
    if (!state.summaryText && s.currentSummary && !(s.busy && s.progress)) state.summaryText = s.currentSummary
    if (s.lastDelivery && !state.title) {
      var ld = s.lastDelivery
      state.title = ld.title || ''
      state.noteTitle = ld.noteTitle || ''
      state.subject = ld.subject || ''
      state.docx = !!ld.docxPath || !!ld.docxOk
      state.generator = ld.generator || ''
      state.phase = 4
    }
    if (s.lastDelivery && (!state.meta || !state.meta.bvid)) {
      var lm = s.lastDelivery
      state.meta = { bvid: lm.bvid || '', danmaku: lm.danmaku || 0, comments: lm.comments || 0, tags: lm.tags || 0, transcript: lm.transcript || 0, subtitleSource: lm.subtitleSource || '', subtitleCoverage: lm.subtitleCoverage || 0 }
    }
    if (s.lastDelivery && s.lastDelivery.title) loadTimeline(s.lastDelivery.title, false)
    state.pending = Array.isArray(s.pending) ? s.pending : []
    if (s.lastPoll && (!state.lastPollAt || Number(s.lastPoll.at) > state.lastPollAt)) {
      state.lastPollAt = Number(s.lastPoll.at) || state.lastPollAt
      state.lastVerdict = s.lastPoll.verdict || state.lastVerdict
      state.lastPollProc = s.lastPoll.proc || state.lastPollProc
      state.lastPollTitle = s.lastPoll.title || s.lastPoll.raw || state.lastPollTitle
      state.lastPollRaw = s.lastPoll.raw || state.lastPollRaw
      updateNow(s.lastPoll)
    }
    renderStatus()
    renderProvider()
    renderPending()
    renderShelf()
    renderStats()
    updateControls()
    renderOffline()
    if (state.summaryText) { showSummary(); renderSummary() }
    scheduleFloat()
  }

  function refresh() {
    return api('/api/state').then(function (s) {
      applyState(s, false)
      renderAll()
      return s
    })
  }
  function refreshQuiet() {
    return api('/api/state').then(function (s) { applyState(s, false) }).catch(function () {})
  }
  function loadHistory() {
    return api('/api/history').then(function (r) {
      state.history = r.items || []
      renderHistory()
    }).catch(function () {})
  }

  function updateControls() {
    var s = state.data
    if (!s) return
    $('toggleWatch').checked = !!s.enabled
    var qi = $('quickInterval')
    var sec = Math.round((s.intervalMs || 15000) / 1000)
    var found = false
    for (var i = 0; i < qi.options.length; i++) {
      if (Number(qi.options[i].value) === sec * 1000) { qi.selectedIndex = i; found = true; break }
    }
    if (!found) qi.value = String(s.intervalMs)
    renderPollMeta()
    $('setIntervalText').textContent = sec + ' 秒'
  }

  function renderPollMeta() {
    var s = state.data
    if (!s) return
    var sec = Math.round((s.intervalMs || 15000) / 1000)
    var last = state.lastPollAt || (s.lastPoll && s.lastPoll.at) || 0
    var age = last ? Math.max(0, Math.round((Date.now() - last) / 1000)) : 0
    $('pollMeta').textContent = '每 ' + sec + ' 秒 · 已轮询 ' + (s.stats ? s.stats.polls : 0) + ' 次' + (last ? ' · 最近 ' + age + ' 秒前' : '')
  }

  // ---- status / badges ----
  function renderStatus() {
    var pill = $('statusPill')
    pill.className = 'pill status'
    if (!state.online) { pill.classList.add('offline'); pill.textContent = '连接断开'; return }
    var s = state.data
    if (!s) { pill.textContent = '连接中…'; return }
    if (state.identifying) {
      pill.classList.add('live'); pill.textContent = '识别中'
    } else if (!s.enabled || s.paused) {
      pill.classList.add('paused'); pill.textContent = '已暂停'
    } else {
      pill.classList.add('live'); pill.textContent = s.busy ? '总结中' : '监视中'
    }
    var lock = $('lockBadge')
    if (s.lock && !s.lock.mine && !s.lock.stale) {
      lock.textContent = 'DSH 正在监视'
      lock.className = 'pill tiny warn'
    } else if (s.lock && s.lock.stale) {
      lock.textContent = '锁已过期'
      lock.className = 'pill tiny warn'
    } else {
      lock.className = 'pill tiny hidden'
    }
  }

  function renderOffline() {
    var banner = $('offlineBanner')
    if (!banner) return
    var s = state.data || {}
    var last = state.lastPollAt || (s.lastPoll && s.lastPoll.at) || 0
    var age = last ? Date.now() - last : 0
    var stale = Boolean(state.online && s.enabled && !s.paused && last && age > Math.max(45000, (s.intervalMs || 15000) * 3))
    var text = $('offlineText')
    var disconnected = !state.online && (state.everOnline || state.healthFailed)
    if (disconnected) {
      banner.classList.remove('hidden', 'amber')
      banner.classList.add('red')
      if (text) text.textContent = '与本地服务断开：请双击桌面快捷方式「B站课代表」重新启动；本页会自动重连。'
      return
    }
    if (stale) {
      banner.classList.remove('hidden', 'red')
      banner.classList.add('amber')
      if (text) text.textContent = '轮询已停滞 ' + Math.round(age / 1000) + ' 秒：请检查监视开关或点「立即提取」；若服务已退出，请双击桌面快捷方式重启。'
      return
    }
    banner.classList.add('hidden')
  }

  function checkHealth() {
    fetch('/api/health', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      state.healthFailed = false
      if (!state.online) {
        state.online = true
        state.everOnline = true
        connectSSE()
        refresh().catch(function () {})
      }
      renderOffline()
    }).catch(function () {
      state.online = false
      state.healthFailed = true
      renderStatus()
      renderOffline()
    })
  }

  function renderProvider() {
    var s = state.data
    var badge = $('providerBadge')
    var gen = $('generatorBadge')
    if (!s || !s.provider) { badge.textContent = '…'; return }
    var p = s.provider
    var map = { ollama: 'Ollama', deepseek: 'DeepSeek', extractive: '离线抽取' }
    badge.textContent = (map[p.active] || p.active) + (p.model ? ' · ' + p.model : '')
    badge.className = 'pill tiny ' + (p.active === 'extractive' ? 'warn' : 'ok')
    if (state.generator) { gen.textContent = state.generator; gen.className = 'pill tiny' }
    else if (s.lastDelivery && s.lastDelivery.generator) { gen.textContent = s.lastDelivery.generator; gen.className = 'pill tiny' }
    else gen.className = 'pill tiny hidden'
    var hint = $('providerHint')
    if (hint) hint.textContent = p.warning || ''
  }

  // ---- poll log ----
  var VERDICT = {
    candidate: { text: 'B站视频', cls: 'bili' },
    seen: { text: '已处理', cls: 'seen' },
    pending: { text: '待确认', cls: 'warn' },
    ignored: { text: '已忽略', cls: 'seen' },
    'not-bilibili': { text: '非B站', cls: 'skip' },
    'not-browser': { text: '非浏览器', cls: 'skip' },
    hub: { text: 'B站页面', cls: 'skip' },
    short: { text: '短标题', cls: 'skip' },
    yield: { text: '让出监视', cls: 'warn' },
    self: { text: '本应用', cls: 'skip' },
    'no-window': { text: '无窗口', cls: 'skip' }
  }
  var VERDICT_HINT = {
    candidate: '已识别为 B 站视频，连续 2 次稳定后进入待确认',
    seen: '该视频已生成过笔记；若笔记已删除，重启后会自动重新询问，也可点「立即提取」重新生成',
    pending: '该视频已在待确认列表，请在右侧确认',
    ignored: '该视频在忽略名单中，之后不再询问',
    'not-bilibili': '当前前台不是 B 站视频（标题未带哔哩哔哩后缀）；只读取前台窗口，后台标签页/虚拟机内读不到',
    'not-browser': '当前前台不是浏览器/视频客户端；只读取前台窗口',
    hub: '当前是 B 站首页/搜索页，请打开具体视频',
    short: '标题太短，无法识别',
    yield: '另一个宿主（DSH）正在监视，本应用暂不处理',
    self: '当前前台是本应用页面/悬浮窗，已跳过（不会打断识别计数）',
    'no-window': '读取不到前台窗口（PowerShell 权限或被最小化）'
  }
  function verdictHint(d) {
    if (!d) return ''
    if (d.verdict === 'not-browser' && /vmware|virtualbox|vbox|vmplayer|mstsc|rdp/i.test(d.proc || '')) {
      return '前台是虚拟机/远程桌面窗口，读不到里面的浏览器标题'
    }
    return VERDICT_HINT[d.verdict] || ''
  }
  function logRowHTML(d) {
    var v = VERDICT[d.verdict] || { text: d.verdict || '?', cls: '' }
    var title = d.title || d.raw || ''
    var proc = d.proc ? ' · ' + d.proc : ''
    var cls = d.verdict === 'candidate' ? 'log-title' : 'log-title sub'
    var count = d.count && d.count > 1 ? '<span class="muted small"> ×' + d.count + '</span>' : ''
    return '<div class="log-row">' +
      '<span class="log-time">' + fmtTime(d.at) + '</span>' +
      '<span class="log-badge ' + v.cls + '">' + esc(v.text) + '</span>' +
      '<div class="' + cls + '">' + esc(title) + '<span class="muted small">' + esc(proc) + '</span>' + count + '</div>' +
      '</div>'
  }
  function renderLog() {
    var list = $('logList')
    if (!list) return
    var items = state.events.filter(function (e) { return e.type === 'poll' })
    if (state.filter === 'bili') items = items.filter(function (e) { return e.verdict === 'candidate' || e.verdict === 'seen' })
    if (state.filter === 'skip') items = items.filter(function (e) { return e.verdict !== 'candidate' && e.verdict !== 'seen' })
    items = items.slice(-80)
    if (!items.length) {
      list.innerHTML = '<div class="muted small" style="padding:18px 10px">暂无轮询记录</div>'
      return
    }
    var html = ''
    for (var i = items.length - 1; i >= 0; i--) html += logRowHTML(items[i])
    list.innerHTML = html
    if (state.autoScroll) list.scrollTop = 0
  }
  function updateNow(d) {
    if (!d) return
    var t = d.title || d.raw || '—'
    $('nowTitle').textContent = t
    $('nowProc').textContent = d.proc ? '进程：' + d.proc : ''
    var hint = verdictHint(d)
    var el = $('pollHint')
    if (el) {
      el.textContent = hint
      el.className = 'poll-hint' + (d.verdict === 'candidate' || d.verdict === 'seen' ? '' : ' muted')
    }
    scheduleFloat()
  }
  function renderStats() {
    var s = state.data
    var el = $('stats')
    if (!s) { el.innerHTML = ''; return }
    var st = s.stats || {}
    var mins = Math.max(1, Math.round((Date.now() - (st.startedAt || Date.now())) / 60000))
    el.innerHTML = '<span>轮询 <b>' + (st.polls || 0) + '</b></span>' +
      '<span>笔记 <b>' + (st.notes || 0) + '</b></span>' +
      '<span>错误 <b>' + (st.errors || 0) + '</b></span>' +
      '<span>运行 <b>' + mins + '</b> 分钟</span>'
  }

  // ---- summary ----
  function showSummary() {
    $('summaryEmpty').classList.add('hidden')
    $('summaryContent').classList.remove('hidden')
  }
  function phaseDone(n) { return state.phase > n }
  function renderSummary() {
    var chip = $('subjectChip')
    if (state.subject) { chip.textContent = state.subject; chip.classList.remove('hidden') }
    else chip.classList.add('hidden')
    $('summaryTitle').textContent = state.noteTitle || state.title || '处理中…'
    var meta = []
    if (state.noteTitle && state.title && state.noteTitle !== state.title) meta.push('视频：' + state.title)
    if (state.meta) {
      if (state.meta.bvid) meta.push('B站 ' + state.meta.bvid)
      if (state.meta.danmaku) meta.push('弹幕 ' + state.meta.danmaku + ' 条')
      if (state.meta.comments) meta.push('评论 ' + state.meta.comments + ' 条')
      if (state.meta.tags) meta.push('标签 ' + state.meta.tags + ' 个')
      if (state.meta.transcript) meta.push('字幕 ' + state.meta.transcript + ' 字' + (state.meta.subtitleSource ? '（' + state.meta.subtitleSource + '）' : '') + (state.meta.subtitleCoverage > 0 && state.meta.subtitleCoverage < 0.999 ? '覆盖 ' + Math.round(state.meta.subtitleCoverage * 100) + '%' : ''))
      if (state.meta.needLogin) meta.push('未登录B站')
    }
    if (state.generator) meta.push('来源：' + state.generator)
    $('summaryMeta').textContent = meta.join(' · ')
    var phases = document.querySelectorAll('.phase')
    for (var i = 0; i < phases.length; i++) {
      var n = Number(phases[i].getAttribute('data-phase'))
      phases[i].className = 'phase' + (state.phase === n ? ' active' : (phaseDone(n) ? ' done' : ''))
    }
    renderMarkdownNow()
    $('btnDownload').disabled = !state.docx
    $('btnDownloadMd').disabled = !state.title
    $('btnDeleteNote').disabled = !state.title
    $('summarySub').textContent = state.phase === 3 ? '正在实时生成…' : (state.progressText || (state.phase === 0 ? '等待下一门课程' : '检测到 B 站课程后自动生成'))
  }
  function scheduleMarkdown() {
    if (state.renderQueued) return
    state.renderQueued = true
    setTimeout(function () { state.renderQueued = false; renderMarkdownNow() }, 90)
  }
  function renderMarkdownNow() {
    var el = $('markdown')
    if (!state.summaryText) {
      var hint = state.progressText
        ? esc(state.progressText)
        : (state.phase === 3 ? '正在生成总结…' : '等待内容…')
      el.innerHTML = '<div class="stream-hint">' + hint + '</div>'
      return
    }
    el.innerHTML = mdToHtml(state.summaryText)
    if (state.phase === 3) el.classList.add('stream-cursor')
    else el.classList.remove('stream-cursor')
  }

  function inlineMd(s) {
    var t = esc(s)
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>')
    return t
  }
  function cleanMermaid(t) {
    var s = String(t || '').trim()
    s = s.replace(/^root\s*/, '')
    for (var i = 0; i < 3; i++) {
      if (s.indexOf('((') === 0 && s.lastIndexOf('))') === s.length - 2) s = s.slice(2, -2).trim()
      else if (s.charAt(0) === '(' && s.charAt(s.length - 1) === ')') s = s.slice(1, -1).trim()
      else if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') s = s.slice(1, -1).trim()
      else if (s.charAt(0) === '{' && s.charAt(s.length - 1) === '}') s = s.slice(1, -1).trim()
      else break
    }
    return s.replace(/[()[\]{}|<>'"\x60\\\/]/g, ' ').replace(/\s+/g, ' ').trim()
  }
  function renderMermaid(lines) {
    var nodes = []
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i]
      if (!raw || !raw.trim()) continue
      if (raw.trim().toLowerCase() === 'mindmap') continue
      var indent = raw.length - raw.replace(/^\s+/, '').length
      var label = cleanMermaid(raw.trim())
      if (label) nodes.push({ level: Math.floor(indent / 2), label: label })
    }
    if (!nodes.length) return ''
    var base = nodes[0].level
    var html = '<div class="mindmap">'
    var stack = []
    for (var k = 0; k < nodes.length; k++) {
      var node = nodes[k]
      var lv = Math.max(0, node.level - base)
      if (!stack.length) {
        html += '<ul><li class="mm-root">' + esc(node.label)
        stack = [0]
        continue
      }
      while (lv < stack[stack.length - 1]) { html += '</li></ul>'; stack.pop() }
      if (lv > stack[stack.length - 1]) {
        html += '<ul><li>' + esc(node.label)
        stack.push(lv)
      } else {
        html += '</li><li>' + esc(node.label)
      }
    }
    while (stack.length) { html += '</li></ul>'; stack.pop() }
    html += '</div>'
    return html
  }
  function mdToHtml(text) {
    var lines = String(text || '').split('\n')
    var html = ''
    var inCode = false
    var codeLang = ''
    var code = []
    var list = []
    function flushList() {
      if (!list.length) return
      var depth = 0
      for (var i = 0; i < list.length; i++) {
        var lv = list[i].level
        while (depth < lv) { html += '<ul>'; depth++ }
        while (depth > lv) { html += '</ul>'; depth-- }
        html += '<li>' + inlineMd(list[i].text) + '</li>'
      }
      while (depth > 0) { html += '</ul>'; depth-- }
      list = []
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (line.indexOf('\x60\x60\x60') === 0) {
        if (!inCode) { flushList(); inCode = true; codeLang = line.slice(3).trim().toLowerCase(); code = [] }
        else {
          inCode = false
          if (codeLang === 'mermaid' || code.some(function (x) { return /^\s*mindmap\s*$/i.test(x) })) html += renderMermaid(code)
          else html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>'
        }
        continue
      }
      if (inCode) { code.push(line); continue }
      if (!line.trim()) { flushList(); continue }
      var h = line.match(/^(#{1,4})\s+(.*)$/)
      if (h) {
        flushList()
        var htext = h[2].trim()
        if (state.title && htext === state.title.trim()) continue
        if (state.noteTitle && htext === state.noteTitle.trim()) continue
        var level = h[1].length
        html += '<h' + level + '>' + inlineMd(htext) + '</h' + level + '>'
        continue
      }
      if (line.charAt(0) === '>') { flushList(); html += '<blockquote>' + inlineMd(line.slice(1).trim()) + '</blockquote>'; continue }
      var li = line.match(/^(\s*)-\s+(.*)$/)
      if (li) { list.push({ level: Math.floor(li[1].length / 2), text: li[2] }); continue }
      flushList()
      html += '<p>' + inlineMd(line) + '</p>'
    }
    flushList()
    return html
  }

  // ---- pending / delete ----
  function upsertPending(p) {
    if (!p || !p.id) return
    for (var i = 0; i < state.pending.length; i++) {
      if (String(state.pending[i].id) === String(p.id)) {
        state.pending[i] = Object.assign({}, state.pending[i], p)
        return
      }
    }
    state.pending.unshift(Object.assign({}, p))
  }
  function removePending(id) {
    state.pending = state.pending.filter(function (p) { return String(p.id) !== String(id) })
  }
  function removePendingByTitle(title) {
    if (!title) return
    state.pending = state.pending.filter(function (p) { return p.title !== title && p.rawTitle !== title })
  }
  function renderPending() {
    var sec = $('pendingSection')
    var list = $('pendingList')
    if (!sec || !list) return
    var items = state.pending || []
    var identifying = state.identifying
    sec.classList.toggle('hidden', !items.length && !identifying)
    $('pendingCount').textContent = items.length ? items.length + ' 条' : (identifying ? '识别中' : '')
    if (!items.length && !identifying) {
      list.innerHTML = ''
      document.title = 'B站课代表 · B站课程实时总结'
      return
    }
    document.title = (items.length ? '(' + items.length + ') ' : '') + 'B站课代表 · B站课程实时总结'
    var html = ''
    if (identifying) {
      html += '<div class="pending-row identifying-row">' +
        '<div class="p-head"><span class="chip">识别中</span><b class="p-title">' + esc(identifying.title || '当前前台视频') + '</b></div>' +
        '<div class="pending-meta muted small">正在抓取 B 站视频信息与字幕… <span id="identifyingMeta">已等待 0 秒</span></div>' +
        '<div class="pending-actions"><button class="btn small" disabled>请稍候</button></div>' +
        '</div>'
    }
    for (var i = 0; i < items.length; i++) {
      var p = items[i]
      var meta = []
      if (p.bvid) meta.push('B站 ' + p.bvid)
      meta.push(p.transcriptChars ? ('字幕 ' + p.transcriptChars + ' 字（' + (p.subtitleSource || '字幕') + (p.subtitleCoverage && p.subtitleCoverage < 0.999 ? '，覆盖 ' + Math.round(p.subtitleCoverage * 100) + '%' : '') + '）') : '未获取字幕')
      if (p.danmaku) meta.push('弹幕 ' + p.danmaku + ' 条')
      if (p.comments) meta.push('评论 ' + p.comments + ' 条')
      if (p.score) meta.push('素材分 ' + p.score)
      var warn = ''
      if (p.needLogin) warn = '未登录 B站 或 Cookie 失效：请在设置里填写 SESSDATA 后点“重新检测”'
      else if (p.aiQueued) warn = '已请求 B站生成 AI 字幕/摘要，可稍后点“重新检测”'
      else if (p.subtitleCoverage > 0 && p.subtitleCoverage < 0.85) warn = '字幕只覆盖前 ' + Math.round(p.subtitleCoverage * 100) + '%，笔记会基于已有部分（点“重新检测”再抓一次）'
      else if (p.insufficient) warn = '可获取素材偏少，生成质量可能有限，确认后可继续生成'
      html += '<div class="pending-row" data-pending-id="' + esc(p.id) + '">' +
        '<div class="p-head"><span class="chip">' + esc(p.subject || '未分类') + '</span><b class="p-title">' + esc(p.title || p.rawTitle || '') + '</b></div>' +
        '<div class="pending-meta muted small">' + esc(meta.join(' · ')) + '</div>' +
        (warn ? '<div class="pending-warn">' + esc(warn) + '</div>' : '') +
        '<div class="pending-actions">' +
        '<button class="btn primary small" data-decision="generate">生成笔记</button>' +
        '<button class="btn small" data-decision="refresh">重新检测</button>' +
        '<button class="btn ghost small" data-decision="ignore">跳过（不再询问）</button>' +
        '</div></div>'
    }
    list.innerHTML = html
  }
  function confirmPending(id, decision, btn) {
    if (!id) return
    if (btn) btn.disabled = true
    api('/api/confirm', { method: 'POST', body: JSON.stringify({ id: id, decision: decision }) }).then(function (r) {
      toast(r.message || (r.ok ? '已处理' : '处理失败'), r.ok ? 'ok' : 'warn')
      if (decision === 'generate' || decision === 'skip' || decision === 'ignore') {
        removePending(id)
        renderPending()
      }
      if (decision === 'refresh') {
        upsertPending(r)
        renderPending()
      }
      refreshQuiet()
      loadHistory()
    }).catch(function (e) {
      toast(e.message, 'err')
      if (btn) btn.disabled = false
    })
  }
  function clearSummary() {
    state.title = ''
    state.noteTitle = ''
    state.subject = ''
    state.keywords = []
    state.meta = null
    state.summaryText = ''
    state.docx = false
    state.generator = ''
    state.phase = 0
    state.progressText = ''
    state.timeline = null
    state.timelineFor = ''
    renderTimeline()
    var content = $('summaryContent')
    var empty = $('summaryEmpty')
    if (content) content.classList.add('hidden')
    if (empty) empty.classList.remove('hidden')
    var chip = $('subjectChip')
    if (chip) chip.classList.add('hidden')
    if ($('summaryTitle')) $('summaryTitle').textContent = '—'
    if ($('summaryMeta')) $('summaryMeta').textContent = ''
    if ($('markdown')) $('markdown').innerHTML = ''
    if ($('btnDownload')) $('btnDownload').disabled = true
    if ($('btnDownloadMd')) $('btnDownloadMd').disabled = true
    if ($('btnDeleteNote')) $('btnDeleteNote').disabled = true
  }
  function deleteNote(title, subject) {
    if (!title) return
    if (!window.confirm('删除笔记“' + title + '”？\n文件会移入知识库 _archive/deleted，可在文件夹中找回。')) return
    api('/api/note/delete', { method: 'POST', body: JSON.stringify({ title: title, subject: subject || '' }) }).then(function (r) {
      toast(r.message || '已删除', 'ok')
      if (state.title === title) clearSummary()
      loadHistory()
      refreshQuiet()
    }).catch(function (e) { toast(e.message, 'err') })
  }

  // ---- shelf / history ----
  function renderShelf() {
    var s = state.data
    var el = $('shelfChips')
    var subjects = (s && s.subjects) || []
    $('shelfCount').textContent = subjects.length ? subjects.length + ' 个学科' : ''
    if (!subjects.length) { el.innerHTML = '<span class="muted small">还没有学科，生成第一份笔记后出现</span>'; return }
    var html = ''
    for (var i = 0; i < subjects.length; i++) {
      var sub = subjects[i]
      var active = state.subjectFilter === sub.subject
      html += '<button class="subject-chip" data-subject="' + esc(sub.subject) + '" style="' + (active ? 'border-color:#fb7299;color:#e85d86' : '') + '">' +
        '<b>' + esc(sub.subject) + '</b><span>' + sub.videos + '</span></button>'
    }
    el.innerHTML = html
  }
  function renderHistory() {
    var el = $('historyList')
    var items = state.history
    if (state.subjectFilter) items = items.filter(function (x) { return x.subject === state.subjectFilter })
    $('historyCount').textContent = items.length ? items.length + ' 条' : ''
    if (!items.length) { el.innerHTML = '<div class="muted small">暂无历史笔记</div>'; return }
    var html = ''
    for (var i = 0; i < Math.min(items.length, 40); i++) {
      var it = items[i]
      html += '<div class="history-row" data-title="' + esc(it.title) + '" data-subject="' + esc(it.subject) + '">' +
        '<span class="h-subject">' + esc(it.subject) + '</span>' +
        '<span class="h-title">' + esc(it.title) + '</span>' +
        (it.hasWord ? '<span class="h-word">Word</span>' : '') +
        '<span class="h-time">' + fmtDate(it.mtime) + '</span>' +
        '<button class="h-del" data-del-title="' + esc(it.title) + '" data-del-subject="' + esc(it.subject) + '" title="删除笔记">删除</button>' +
        '</div>'
    }
    el.innerHTML = html
  }
  function loadNote(title) {
    api('/api/note?title=' + encodeURIComponent(title)).then(function (r) {
      state.title = r.title
      state.noteTitle = r.noteTitle || ''
      state.subject = r.subject
      state.summaryText = r.markdown || ''
      state.docx = !!r.hasWord
      state.generator = ''
      state.phase = 4
      state.meta = null
      showSummary()
      renderSummary()
      loadTimeline(r.title)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }).catch(function (e) { toast(e.message, 'err') })
  }

  // ---- 字幕时间线（只在网站显示，不进笔记） ----
  function clockOf(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0))
    var h = Math.floor(s / 3600)
    var m = Math.floor((s % 3600) / 60)
    var r = s % 60
    return (h > 0 ? h + ':' : '') + (m < 10 ? '0' + m : m) + ':' + (r < 10 ? '0' + r : r)
  }
  function loadTimeline(title, force) {
    if (!title) { state.timeline = null; state.timelineFor = ''; renderTimeline(); return }
    if (!force && state.timelineFor === title) { renderTimeline(); return }
    state.timelineFor = title
    api('/api/timeline?title=' + encodeURIComponent(title)).then(function (r) {
      if (state.timelineFor !== title) return
      state.timeline = r
      renderTimeline()
    }).catch(function () {
      if (state.timelineFor !== title) return
      state.timeline = null
      renderTimeline()
    })
  }
  function renderTimeline() {
    var sec = $('timelineSection')
    var list = $('timelineList')
    var meta = $('timelineMeta')
    if (!sec || !list) return
    var tl = state.timeline
    if (!tl || !tl.segments || !tl.segments.length) {
      sec.classList.add('hidden')
      list.innerHTML = ''
      return
    }
    sec.classList.remove('hidden')
    var total = tl.duration || tl.segments[tl.segments.length - 1].end
    if (meta) meta.textContent = tl.segments.length + ' 段 · 全长 ' + clockOf(total) + ' · 点时间跳到 B 站'
    var html = ''
    for (var i = 0; i < tl.segments.length; i++) {
      var s = tl.segments[i]
      var stamp = clockOf(s.start)
      var href = tl.bvid ? 'https://www.bilibili.com/video/' + encodeURIComponent(tl.bvid) + '?t=' + Math.max(0, Math.round(s.start)) : ''
      var time = href
        ? '<a class="tl-time" href="' + esc(href) + '" target="_blank" rel="noreferrer" title="在 B 站从 ' + stamp + ' 开始播放">' + stamp + '</a>'
        : '<span class="tl-time">' + stamp + '</span>'
      html += '<div class="tl-row">' + time +
        '<div class="tl-main">' +
        '<div class="tl-title">' + esc(s.title || ('第 ' + (i + 1) + ' 段')) +
        '<span class="tl-dur">' + clockOf(s.start) + '–' + clockOf(s.end) + '</span></div>' +
        '<details class="tl-text"><summary>查看字幕原文（' + String(s.text || '').length + ' 字）</summary><p>' + esc(s.text || '') + '</p></details>' +
        '</div></div>'
    }
    list.innerHTML = html
  }

  // ---- floating mini window (Document Picture-in-Picture) ----
  function canUseDocumentPiP() {
    return typeof window.documentPictureInPicture !== 'undefined' &&
      typeof window.documentPictureInPicture.requestWindow === 'function'
  }
  function floatOpen() {
    return !!(state.pipWin && !state.pipWin.closed)
  }
  function updateFloatButton() {
    var b = $('btnFloat')
    if (!b) return
    var on = floatOpen()
    b.textContent = on ? '关闭悬浮' : '悬浮窗'
    b.classList.toggle('primary', on)
  }
  function openCompactWindow() {
    var w = window.open('/?compact=1', 'courseNotesCompact', 'popup=1,width=460,height=700,left=' + Math.max(0, (screen.availWidth || 1200) - 480) + ',top=80')
    return Boolean(w)
  }
  function openFloat() {
    if (floatOpen()) { try { state.pipWin.focus() } catch (e) { /* 忽略 */ } return }
    if (!canUseDocumentPiP()) {
      var ok = openCompactWindow()
      toast(ok ? '当前浏览器不支持置顶悬浮，已打开紧凑小窗；Edge/Chrome 116+ 可置顶' : '弹窗被拦截，请允许弹窗后重试', ok ? 'warn' : 'err')
      return
    }
    window.documentPictureInPicture.requestWindow({ width: 400, height: 600 }).then(function (w) {
      try {
        state.pipWin = w
        setupFloatDoc(w)
        updateFloatButton()
        w.addEventListener('pagehide', function () {
          if (state.pipWin !== w) return
          state.pipWin = null
          state.pipBuilt = false
          state.pipBaseSig = ''
          state.pipPendSig = ''
          state.pipSumText = ''
          updateFloatButton()
        })
        renderFloat(true)
      } catch (e) {
        try { w.close() } catch (err) { /* 忽略 */ }
        state.pipWin = null
        state.pipBuilt = false
        updateFloatButton()
        var compact = openCompactWindow()
        toast('悬浮窗初始化失败：' + ((e && e.message) || e) + (compact ? '；已打开紧凑小窗' : ''), 'warn')
      }
    }).catch(function (e) {
      var compact = openCompactWindow()
      toast('无法打开置顶悬浮窗：' + ((e && e.message) || e) + (compact ? '；已打开紧凑小窗' : ''), 'warn')
    })
  }
  function closeFloat() {
    if (floatOpen()) { try { state.pipWin.close() } catch (e) { /* 忽略 */ } }
    state.pipWin = null
    state.pipBuilt = false
    state.pipBaseSig = ''
    state.pipPendSig = ''
    state.pipSumText = ''
    updateFloatButton()
  }
  function toggleFloat() {
    if (floatOpen()) closeFloat()
    else openFloat()
  }
  function setupFloatDoc(w) {
    var d = w.document
    d.documentElement.lang = 'zh-CN'
    d.title = 'B站课代表 · 悬浮'
    var meta = d.createElement('meta')
    meta.setAttribute('charset', 'utf-8')
    d.head.appendChild(meta)
    var link = d.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/style.css'
    d.head.appendChild(link)
    d.body.className = 'pip-body'
    d.body.innerHTML = [
      '<div class="pip-wrap">',
      '  <header class="pip-head">',
      '    <span id="pipStatus" class="pill status">连接中…</span>',
      '    <span id="pipAge" class="muted small"></span>',
      '    <button id="pipClose" class="icon-btn" title="关闭悬浮窗">×</button>',
      '  </header>',
      '  <div class="pip-now">',
      '    <div class="pip-now-label">当前前台窗口</div>',
      '    <div id="pipNowTitle" class="pip-now-title">尚未读取</div>',
      '    <div id="pipNowMeta" class="muted small"></div>',
      '  </div>',
      '  <div id="pipPending" class="pip-pending hidden">',
      '    <div class="pip-pending-head">待确认</div>',
      '    <div id="pipPendingList"></div>',
      '  </div>',
      '  <div id="pipEmpty" class="pip-empty">播放 B 站课程视频；检测到后会在这里询问是否生成笔记。</div>',
      '  <div id="pipSummary" class="pip-summary markdown"></div>',
      '  <footer class="pip-actions">',
      '    <button id="pipToggle" class="btn small">暂停</button>',
      '    <button id="pipMain" class="btn small primary">打开主页面</button>',
      '  </footer>',
      '  <div id="pipToast" class="pip-toast"></div>',
      '</div>'
    ].join('\n')
    d.getElementById('pipClose').addEventListener('click', closeFloat)
    d.getElementById('pipToggle').addEventListener('click', function () {
      var s = state.data || {}
      toggleWatch(!s.enabled)
    })
    d.getElementById('pipMain').addEventListener('click', function () {
      try { window.focus() } catch (e) { /* 忽略 */ }
      try { window.scrollTo({ top: 0, behavior: 'smooth' }) } catch (e) { /* 忽略 */ }
    })
    d.getElementById('pipPendingList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pip-decision]')
      if (!btn) return
      var row = btn.closest('[data-pip-id]')
      if (!row) return
      pipConfirm(row.getAttribute('data-pip-id'), btn.getAttribute('data-pip-decision'), btn)
    })
    state.pipBuilt = true
  }
  function scheduleFloat() {
    if (!floatOpen() || scheduleFloat._t) return
    scheduleFloat._t = setTimeout(function () {
      scheduleFloat._t = null
      renderFloat(false)
    }, 80)
  }
  function pickLastPoll() {
    var s = state.data || {}
    if (state.lastPollAt) {
      return { at: state.lastPollAt, verdict: state.lastVerdict, proc: state.lastPollProc, title: state.lastPollTitle, raw: state.lastPollRaw }
    }
    return s.lastPoll || null
  }
  function renderFloat(force) {
    if (!floatOpen() || !state.pipBuilt) return
    var d = state.pipWin.document
    var s = state.data || {}
    var poll = pickLastPoll()
    var pendingItems = state.pending || []
    var hasPending = pendingItems.length > 0 || Boolean(state.identifying)
    var baseSig = [
      s.enabled, s.paused, s.busy, state.online, state.title, state.subject, Boolean(state.identifying),
      poll ? poll.verdict : '', poll ? (poll.title || poll.raw) : '', poll ? poll.proc : ''
    ].join('|')
    if (force || baseSig !== state.pipBaseSig) {
      state.pipBaseSig = baseSig
      var status = d.getElementById('pipStatus')
      if (status) {
        status.className = 'pill status'
        if (!state.online) { status.classList.add('offline'); status.textContent = '连接断开' }
        else if (state.identifying) { status.classList.add('live'); status.textContent = '识别中' }
        else if (!s.enabled || s.paused) { status.classList.add('paused'); status.textContent = '已暂停' }
        else { status.classList.add('live'); status.textContent = s.busy ? '总结中' : '监视中' }
      }
      var nowTitle = d.getElementById('pipNowTitle')
      if (nowTitle) nowTitle.textContent = (poll && (poll.title || poll.raw)) || '尚未读取'
      var nowMeta = d.getElementById('pipNowMeta')
      if (nowMeta) {
        var parts = []
        if (poll && poll.verdict && VERDICT[poll.verdict]) parts.push(VERDICT[poll.verdict].text)
        if (poll && poll.proc) parts.push(poll.proc)
        var hint = verdictHint(poll)
        if (hint) parts.push(hint)
        nowMeta.textContent = parts.join(' · ')
      }
      var toggle = d.getElementById('pipToggle')
      if (toggle) toggle.textContent = (!s.enabled || s.paused) ? '继续' : '暂停'
    }
    updateFloatAge()

    var pendSig = (state.identifying ? state.identifying.title : '') + '|' +
      pendingItems.map(function (p) { return [p.id, p.subject, p.title, p.bvid, p.transcriptChars].join('~') }).join(',')
    if (force || pendSig !== state.pipPendSig) {
      state.pipPendSig = pendSig
      var pendingBox = d.getElementById('pipPending')
      var pendingList = d.getElementById('pipPendingList')
      if (pendingBox) pendingBox.classList.toggle('hidden', !hasPending)
      if (pendingList) {
        var ph = ''
        if (state.identifying) {
          ph += '<div class="pip-pending-row">' +
            '<div class="pip-pending-title">识别中：' + esc(state.identifying.title || '当前前台视频') + '</div>' +
            '<div class="muted small">正在抓取 B 站信息与字幕…</div>' +
            '</div>'
        }
        for (var i = 0; i < pendingItems.length; i++) {
          var p = pendingItems[i]
          ph += '<div class="pip-pending-row" data-pip-id="' + esc(p.id) + '">' +
            '<div class="pip-pending-title"><span class="chip">' + esc(p.subject || '未分类') + '</span>' + esc(p.title || p.rawTitle || '') + '</div>' +
            '<div class="muted small">' + (p.bvid ? 'B站 ' + esc(p.bvid) : '未匹配 B 站') +
            (p.transcriptChars ? ' · 字幕 ' + p.transcriptChars + ' 字' : '') + '</div>' +
            '<div class="pip-pending-actions">' +
            '<button class="btn primary small" data-pip-decision="generate">生成笔记</button>' +
            '<button class="btn ghost small" data-pip-decision="skip">跳过</button>' +
            '</div></div>'
        }
        pendingList.innerHTML = ph
      }
    }

    var empty = d.getElementById('pipEmpty')
    if (empty) empty.classList.toggle('hidden', Boolean(state.summaryText) || hasPending)

    var sumText = state.summaryText || ''
    if (force || sumText !== state.pipSumText) {
      state.pipSumText = sumText
      var summary = d.getElementById('pipSummary')
      if (summary) {
        var nearBottom = summary.scrollHeight - summary.scrollTop - summary.clientHeight < 40
        if (sumText) {
          summary.innerHTML = mdToHtml(sumText)
          summary.classList.toggle('stream-cursor', state.phase === 3)
          if (nearBottom) summary.scrollTop = summary.scrollHeight
        } else {
          summary.innerHTML = ''
        }
      }
    }
  }
  function updateFloatAge() {
    if (!floatOpen()) return
    var d = state.pipWin.document
    var el = d.getElementById('pipAge')
    if (!el) return
    var poll = pickLastPoll()
    var age = poll && poll.at ? Math.max(0, Math.round((Date.now() - poll.at) / 1000)) : 0
    el.textContent = poll && poll.at ? '最近轮询 ' + age + ' 秒前' : '等待轮询'
  }
  function pipToast(msg, kind) {
    if (!floatOpen()) return
    var d = state.pipWin.document
    var el = d.getElementById('pipToast')
    if (!el) return
    el.textContent = msg
    el.className = 'pip-toast show ' + (kind || '')
    clearTimeout(pipToast._t)
    pipToast._t = setTimeout(function () { el.className = 'pip-toast' }, 3200)
  }
  function pipConfirm(id, decision, btn) {
    if (btn) btn.disabled = true
    api('/api/confirm', { method: 'POST', body: JSON.stringify({ id: id, decision: decision }) }).then(function (r) {
      pipToast(r.message || (r.ok ? '已处理' : '处理失败'), r.ok ? 'ok' : 'warn')
      if (decision === 'generate' || decision === 'skip' || decision === 'ignore') removePending(id)
      renderPending()
      renderStatus()
      refreshQuiet()
      loadHistory()
      renderFloat(true)
    }).catch(function (e) {
      pipToast(e.message, 'err')
      if (btn) btn.disabled = false
    })
  }

  // ---- actions ----
  function scan() {
    var btn = $('btnScan')
    if (btn) { btn.disabled = true; btn.textContent = '提取中…' }
    var restore = function () { if (btn) { btn.disabled = false; btn.textContent = '立即提取' } }
    api('/api/scan', { method: 'POST', body: JSON.stringify({}) }).then(function (r) {
      toast(r.message || (r.ok ? '已触发' : '未处理'), r.ok ? 'ok' : 'warn')
    }).catch(function (e) { toast(e.message, 'err') }).then(restore, restore)
  }
  function toggleWatch(enabled) {
    api('/api/settings', { method: 'POST', body: JSON.stringify({ enabled: enabled }) }).then(function (r) {
      applyState(r.state, false)
      toast(enabled ? '已开始监视' : '已暂停监视', 'ok')
      pipToast(enabled ? '已开始监视' : '已暂停监视', 'ok')
      renderFloat(true)
    }).catch(function (e) { toast(e.message, 'err'); pipToast(e.message, 'err'); $('toggleWatch').checked = !enabled })
  }
  function setIntervalMs(ms) {
    api('/api/settings', { method: 'POST', body: JSON.stringify({ pollIntervalMs: ms }) }).then(function (r) {
      applyState(r.state, false)
      toast('轮询间隔已改为 ' + Math.round(ms / 1000) + ' 秒', 'ok')
    }).catch(function (e) { toast(e.message, 'err') })
  }
  function openSettings() {
    var s = state.data || {}
    var p = s.provider || {}
    $('setProviderKind').value = p.requested || 'auto'
    $('setModel').value = p.model || ''
    $('setBaseURL').value = p.baseURL || ''
    $('setApiKey').value = ''
    var source = p.apiKeySource || (p.apiKeySet ? 'config' : '')
    $('setApiKey').placeholder = source === 'env' ? '已从环境变量 DEEPSEEK_API_KEY 读取' : (source === 'config' ? '已配置，留空不修改' : '粘贴 API Key（也可用环境变量）')
    $('keyHint').textContent = source === 'env' ? '已读取环境变量 DEEPSEEK_API_KEY' : (source === 'config' ? '已保存 Key（不会回显）' : '未配置 Key（会回退读取 DEEPSEEK_API_KEY）')
    $('setInterval').value = Math.round((s.intervalMs || 15000) / 1000)
    $('setIntervalText').textContent = Math.round((s.intervalMs || 15000) / 1000) + ' 秒'
    $('setStable').value = String(s.stablePolls || 2)
    $('setOnlyBili').checked = s.onlyBilibili !== false
    $('setConfirm').checked = s.confirmBeforeGenerate !== false
    $('setSkipSparse').checked = s.skipInsufficientMaterial !== false
    $('setAutoWatch').checked = s.autoWatch !== false
    $('setAutoStart').checked = !!s.autoStartWindows
    $('setOutput').value = s.outputDir || ''
    $('setBiliCookie').value = ''
    var biliSource = s.biliCookieSource || ''
    $('setBiliCookie').placeholder = biliSource === 'env' ? '已从环境变量 BILI_SESSDATA 读取' : (s.biliCookieSet ? '已保存 Cookie，留空不修改' : '粘贴 SESSDATA=... 或完整 Cookie')
    $('biliCookieState').textContent = biliSource === 'env' ? '（环境变量）' : (s.biliCookieSet ? '（已保存）' : '（未配置）')
    $('biliHint').textContent = s.biliCookieSet ? '已配置登录 Cookie' : '未配置 Cookie：B站 AI 字幕/字幕通常读不到'
    state.clearBiliCookie = false
    $('saveHint').textContent = ''
    state.clearKey = false
    $('settingsOverlay').classList.remove('hidden')
  }
  function closeSettings() { $('settingsOverlay').classList.add('hidden') }
  function saveSettings() {
    var key = $('setApiKey').value.trim()
    var provider = {
      kind: $('setProviderKind').value,
      model: $('setModel').value.trim(),
      baseURL: $('setBaseURL').value.trim(),
      maxTokens: 4096,
    }
    if (key) provider.apiKey = key
    else if (state.clearKey) provider.apiKey = ''
    var payload = {
      pollIntervalMs: Math.round(Number($('setInterval').value) * 1000),
      stablePolls: Number($('setStable').value),
      onlyBilibili: $('setOnlyBili').checked,
      confirmBeforeGenerate: $('setConfirm').checked,
      skipInsufficientMaterial: $('setSkipSparse').checked,
      autoWatch: $('setAutoWatch').checked,
      autoStartWindows: $('setAutoStart').checked,
      provider: provider,
    }
    var biliCookie = $('setBiliCookie').value.trim()
    if (biliCookie) payload.biliCookie = biliCookie
    else if (state.clearBiliCookie) payload.clearBiliCookie = true
    $('saveHint').textContent = '保存中…'
    api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }).then(function (r) {
      applyState(r.state, false)
      $('saveHint').textContent = '已保存'
      toast('设置已保存', 'ok')
      setTimeout(closeSettings, 400)
    }).catch(function (e) { $('saveHint').textContent = ''; toast(e.message, 'err') })
  }
  function testProvider() {
    $('providerHint').textContent = '测试中…'
    api('/api/provider/test', { method: 'POST', body: JSON.stringify({}) }).then(function (r) {
      $('providerHint').textContent = (r.ok ? '✓ ' : '✗ ') + (r.message || '') + (r.latencyMs ? ' · ' + r.latencyMs + 'ms' : '')
      toast(r.ok ? '连接成功' : '连接失败', r.ok ? 'ok' : 'warn')
    }).catch(function (e) { $('providerHint').textContent = e.message; toast(e.message, 'err') })
  }
  function testBili() {
    var title = $('setBiliTestTitle').value.trim()
    $('biliHint').textContent = '检测中…'
    api('/api/bili/test', { method: 'POST', body: JSON.stringify({ title: title }) }).then(function (r) {
      $('biliHint').textContent = (r.ok ? '✓ ' : '✗ ') + (r.message || '')
      toast(r.ok ? '字幕检测完成' : '字幕检测失败', r.ok ? 'ok' : 'warn')
    }).catch(function (e) { $('biliHint').textContent = e.message; toast(e.message, 'err') })
  }
  function listModels() {
    api('/api/providers/models').then(function (r) {
      var el = $('modelList')
      var models = r.models || []
      if (!models.length) { el.innerHTML = '<span class="muted small">Ollama 没有模型，先执行 ollama pull qwen2.5:3b</span>'; return }
      el.innerHTML = models.map(function (m) {
        return '<button class="model-pill" data-model="' + esc(m) + '">' + esc(m) + '</button>'
      }).join('')
    }).catch(function (e) { toast(e.message, 'err') })
  }

  // ---- bind ----
  function bind() {
    $('toggleWatch').addEventListener('change', function (e) { toggleWatch(e.target.checked) })
    $('quickInterval').addEventListener('change', function (e) { setIntervalMs(Number(e.target.value)) })
    $('btnScan').addEventListener('click', scan)
    $('btnFloat').addEventListener('click', toggleFloat)
    $('btnRetryConnect').addEventListener('click', function () {
      connectSSE()
      refresh().then(function () { toast('连接已恢复', 'ok') }).catch(function () { toast('仍无法连接，请双击桌面快捷方式重启服务', 'err') })
    })
    $('btnEmptyScan').addEventListener('click', scan)
    $('btnSettings').addEventListener('click', openSettings)
    $('btnCloseSettings').addEventListener('click', closeSettings)
    $('btnSaveSettings').addEventListener('click', saveSettings)
    $('btnTestProvider').addEventListener('click', testProvider)
    $('btnTestBili').addEventListener('click', testBili)
    $('btnListModels').addEventListener('click', listModels)
    $('btnClearKey').addEventListener('click', function () {
      state.clearKey = true
      $('setApiKey').value = ''
      $('keyHint').textContent = '保存后清除已存 Key'
    })
    $('btnClearBiliCookie').addEventListener('click', function () {
      state.clearBiliCookie = true
      $('setBiliCookie').value = ''
      $('biliCookieState').textContent = '（保存后清除）'
      $('biliHint').textContent = '保存后清除已存 Cookie'
    })
    $('setInterval').addEventListener('input', function (e) { $('setIntervalText').textContent = e.target.value + ' 秒' })
    $('modelList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-model]')
      if (b) { $('setModel').value = b.getAttribute('data-model'); toast('已选择 ' + b.getAttribute('data-model')) }
    })
    $('shelfChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-subject]')
      if (!b) return
      var sub = b.getAttribute('data-subject')
      state.subjectFilter = state.subjectFilter === sub ? '' : sub
      renderShelf(); renderHistory()
    })
    $('historyList').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del-title]')
      if (del) {
        e.stopPropagation()
        deleteNote(del.getAttribute('data-del-title'), del.getAttribute('data-del-subject'))
        return
      }
      var row = e.target.closest('[data-title]')
      if (row) loadNote(row.getAttribute('data-title'))
    })
    $('pendingList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-decision]')
      if (!btn) return
      var row = btn.closest('[data-pending-id]')
      if (!row) return
      confirmPending(row.getAttribute('data-pending-id'), btn.getAttribute('data-decision'), btn)
    })
    $('btnDeleteNote').addEventListener('click', function () { deleteNote(state.title, state.subject) })
    $('logTabs').addEventListener('click', function (e) {
      var b = e.target.closest('[data-filter]')
      if (!b) return
      state.filter = b.getAttribute('data-filter')
      var tabs = document.querySelectorAll('.tab')
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.toggle('active', tabs[i] === b)
      renderLog()
    })
    $('autoScroll').addEventListener('change', function (e) { state.autoScroll = e.target.checked; renderLog() })
    $('clearLog').addEventListener('click', function () { state.events = []; renderLog() })
    $('btnDownload').addEventListener('click', function () {
      if (state.title) window.location.href = '/api/download?title=' + encodeURIComponent(state.title)
    })
    $('btnDownloadMd').addEventListener('click', function () {
      if (state.title) window.location.href = '/api/download?format=md&title=' + encodeURIComponent(state.title)
    })
    $('btnOpenFolder').addEventListener('click', function () {
      api('/api/open', { method: 'POST', body: JSON.stringify({ title: state.title }) }).catch(function (e) { toast(e.message, 'err') })
    })
    $('btnOpenOutput').addEventListener('click', function () {
      api('/api/open', { method: 'POST', body: JSON.stringify({}) }).catch(function (e) { toast(e.message, 'err') })
    })
    $('btnMockScan').addEventListener('click', function () {
      var t = $('setMockTitle').value.trim()
      if (!t) return toast('先填一个标题', 'warn')
      api('/api/scan', { method: 'POST', body: JSON.stringify({ title: t }) }).then(function (r) {
        toast(r.message || '已触发', r.ok ? 'ok' : 'warn')
      }).catch(function (e) { toast(e.message, 'err') })
    })
    $('btnQuit').addEventListener('click', function () {
      if (!confirm('确定退出 B站课代表应用？后台监视会停止。')) return
      api('/api/shutdown', { method: 'POST', body: JSON.stringify({}) }).then(function () {
        $('quitOverlay').classList.remove('hidden')
        document.querySelector('main').classList.add('hidden')
        document.querySelector('.topbar').style.display = 'none'
      }).catch(function () {})
    })
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('settingsOverlay').classList.contains('hidden')) closeSettings()
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') scan()
    })
    $('settingsOverlay').addEventListener('click', function (e) { if (e.target === $('settingsOverlay')) closeSettings() })
  }

  function renderAll() {
    renderStatus(); renderProvider(); renderLog(); renderStats(); renderShelf(); renderHistory(); renderPending(); renderTimeline()
    if (state.summaryText || state.title) { showSummary(); renderSummary() }
    scheduleFloat()
  }

  function tick() {
    var bar = $('countdownBar')
    var s = state.data
    if (bar) {
      if (!s || !s.enabled || s.paused) {
        bar.style.width = '0%'
      } else {
        var elapsed = Date.now() - (state.lastPollAt || Date.now())
        var pct = Math.max(0, Math.min(100, 100 - (elapsed / state.intervalMs) * 100))
        bar.style.width = pct + '%'
      }
    }
    renderPollMeta()
    renderOffline()
    updateFloatAge()
    if (state.identifying) {
      var meta = document.getElementById('identifyingMeta')
      if (meta) {
        var secs = Math.round((Date.now() - state.identifying.at) / 1000)
        meta.textContent = '已等待 ' + secs + ' 秒' + (secs > 90 ? '（较慢，可继续等待或点「立即提取」）' : '')
      }
    }
  }

  function init() {
    if (location.search.indexOf('compact=1') >= 0) document.body.classList.add('compact')
    bind()
    updateFloatButton()
    refresh().then(function () { if (location.search.indexOf('settings=1') >= 0) openSettings() }).catch(function () { toast('无法连接本地服务', 'err') })
    loadHistory()
    connectSSE()
    setInterval(tick, 500)
    setInterval(checkHealth, 60000)
    setTimeout(checkHealth, 3000)
    var wantSettings = location.search.indexOf('settings=1') >= 0
    if (wantSettings) openSettings()
    setInterval(function () { refreshQuiet(); loadHistory() }, 15000)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
