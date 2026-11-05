import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../../app/engine/lib/index.js', import.meta.url))
const mod = await import(pathToFileURL(target).href)

function makeRoot() {
  const root = mkdtempSync(join(process.cwd(), '.tmp-coursemap-reconcile-'))
  const stateDir = join(root, '.state')
  mkdirSync(join(stateDir, 'videos'), { recursive: true })
  return { root, stateDir }
}
function writeArchive(root, title, bvid, subject = '数学') {
  const dir = join(root, '_archive', 'deleted', '2026-01-01T00-00-00', subject)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, title + '.md'), '# ' + title + '\n\n- 来源：B站 ' + bvid + ' · 弹幕 10 条\n')
  // 学科手册文件不应参与对账
  writeFileSync(join(dir, '学习手册.docx'), 'fake')
  writeFileSync(join(dir, subject + '.md'), '# ' + subject + ' 学习手册\n')
  return dir
}
function applyEngine(root) {
  const disposers = []
  const events = []
  const ctx = {
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d || (() => {})
    },
    tools: { register() { return () => {} } },
    get() { return undefined },
    llm: { async *stream() { /* noop */ } },
    emit(event, payload) { events.push(payload) },
  }
  mod.apply(ctx, {
    enabled: false,
    pollIntervalMs: 60000,
    stablePolls: 1,
    outputDir: root,
    provider: 'standalone',
    model: 'standalone',
    maxTokens: 2048,
    fetchContent: false,
    onlyBilibili: true,
    deliverSession: false,
    skipInsufficientMaterial: false,
    minMaterialScore: 0,
    requireBilibiliMatch: false,
    confirmBeforeGenerate: true,
    watcherRole: 'standalone',
    skipStartupDocx: true,
    generatorLabel: 'test',
  })
  return { disposers, events }
}
function readState(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
}
function cleanup(root, disposers) {
  for (const d of disposers.reverse()) { try { d() } catch { /* 忽略 */ } }
  rmSync(root, { recursive: true, force: true })
}

// 1) 已归档删除、当前不在架 → seen 清掉，允许重新检测（含截断/空格变体）
{
  const { root, stateDir } = makeRoot()
  writeArchive(root, 'Linux 常用命令教程', 'BV12Ltest')
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    revision: 1,
    subjects: {},
    seen: {
      'title:linux常用命令教程': 1,
      'Linux 常用命令 教程': 1,
      'Linux 常用命令': 1,
      'bvid:BV12Ltest': 1,
      'title:数学': 1,
      'title:other': 1,
    },
    pending: [],
    ignored: {},
  }, null, 2))
  const { disposers } = applyEngine(root)
  const st = readState(stateDir)
  assert.equal(st.seen['title:linux常用命令教程'], undefined, 'deleted title should be re-detectable')
  assert.equal(st.seen['Linux 常用命令 教程'], undefined, 'deleted raw title should be re-detectable')
  assert.equal(st.seen['Linux 常用命令'], undefined, 'truncated title variant should be re-detectable')
  assert.equal(st.seen['bvid:BV12Ltest'], undefined, 'deleted bvid should be re-detectable')
  assert.equal(st.seen['title:数学'], 1, 'subject manual should not be touched')
  assert.equal(st.seen['title:other'], 1, 'unrelated seen should stay')
  assert.ok(readdirSync(stateDir).some((n) => n.startsWith('state.json.bak-')), 'state backup missing')

  // 第二次启动：已对账过的归档不再清 seen（否则用户「跳过」后会被反复询问）
  st.seen['Linux 常用命令'] = 2
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(st, null, 2))
  const second = applyEngine(root)
  const st2 = readState(stateDir)
  assert.equal(st2.seen['Linux 常用命令'], 2, 'already reconciled archive must not clear seen again')
  cleanup(root, disposers.concat(second.disposers))
}

// 2) 归档里同名笔记仍在架 → seen 保持，避免把在架笔记重新变成待确认
{
  const { root, stateDir } = makeRoot()
  writeArchive(root, 'V1', 'BV1test001')
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    revision: 1,
    subjects: { 数学: { createdAt: 1, videos: ['V1'] } },
    seen: { 'title:v1': 1, 'V1': 1, 'bvid:BV1test001': 1 },
    pending: [],
    ignored: {},
  }, null, 2))
  const { disposers } = applyEngine(root)
  const st = readState(stateDir)
  assert.equal(st.seen['title:v1'], 1, 'live note seen should stay')
  assert.equal(st.seen['V1'], 1, 'live note raw seen should stay')
  assert.equal(st.seen['bvid:BV1test001'], 1, 'live note bvid seen should stay')
  cleanup(root, disposers)
}

console.log('reconcile tests ok')
