# Plastome Pixels

**Genomes as columns of pixels: one pixel per base, plus columns that show each window's most common base.**

Open it at **https://atinygreencell.github.io/PlastomePixels/** — on a phone too. It installs to the home
screen, opens offline, and updates itself.

The first column shows every base, filled left to right in rows of a width you choose, so the column is
as tall as the genome needs. Each further column tiles the sequence into windows (20, 40, 80, 160 bp by
default) and paints every base in a window with the colour of the window's most common base, so the
large-scale structure shows through the noise: AT-rich stretches go cyan and yellow, GC-rich ones red and
black, and a plastome's inverted repeats and single-copy regions stand apart.

| Base | Colour |
| --- | --- |
| A | cyan `#00ffff` |
| T | yellow `#ffff00` |
| C | red `#ff0000` |
| G | black `#000000` |
| N and other IUPAC letters | grey (adjustable), never counted in a window's call |

## Using it

- **Open / Add**: FASTA, multi-FASTA, GenBank, EMBL or plain sequence, gzipped or not, by file picker,
  drag and drop, or paste. Several files or records become genomes side by side (up to 24).
- **Find on NCBI**: type an organism, scientific or common (`duckweed`, `tobacco`, `Escherichia coli`),
  or an accession (`NC_000913.3`). Pick plastid, mitochondrion, plasmid, chromosome / genome or any;
  RefSeq records come first. A record over 20 Mb (a human chromosome) downloads as a stretch, the first
  1 Mb by default, with its genome coordinates kept.
- **Layout**: bases per row, the window columns (`1, 20, 40, 80, 160`), a range to show, the gaps, a
  margin, background and N colours, and how a tie between equally common bases is broken (A, then T, C,
  G; or whichever came first in the window).
- **Viewer**: pinch, Ctrl/⌘-scroll, `+` `-` `0` or the zoom bar. Zooming in lands on whole screen pixels
  per base so every base is the same size; zoomed out, each screen pixel is the true average of the bases
  under it, never a flickering sample.
- **Inspect**: tap or click any pixel for its position, the bases around it, and each column's call with
  the counts behind it.
- **Inverted repeats**: found from the sequence itself (16-mers whose reverse complement also occurs,
  gathered along one anti-diagonal), shown as LSC / IRb / SSC / IRa in the list and the inspector, and as
  optional marks in the viewer. Checked against Arabidopsis (IRs 84,171–110,434 and 128,215–154,478) and
  the Amborella GenBank annotation.
- **Save PNG**: the picture alone, without labels or ruler, exactly one pixel per base or scaled by a
  whole number. It is written as an indexed PNG, a few hundred KB for a plastome.

Your genomes and settings stay on the device between visits (genomes up to 64 Mb in all). Each genome is
written once; reordering or removing one only rewrites the short list, never the bases.

## Speed

All the heavy work (reading files, the window calls, the inverted-repeat search, every pixel) runs in a
background worker, so the page never stalls. Only the part of the picture near the screen is ever drawn,
in a few large tiles; zoomed out, tiles are averaged down, so memory stays flat however long the genome.

Measured on a phone-sized screen with Chrome's 4× CPU slowdown (its stand-in for a mid-range phone),
first version against this one:

| | v1 | v2 |
| --- | --- | --- |
| Zooming: slowest frame | 217 ms (9 frames over 50 ms) | 17 ms (none over 50 ms) |
| Opening a 5 Mb genome | 6.7 s, page frozen for 4.1 s | 0.4 s, longest pause 71 ms |
| Opening a 20 Mb genome | refused (too many pixels) | 0.4 s, no pause at all |
| Pixels held on screen after the 5 Mb genome | 25 million (100 MB) | 0.8 million (3 MB) |

Reading runs at 200–400 MB/s; the window calls for 20 Mb in four window sizes take about 120 ms.

## Robustness

- **Files**: CR, LF and CRLF line ends, byte-order marks, gzip (also concatenated gzip), lowercase and
  soft-masked bases, numbers and spaces inside GenBank sequence lines. A zip, BAM or other binary file,
  a web page, JSON, a protein FASTA, or a contig-only GenBank record is refused with a sentence saying
  what it is.
- **Size**: at most 96 million bases at once (48 million on a phone); a larger file is cut at that point
  and says so, and a stretch can be read straight out of a long file (From base / Length).
- **NCBI**: every request has a time limit, busy answers (429, 5xx) are retried twice with a pause, a
  stalled download is stopped, and the status line says what went wrong (offline, NCBI unreachable,
  limiting requests, no such accession). A Wi-Fi sign-in page is never taken for an answer.
- **Storage**: private browsing, a full disk or blocked storage only mean genomes are not kept; the page
  still works. Genomes saved by the first version move over by themselves.
- **No worker?** If the browser will not start one, the same engine runs on the page in short slices.
- **Security policy**: the site runs only its own scripts and talks only to itself and NCBI.

## On a phone

- **iPhone**: Safari, Share button, **Add to Home Screen**.
- **Android**: Chrome menu, **Install app** or **Add to Home screen**.

It then opens like an app, works offline (except NCBI), and costs nothing to reopen. When a new version
is published, a bar says "Version X is ready. Tap to update."; one tap swaps it in. If a phone still shows
the old one after that, the next tap clears the offline copy and loads fresh from the site, once.

## Development

Built from TypeScript with esbuild; the only build tools are esbuild and TypeScript (versions locked in
`package-lock.json`). `ppx` is the dev loop, like LowPingNews's `lpn`:

