import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../../app/engine/lib/index.js', import.meta.url))
const mod = await import(pathToFileURL(target).href)
const t = mod.__courseMapTest
assert.ok(t, 'test exports missing')

// 纯函数
assert.match(t.buildWbiQuery({ a: 1, b: '中' }, 'ea1db124af3c7062474693fa704f4ff8', 1700000000), /wts=1700000000&w_rid=[0-9a-f]{32}$/)
assert.equal(t.normalizeBiliCookie('abc'), 'SESSDATA=abc')
assert.equal(t.normalizeBiliCookie('SESSDATA=abc; bili_jct=x'), 'SESSDATA=abc; bili_jct=x')
assert.equal(t.normalizeBiliCookie('Cookie: SESSDATA=abc'), 'SESSDATA=abc')
assert.deepEqual(t.rankSubtitleTracks([{ lan: 'en', subtitle_url: 'x' }, { lan: 'ai-zh', subtitle_url: 'y' }, { lan: 'zh-Hans', subtitle_url: 'z' }]).map((x) => x.lan), ['zh-Hans', 'ai-zh', 'en'])
assert.equal(t.subtitleIsAi({ lan: 'ai-zh', lan_doc: '中文（自动生成）' }), true)
assert.equal(t.subtitleIsAi({ lan: 'zh-Hans', lan_doc: '中文' }), false)
assert.equal(t.flattenSubtitleBody([{ from: 0, to: 1, content: '你好' }, { from: 2, to: 3, content: '世界' }, { from: 20, to: 21, content: '再来' }]), '你好 世界\n再来')
assert.ok(t.materialScore({ desc: 'a'.repeat(10), transcript: 'b'.repeat(20), aiSummary: 'c'.repeat(30), danmaku: [], comments: [] }) >= 60)

// 集成：删除 + 待确认生成
const root = mkdtempSync(join(process.cwd(), '.tmp-coursemap-test-'))
const stateDir = join(root, '.state')
mkdirSync(join(stateDir, 'videos'), { recursive: true })
mkdirSync(join(root, 'S'), { recursive: true })
writeFileSync(join(stateDir, 'videos', 'V1.md'), '# V1\n\n- 来源：B站 BV1test001 · 弹幕 10 条\n- 内容')
writeFileSync(join(stateDir, 'videos', 'V2.md'), '# V2\n\n## V2\n- 内容')
writeFileSync(join(root, 'S', 'V1.docx'), 'fake')
writeFileSync(join(root, 'S', 'V1.md'), '# V1\n\n- 来源：B站 BV1test001 · 弹幕 10 条\n- 内容')
writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
  revision: 1,
  subjects: { S: { createdAt: 1, videos: ['V1', 'V2'] } },
  seen: { 'title:v1': 1, 'V1': 1, 'V 1': 1, 'bvid:BV1test001': 1, 'title:v2': 1 },
  pending: [{ id: 'abcd1234', rawTitle: 'V3 新视频', title: 'V3 新视频', subject: 'S', keywords: [], bvid: '', at: Date.now() }],
}, null, 2))

const tools = new Map()
const disposers = []
const events = []
const ctx = {
  effect(fn) {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d || (() => {})
  },
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  get() { return undefined },
  llm: {
    async *stream(opts) {
      const sys = String(opts.system || '')
      if (sys.includes('分类助手')) {
        yield { type: 'text-delta', text: JSON.stringify({ isCourse: true, subject: 'S', title: 'V3 新视频', keywords: ['a', 'b'] }) }
        return
      }
      const points = Array.from({ length: 10 }, (_, i) => `- **点${i + 1}**\n  - 说明${i + 1}`).join('\n')
      yield { type: 'text-delta', text: `## V3 新视频\n\n> 简介\n\n### 核心知识点\n${points}\n\n### 弹幕与评论讨论焦点\n- 讨论\n\n### 思维导图\n\`\`\`mermaid\nmindmap\n  root((V3))\n    点1\n\`\`\`` }
    },
  },
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
  onlyBilibili: false,
  deliverSession: false,
  skipInsufficientMaterial: false,
  minMaterialScore: 0,
  requireBilibiliMatch: false,
  confirmBeforeGenerate: true,
  watcherRole: 'standalone',
  skipStartupDocx: true,
  generatorLabel: 'test',
})

