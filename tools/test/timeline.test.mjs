#!/usr/bin/env node
// 字幕时间线单元测试：node tools/test/timeline.test.mjs
import assert from 'node:assert/strict'
import { __courseMapTest as t } from '../../app/engine/lib/index.js'

// 造 40 分钟字幕：每 3 秒一条，中间塞入几处 10 秒停顿模拟「章节切换」
const cues = []
let cursor = 0
for (let i = 0; i < 800; i++) {
  const gap = i > 0 && i % 120 === 0 ? 12 : 3
  cursor += gap
  cues.push({ from: cursor, to: cursor + 2.5, text: '第' + (i + 1) + '句讲解内容' })
  cursor += 2.5
}

const timeline = t.buildTimeline(cues)
assert.ok(timeline.length >= 6 && timeline.length <= 20, '段数应在 6~20：' + timeline.length)
assert.equal(timeline[0].start, cues[0].from, '首段应从 0 开始')
assert.ok(timeline[timeline.length - 1].end >= cues[cues.length - 1].to - 1, '末段应覆盖到最后一条字幕')
for (let i = 1; i < timeline.length; i++) {
  assert.ok(timeline[i].start >= timeline[i - 1].end, '时间段不应重叠')
}
const totalText = timeline.map((s) => s.text).join('')
assert.ok(totalText.includes('第1句') && totalText.includes('第800句'), '时间线应保留完整字幕文本')
assert.ok(timeline.every((s) => s.end - s.start >= 60), '每段至少 1 分钟')

// 空输入
assert.deepEqual(t.buildTimeline([]), [])
assert.deepEqual(t.buildTimeline(null), [])

// 超多段时合并到上限
const many = []
for (let i = 0; i < 4000; i++) many.push({ from: i * 10, to: i * 10 + 9, text: '内容' + i })
const capped = t.buildTimeline(many, { maxSegments: 12 })
assert.ok(capped.length <= 12, '应合并到 maxSegments 以内：' + capped.length)

// 时钟格式
assert.equal(t.fmtClock(0), '00:00')
assert.equal(t.fmtClock(65), '01:05')
assert.equal(t.fmtClock(3661), '1:01:01')

// 字幕条目解析
const cues2 = t.subtitleCues([{ from: 0, to: 1, content: '你好' }, { from: 2, to: 3, content: '  ' }, { from: 4, to: 5, content: '世界' }])
assert.equal(cues2.length, 2)
assert.equal(cues2[1].text, '世界')

console.log('timeline.test：全部通过（' + timeline.length + ' 段，覆盖 ' + t.fmtClock(timeline[timeline.length - 1].end) + '）')
