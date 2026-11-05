#!/usr/bin/env node
// 字幕完整性探针：对比视频时长与各字幕来源的覆盖范围。
// 用法：node tools/test/subtitle-probe.mjs BV号
//   登录态来源：环境变量 BILI_SESSDATA，或本机 课程知识地图/.state/bili-auth.json
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const bvid = String(process.argv[2] || '').trim()
if (!bvid) {
  console.log('用法：node tools/test/subtitle-probe.mjs BV号')
  process.exit(0)
}
const authPath = join(process.cwd(), '课程知识地图', '.state', 'bili-auth.json')
let cookie = process.env.BILI_SESSDATA || ''
if (!cookie) {
  try { cookie = JSON.parse(readFileSync(authPath, 'utf8')).cookie || '' } catch { /* 忽略 */ }
}

async function get(url, useCookie = true) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (useCookie && cookie) headers.Cookie = cookie
  const r = await fetch(url, { headers })
  const text = await r.text()
  try { return JSON.parse(text) } catch { return text }
}

const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
function wbiQuery(params, mixinKey, wts = Math.floor(Date.now() / 1000)) {
  const p = { ...params, wts }
  const q = Object.keys(p).sort().map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))).join('&')
  return q + '&w_rid=' + createHash('md5').update(q + mixinKey).digest('hex')
}

const nav = await get('https://api.bilibili.com/x/web-interface/nav')
const img = String(nav?.data?.wbi_img?.img_url || '')
const sub = String(nav?.data?.wbi_img?.sub_url || '')
const base = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0]
const orig = base(img) + base(sub)
const mixinKey = orig.length >= 64 ? MIXIN.map((i) => orig[i]).join('').slice(0, 32) : ''
console.log('登录：' + Boolean(nav?.data?.isLogin) + ' · wbi=' + Boolean(mixinKey))

const view = await get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid)
const d = view?.data || {}
console.log('标题：' + d.title)
console.log('时长：' + d.duration + ' 秒 · cid=' + d.cid + ' · 分P数=' + (d.pages?.length || 1))
for (const p of (d.pages || []).slice(0, 8)) console.log('  P' + p.page + ' cid=' + p.cid + ' 时长=' + p.duration + ' 标题=' + p.part)

for (const api of ['player/v2', 'player/wbi/v2']) {
  const url = api.includes('wbi') && mixinKey
    ? 'https://api.bilibili.com/x/' + api + '?' + wbiQuery({ aid: d.aid, cid: d.cid }, mixinKey)
    : 'https://api.bilibili.com/x/' + api + '?aid=' + d.aid + '&cid=' + d.cid
  const player = await get(url)
  const tracks = player?.data?.subtitle?.subtitles || []
  console.log('\n[' + api + '] code=' + player?.code + ' 字幕轨=' + tracks.length)
  for (const t of tracks) {
    let u = String(t.subtitle_url || '')
    if (u.startsWith('//')) u = 'https:' + u
    const body = await get(u, false)
    const cues = Array.isArray(body?.body) ? body.body : []
    if (!cues.length) { console.log('  ' + t.lan + '/' + t.lan_doc + ' 空'); continue }
    const last = cues[cues.length - 1]
    const chars = cues.reduce((n, c) => n + String(c.content || '').length, 0)
    console.log('  ' + t.lan + '/' + t.lan_doc + '：' + cues.length + ' 条 · 0→' + last.to + 's · ' + chars + ' 字 · 覆盖 ' + (last.to / (d.duration || 1) * 100).toFixed(1) + '% · url=' + u.slice(0, 90))
  }
}

if (mixinKey) {
  const q = wbiQuery({ bvid, cid: d.cid, ...(d.owner?.mid ? { up_mid: d.owner.mid } : {}) }, mixinKey)
  const cj = await get('https://api.bilibili.com/x/web-interface/view/conclusion/get?' + q)
  const dd = cj?.data || {}
  const mr = dd.model_result || {}
  const parts = (Array.isArray(mr.subtitle) ? mr.subtitle : []).flatMap((s) => Array.isArray(s?.part_subtitle) ? s.part_subtitle : [])
  console.log('\n[conclusion/get] code=' + cj?.code + ' data.code=' + dd.code + ' stid=' + dd.stid + ' 段=' + parts.length)
  if (parts.length) {
    const chars = parts.reduce((n, c) => n + String(c.content || '').length, 0)
    console.log('  首条 from=' + parts[0].from + ' 末条 to=' + parts[parts.length - 1].to + ' · ' + chars + ' 字 · 摘要 ' + String(mr.summary || '').length + ' 字 · 覆盖 ' + (Number(parts[parts.length - 1].to) / (d.duration || 1) * 100).toFixed(1) + '%')
  }
}
