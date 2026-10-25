"""Performance harness: boot, big-file load, zoom and scroll under CPU throttling.

usage: python3 perf.py <page.html | http://…> [throttle]
Readiness: the new build sets document.body.dataset.ready when the visible tiles are all drawn;
the baseline build is ready when its column canvases exist.
"""
import asyncio, json, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

ARG = sys.argv[1]
URL = ARG if ARG.startswith('http') else Path(ARG).resolve().as_uri()
RATE = float(sys.argv[2]) if len(sys.argv) > 2 else 4
PERF = Path(__file__).resolve().parent

INIT = """
window.__lt = [];
new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
window.__frames = [];
window.__recFrames = (on) => {
  if (!on) { window.__rec = false; return; }
  window.__frames = []; window.__rec = true;
  let last = performance.now();
  const tick = (t) => { if (!window.__rec) return; window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
};
"""

READY = """() => {
  if (document.body.dataset.ready !== undefined) return document.body.dataset.ready === 'done';
  return document.querySelectorAll('.col canvas').length > 0;
}"""

async def wait_ready(page, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if await page.evaluate(READY):
            return True
        await page.wait_for_timeout(20)
    return False

def summarize_lt(lt, since=0):
    xs = [d for s, d in lt if s >= since]
    return {'longtasks': len(xs), 'longest_ms': round(max(xs), 1) if xs else 0, 'blocking_ms': round(sum(max(0, d - 50) for d in xs), 1)}

def frames_stats(fr):
    fr = [f for f in fr[1:] if f > 0]
    if not fr: return {}
    fr.sort()
    return {'frames': len(fr), 'p50_ms': round(fr[len(fr) // 2], 1), 'p95_ms': round(fr[int(len(fr) * 0.95) - 1], 1), 'max_ms': round(fr[-1], 1), 'over_50ms': sum(1 for f in fr if f > 50)}

async def canvas_pixels(page):
    return await page.evaluate("() => [...document.querySelectorAll('canvas')].reduce((n, c) => n + c.width * c.height, 0)")

def ensure_inputs():
    # synthetic genomes for the load test, made once (not kept in git)
    import random
    for name, n in (('5mb.fa', 5_000_000), ('20mb.fa', 20_000_000)):
        f = PERF / name
        if f.exists():
            continue
        rnd = random.Random(n)
        seq = ''.join(rnd.choices('ACGT', k=n))
        with open(f, 'w') as fh:
            fh.write(f'>syn{n // 1_000_000} synthetic test sequence\n')
            for i in range(0, n, 70):
                fh.write(seq[i:i + 70] + '\n')

async def main():
    ensure_inputs()
    out = {}
    async with async_playwright() as pw:
        chrome = next((str(c) for c in Path('/opt/pw-browsers').glob('chromium-*/chrome-linux64/chrome')), None)  # else Playwright's own
        b = await pw.chromium.launch(executable_path=chrome, args=['--enable-precise-memory-info'])
        ctx = await b.new_context(viewport={'width': 412, 'height': 900}, device_scale_factor=2.625, is_mobile=True, has_touch=True)
        await ctx.add_init_script(INIT)
        page = await ctx.new_page()
        cdp = await ctx.new_cdp_session(page)
        await cdp.send('Emulation.setCPUThrottlingRate', {'rate': RATE})
        # ---- boot ----
        t0 = time.time()
        await page.goto(URL, wait_until='commit')
        ok = await wait_ready(page)
        boot_wall = time.time() - t0
        fcp = await page.evaluate("() => (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || null")
        ready_at = await page.evaluate("() => performance.now()")
        lt = await page.evaluate('() => window.__lt')
        out['boot'] = {'ready': ok, 'fcp_ms': round(fcp or 0), 'ready_ms': round(ready_at), **summarize_lt(lt), 'canvas_px': await canvas_pixels(page)}
        # ---- zoom: 24 slider steps ----
        await page.evaluate('() => window.__recFrames(true)')
        mark = await page.evaluate('() => performance.now()')
        for i in range(24):
            await page.evaluate("(v) => { const r = document.getElementById('zoomRange'); r.value = v; r.dispatchEvent(new Event('input', {bubbles: true})); }", str(500 + i * 18))
            await page.wait_for_timeout(16)
        await page.wait_for_timeout(300)
        await page.evaluate('() => window.__recFrames(false)')
        out['zoom'] = {**frames_stats(await page.evaluate('() => window.__frames')), **summarize_lt(await page.evaluate('() => window.__lt'), mark), 'scale': await page.text_content('#zoomVal')}
        # ---- scroll: 60 steps ----
        await page.evaluate('() => window.__recFrames(true)')
        mark = await page.evaluate('() => performance.now()')
        for i in range(60):
            await page.evaluate("(i) => { const v = document.getElementById('viewer'); v.scrollTop += 90; v.scrollLeft = (i % 20) * 12; }", i)
            await page.wait_for_timeout(16)
        await page.wait_for_timeout(300)
        await page.evaluate('() => window.__recFrames(false)')
        out['scroll'] = {**frames_stats(await page.evaluate('() => window.__frames')), **summarize_lt(await page.evaluate('() => window.__lt'), mark), 'canvas_px': await canvas_pixels(page)}
        # ---- load a 5 Mb and a 20 Mb FASTA ----
        for name in ['5mb.fa', '20mb.fa']:
            await page.click('#fitBtn')
            mark = await page.evaluate('() => performance.now()')
            await page.evaluate("() => { delete document.body.dataset.ready; }")
            t0 = time.time()
            await page.set_input_files('#fileInput', str(PERF / name))
            await page.wait_for_function("(n) => document.getElementById('panelList').textContent.includes(n)", arg=name.replace('mb.fa', '').join(['syn', '']), timeout=120000)
            ok = await wait_ready(page, 120)
            wall = time.time() - t0
            heap = await page.evaluate("() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null")
            msg = await page.evaluate("() => { const m = document.getElementById('viewerMsg'); return m && !m.hidden ? m.textContent.slice(0, 80) : ''; }")
            out['load_' + name] = {'ready': ok, 'wall_s': round(wall, 2), **summarize_lt(await page.evaluate('() => window.__lt'), mark), 'heap_mb': heap, 'canvas_px': await canvas_pixels(page), 'msg': msg}
        await b.close()
    print(json.dumps(out, indent=1))

asyncio.run(main())
