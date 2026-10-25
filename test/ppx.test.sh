#!/bin/sh
# ppx's own tests: the whole phone workflow (init, sync, release, ship, pack, clean) in a throwaway HOME,
# with a local bare repository standing in for GitHub (its pre-receive hook can refuse pushes) and a fake
# gh. Covers the ways a sync or a release could lose work, publish the wrong thing or move a published tag,
# including every case two independent reviews reproduced.
# usage: sh test/ppx.test.sh [--node]   (--node also runs the test suite at each release: slower)
# needs git, GNU tar/sed/touch/date and python3 (Termux or Linux)
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SIM="$(mktemp -d 2>/dev/null || mktemp -d -t ppxtest)"
trap 'rm -rf "$SIM"' EXIT
mkdir -p "$SIM/home/storage/downloads" "$SIM/home/downloads" "$SIM/work" "$SIM/home/fakebin" "$SIM/nonode"
export HOME="$SIM/home"
for c in sh dash git tar gzip awk sed grep cut paste sort find cksum cmp mktemp rm cp mv mkdir cat head tail tr wc basename dirname touch chmod ls env date sleep timeout printf test expr id uname ln readlink python3; do
  p="$(command -v "$c" 2>/dev/null)" && ln -sf "$p" "$SIM/nonode/$c"
done
NODEPATH="$HOME/.local/bin:$HOME/fakebin:/usr/local/bin:/usr/bin:/bin"
NONODE="$HOME/.local/bin:$HOME/fakebin:$SIM/nonode"
if [ "${1:-}" = --node ]; then export PATH="$NODEPATH"; else export PATH="$NONODE"; fi
export GIT_CONFIG_GLOBAL="$HOME/.gitconfig"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset GH_TOKEN PREFIX PPX_REPO PPX_DOWNLOADS PPX_FORCE PPX_GH_REPO
export PPX_NOFETCH=1
git config --global init.defaultBranch main
git config --global advice.detachedHead false
pass=0; fail=0
check() { if eval "$2"; then pass=$((pass + 1)); echo "PASS $1"; else fail=$((fail + 1)); echo "FAIL $1"; fi; }
show() { printf '%s\n' "$1" | sed 's/^/      | /'; }

