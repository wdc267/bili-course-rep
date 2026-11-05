import docx, sys, json
d = docx.Document(sys.argv[1])
texts = [p.text for p in d.paragraphs if p.text.strip()]
print(json.dumps({"paragraphs": len(texts), "has_points": any("核心知识点" in t for t in texts), "has_danmaku": any("弹幕" in t for t in texts), "has_mindmap": any("Redis概述" in t for t in texts), "styles": sorted(set(p.style.name for p in d.paragraphs))[:8]}, ensure_ascii=False))
