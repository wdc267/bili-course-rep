// 联网冒烟测试（可选）：需要有 B 站登录态
// 用法：node tools/test/bili.test.mjs "B站视频标题" [引擎路径]
//   - 登录态来源：环境变量 BILI_SESSDATA，或本机 课程知识地图/.state/bili-auth.json
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const title = String(process.argv[2] || '').trim()
const target = process.argv[3] || fileURLToPath(new URL('../../app/engine/lib/index.js', import.meta.url))
if (!title) {
  console.log('用法：node tools/test/bili.test.mjs "B站视频标题"  （需要 BILI_SESSDATA 或已配置的 Cookie）')
  process.exit(0)
}
const mod = await import(pathToFileURL(target).href)
const t = mod.__courseMapTest
const c = await t.fetchBiliContent(title)
assert.ok(c, 'fetchBiliContent 返回空：未匹配到 B 站视频')
assert.match(c.bvid, /^BV/, '没有拿到 BV 号')
console.log(JSON.stringify({
  bvid: c.bvid,
  title: c.title,
  danmaku: c.danmaku.length,
  comments: c.comments.length,
  transcript: c.transcript.length,
  subtitleSource: c.subtitleSource,
  login: c.loginState,
}))
