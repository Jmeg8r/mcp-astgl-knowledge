#!/usr/bin/env bash
# WHAT: Self-test for scan-staged-binaries.sh.
#
# WHY:  This gate exists because a scanner reported "clean" on files it never
#       read. A test that cannot tell those two states apart would reproduce the
#       original defect, so every case below asserts on WHAT WAS INSPECTED, not
#       just on the exit code.
#
# FIXTURES ARE REAL, DELIBERATELY. The PDFs are built with genuinely
#       Flate-compressed content streams (python3 + zlib, both stdlib) and the
#       xlsx is a real zip container. A text file merely NAMED .pdf would pass
#       every check here while proving nothing -- that shortcut is exactly how a
#       fixture ends up encoding the wrong belief.
#
# Run:  scripts/selftest-binary-scan.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/scan-staged-binaries.sh"

# Detach from any inherited git context before the throwaway repos below are created.
#
# WHY: git exports GIT_DIR (an absolute path) into every hook it runs, so the `git init`
# on line ~76 produced a repo that still resolved to the OUTER repository -- inside the
# pre-push hook this failed with "fatal: this operation must be run in a work tree".
# The suite passes standalone and fails only on a real `git push`. SUT above is resolved
# from BASH_SOURCE, not from git, so nothing here needs the ambient repo.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE
# Split so the literal never appears as a matchable token in this file -- a test
# fixture that trips the primary gate would block the commit that adds the test.
SECRET="cr-""0123456789abcdefghijklmnop"

# Assert EVERY tool this suite depends on, not just the obvious one.
#
# WHY all three: a missing tool here does not produce a failure, it produces a
# false pass, which is the defect this whole suite was written against.
#   gitleaks  -- the system under test.
#   python3   -- builds every fixture. Without it `set -e` kills the run inside
#                build_pdf before a single case reports, so the suite dies rather
#                than passing; loud, but it would still be reported as "no output".
#   pdftotext -- what the SUT uses for PDFs. Without it the SUT emits UNKNOWN for
#                doc.pdf, which is the exact string case 10 asserts. Every PDF case
#                then goes green while proving nothing about the version canary
#                they exist to check. This is the dangerous one: silent, and it
#                looks identical to success.
# Skipping loudly beats passing falsely.
for tool in gitleaks python3 pdftotext; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "SKIP: $tool not installed — this suite cannot distinguish pass from no-op without it"
    [ "$tool" = pdftotext ] && echo "      (brew install poppler)"
    exit 0
  }
done

