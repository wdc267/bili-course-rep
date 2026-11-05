# 第三方组件与许可

本项目包含修改自 **dsh-video-coursemap** 的代码，遵循其 MIT 许可。

## dsh-video-coursemap

- 项目：https://github.com/linner1224/dsh-video-coursemap
- 版本：2.0.0（本项目基于其 `lib/index.js` 与 `scripts/md2docx.py` 修改）
- 许可：MIT
- 版权：Copyright (c) 2026 dsh-video-coursemap contributors

修改说明：

- `app/engine/lib/index.js`：重写/扩展了字幕抓取（覆盖度校验、缓存绕过）、长字幕分段提炼、笔记结构（多级章节）、字幕时间线、笔记元数据 sidecar、单词级 LLM 预算与兜底等；保留其原有的窗口轮询、B 站抓取、去重、学科手册等逻辑。
- `app/engine/scripts/md2docx.py`：用于 Markdown → Word 转换，未做功能性改动（随插件分发）。

## Python 依赖

- [python-docx](https://python-docx.readthedocs.io/)（MIT），仅用于生成 Word 文档。

## 其余代码

`app/server.mjs`、`app/public/`、`tools/` 等为本项目新写，按根目录 [LICENSE](LICENSE)（MIT）发布。

---

```
MIT License

Copyright (c) 2026 dsh-video-coursemap contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
