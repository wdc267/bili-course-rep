import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] || fileURLToPath(new URL('../../app/engine/lib/index.js', import.meta.url))
const mod = await import(pathToFileURL(target).href)
const t = mod.__courseMapTest
assert.ok(t, 'test exports missing')

const edgeTitle = '【示例】Redis 入门教程（完整版）_哔哩哔哩_bilibili 和另外 6 个页面 - 个人 - Microsoft Edge'
assert.equal(t.isBiliTitle(edgeTitle), true)
assert.equal(t.cleanTitle(edgeTitle), '【示例】Redis 入门教程（完整版）')
assert.equal(t.isBiliHubPage(t.cleanTitle(edgeTitle)), false)

const chrome = 'Redis基础篇（入门）_哔哩哔哩_bilibili - Google Chrome'
assert.equal(t.cleanTitle(chrome), 'Redis基础篇（入门）')

// Edge 单标签/InPrivate/工作配置：不能把「 - 个人 - Microsoft Edge」留在标题里
const singleTab = 'Redis基础篇（入门）_哔哩哔哩_bilibili - 个人 - Microsoft Edge'
assert.equal(t.cleanTitle(singleTab), 'Redis基础篇（入门）')
const inPrivate = 'Vue 3 - 基础教程_哔哩哔哩_bilibili - [InPrivate] - Microsoft Edge'
assert.equal(t.cleanTitle(inPrivate), 'Vue 3 - 基础教程')
const workProfile = '算法 第3讲_哔哩哔哩_bilibili - 工作 - Microsoft Edge'
assert.equal(t.cleanTitle(workProfile), '算法 第3讲')

// 本应用页面/悬浮窗标题：应跳过轮询且不打断稳定性计数
assert.equal(t.isAppTitle('课程笔记 · B站课程实时总结 - 个人 - Microsoft Edge'), true)
assert.equal(t.isAppTitle('(1) 课程笔记 · B站课程实时总结'), true)
assert.equal(t.isAppTitle('课程笔记 · 悬浮'), true)
assert.equal(t.isAppTitle('【示例】Redis 入门教程_哔哩哔哩_bilibili'), false)

const feishu = '\u200bRedis基础篇（入门） - 飞书云文档 和另外 6 个页面 - 个人 - Microsoft Edge'
assert.equal(t.isBiliTitle(feishu), false)
assert.equal(t.cleanTitle(feishu), 'Redis基础篇（入门） - 飞书云文档')

const hub = '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili - Microsoft Edge'
assert.equal(t.isBiliHubPage(t.cleanTitle(hub)), true)

assert.equal(t.isBiliTitle('视频课程实时笔记应用 — DeepSeek Harness'), false)
assert.equal(t.isBiliTitle('anything', 'bilibili'), true)
assert.equal(t.titleKey('Redis 基础篇（入门）'), t.titleKey('Redis基础篇(入门)'))
assert.equal(t.bvidKey(' BV123 '), 'bvid:BV123')
assert.equal(t.isAppTitle('B站课代表 · B站课程实时总结 - 个人 - Microsoft Edge'), true)
assert.equal(t.isAppTitle('(1) B站课代表 · B站课程实时总结'), true)
assert.equal(t.isAppTitle('B站课代表 · 悬浮'), true)
console.log('title tests ok')
