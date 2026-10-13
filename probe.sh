#!/bin/bash
# Evidence-branch probe: the three rows PR 128's hunts failed on Windows, five rounds per job.
set -uo pipefail
fails=0
for i in 1 2 3 4 5; do
  node --test --test-timeout=120000 --test-name-pattern="stops early|stopped early|killed outright" \
    test/browser.test.js test/interrupt.test.js > "$RUNNER_TEMP/r.$i.log" 2>&1
  rc=$?
  cat "$RUNNER_TEMP/r.$i.log"
  echo "PROBE round $i rc=$rc"
  [ $rc -ne 0 ] && fails=$((fails+1))
done
echo "PROBE failed_rounds=$fails of 5"
[ $fails -eq 0 ]
