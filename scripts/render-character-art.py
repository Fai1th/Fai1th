"""Translate the supplied artwork into text characters without drawing imagery."""
from pathlib import Path
from html import escape
from random import Random
from PIL import Image, ImageOps

root = Path(__file__).resolve().parent.parent
source = ImageOps.autocontrast(Image.open(root / 'assets/nazuna-wave.png').convert('L'), cutoff=0.4)
source = source.point(lambda value: max(0, min(255, round((value - 18) * 1.3))))
columns, cell_width, cell_height = 216, 5, 6
rows = round(source.height / source.width * columns * cell_width / cell_height)
sample = source.resize((columns, rows), Image.Resampling.LANCZOS)
width, height = columns * cell_width + 24, rows * cell_height + 24
digits = '0123456789'
random = Random(0)
head_box = (278, 20, 444, 165)
lines, elements = [], []
for y in range(rows):
    chars, spans = [], []
    for x in range(columns):
        value = sample.getpixel((x, y))
        if value < 12:
            char, tone = ' ', 0
        else:
            char = random.choice(digits)
            tone = min(255, round(255 * (value / 255) ** 0.9))
        chars.append(char)
        source_x = (x + 0.5) / columns * source.width
        source_y = (y + 0.5) / rows * source.height
        inside_head = head_box[0] <= source_x < head_box[2] and head_box[1] <= source_y < head_box[3]
        if char != ' ' and not inside_head:
            spans.append(f'<tspan x="{12+x*cell_width}" fill="rgb({tone},{tone},{tone})">{escape(char)}</tspan>')
    lines.append(''.join(chars).rstrip())
    elements.append(f'<text y="{20+y*cell_height}">{"".join(spans)}</text>')
fine_columns, fine_rows = 100, 73
head = source.crop(head_box).resize((fine_columns, fine_rows), Image.Resampling.LANCZOS)
scale_x, scale_y = columns * cell_width / source.width, rows * cell_height / source.height
fine_width = (head_box[2] - head_box[0]) * scale_x / fine_columns
fine_height = (head_box[3] - head_box[1]) * scale_y / fine_rows
for y in range(fine_rows):
    spans = []
    for x in range(fine_columns):
        value = head.getpixel((x, y))
        if value < 12:
            continue
        tone = min(255, round(255 * (value / 255) ** 0.9))
        px = 12 + head_box[0] * scale_x + x * fine_width
        spans.append(f'<tspan x="{px:.2f}" fill="rgb({tone},{tone},{tone})">{random.choice(digits)}</tspan>')
    py = 12 + head_box[1] * scale_y + (y + 1) * fine_height
    elements.append(f'<text y="{py:.2f}" font-size="4.5">{"".join(spans)}</text>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="art-title art-desc">
<title id="art-title">Nazuna and the wave, in characters</title>
<desc id="art-desc">The supplied Nazuna illustration translated into visible monospace digits. Every mark is a text character.</desc>
<rect width="{width}" height="{height}" fill="#000000"/>
<g font-family="Consolas, Courier New, monospace" font-size="8" font-weight="700" xml:space="preserve">
{''.join(elements)}
</g></svg>
'''
(root / 'assets/nazuna-ascii.svg').write_text(svg, encoding='utf-8')
(root / 'assets/nazuna-ascii.txt').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(f'Character art: {columns} columns × {rows} rows, {width} × {height}')
