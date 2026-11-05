#!/usr/bin/env node
// 字幕分段与覆盖度单元测试：node tools/test/subtitle-split.test.mjs
import assert from 'node:assert/strict'
import { __courseMapTest as t } from '../../app/engine/lib/index.js'

// 1) 分段不丢字：拼回去应覆盖原文 99% 以上
const para = '这是一句讲解内容，包含命令 ollama pull qwen2.5:3b 和参数。'
const long = Array.from({ length: 600 }, (_, i) => para + (i % 40 === 0 ? '\n' : '')).join('')
const chunks = t.splitTranscript(long, 3200, 14)
assert.ok(chunks.length >= 4 && chunks.length <= 14, '分段数应在 4~14：' + chunks.length)
const joined = chunks.join('')
assert.ok(joined.length >= long.length * 0.98, '分段不应丢失内容：' + joined.length + '/' + long.length)
assert.ok(chunks.every((c) => c.length <= 7000), '单段不应过大')
assert.ok(chunks.every((c) => c.trim().length > 0), '不应有空段')

// 2) 短文本只有一段
assert.equal(t.splitTranscript('短字幕').length, 1)
assert.equal(t.splitTranscript('').length, 0)

// 3) 覆盖度计算
assert.deepEqual(t.subtitleSpan([{ from: 0, to: 10.5, content: 'a' }, { from: 10.6, to: 300.2, content: 'b' }]), { count: 2, from: 0, to: 300.2 })
assert.deepEqual(t.subtitleSpan([]), { count: 0, from: 0, to: 0 })
assert.equal(t.subtitleSpan([{ from: 0, to: 90, content: 'x' }]).to, 90)

// 4) 字幕正文按 4 秒以上停顿分段
const text = t.flattenSubtitleBody([
  { from: 0, to: 2, content: '第一句' },
  { from: 2.1, to: 4, content: '第二句' },
  { from: 20, to: 22, content: '隔了很久' },
])
assert.equal(text, '第一句 第二句\n隔了很久')

console.log('subtitle-split.test：全部通过（分段 ' + chunks.length + ' 段，原文 ' + long.length + ' 字）')