```sh
ppx status          repo / newest download / git, and what the live site serves
ppx sync            newest complete build (by the version inside, never the filename) -> repo
ppx test            type-check, test and build (needs node: pkg install nodejs)
ppx ship "msg"      commit and push; GitHub tests, builds and publishes the site
ppx release 2.1 "what changed"
                    bump the version, test, commit, tag, push, GitHub release
ppx init            first time: git, a GitHub repository, Pages and the first release
ppx web             switch Pages on and start a publish
ppx open            open the live site
ppx pack            make plastomepixels-v<version>.tar.gz, the archive sync takes
ppx clean           delete downloaded builds already synced
```

**How `sync` keeps your work.** A build comes in as a git commit on top of the code it was made from
(`ppx pack` in a clone of the GitHub repository records that commit) and is merged into the repository,
so git itself keeps whatever was done here since (edits, added files, deletions) and stops at any real
clash, listing the files, before a single file changes. Unsaved changes stop a sync until they are
shipped. A build that doesn't say what it was made from is only taken over a repository untouched since
the last sync. Also refused: an archive older than the repo (`PPX_FORCE=1` to go back), part of a
build, a download cut short, and archives holding links, devices or files this project does not own
(anything under `.git` included).

**How `release` keeps GitHub right.** It asks GitHub first, before pushing anything: a version GitHub
already has is never moved or reused, and offline nothing changes. It refuses a bare version bump (a
stale build synced by mistake), puts the version back when the tests fail, and checks that GitHub's
tag is exactly the one made here before it makes the release. A release that stopped half way (a
dropped connection) finishes when run again; the notes given the first time are kept in the tag.
`ship` and `release` refuse to commit files this project does not own, and a failed push goes out with
the next `ship`.

**Making a build** (for whoever works on the code): clone the GitHub repository, make the changes, set
the new version in `src/version.ts`, run `ppx test`, then `ppx pack ~/out`. On the phone: `ppx sync`,
then `ppx release <version> "notes"`.

### First time (Termux)

```sh
mkdir -p ~/PlastomePixels
tar xzf ~/storage/downloads/plastomepixels-v2.0.tar.gz -C ~/PlastomePixels
sh ~/PlastomePixels/install.sh      # puts ppx on your PATH
ppx init                            # git + github.com/<you>/PlastomePixels + Pages + release v2.0
```

`ppx init` needs `gh` signed in (`pkg install gh`, `gh auth login`); `ppx init OtherName` picks another
repository name. The site is up a few minutes later; `ppx status` shows when.

### Publishing

`.github/workflows/pages.yml` runs on every push to `main`: it type-checks, runs the tests, builds `site/`
and publishes it. A failing test stops the publish and the previous site stays up. As in LowPingNews,
each job holds only the rights it needs (the build job can only read the repository; only the deploy job
can publish) and every action is pinned to an exact commit.

Each publish carries its version three ways: `src/version.ts` (`APP_VERSION`), `version.json` beside the
app (what installed copies check for updates), and the service worker's cache name, so a phone never mixes
files from two versions.

### Building and testing by hand

```sh
npm ci                   # esbuild and TypeScript
npm run check            # TypeScript, strict
npm test                 # parser, window calls against brute force, tiles against a box filter,
                         # inverted repeats, NCBI query building, PNG encoder, speed
node build.mjs           # site/ (GitHub Pages), dist/plastome-pixels.html (one file that works offline,
                         # attached to each GitHub release) and dist/artifact-body.html (for claude.ai)
python3 test/browser.py  # 58 checks in Chromium: all three builds, phone pinch, offline start, a new
                         # version reaching an installed copy, NCBI failures, and the export
                         # compared pixel by pixel with an independent renderer
python3 test/perf/perf.py http://127.0.0.1:8765/site/ 4     # the measurements above
sh test/ppx.test.sh      # ppx itself: 45 checks of the phone workflow against a stand-in GitHub (15 s)
```

The browser tests and the perf harness need Playwright and a local server on port 8765 rooted at the repo
(`python3 -m http.server 8765 --bind 127.0.0.1`).

### Files

- `src/main.ts` the page: settings, loading, the genome list, inspector, export, NCBI search, updates
- `src/viewer.ts` the tiled viewer: scrolling, zoom and pinch, tile requests, ruler and headers
- `src/engine.ts` the background worker: genomes, window calls, tiles, PNG export, saving
- `src/client.ts` talks to the worker, or runs the engine on the page when no worker can start
- `src/seq.ts` the streaming parser (FASTA, GenBank, EMBL, plain, gzip)
- `src/analysis.ts` window calls, composition, inverted-repeat search
- `src/paint.ts` tile pixels, full resolution and averaged
- `src/png.ts` indexed PNG encoder, streamed through `CompressionStream`
- `src/ncbi.ts` NCBI E-utilities: search, summaries, download
- `src/sw.ts` the service worker; `src/version.ts` the version
- `src/template.html` markup and styles; `build.mjs` makes both builds
- `src/samples.ts` the two sample plastomes (Arabidopsis thaliana NC_000932.1, Amborella trichopoda
  AJ506156.2) at 2 bits per base, made by `scripts/make_samples.py` from `data/`
- `static/` icons, manifest, and the Martian Mono and Atkinson Hyperlegible fonts (SIL OFL)

## License

MIT. The fonts in `static/fonts` are under the SIL Open Font License (licences beside them).