pass=0; fail=0
ok()   { pass=$((pass+1)); echo "  ✓ $1"; }
# shellcheck disable=SC2001  # prefixing EVERY line needs sed; ${x//a/b} cannot.
bad()  { fail=$((fail+1)); echo "  ✗ $1"; echo "$2" | sed 's/^/        /'; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- fixture builders (stdlib only, so this runs anywhere) ------------------
build_pdf() {  # build_pdf <out> <text|empty>
  python3 - "$1" "${2-}" <<'PY'
import io, sys, zlib
out, text = sys.argv[1], sys.argv[2]
content = (f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET" if text else "").encode()
stream = zlib.compress(content)           # real deflate -- the whole point
objs = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R"
    b"/Resources<</Font<</F1 5 0 R>>>>>>",
    b"<</Length %d/Filter/FlateDecode>>\nstream\n" % len(stream) + stream + b"\nendstream",
    b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
]
buf = io.BytesIO(); buf.write(b"%PDF-1.4\n"); offs = []
for i, o in enumerate(objs, 1):
    offs.append(buf.tell()); buf.write(b"%d 0 obj " % i + o + b" endobj\n")
xref = buf.tell()
buf.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
for o in offs:
    buf.write(b"%010d 00000 n \n" % o)
buf.write(b"trailer <</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref))
open(out, "wb").write(buf.getvalue())
PY
}

build_xlsx() {  # build_xlsx <out> <text>
  python3 - "$1" "$2" <<'PY'
import sys, zipfile
out, text = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
    z.writestr("xl/sharedStrings.xml", f'<?xml version="1.0"?><sst><si><t>{text}</t></si></sst>')
PY
}

# --- harness ---------------------------------------------------------------
# Each case runs in a throwaway repo so staging state never leaks between them.
new_repo() {
  local d="$WORK/$1"; mkdir -p "$d"; cd "$d"
  git init -q .

  # Refuse to continue unless `git init` really produced a repo HERE.
  #
  # WHY this is worth six lines: when GIT_DIR is inherited (as it is inside every git
  # hook), `git init .` does not create a new repo -- it RE-INITIALISES the one GIT_DIR
  # points at, from a cwd that is not its work tree, and writes `core.bare = true` into
  # the shared config. On 2026-08-08 that ran during a real `git push` and left the
  # repository and both of its worktrees unusable until core.bare was reset by hand; the
  # `git config user.email t@t.t` below landed in the shared config in the same breath.
  # The unset above prevents it. This assertion is what makes a regression loud and
  # local instead of silent and repo-wide.
  local root; root="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"
  if [ "$root" != "$(pwd -P)" ]; then
    echo "FATAL: temp repo resolved to '${root:-<none>}', not '$(pwd -P)'." >&2
    echo "       An ambient GIT_DIR is leaking in. Refusing to touch that repository." >&2
    exit 1
  fi

  git config --local user.email t@t.t; git config --local user.name t
  cp "$SCRIPT_DIR/../.gitleaks.toml" .
  git add .gitleaks.toml
}

run_sut() { set +e; SUT_OUT="$("$SUT" 2>&1)"; SUT_RC=$?; set -e; }

echo "scan-staged-binaries.sh self-test"

# 1. THE CORE CASE: secret inside a really-compressed PDF must be caught.
new_repo c1
build_pdf secret.pdf "API key: $SECRET"
git add secret.pdf; run_sut
if [ "$SUT_RC" -ne 0 ] && grep -q "SECRET in secret.pdf" <<<"$SUT_OUT"; then
  ok "compressed PDF: secret detected, commit blocked"
else bad "compressed PDF: secret NOT detected (rc=$SUT_RC)" "$SUT_OUT"; fi

# 2. REGRESSION GUARD for the approach itself: prove the raw-byte scan this
#    replaces would have MISSED that same file. If this ever starts passing,
#    raw scanning became viable and the pdftotext dependency can be revisited.
if gitleaks stdin --no-banner --redact --config .gitleaks.toml < secret.pdf 2>&1 \
     | grep -q "no leaks found"; then
  ok "raw-byte scan of the same PDF finds nothing (why pdftotext is required)"
else bad "raw-byte scan now finds it — revisit the pdftotext dependency" ""; fi

# 3. Secret inside a real xlsx (zip container) must be caught.
new_repo c3
build_xlsx book.xlsx "token $SECRET"
git add book.xlsx; run_sut
if [ "$SUT_RC" -ne 0 ] && grep -q "SECRET in book.xlsx" <<<"$SUT_OUT"; then
  ok "xlsx: secret inside zip container detected"
else bad "xlsx: secret NOT detected (rc=$SUT_RC)" "$SUT_OUT"; fi

# 4. Clean binaries pass -- and REPORT that bytes were actually read.
new_repo c4
build_pdf clean.pdf "quarterly revenue notes, nothing sensitive"
build_xlsx clean.xlsx "ordinary spreadsheet text"
git add clean.pdf clean.xlsx; run_sut
if [ "$SUT_RC" -eq 0 ] && grep -qE "inspected 2 file\(s\), [1-9][0-9]* bytes read" <<<"$SUT_OUT"; then
  ok "clean binaries pass AND report non-zero bytes read"
else bad "clean binaries: wrong verdict or zero-byte 'pass' (rc=$SUT_RC)" "$SUT_OUT"; fi

# 5. Image-only PDF must read as UNKNOWN, never as clean. This is the exact
#    "scanned ~0 bytes -> no leaks found" failure the whole gate exists to stop.
new_repo c5
build_pdf scanned.pdf ""
git add scanned.pdf; run_sut
if [ "$SUT_RC" -ne 0 ] && grep -q "UNKNOWN" <<<"$SUT_OUT"; then
  ok "image-only PDF reports UNKNOWN instead of clean"
else bad "image-only PDF reported clean (rc=$SUT_RC)" "$SUT_OUT"; fi

# 6. Opaque formats are reported as NOT INSPECTED but do not block.
new_repo c6
printf '\x89PNG\r\n\x1a\n binary junk' > shot.png
git add shot.png; run_sut
if [ "$SUT_RC" -eq 0 ] && grep -q "NOT INSPECTED" <<<"$SUT_OUT"; then
  ok "opaque file reported as NOT INSPECTED, does not block"
else bad "opaque file handling wrong (rc=$SUT_RC)" "$SUT_OUT"; fi

# 7. Filenames with spaces. This repo family really has one ("The High-Paying
#    YouTube Niches Report.pdf"), so word-splitting here would be a live bug.
new_repo c7
build_pdf "My Quarterly Report.pdf" "API key: $SECRET"
git add "My Quarterly Report.pdf"; run_sut
# Assert on "SECRET in <name>", not merely on the name appearing somewhere: the
# name also shows up in the UNKNOWN list, so the looser check passed against a
# deliberately broken build.
if [ "$SUT_RC" -ne 0 ] && grep -q "SECRET in My Quarterly Report.pdf" <<<"$SUT_OUT"; then
  ok "filename with spaces handled"
else bad "filename with spaces mishandled (rc=$SUT_RC)" "$SUT_OUT"; fi

# 8. The STAGED blob is what gets scanned, not the worktree file. Staging a
#    secret and then cleaning the worktree copy must still block the commit --
#    it is the staged bytes that are about to ship.
new_repo c8
build_pdf sneaky.pdf "API key: $SECRET"
git add sneaky.pdf
build_pdf sneaky.pdf "totally innocent now"   # worktree cleaned AFTER staging
run_sut
if [ "$SUT_RC" -ne 0 ] && grep -q "SECRET in sneaky.pdf" <<<"$SUT_OUT"; then
  ok "scans the staged blob, not the worktree copy"
else bad "scanned worktree instead of staged blob (rc=$SUT_RC)" "$SUT_OUT"; fi

# 9. No binaries staged -> fast, explicit no-op.
new_repo c9
printf 'plain text, primary gate handles this\n' > notes.md
git add notes.md; run_sut
if [ "$SUT_RC" -eq 0 ] && grep -q "no binary or document files staged" <<<"$SUT_OUT"; then
  ok "no binaries staged: explicit no-op"
else bad "empty case wrong (rc=$SUT_RC)" "$SUT_OUT"; fi

# 10. The version canary must fail closed. lefthook runs a bare `gitleaks`, so an
#     old binary on PATH is a real scenario (a reviewer's sandbox reported 1.7.3).
#     Simulate it with a stub that answers like a tool lacking these subcommands:
#     the gate must report UNKNOWN, not pass.
new_repo c10
build_pdf doc.pdf "API key: $SECRET"
git add doc.pdf
mkdir -p "$WORK/stub"
printf '#!/bin/sh\necho "unknown command" >&2\nexit 2\n' > "$WORK/stub/gitleaks"
chmod +x "$WORK/stub/gitleaks"
set +e
STUB_OUT="$(PATH="$WORK/stub:$PATH" "$SUT" 2>&1)"; STUB_RC=$?
set -e
# Assert the CAUSE, not just the word UNKNOWN.
#
# "UNKNOWN" alone is emitted by several unrelated paths -- notably a missing
# pdftotext -- so matching it proved only that something went wrong, not that the
# version canary was what caught it. The precondition check above now rules out
# the pdftotext case, and this asserts the specific reason string so the two can
# never be confused again even if that check is later relaxed.
# shellcheck disable=SC2016  # single quotes are deliberate: the backticks are literal
if [ "$STUB_RC" -ne 0 ] && grep -q 'no working `stdin` scan' <<<"$STUB_OUT"; then
  ok "unsupported gitleaks on PATH fails closed as UNKNOWN (named the version canary)"
else bad "unsupported gitleaks did not fail closed via the version canary (rc=$STUB_RC)" "$STUB_OUT"; fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
