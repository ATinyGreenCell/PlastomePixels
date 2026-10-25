"""Browser tests for the built site (site/) and the single-file page (dist/plastome-pixels.html).
Needs a static server on 127.0.0.1:8765 rooted at the repo, and Playwright's Chromium.
usage: python3 test/browser.py
"""
import asyncio, gzip, json, random, re, sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'test' / 'shots'
SHOTS.mkdir(exist_ok=True)
SITE = 'http://127.0.0.1:8765/site/'
ARTIFACT = 'http://127.0.0.1:8765/dist/__artifact__.html'     # dist/artifact-body.html in claude.ai's shell
STANDALONE = (ROOT / 'dist' / 'plastome-pixels.html').as_uri()   # the release download, opened as a file

async def claude_shell(route):
    # claude.ai wraps an artifact in a document of its own: charset, viewport, a small reset
    body = (ROOT / 'dist' / 'artifact-body.html').read_text(encoding='utf-8')
    await route.fulfill(status=200, content_type='text/html', body='<!doctype html><html><head><meta charset=utf8>'
        '<meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>body{margin:0}</style></head><body>'
        + body + '</body></html>')
CHROME = next((str(c) for c in Path('/opt/pw-browsers').glob('chromium-*/chrome-linux64/chrome')), None)  # else Playwright's own

ran = failed = 0
def ok(cond, msg):
    global ran, failed
    ran += 1
    if not cond: failed += 1
    print(('  ok    ' if cond else '  FAIL  ') + msg)

def gb_seq(name):
    t = (ROOT / 'data' / name).read_text()
    return re.sub(r'[^A-Za-z]', '', t.split('\nORIGIN')[1].split('//')[0]).upper()

ARA, AMB = gb_seq('NC_000932.gb'), gb_seq('Amborella_trichopoda.gb')

