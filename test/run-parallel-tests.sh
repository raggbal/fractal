#!/bin/bash
set -e
cd "$(dirname "$0")/.."

node test/build-standalone.js
node test/build-standalone-outliner.js
node test/build-standalone-notes.js

if ! curl -s http://localhost:3000 > /dev/null 2>&1; then
  npx serve test/html -l 3000 > /dev/null 2>&1 &
  SERVER_PID=$!
  trap "kill $SERVER_PID 2>/dev/null || true" EXIT
  sleep 2
fi

npx playwright test --shard=1/4 --workers=2 &
PID1=$!
npx playwright test --shard=2/4 --workers=2 &
PID2=$!
npx playwright test --shard=3/4 --workers=2 &
PID3=$!
npx playwright test --shard=4/4 --workers=2 &
PID4=$!

EXIT=0
wait $PID1 || EXIT=$?
wait $PID2 || EXIT=$?
wait $PID3 || EXIT=$?
wait $PID4 || EXIT=$?
exit $EXIT
