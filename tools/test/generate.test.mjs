#!/usr/bin/env node
// 生成流程集成测试（假 LLM，不发网络请求）：验证长字幕会分段覆盖全片、短字幕全文传入。
// 用法：node tools/test/generate.test.mjs
import assert from 'node:assert/strict'
import { __courseMapTest as t } from '../../app/engine/lib/index.js'

function fakeCtx(handler) {
  const calls = []
  return {
    calls,
    ctx: {
      emit() {},
      get() { return undefined },
      llm: {
        stream(opts) {
          const prompt = String(opts.messages?.[0]?.content?.[0]?.text || '')
          calls.push(prompt)
          const text = handler(prompt, calls.length)
          return (async function* () {
            for (const piece of String(text).split(/(?<=。)/)) yield { type: 'text-delta', text: piece }
          })()
        },
      },
    },
  }
}

const finalMd = [
  '# 测试标题',
  '',
  '- 学科：测试学科',
  '- 关键词：k1、k2',
  '- 来源：B站 BV1test0001 · 弹幕 10 条',
  '',
  '> 一句话简介（这一段应当被清掉）',
  '',
  '## 一、概念',
  '### 什么是 Harness',
  '- 要点说明文字，包含命令与参数示例。',
  '- 第二条要点，覆盖安装与配置流程。',
  '### 与网页版的区别',
  '- 能直接改文件。',
  '- 能自己上网查资料。',
  '## 二、安装与登录',
  '### 下载安装',
  '- 官网下载安装包。',
  '- 安装路径建议放 D 盘。',
  '### 首次登录',
  '- 手机号验证码登录。',
  '- 配置跟着账号走。',
  '## 三、配置与模式',
  '### API 配置',
  '- 设置里粘贴密钥。',
  '- 看到绿点即成功。',
  '### 四种模式',
  '- 标准、PTC、极简、创造。',
  '- 拿不准先用标准。',
  '## 四、插件与权限',
  '### 插件市场',
  '- 输入 dshmarket 安装。',
  '- 插件太多会吃上下文。',
  '### 权限四档',
  '- 日常用工作区内修改。',
  '- 完全权限慎用。',
  '',
  '### 弹幕与评论讨论焦点',
  '- 这一段也应当被清掉',
  '',
  '### 思维导图',
  '```mermaid',
  'mindmap',
  '  root((测试))',
  '    安装',
  '```',
].join('\n')

// 1) 长字幕（约 18000 字）：应分段提炼，最终提示词覆盖到片尾内容
const paragraphs = []
for (let i = 1; i <= 600; i++) paragraphs.push('第' + i + '段讲解：执行命令 demo ' + i + ' 并解释参数含义。')
const tail = '结尾彩蛋：这一段讲了插件市场与权限设置的坑，必须写进笔记。'
const longTranscript = paragraphs.join('') + tail
assert.ok(longTranscript.length > 15000, '测试字幕应足够长：' + longTranscript.length)

const a = fakeCtx((prompt) => (prompt.includes('字幕的第') ? '- 本段要点：安装与配置步骤 A\n- 本段要点：插件与权限 B' : finalMd))
const mdLong = await t.generate(a.ctx, { provider: 'fake', model: 'fake', maxTokens: 4096 }, {
  title: '测试标题', subject: '测试学科', keywords: ['k1', 'k2'],
  content: { transcript: longTranscript, desc: '简介', tags: ['t'], danmaku: ['a'], comments: ['b'], subtitleSource: 'AI字幕', duration: 3000, subtitleCoverage: 1 },
})
const mapCalls = a.calls.filter((p) => p.includes('字幕的第'))
const lastCall = a.calls[a.calls.length - 1]
assert.ok(mapCalls.length >= 4, '长字幕应拆成多段提炼：' + mapCalls.length)
assert.ok(/第 1\/\d+ 段/.test(mapCalls[0]), '首段提示词应带段号')
assert.ok(lastCall.includes('字幕分段时间摘要'), '最终提示词应包含分段摘要')
assert.ok(lastCall.includes('第 ' + mapCalls.length + ' 段'), '最终提示词应覆盖最后一段')
assert.ok(lastCall.includes('覆盖全片'), '最终提示词应要求覆盖全片')
assert.ok(mdLong.includes('## 一、概念') && mdLong.includes('## 四、插件与权限'), '应返回多章节笔记：' + mdLong.slice(0, 80))
assert.ok(!mdLong.includes('mindmap'), '笔记里不应再出现思维导图')
assert.ok(!mdLong.includes('原始素材'), '笔记里不应出现原始素材')
assert.ok(!mdLong.includes('弹幕与评论讨论焦点'), '笔记里不应出现弹幕讨论')
assert.ok(!mdLong.includes('- 学科：'), '笔记里不应出现元数据')
assert.ok(!/^> /m.test(mdLong), '笔记里不应有一句话简介')

