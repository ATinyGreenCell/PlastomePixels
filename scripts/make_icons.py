"""App icons: the first bases of the Arabidopsis plastome as five pixel columns (1, 20, 40, 80, 160 bp)."""
import re, pathlib
from PIL import Image
root = pathlib.Path(__file__).resolve().parent.parent
t = (root / 'data' / 'NC_000932.gb').read_text()
seq = re.sub(r'[^A-Za-z]', '', t.split('\nORIGIN', 1)[1].split('\n//', 1)[0]).upper()
COL = {'A': (0, 255, 255), 'T': (255, 255, 0), 'C': (255, 0, 0), 'G': (0, 0, 0)}
BG = (19, 24, 20)
W, ROWS, WINDOWS, GAP = 8, 40, [1, 20, 40, 80, 160], 2
start = 84170  # the IRb junction: rRNA genes make the window columns stripe nicely
s = seq[start:start + W * ROWS]
def dominant(chunk):
    counts = [chunk.count(b) for b in 'ATCG']
    return 'ATCG'[counts.index(max(counts))]
cols = []
for w in WINDOWS:
    col = []
    for p in range(len(s)):
        k = (p // w) * w
        col.append(s[p] if w == 1 else dominant(seq[start + k:start + k + w]))
    cols.append(col)
gw = len(WINDOWS) * W + (len(WINDOWS) - 1) * GAP
art = Image.new('RGB', (gw, ROWS), BG)
for i, col in enumerate(cols):
    x0 = i * (W + GAP)
    for p, b in enumerate(col):
        art.putpixel((x0 + p % W, p // W), COL[b])
for size in (180, 192, 512):
    im = Image.new('RGB', (size, size), BG)
    inner = int(size * 0.64)                       # inside the maskable safe zone
    scale = max(1, inner // max(gw, ROWS))
    big = art.resize((gw * scale, ROWS * scale), Image.NEAREST)
    im.paste(big, ((size - big.width) // 2, (size - big.height) // 2))
    im.save(root / 'static' / f'icon-{size}.png', optimize=True)
    print('icon', size, big.size)