def ref_image(seqs, W, windows, gap, panel_gap, margin, bg, other):
    pal = [(0, 255, 255), (255, 255, 0), (255, 0, 0), (0, 0, 0), other, bg]
    code = {'A': 0, 'T': 1, 'C': 2, 'G': 3}
    nC = len(windows)
    pw = nC * W + (nC - 1) * gap
    width = 2 * margin + len(seqs) * pw + (len(seqs) - 1) * panel_gap
    rows = max((len(s) + W - 1) // W for s in seqs)
    img = [[pal[5]] * width for _ in range(rows + 2 * margin)]
    for pi, s in enumerate(seqs):
        c = [code.get(ch, 4) for ch in s]
        x0 = margin + pi * (pw + panel_gap)
        for k, w in enumerate(windows):
            cx = x0 + k * (W + gap)
            for st in range(0, len(c), w):
                seg = c[st:st + w]
                cnt = [seg.count(b) for b in range(4)]
                m = max(cnt)
                call = 4 if m == 0 else cnt.index(m)
                for p in range(st, st + len(seg)):
                    img[margin + p // W][cx + p % W] = pal[seg[p - st] if w == 1 else call]
    return width, rows + 2 * margin, img

async def ready(page, timeout=20000):
    await page.wait_for_function("() => document.body.dataset.ready === 'done' && document.querySelectorAll('.plate canvas').length > 0", timeout=timeout)

async def wait_panels(page, n, timeout=30000):
    await page.wait_for_function(f"() => document.querySelectorAll('#panelList .pl-name').length === {n}", timeout=timeout)

def ncbi_mock(calls):
    random.seed(7)
    REC = {
        '101': ('NC_001879.2', 155943, 'circular', 'Nicotiana tabacum plastid, complete genome'),
        '102': ('NC_000023.11', 156040895, 'linear', 'Homo sapiens chromosome X, GRCh38.p14 Primary Assembly'),
    }
    async def handler(route):
        u = urlparse(route.request.url)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        calls.append((u.path.rsplit('/', 1)[-1], q))
        hdr = {'access-control-allow-origin': '*'}
        if u.path.endswith('esearch.fcgi'):
            ids = [] if '"tobacco"[Organism]' in q['term'] else ['101', '102']
            return await route.fulfill(status=200, headers=hdr, content_type='application/json', body=json.dumps({'esearchresult': {'count': str(len(ids)), 'idlist': ids}}))
        if u.path.endswith('esummary.fcgi'):
            ids = q['id'].split(',')
            res = {'uids': ids}
            for i in ids:
                a, n, top, t = REC[i]
                res[i] = {'uid': i, 'accessionversion': a, 'slen': n, 'topology': top, 'title': t}
            return await route.fulfill(status=200, headers=hdr, content_type='application/json', body=json.dumps({'result': res}))
        if u.path.endswith('efetch.fcgi'):
            if q['id'] == 'NC_001879.2':
                fa = '>NC_001879.2 Nicotiana tabacum plastid, complete genome\n' + '\n'.join(ARA[i:i + 70] for i in range(0, len(ARA), 70)) + '\n'
            else:
                a, b = int(q['seq_start']), int(q['seq_stop'])
                n = b - a + 1
                s = 'N' * 10000 + ''.join(random.choice('ACGT') for _ in range(n - 10000))
                fa = f'>NC_000023.11:{a}-{b} Homo sapiens chromosome X, GRCh38.p14 Primary Assembly\n' + '\n'.join(s[i:i + 80] for i in range(0, n, 80)) + '\n'
            return await route.fulfill(status=200, headers=hdr, content_type='text/plain', body=fa)
        await route.abort()
    return handler

async def main():
    errors = []
    async with async_playwright() as pw:
        b = await pw.chromium.launch(executable_path=CHROME)

        # ================= GitHub Pages build, desktop =================
        print('site: desktop')
        ctx = await b.new_context(viewport={'width': 1440, 'height': 900}, accept_downloads=True)
        calls = []
        await ctx.route('https://eutils.ncbi.nlm.nih.gov/**', ncbi_mock(calls))
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'site pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'site console.{m.type}: {m.text}') if m.type == 'error' else None)
        await page.goto(SITE)
        await ready(page)
        info = await page.evaluate("""() => ({ names: [...document.querySelectorAll('#panelList .pl-name')].map(e => e.textContent),
          struct: [...document.querySelectorAll('.pl-struct')].map(e => e.textContent), ver: document.getElementById('ver').textContent,
          size: document.getElementById('exportSize').textContent, mode: navigator.serviceWorker ? 'sw' : 'none' })""")
        ok(info['names'] == ['Arabidopsis thaliana chloroplast', 'Amborella trichopoda chloroplast'], 'boots with both sample plastomes')
        ok(info['struct'][0] == 'IRs 26,264 bp · LSC 84,170 · SSC 17,780', 'sample IRs shown at once (precomputed)')
        ok(info['ver'] == 'v' + re.search(r'APP_VERSION = "([^"]+)"', (ROOT / 'src' / 'version.ts').read_text()).group(1), 'version shown in the header')
        ok(await page.text_content('#openBtn') == 'Open…', 'text arrives intact (UTF-8)')
        ok(info['size'] == '1,070 × 1,627 px', 'export size for 100 bp rows')
        await page.screenshot(path=str(SHOTS / 'v2-site-fit.png'))

        # inspect: click base 84,171 (IRb start) in the first column
        pos = await page.evaluate("""() => { const r = document.getElementById('plate').getBoundingClientRect();
          const s = parseFloat(getComputedStyle(document.getElementById('sheet')).getPropertyValue('--s'));
          const p = 84170; return { x: r.left + (p % 100 + 0.5) * s, y: r.top + (Math.floor(p / 100) + 0.5) * s }; }""")
        await page.mouse.click(pos['x'], pos['y'])
        await page.wait_for_selector('.ins-table')
        ins = await page.inner_text('#inspector')
        ok('84,171' in ins and 'IRb' in ins and '84,161–84,180' in ins, 'click inspects the base, its region and its windows')
        # zoom to whole device pixels and check crisp full-resolution tiles
        for _ in range(8):
            await page.click('#zoomIn')
        await ready(page)
        z = await page.evaluate("() => ({ s: getComputedStyle(document.getElementById('sheet')).getPropertyValue('--s'), px: document.getElementById('plate').classList.contains('px'), c: document.querySelectorAll('.plate canvas').length })")
        ok(float(z['s']) >= 2 and float(z['s']) == int(float(z['s'])) and z['px'], f'zoom buttons land on whole pixels (scale {z["s"]}, crisp {z["px"]})')
        ok(z['c'] < 200, f'only nearby tiles exist ({z["c"]} canvases)')
        await page.screenshot(path=str(SHOTS / 'v2-site-zoom.png'))
        # scroll far and check the tile count stays bounded
        for i in range(30):
            await page.evaluate('(i) => { const v = document.getElementById("viewer"); v.scrollTop += 400; }', i)
            await page.wait_for_timeout(16)
        await ready(page)
        c2 = await page.evaluate("() => document.querySelectorAll('.plate canvas').length")
        ok(c2 < 200, f'tiles stay bounded while scrolling ({c2})')

        # export and compare with an independent renderer
        await page.click('#fitBtn')
        async with page.expect_download() as dl_info:
            await page.click('#saveBtn')
        dl = await dl_info.value
        out = SHOTS / dl.suggested_filename
        await dl.save_as(str(out))
        from PIL import Image
        got = Image.open(out).convert('RGB')
        w, h, refimg = ref_image([ARA, AMB], 100, [1, 20, 40, 80, 160], 5, 30, 0, (0, 0, 0), (128, 128, 128))
        px = got.load()
        bad = sum(1 for y in range(h) for x in range(w) if px[x, y] != refimg[y][x]) if got.size == (w, h) else -1
        ok(bad == 0, f'exported PNG matches an independent renderer pixel for pixel ({got.size}, {bad} differences)')

        # settings: width 200, seven windows, white background; export again at 2x
        await page.fill('#width', '200')
        await page.wait_for_timeout(500)
        await page.fill('#windows', '1, 10, 25, 50, 100, 200, 400')
        await page.wait_for_timeout(600)
        await page.click('[data-bg="#ffffff"]')
        await page.wait_for_timeout(300)
        await ready(page)
        await page.select_option('#scale', '2')
        size2 = await page.text_content('#exportSize')
        ok(size2 == '5,780 × 1,628 px', f'export size follows width, windows and scale ({size2})')
        async with page.expect_download() as dl_info:
            await page.click('#saveBtn2')
        dl = await dl_info.value
        await dl.save_as(str(SHOTS / 'v2-export-2x.png'))
        got2 = Image.open(SHOTS / 'v2-export-2x.png').convert('RGB')
        w2, h2, ref2 = ref_image([ARA, AMB], 200, [1, 10, 25, 50, 100, 200, 400], 5, 30, 0, (255, 255, 255), (128, 128, 128))
        p2 = got2.load()
        bad2 = sum(1 for y in range(0, h2, 3) for x in range(0, w2, 3) if p2[2 * x, 2 * y] != ref2[y][x] or p2[2 * x + 1, 2 * y + 1] != ref2[y][x]) if got2.size == (2 * w2, 2 * h2) else -1
        ok(bad2 == 0, f'2x export with new layout matches ({got2.size})')
        await page.screenshot(path=str(SHOTS / 'v2-site-200.png'))
        await page.fill('#windows', '1, x')
        await page.wait_for_timeout(500)
        ok(await page.is_visible('#windowsErr'), 'bad window list is explained')
        await page.click('#resetBtn')
        await page.wait_for_timeout(500)

        # files: FASTA + gzip + a bad file
        fa = SHOTS / 'ara.fasta'
        fa.write_text('>NC_000932.1 Arabidopsis thaliana chloroplast, complete genome\n' + '\n'.join(ARA[i:i + 70] for i in range(0, len(ARA), 70)) + '\n')
        gz = SHOTS / 'amb.fa.gz'
        gz.write_bytes(gzip.compress(('>AJ506156.2 Amborella trichopoda chloroplast\n' + AMB + '\n').encode()))
        await page.set_input_files('#fileInput', [str(fa), str(gz)])
        await page.wait_for_function("() => [...document.querySelectorAll('#panelList .pl-id')].some(e => e.textContent.includes('ara.fasta'))", timeout=30000)
        await ready(page)
        names = await page.evaluate("() => [...document.querySelectorAll('#panelList .pl-id')].map(e => e.textContent)")
        ok(names == ['NC_000932.1 · ara.fasta', 'AJ506156.2 · amb.fa'], f'opened a FASTA and a gzip file ({names})')
        await page.wait_for_function("() => [...document.querySelectorAll('.pl-struct')].every(e => e.textContent.startsWith('IRs'))", timeout=15000)
        ok(True, 'inverted repeats found in the background for opened files')
        bad = SHOTS / 'protein.fa'
        bad.write_text('>p\nMKVLLLAEQRSTWYFPHIKLMNEQ\n')
        await page.set_input_files('#fileInput', [str(bad)])
        await page.wait_for_timeout(800)
        t = await page.text_content('#toast')
        ok('protein' in t and await page.evaluate("() => document.querySelectorAll('#panelList .pl-name').length") == 2, 'a protein file is refused and the genomes stay')

        # IR marks
        await page.check('#irMarks')
        await page.wait_for_timeout(200)
        labels = await page.evaluate("() => [...document.querySelectorAll('.ir-label')].map(e => e.textContent)")
        ok(labels[:3] == ['IRb 84,171', 'SSC 110,435', 'IRa 128,215'], f'IR boundary marks ({labels[:3]})')
        await page.uncheck('#irMarks')

        # NCBI: name search falls back from organism to all fields; a long record downloads as a slice
        await page.fill('#ncbiQ', 'tobacco')
        await page.press('#ncbiQ', 'Enter')
        await page.wait_for_selector('#ncbiResults .hit')
        terms = [c[1]['term'] for c in calls if c[0] == 'esearch.fcgi']
        ok(terms[0].startswith('"tobacco"[Organism]') and terms[1].startswith('(tobacco)'), 'search tries the organism name, then any field')
        await page.click('#ncbiResults .hit:nth-child(2) button[data-mode=add]')
        await wait_panels(page, 3)
        await ready(page)
        ef = [c[1] for c in calls if c[0] == 'efetch.fcgi'][-1]
        ok(ef.get('seq_start') == '1' and ef.get('seq_stop') == '1000000', 'a 156 Mb chromosome downloads as its first 1 Mb')
        st = await page.evaluate("() => document.querySelectorAll('#panelList .pl-stats')[2].textContent")
        ok('1,000,000' in st and '10,000 other' in st, f'slice listed with its size and unknown bases ({st.strip()})')
        await page.screenshot(path=str(SHOTS / 'v2-site-ncbi.png'))

        # persistence: reload restores the genomes (IndexedDB), settings come back too
        await page.wait_for_timeout(2000)
        await page.reload()
        await ready(page)
        names = await page.evaluate("() => [...document.querySelectorAll('#panelList .pl-id')].map(e => e.textContent.split(' · ')[0])")
        ok(names == ['NC_000932.1', 'AJ506156.2', 'NC_000023.11:1-1000000'], f'genomes restored after reload ({names})')
        idb_keys = """() => new Promise(res => { const r = indexedDB.open('plastome-pixels'); r.onsuccess = () => {
          const k = r.result.transaction('genomes').objectStore('genomes').getAllKeys(); k.onsuccess = () => { res(k.result.map(String).sort()); r.result.close(); }; }; })"""
        k1 = await page.evaluate(idb_keys)
        ok(len(k1) == 4 and k1[0] == 'current' and all(k.startswith('g:') for k in k1[1:]), f'each genome is its own record ({len(k1) - 1} genomes + the list)')
        await page.click('#panelList li:nth-child(2) [data-act=left]')
        await page.wait_for_timeout(2200)
        k2 = await page.evaluate(idb_keys)
        ok(k2 == k1, 'reordering rewrites only the list, never the bases')
        await page.click('#panelList li:nth-child(3) [data-act=remove]')
        await page.wait_for_timeout(2200)
        k3 = await page.evaluate(idb_keys)
        ok(len(k3) == 3 and set(k3) < set(k1), 'a removed genome leaves the database')
        await page.reload()
        await ready(page)
        names = await page.evaluate("() => [...document.querySelectorAll('#panelList .pl-id')].map(e => e.textContent.split(' · ')[0])")
        ok(names == ['AJ506156.2', 'NC_000932.1'], f'the new order and the removal survive a reload ({names})')

        # update flow: a newer version.json shows the banner
        await page.route('**/version.json', lambda r: r.fulfill(status=200, content_type='application/json', body='{"version":"2.1"}'))
        await page.evaluate("() => window.dispatchEvent(new Event('online'))")
        await page.wait_for_selector('#update:not([hidden])', timeout=5000)
        ok('Version 2.1 is ready (you have 2.0)' in await page.text_content('#update'), 'a newer published version offers itself')
        sw = await page.evaluate("async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r && !!(r.active || r.installing || r.waiting); }")
        ok(sw, 'service worker registered')
        await ctx.close()

        # offline start: the service worker serves the app with no network
        print('site: offline')
        ctx = await b.new_context(viewport={'width': 1200, 'height': 800})
        page = await ctx.new_page()
        await page.goto(SITE)
        await page.wait_for_function("async () => { const r = await navigator.serviceWorker.ready; return !!r.active; }", timeout=15000)
        await page.wait_for_timeout(500)
        await ctx.set_offline(True)
        await page.reload()
        await ready(page)
        ok(True, 'opens offline from the service worker')
        await ctx.close()

        # first-version genomes in localStorage migrate
        print('site: migration')
        ctx = await b.new_context()
        page = await ctx.new_page()
        await page.goto(SITE)
        await ready(page)
        await page.evaluate("""() => { indexedDB.deleteDatabase('plastome-pixels');
          localStorage.setItem('plastome-pixels/genomes/v1', JSON.stringify([{id: 'MIG_1', title: 'Migrated test, complete genome', circular: true, source: 'Saved', length: 6, data: btoa(String.fromCharCode(0x02, 0x31, 0x40))}])); }""")
        await page.reload()
        await wait_panels(page, 1)
        mig = await page.evaluate("() => [document.querySelector('#panelList .pl-id').textContent, localStorage.getItem('plastome-pixels/genomes/v1')]")
        ok(mig[0].startswith('MIG_1') and mig[1] is None, f'old saved genomes migrate and the old key is removed ({mig})')
        await ctx.close()

        # ================= a new version reaches an installed copy =================
        print('site: update')
        import shutil, subprocess
        cur = re.search(r'APP_VERSION = "([^"]+)"', (ROOT / 'src' / 'version.ts').read_text()).group(1)
        parts = cur.split('.'); parts[-1] = str(int(parts[-1]) + 1); nxt = '.'.join(parts)
        b2 = SHOTS / 'build-next'
        shutil.rmtree(b2, ignore_errors=True)
        shutil.copytree(ROOT, b2, ignore=shutil.ignore_patterns('node_modules', 'site', 'dist', 'test', 'data', '.git', '.build'))
        (b2 / 'node_modules').symlink_to(ROOT / 'node_modules')
        vt = b2 / 'src' / 'version.ts'
        vt.write_text(vt.read_text().replace(f'APP_VERSION = "{cur}"', f'APP_VERSION = "{nxt}"'))
        subprocess.run(['node', 'build.mjs'], cwd=b2, check=True, capture_output=True)
        upd = SHOTS / 'upd'
        shutil.rmtree(upd, ignore_errors=True)
        shutil.copytree(ROOT / 'site', upd)
        ctx = await b.new_context()
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'update pageerror: {e}'))
        url = 'http://127.0.0.1:8765/test/shots/upd/'
        await page.goto(url)
        await ready(page)
        await page.wait_for_function("() => !!navigator.serviceWorker.controller", timeout=15000)
        ok(await page.text_content('#ver') == f'v{cur}', f'installed copy runs v{cur}')
        # publish the next version under it
        shutil.rmtree(upd)
        shutil.copytree(b2 / 'site', upd)
        await page.evaluate("() => window.dispatchEvent(new Event('online'))")
        await page.wait_for_selector('#update:not([hidden])', timeout=10000)
        ok(f'Version {nxt} is ready' in await page.text_content('#update'), 'it notices the new version')
        async with page.expect_navigation(timeout=30000):
            await page.click('#update')
        await ready(page)
        caches = await page.evaluate("async () => (await caches.keys()).filter(k => k.startsWith('ppx-shell-'))")
        ok(await page.text_content('#ver') == f'v{nxt}' and caches == [f'ppx-shell-{nxt}'], f'one tap: now v{nxt}, old offline copy gone ({caches})')
        ok(await page.is_hidden('#update'), 'and the banner is gone')
        names = await page.evaluate("() => [...document.querySelectorAll('#panelList .pl-id')].map(e => e.textContent)")
        ok(len(names) == 2, 'genomes survive the update')
        await ctx.close()

        # ================= edge cases =================
        print('site: edges')
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800})
        mode = {'v': 'down'}
        hits = []
        async def flaky(route):
            hits.append(route.request.url)
            if mode['v'] == 'down': return await route.abort('internetdisconnected')
            if mode['v'] == '500': return await route.fulfill(status=500, body='busy')
            if mode['v'] == '429': return await route.fulfill(status=429, body='slow down')
            if mode['v'] == 'portal': return await route.fulfill(status=200, content_type='text/html', body='<html>sign in to the Wi-Fi</html>')
            await route.abort()
        await ctx.route('https://eutils.ncbi.nlm.nih.gov/**', flaky)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'edges pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'edges console.{m.type}: {m.text}') if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        await page.goto(SITE)
        await ready(page)
        async def setv(sel, v, tiles=True):
            await page.fill(sel, v)
            await page.wait_for_timeout(450)
            if tiles: await ready(page)
            else: await page.wait_for_function("() => document.body.dataset.ready === 'done'", timeout=20000)
        await setv('#width', '1')
        ok(await page.text_content('#exportSize') == '80 × 162,686 px', f'1 bp rows: a thin, very tall picture ({await page.text_content("#exportSize")})')
        await page.screenshot(path=str(SHOTS / 'v2-edge-w1.png'))
        await setv('#width', '100000')
        ok(await page.text_content('#exportSize') == '1,000,070 × 2 px', f'100,000 bp rows: a very wide, short picture ({await page.text_content("#exportSize")})')
        await page.screenshot(path=str(SHOTS / 'v2-edge-wide.png'))
        await setv('#width', '100')
        await setv('#start', '400000', tiles=False)
        msg = await page.evaluate("() => { const m = document.getElementById('viewerMsg'); return m.hidden ? '' : m.textContent; }")
        n = await page.evaluate("() => document.querySelectorAll('.plate canvas').length")
        ok('Nothing falls inside the chosen range' in msg and n == 0, f'a range past the end of every genome says so ({n} tiles left)')
        await page.click('#resetBtn')
        await page.wait_for_timeout(300)
        await ready(page)
        await page.fill('#windows', '1, 1000000')
        await page.wait_for_timeout(600)
        await ready(page)
        ok(await page.is_hidden('#windowsErr'), 'a window larger than the genome is fine (one call for everything)')
        await page.click('#resetBtn')
        await page.wait_for_timeout(300)
        async def search(q):
            await page.fill('#ncbiQ', q)
            await page.press('#ncbiQ', 'Enter')
            await page.wait_for_function("() => !document.getElementById('ncbiGo').disabled", timeout=30000)
            return await page.text_content('#ncbiStatus')
        st = await search('tobacco')
        ok('Couldn’t reach NCBI' in st or 'offline' in st, f'no connection: says so ({st[:60]})')
        mode['v'] = '500'; hits.clear()
        st = await search('tobacco')
        ok('error 500' in st and len(hits) == 3, f'NCBI errors are retried twice, then explained ({len(hits)} tries: {st[:50]})')
        mode['v'] = '429'
        st = await search('tobacco')
        ok('limiting requests' in st, 'rate limiting is explained')
        mode['v'] = 'portal'
        st = await search('tobacco')
        ok('sign in' in st, f'a Wi-Fi sign-in page is not taken for results ({st[:60]})')
        # pasted GenBank-style text with numbers and spaces
        await page.click('#pasteToggle')
        await page.fill('#pasteArea', '        1 acgtacgtac gtacgtacgt\n       21 ttttttttnn aaaaaaaaaa\n')
        await page.click('#pasteAdd')
        await wait_panels(page, 3)
        st3 = await page.evaluate("() => document.querySelectorAll('#panelList .pl-stats')[2].textContent")
        ok(st3.startswith('40 bp'), f'pasted text with position numbers and spaces ({st3.strip()[:40]})')
        # remove every genome: the empty state, and nothing to save
        for _ in range(3):
            await page.click('#panelList [data-act=remove]')
            await page.wait_for_timeout(250)
        msg = await page.evaluate("() => { const m = document.getElementById('viewerMsg'); return m.hidden ? '' : m.textContent; }")
        ok('Open a FASTA or GenBank file' in msg, 'with no genomes the page says how to begin')
        ok(await page.is_disabled('#saveBtn'), 'and Save PNG waits for a genome')
        await ctx.close()

        # ================= phone =================
        print('site: phone')
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=3, is_mobile=True, has_touch=True, color_scheme='dark')
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'phone pageerror: {e}'))
        await page.goto(SITE)
        await ready(page)
        hs = await page.evaluate("() => document.documentElement.scrollWidth > document.documentElement.clientWidth")
        ok(not hs, 'no sideways page scroll on a phone')
        vb = await page.evaluate("() => { const r = document.getElementById('viewer').getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; }")
        cdp = await ctx.new_cdp_session(page)
        cx, cy = vb['x'] + vb['w'] / 2, vb['y'] + vb['h'] / 2
        before = await page.text_content('#zoomVal')
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': cx - 20, 'y': cy, 'id': 1}, {'x': cx + 20, 'y': cy, 'id': 2}]})
        for i in range(1, 13):
            d = 20 + i * 12
            await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': cx - d, 'y': cy, 'id': 1}, {'x': cx + d, 'y': cy, 'id': 2}]})
            await page.wait_for_timeout(16)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        await page.wait_for_timeout(400)
        after = await page.text_content('#zoomVal')
        s = float(await page.evaluate("() => getComputedStyle(document.getElementById('sheet')).getPropertyValue('--s')"))
        ok(before != after and abs(s * 3 - round(s * 3)) < 1e-6, f'pinch zooms ({before} -> {after}) and settles on whole device pixels')
        await page.touchscreen.tap(cx, cy)
        await page.wait_for_timeout(300)
        ok(await page.is_visible('.ins-table'), 'tap inspects after a pinch')
        await ready(page)
        await page.screenshot(path=str(SHOTS / 'v2-phone.png'))
        await ctx.close()

        # ================= single-file page (claude.ai) =================
        print('artifact')
        ctx = await b.new_context(viewport={'width': 412, 'height': 900}, device_scale_factor=2.625, is_mobile=True, has_touch=True)
        await ctx.add_init_script("""window.claude = { use: (n) => new Promise(r => setTimeout(() => r(n === 'downloads' ? Object.freeze({
          save: async (req) => { window.__saved = { filename: req.filename, size: req.data.size, type: req.data.type }; return { status: 'saved' }; } }) : null), 30)) };""")
        await ctx.route('https://eutils.ncbi.nlm.nih.gov/**', lambda r: r.abort())
        await ctx.route(ARTIFACT, claude_shell)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'artifact pageerror: {e}'))
        await page.goto(ARTIFACT)
        await ready(page)
        ok(await page.text_content('#openBtn') == 'Open…', 'text arrives intact (UTF-8) inside claude.ai')
        mode = await page.evaluate("() => document.getElementById('ver').hidden")
        ok(mode, 'no version label or update banner inside claude.ai')
        await page.click('#saveBtn')
        await page.wait_for_function('() => window.__saved', timeout=10000)
        saved = await page.evaluate('() => window.__saved')
        ok(saved['type'] == 'image/png' and saved['filename'].endswith('.png'), f'Save PNG goes through the downloads capability ({saved})')
        await page.fill('#ncbiQ', 'duckweed')
        await page.click('#ncbiGo')
        await page.wait_for_timeout(600)
        st = await page.text_content('#ncbiStatus')
        ok('claude.ai' in st and 'NCBI site' in st, 'NCBI search explains the claude.ai limit and offers the NCBI site')
        await ctx.close()

        # the one-file download, opened from disk: no claude.ai, so NCBI and saving work directly
        print('one file')
        ctx = await b.new_context(viewport={'width': 1280, 'height': 800}, accept_downloads=True)
        calls = []
        await ctx.route('https://eutils.ncbi.nlm.nih.gov/**', ncbi_mock(calls))
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'one-file pageerror: {e}'))
        await page.goto(STANDALONE)
        await ready(page)
        ok(await page.text_content('#openBtn') == 'Open…' and await page.title() == 'Plastome Pixels', 'opens from a file with its text intact')
        async with page.expect_download() as dl_info:
            await page.click('#saveBtn')
        dl = await dl_info.value
        ok(dl.suggested_filename.endswith('.png'), f'Save PNG downloads ({dl.suggested_filename})')
        await page.fill('#ncbiQ', 'tobacco')
        await page.press('#ncbiQ', 'Enter')
        await page.wait_for_selector('#ncbiResults .hit', timeout=15000)
        ok(len(calls) >= 2, 'searches NCBI directly')
        await ctx.close()

        # worker blocked: the engine runs on the page instead
        print('fallback')
        ctx = await b.new_context()
        await ctx.add_init_script("window.Worker = function () { throw new Error('blocked'); };")
        await ctx.route(ARTIFACT, claude_shell)
        page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'fallback pageerror: {e}'))
        await page.goto(SITE)
        await ready(page, 30000)
        ok(True, 'works with Web Workers blocked (site)')
        await page.goto(ARTIFACT)
        await ready(page, 30000)
        ok(True, 'works with Web Workers blocked (single file)')
        await ctx.close()
        await b.close()
    for e in errors: print('  ' + e)
    ok(not errors, 'no page errors')
    print(f'{ran - failed} of {ran} passed' if failed else f'all {ran} passed')
    sys.exit(1 if failed else 0)

asyncio.run(main())