// 2) 短字幕：不分段，全文进入提示词
const shortTranscript = '短字幕：安装 Redis 并启动服务。' + '补充说明。'.repeat(50)
const b = fakeCtx(() => finalMd)
await t.generate(b.ctx, { provider: 'fake', model: 'fake', maxTokens: 4096 }, {
  title: '短测试', subject: '测试学科', keywords: [],
  content: { transcript: shortTranscript, duration: 120, subtitleCoverage: 1 },
})
const shortPrompt = b.calls[b.calls.length - 1]
assert.ok(b.calls.length === 1, '短字幕应只调用一次模型：' + b.calls.length)
assert.ok(shortPrompt.includes(shortTranscript), '短字幕应全文传入提示词')

// 5) 离线抽取兜底文本不能被当成模型输出（会导致笔记跑偏）
assert.equal(t.isOfflineFallbackText('### 思维导图\n\n*（离线抽取模式：未配置 LLM，仅基于简介/标签/弹幕/评论做结构化整理）*'), true)
assert.equal(t.isOfflineFallbackText('- **真实要点**\n  - 说明了安装步骤'), false)

// 6) 分段提炼若拿到兜底文本，应改用原文片段而不是兜底骨架
const c = fakeCtx((prompt) => (prompt.includes('字幕的第') ? '*（离线抽取模式：未配置 LLM，仅基于简介/标签/弹幕/评论做结构化整理）*' : finalMd))
await t.generate(c.ctx, { provider: 'fake', model: 'fake', maxTokens: 4096 }, {
  title: '兜底测试', subject: '测试学科', keywords: [],
  content: { transcript: longTranscript, duration: 3000, subtitleCoverage: 1 },
})
const fallbackLast = c.calls[c.calls.length - 1]
assert.ok(!fallbackLast.includes('离线抽取模式'), '兜底文本不应进入最终提示词')
assert.ok(fallbackLast.includes(longTranscript.slice(0, 200)), '应改用原文片段覆盖')

// 7) 笔记标题：取模型概括的短标题，正文去掉重复标题；照抄原标题则退回原标题
const t1 = t.splitNoteTitle('# 五十分钟吃透 Redis\n\n> 简介\n\n### 核心知识点', '【示例】Redis 入门教程（完整版）')
assert.equal(t1.title, '五十分钟吃透 Redis')
assert.ok(!t1.body.includes('# 五十分钟吃透 Redis'), '正文不应重复标题')
assert.ok(t1.body.startsWith('> 简介'))

const t2 = t.splitNoteTitle('## 【示例】Redis 入门教程（完整版）\n\n> 简介', '【示例】Redis 入门教程（完整版）')
assert.equal(t2.title, '【示例】Redis 入门教程（完整版）', '照抄原标题时退回原标题')

const t3 = t.splitNoteTitle('没有标题的正文\n\n> 简介', '视频原标题')
assert.equal(t3.title, '视频原标题')

const longTitle = '这是一个明显超过二十个字上限的笔记标题需要被截断处理一下'
const t4 = t.splitNoteTitle('# ' + longTitle + '\n\n> 简介', '视频原标题')
assert.ok(t4.title.length <= 21, '超长标题应截断：' + t4.title.length + ' ' + t4.title)

console.log('generate.test：全部通过（长字幕 ' + mapCalls.length + ' 段；长字幕 ' + longTranscript.length + ' 字）')