# "GitHub": a bare repository at a path that reads like github.com/owner/name, so ppx finds the slug
RG="$HOME/github.com/ATinyGreenCell/PlastomePixels.git"
mkdir -p "$(dirname "$RG")" && git init -q --bare -b main "$RG"
cat > "$RG/hooks/pre-receive" <<'EOF'
#!/bin/sh
while read -r o n ref; do
  [ -f "$HOME/block-push" ] && { echo "blocked $ref" >&2; exit 1; }
  case "$ref" in refs/tags/*) [ -f "$HOME/block-tags" ] && { echo "blocked $ref" >&2; exit 1; } ;; esac
done
exit 0
EOF
chmod +x "$RG/hooks/pre-receive"
cat > "$HOME/fakebin/gh" <<'EOF'
#!/bin/sh
printf 'gh' >> "$HOME/gh.log"; for a in "$@"; do printf ' [%s]' "$a" >> "$HOME/gh.log"; done; echo >> "$HOME/gh.log"
case "$1 $2" in
  "repo create") git remote add origin "$HOME/github.com/ATinyGreenCell/$3.git" ;;
  "api -X"|"workflow run"|"release edit"|"release upload") exit 0 ;;
  "run list") echo "${FAKE_RUN:-completed success 3 4242}" ;;
  "release view") [ -f "$HOME/rel-$3" ] ;;
  "release create") [ -f "$HOME/rel-$3" ] && exit 1; touch "$HOME/rel-$3"; printf '%s' "$*" > "$HOME/rel-$3" ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$HOME/fakebin/gh"
P="$HOME/PlastomePixels"
rtag() { git --git-dir="$RG" rev-parse -q --verify "refs/tags/$1^{commit}" 2>/dev/null || echo none; }
head_is() { [ "$(git -C "$P" rev-parse HEAD)" = "$1" ]; }
# mkbuild VERSION DEST FROM [snippet]: an archive made from FROM ("git": a clone of GitHub's main, so the
# build says what it was made from; "plain": the v2.0 archive's files, so it doesn't; or a clone's path)
# after running snippet inside it
mkbuild() {
  b="$SIM/work/build-$1-$(date +%s%N)"; mkdir -p "$b"
  case "$3" in
    git) git clone -q "$RG" "$b" 2>/dev/null ;;
    plain) tar xzf "$SIM/work/v20.tar.gz" -C "$b" ;;
    *) cp -R "$3/." "$b/" ;;
  esac
  sed -i "s/APP_VERSION = \"[^\"]*\"/APP_VERSION = \"$1\"/" "$b/src/version.ts"
  [ -n "${4:-}" ] && (cd "$b" && eval "$4")
  PPX_REPO="$b" sh "$b/ppx" pack "$2" >/dev/null || echo "mkbuild failed"
}
rmb() { rm -f "$HOME"/downloads/*.tar.gz "$HOME"/storage/downloads/*.tar.gz; }

# ---- the delivered v2.0 archive, and the README's first-time steps ----
out="$(PPX_REPO="$SRC" sh "$SRC/ppx" pack "$SIM/work" 2>&1)"; show "$out"
cp "$SIM/work/plastomepixels-v2.0.tar.gz" "$SIM/work/v20.tar.gz"
mv "$SIM/work/plastomepixels-v2.0.tar.gz" "$HOME/storage/downloads/"
check "pack: a complete v2.0 archive" 'tar tzf "$SIM/work/v20.tar.gz" | grep -qx src/version.ts'
mkdir -p "$P" && tar xzf "$HOME/storage/downloads/plastomepixels-v2.0.tar.gz" -C "$P" && sh "$P/install.sh" >/dev/null 2>&1
check "install.sh puts ppx on PATH" '[ "$(command -v ppx)" = "$HOME/.local/bin/ppx" ]'
out="$(ppx init 2>&1)"; show "$out"
check "init: repository, main and tag v2.0 on GitHub, first release" 'head_is "$(git --git-dir="$RG" rev-parse main)" && [ "$(rtag v2.0)" = "$(git -C "$P" rev-parse HEAD)" ] && [ -f "$HOME/rel-v2.0" ] && echo "$out" | grep -q "released v2.0"'
check "init: Pages on before the first push" 'awk "/pages/ {p=NR} /release\] \[create/ {r=NR} END {exit !(p && r && p < r)}" "$HOME/gh.log"'
check "init: the extracted files are the synced build" '[ "$(git -C "$P" rev-parse refs/ppx/synced)" = "$(git -C "$P" rev-parse HEAD)" ]'
check "init committed nothing foreign" '! git -C "$P" ls-files | grep -qE "^(node_modules|site|dist)/"'
out="$(ppx init 2>&1)"
check "init again just finishes (nothing new)" 'echo "$out" | grep -q "released v2.0"'
out="$(ppx release 2.0 "First Pages release" 2>&1)"; show "$out"
check "release 2.0 after init: finished, notes updated, tag kept" 'echo "$out" | grep -q "finishing v2.0" && echo "$out" | grep -q "notes updated" && [ "$(rtag v2.0)" = "$(git -C "$P" rev-parse HEAD)" ]'

# ---- a build made from GitHub, with decoys around it ----
mkbuild 2.1 "$HOME/downloads" git 'git rm -q test/perf/perf.py; echo "# newer ppx" >> ppx; echo "Changed." >> README.md'
touch -d '2020-01-01' "$HOME/downloads/plastomepixels-v2.1.tar.gz"
cp "$SIM/work/v20.tar.gz" "$HOME/storage/downloads/plastomepixels-v9.0.tar.gz"     # an old build, renamed
python3 - "$HOME/storage/downloads" "$SIM/work/v20.tar.gz" <<'EOF'
import io, sys, tarfile
d, v20 = sys.argv[1], sys.argv[2]
with tarfile.open(v20) as t:
    full = [(m, t.extractfile(m).read()) for m in t.getmembers() if m.isfile()]
def mk(path, ver, extra):
    with tarfile.open(path, "w:gz", format=tarfile.GNU_FORMAT) as t:
        for m, data in full:
            if m.name == "src/version.ts": data = ('export const APP_VERSION = "%s";\n' % ver).encode()
            ti = tarfile.TarInfo(m.name); ti.size = len(data); ti.mode = m.mode; t.addfile(ti, io.BytesIO(data))
        for ti, data in extra:
            t.addfile(ti, io.BytesIO(data) if data is not None else None)
def f(name, data=b"x\n", mode=0o644, kind=None):
    ti = tarfile.TarInfo(name); ti.mode = mode
    if kind: ti.type = kind
    else: ti.size = len(data)
    return ti, (data if not kind else None)
mk(d + "/plastomepixels-v9.9.tar.gz", "9.9", [f(".//.git/hooks/pre-commit", b"#!/bin/sh\necho HOOK RAN\n", 0o755)])
mk(d + "/plastomepixels-v9.8.tar.gz", "9.8", [f("evil.sh", b"rm -rf ~\n")])
mk(d + "/plastomepixels-v9.5.tar.gz", "9.5", [f("src/zz.ts", kind=tarfile.FIFOTYPE)])
with tarfile.open(d + "/plastomepixels-v9.6.tar.gz", "w:gz") as t:
    ti, data = f("src/version.ts", b'export const APP_VERSION = "9.6";\n'); t.addfile(ti, io.BytesIO(data))
EOF
printf 'not gzip' > "$HOME/storage/downloads/plastomepixels-v9.7.tar.gz"
out="$(ppx sync 2>&1)"; show "$out"
check "sync picks v2.1 by the version inside" 'echo "$out" | grep -q "synced v2.1 from plastomepixels-v2.1.tar.gz" && [ "$(ppx version)" = "2.1" ]'
check "sync skips: a .git path, a foreign file, a FIFO, a cut-short and a partial archive" 'for n in 9.9 9.8 9.5; do echo "$out" | grep -q "v$n.tar.gz: holds" || exit 1; done; echo "$out" | grep -q "v9.7.tar.gz: not a whole" && echo "$out" | grep -q "v9.6.tar.gz: only part" && [ ! -e "$P/.git/hooks/pre-commit" ] && [ ! -e "$P/evil.sh" ] && [ ! -e "$P/src/zz.ts" ]'
check "sync applies the build: dropped file gone, ppx updated, all committed" '[ ! -e "$P/test/perf/perf.py" ] && tail -n 1 "$HOME/.local/bin/ppx" | grep -q "newer ppx" && [ -z "$(git -C "$P" status --porcelain)" ]'
out="$(ppx sync 2>&1)"
check "the same build again: already synced" 'echo "$out" | grep -q "already synced"'
out="$(ppx release 2.1 "Second" 2>&1)"; show "$out"
check "release 2.1: tagged, pushed, released with its notes" '[ "$(rtag v2.1)" = "$(git -C "$P" rev-parse HEAD)" ] && grep -q Second "$HOME/rel-v2.1"'
n_edit="$(grep -c 'release\] \[edit\] \[v2.1' "$HOME/gh.log")"
out="$(ppx release 2.1 2>&1)"
check "the same release again: nothing moves, notes kept" 'echo "$out" | grep -q "finishing v2.1" && echo "$out" | grep -q "already made" && [ "$(grep -c "release\] \[edit\] \[v2.1" "$HOME/gh.log")" = "$n_edit" ]'
out="$(ppx release 2.2 2>&1)"
check "a bare version bump is refused" 'echo "$out" | grep -q "nothing changed" && [ "$(ppx version)" = "2.1" ]'

# ---- releases that stop part way, or reuse a number ----
echo "// 2.2 work" >> "$P/src/main.ts"
touch "$HOME/block-tags"; out="$(ppx release 2.2 "Third, with notes" 2>&1)"; rm "$HOME/block-tags"; show "$out"
check "a failed tag push says so" 'echo "$out" | grep -q "pushing tag v2.2 failed" && [ "$(rtag v2.2)" = none ]'
out="$(ppx release 2.2 2>&1)"; show "$out"
check "...the same release again pushes it, with the notes given the first time" '[ "$(rtag v2.2)" = "$(git -C "$P" rev-parse HEAD)" ] && grep -q "Third, with notes" "$HOME/rel-v2.2"'
echo "// more" >> "$P/src/engine.ts"; ppx ship "more" >/dev/null 2>&1
old="$(rtag v2.2)"; out="$(ppx release 2.2 "oops" 2>&1)"
check "a released version never moves to newer work" 'echo "$out" | grep -q "already released" && [ "$(rtag v2.2)" = "$old" ]'
git -C "$P" tag -d v2.2 >/dev/null; mainb="$(git --git-dir="$RG" rev-parse main)"; echo "// newer" >> "$P/src/engine.ts"; git -C "$P" commit -qam newer
out="$(ppx release 2.2 "again" 2>&1)"
check "...even with the local tag gone: refused before anything is pushed" 'echo "$out" | grep -q "already released" && [ "$(git --git-dir="$RG" rev-parse main)" = "$mainb" ]'
git -C "$P" fetch -q origin "refs/tags/v2.2:refs/tags/v2.2"
mv "$RG" "$RG.off"; out="$(ppx release 2.2 "offline" 2>&1)"; mv "$RG.off" "$RG"
check "offline: nothing is changed, the tag stays put" 'echo "$out" | grep -q "can.t be reached" && [ "$(git -C "$P" rev-parse v2.2^{commit})" = "$old" ]'
ppx ship "newer" >/dev/null 2>&1
echo "// broken" >> "$P/src/main.ts"; ppx ship "broken" >/dev/null 2>&1
for t in node npm npx; do printf '#!/bin/sh\nexit 1\n' > "$HOME/fakebin/$t"; chmod +x "$HOME/fakebin/$t"; done
out="$(PATH="$NODEPATH" ppx release 2.3 "fails" 2>&1)"; rm -f "$HOME/fakebin/node" "$HOME/fakebin/npm" "$HOME/fakebin/npx"
check "tests fail: nothing committed, the version goes back" 'echo "$out" | grep -q "tests failed" && [ "$(ppx version)" = "2.2" ] && [ -z "$(git -C "$P" status --porcelain)" ] && [ "$(rtag v2.3)" = none ]'
out="$(ppx release 2.3 "Fourth" 2>&1)"
check "release 2.3 once things work" '[ "$(rtag v2.3)" = "$(git -C "$P" rev-parse HEAD)" ]'

# ---- builds that must not undo work done here ----
echo "// owner's shipped fix" >> "$P/src/viewer.ts"; ppx ship "owner fix" >/dev/null 2>&1
git -C "$P" rm -q scripts/make_icons.py; ppx ship "drop make_icons" >/dev/null 2>&1
mkbuild 2.4 "$HOME/downloads" plain 'echo "// claude change" >> src/paint.ts'
out="$(ppx sync 2>&1)"; show "$out"
check "a build that doesn't say what it was made from is refused when there is work here" 'echo "$out" | grep -q "doesn.t say what it was made from" && grep -q "owner.s shipped fix" "$P/src/viewer.ts" && [ ! -e "$P/scripts/make_icons.py" ] && [ "$(ppx version)" = "2.3" ]'
rmb
old_clone="$SIM/work/oldclone"; git clone -q "$RG" "$old_clone"; git -C "$old_clone" reset -q --hard v2.3
mkbuild 2.4 "$HOME/downloads" "$old_clone" 'echo "// claude change" >> src/paint.ts; sed -i "1s|^|// claude, top of viewer\\n|" src/viewer.ts'
out="$(ppx sync 2>&1)"; show "$out"
check "a build from an older commit is merged: the fix and the deletion stay, its changes arrive" 'echo "$out" | grep -q "synced v2.4" && grep -q "owner.s shipped fix" "$P/src/viewer.ts" && grep -q "claude, top of viewer" "$P/src/viewer.ts" && grep -q "claude change" "$P/src/paint.ts" && [ ! -e "$P/scripts/make_icons.py" ]'
ppx release 2.4 "Fifth" >/dev/null 2>&1
rmb
sed -i '1s|^|// owner edit at the top\n|' "$P/src/png.ts"; ppx ship "owner png" >/dev/null 2>&1
git -C "$old_clone" fetch -q origin; git -C "$old_clone" reset -q --hard v2.4
mkbuild 2.5 "$HOME/downloads" "$old_clone" 'sed -i "1s|^|// claude edit at the top\n|" src/png.ts'
out="$(ppx sync 2>&1)"; show "$out"
check "a real clash (both changed the same lines) is refused, naming the file, changing nothing" 'echo "$out" | grep -q "both changed" && echo "$out" | grep -q "src/png.ts" && grep -q "owner edit at the top" "$P/src/png.ts" && [ -z "$(git -C "$P" status --porcelain)" ] && [ "$(ppx version)" = "2.4" ]'
rmb
echo "UNSAVED WORK" >> "$P/README.md"
mkbuild 2.5 "$SIM/work" git 'echo "// 2.5" >> src/engine.ts'
head -c 20000 "$SIM/work/plastomepixels-v2.5.tar.gz" > "$HOME/downloads/plastomepixels-v2.5.tar.gz"
out="$(ppx sync 2>&1)"; show "$out"
check "a cut-short newer build is skipped" 'echo "$out" | grep -q "v2.5.tar.gz: not a whole"'
mv "$SIM/work/plastomepixels-v2.5.tar.gz" "$HOME/downloads/plastomepixels-v2.5.tar.gz"
out="$(ppx sync 2>&1)"; show "$out"
out2="$(PPX_FORCE=1 ppx sync 2>&1)"
check "unsaved changes block a sync (even forced), and are named" 'echo "$out" | grep -q "unsaved changes" && echo "$out" | grep -q README.md && echo "$out2" | grep -q "unsaved changes" && grep -q "UNSAVED WORK" "$P/README.md"'
ppx ship "notes in README" >/dev/null 2>&1
out="$(ppx sync 2>&1)"; show "$out"
check "once shipped, the build merges in and the notes stay" 'echo "$out" | grep -q "synced v2.5" && grep -q "UNSAVED WORK" "$P/README.md" && grep -q "// 2.5" "$P/src/engine.ts"'
ppx release 2.5 "Sixth" >/dev/null 2>&1

# ---- a new phone: a fresh clone, no record of syncs ----
rm -rf "$P"; git clone -q "$RG" "$P"
mkbuild 2.6 "$HOME/downloads" plain 'echo "// x" >> src/paint.ts'
out="$(ppx sync 2>&1)"
check "fresh clone: a build that doesn't say what it was made from is refused" 'echo "$out" | grep -q "doesn.t say what it was made from" && [ "$(ppx version)" = "2.5" ]'
rmb
echo "# OWNER'S UNSAVED PERF WORK" >> "$P/src/png.ts"
mkbuild 2.6 "$HOME/downloads" git 'git rm -q src/png.ts 2>/dev/null; echo "// c" >> src/paint.ts'
out="$(ppx sync 2>&1)"
check "fresh clone: unsaved edits in a file the build drops are kept" 'echo "$out" | grep -q "unsaved changes" && grep -q "OWNER.S UNSAVED PERF WORK" "$P/src/png.ts"'
git -C "$P" checkout -q -- .
rmb
mkbuild 2.6 "$HOME/downloads" git 'echo "// 2.6" >> src/paint.ts'
echo "export const extra = 1;" > "$P/src/extra.ts"; ppx ship "add extra" >/dev/null 2>&1
out="$(ppx sync 2>&1)"; show "$out"
check "fresh clone: a build from before an added file keeps the file" 'echo "$out" | grep -q "synced v2.6" && [ -f "$P/src/extra.ts" ]'

# ---- two builds of one version, pack, ship, clean ----
ppx release 2.6 "Seventh" >/dev/null 2>&1
rmb
mkbuild 2.7 "$HOME/downloads" git 'echo "// first 2.7" >> src/engine.ts'
touch -d '2020-01-01' "$HOME/downloads/plastomepixels-v2.7.tar.gz"
mkbuild 2.7 "$SIM/work" git 'echo "// corrected 2.7" >> src/engine.ts'
mv "$SIM/work/plastomepixels-v2.7.tar.gz" "$HOME/storage/downloads/plastomepixels-v2.7 (1).tar.gz"
out="$(ppx sync 2>&1)"; show "$out"
check "same version twice: the newer download wins (spaces in its name)" 'echo "$out" | grep -q "synced v2.7 from plastomepixels-v2.7 (1).tar.gz" && grep -q "corrected 2.7" "$P/src/engine.ts" && ! grep -q "first 2.7" "$P/src/engine.ts"'
out="$(ppx sync 2>&1)"
check "...and the older of the two is not taken afterwards" 'echo "$out" | grep -q "already synced"'
ppx release 2.7 "Eighth" >/dev/null 2>&1
rmb
out="$(cd "$P/src" && ppx pack 2>&1)"; show "$out"
check "pack from a subfolder: whole project, outside it, with its base commit" '[ -f "$HOME/downloads/plastomepixels-v2.7.tar.gz" ] && [ "$(tar tzf "$HOME/downloads/plastomepixels-v2.7.tar.gz" | grep -c .)" -ge 45 ] && [ "$(tar xzf "$HOME/downloads/plastomepixels-v2.7.tar.gz" -O .ppx-base)" = "$(git -C "$P" rev-parse HEAD)" ] && [ -z "$(find "$P" -name "*.tar.gz")" ]'
out="$(ppx pack "$P/src" 2>&1)"
check "pack refuses to write into the project" 'echo "$out" | grep -q "outside the project"'
touch "$P/src/a b.ts"; out="$(ppx ship "space" 2>&1)"
check "ship accepts an owned file with a space in its name" 'echo "$out" | grep -q pushed'
git -C "$P" rm -q "src/a b.ts" && ppx ship "drop it" >/dev/null 2>&1
echo x > "$P/notes.txt"; out="$(ppx ship "Notes" 2>&1)"; rm "$P/notes.txt"
check "ship refuses a file the project does not own" 'echo "$out" | grep -q "does not own: notes.txt"'
echo "// offline edit" >> "$P/src/main.ts"
touch "$HOME/block-push"; out="$(ppx ship "offline" 2>&1)"; rm "$HOME/block-push"
check "a failed push keeps the commit" 'echo "$out" | grep -q "push failed" && git -C "$P" log -1 --format=%s | grep -qx offline'
out="$(ppx ship "again" 2>&1)"
check "...and the next ship pushes it" 'echo "$out" | grep -q pushed && [ "$(git --git-dir="$RG" rev-parse main)" = "$(git -C "$P" rev-parse HEAD)" ]'
rmb
mkbuild 2.6 "$HOME/storage/downloads" plain
out="$(ppx sync 2>&1)"
check "an older archive is refused" 'echo "$out" | grep -q "older than"'
check "status reads the publish runs" '[ "$(FAKE_RUN="completed failure 75 4243" ppx status 2>/dev/null | tail -n 1 | grep -c FAILED)" = 1 ]'
mkbuild 2.8 "$HOME/downloads" git 'echo "// 2.8" >> src/engine.ts'
cp "$SIM/work/v20.tar.gz" "$HOME/storage/downloads/plastomepixels-v9.0.tar.gz"
printf 'junk' > "$HOME/storage/downloads/plastomepixels-v9.7.tar.gz"
out="$(ppx clean 2>&1)"; show "$out"
check "clean keeps the build not synced yet, removes old and broken ones" '[ -f "$HOME/downloads/plastomepixels-v2.8.tar.gz" ] && [ "$(find "$HOME/downloads" "$HOME/storage/downloads" -name "*.tar.gz" | grep -c .)" = 1 ]'
git -C "$old_clone" fetch -q origin; git -C "$old_clone" reset -q --hard v2.5
mkbuild 2.9 "$HOME/downloads" "$old_clone" 'echo "// 2.9 change" >> src/client.ts'
out="$(ppx sync 2>&1)"; show "$out"
check "a build from before later releases (both bumped the version) merges with the build's version" 'echo "$out" | grep -q "synced v2.9" && [ "$(ppx version)" = "2.9" ] && grep -q "2.9 change" "$P/src/client.ts" && grep -q "corrected 2.7" "$P/src/engine.ts" && [ -z "$(git -C "$P" status --porcelain)" ]'
out="$(ppx init 2>&1)"
check "init on a released repository refuses" 'echo "$out" | grep -q "already set up"'
out="$(ppx bogus 2>&1)"; rc=$?
check "an unknown command prints usage and fails" '[ $rc -ne 0 ] && echo "$out" | grep -q "ppx status"'
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
