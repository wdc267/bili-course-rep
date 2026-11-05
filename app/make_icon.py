# -*- coding: utf-8 -*-
"""生成课程笔记应用图标（app/icon.ico）。"""
from PIL import Image, ImageDraw, ImageFont
import os

W = 256
img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
# 粉色渐变底
grad = Image.new('RGBA', (W, W))
gd = ImageDraw.Draw(grad)
for y in range(W):
    t = y / (W - 1)
    r = int(251)
    g = int(114 + (154 - 114) * t)
    b = int(153 + (118 - 153) * t)
    gd.line([(0, y), (W, y)], fill=(r, g, b, 255))
mask = Image.new('L', (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([8, 8, W - 8, W - 8], radius=58, fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)
# 白色书本
d.rounded_rectangle([62, 50, 200, 208], radius=14, fill=(255, 255, 255, 245))
d.rounded_rectangle([62, 50, 86, 208], radius=14, fill=(255, 238, 243, 255))
d.rectangle([86, 50, 96, 208], fill=(255, 238, 243, 255))
# 书页横线
for i, y in enumerate([86, 112, 138, 164]):
    d.rounded_rectangle([112, y, 178 - (12 if i == 3 else 0), y + 8], radius=4, fill=(251, 114, 153, 210))
# 书签
d.polygon([(166, 50), (192, 50), (192, 96), (179, 84), (166, 96)], fill=(251, 114, 153, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(out)