const del = await tools.get('course_map_delete').execute({ title: 'V1', subject: 'S' })
assert.equal(del.ok, true, del.message)
const st1 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
assert.deepEqual(st1.subjects.S.videos, ['V2'])
assert.equal(st1.seen['title:v1'], undefined, 'deleted title key still in seen')
assert.equal(st1.seen['V1'], undefined, 'deleted raw title still in seen')
assert.equal(st1.seen['V 1'], undefined, 'deleted raw title variant still in seen')
assert.equal(st1.seen['bvid:BV1test001'], undefined, 'deleted bvid still in seen')
assert.ok(st1.seenReconciled && Object.keys(st1.seenReconciled).length >= 1, 'archive not marked as reconciled')
assert.equal(st1.seen['title:v2'], 1, 'other seen keys should stay')
assert.equal(existsSync(join(stateDir, 'videos', 'V1.md')), false)
assert.equal(existsSync(join(root, 'S', 'V1.docx')), false)
assert.equal(existsSync(join(root, 'S', 'V1.md')), false, 'exported markdown copy should be removed')
assert.ok(existsSync(join(root, '_archive', 'deleted')), 'archive dir missing')
// 归档里只应有一份 V1.md（导出副本不重复归档）
const archivedMd = readdirSync(join(root, '_archive', 'deleted'), { recursive: true }).filter((f) => String(f).endsWith('V1.md'))
assert.equal(archivedMd.length, 1, 'archived md should be deduped: ' + archivedMd.join(','))

const conf = await tools.get('course_map_confirm').execute({ id: 'abcd1234', decision: 'generate' })
assert.equal(conf.ok, true, conf.message)
const st2 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
assert.ok(st2.subjects.S.videos.includes('V3 新视频'), 'generated video missing')
assert.equal(st2.pending.length, 0, 'pending not cleared')
assert.ok(st2.revision > 1, 'revision not incremented')
assert.ok(existsSync(join(stateDir, 'videos', 'V3 新视频.md')), 'video md missing')
assert.ok(existsSync(join(stateDir, 'notes', 'V3 新视频.json')), 'note meta sidecar missing')
const v3md = readFileSync(join(stateDir, 'videos', 'V3 新视频.md'), 'utf8')
assert.ok(v3md.startsWith('# '), 'note should start with a single H1')
assert.equal((v3md.match(/^# /gm) || []).length, 1, 'note should contain exactly one H1')
assert.ok(!/^## V3 新视频/m.test(v3md), 'duplicated title heading should be removed')
assert.ok(!v3md.includes('mindmap'), 'note should not contain a mindmap')
assert.ok(!v3md.includes('原始素材'), 'note should not contain raw materials')
assert.ok(events.some((e) => e.type === 'note_deleted'), 'note_deleted event missing')
assert.ok(events.some((e) => e.type === 'confirm_request' || e.type === 'summary_done'), 'confirm/summary event missing')

// 删除学科最后一个视频：学科应移除，手册一并归档
mkdirSync(join(root, 'T'), { recursive: true })
mkdirSync(join(stateDir, 'manuals'), { recursive: true })
writeFileSync(join(stateDir, 'videos', 'T1.md'), '# T1\n\n## T1\n- 内容')
writeFileSync(join(root, 'T', '学习手册.docx'), 'fake-manual')
writeFileSync(join(stateDir, 'manuals', 'T.md'), '# T 学习手册')
const st3 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
st3.subjects.T = { createdAt: 2, videos: ['T1'] }
writeFileSync(join(stateDir, 'state.json'), JSON.stringify(st3, null, 2))
const del2 = await tools.get('course_map_delete').execute({ title: 'T1', subject: 'T' })
assert.equal(del2.ok, true, del2.message)
const st4 = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
assert.equal(st4.subjects.T, undefined, 'empty subject not removed')
assert.equal(existsSync(join(root, 'T', '学习手册.docx')), false, 'subject manual not archived')
assert.equal(existsSync(join(stateDir, 'manuals', 'T.md')), false, 'manual md not archived')

for (const d of disposers.reverse()) { try { d() } catch { /* 忽略 */ } }
rmSync(root, { recursive: true, force: true })
console.log('delete/confirm tests ok')
