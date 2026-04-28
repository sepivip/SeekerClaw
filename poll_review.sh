#!/bin/bash
# Poll for new Copilot review on PR #343. Per dev-workflow Step 5b.
BASELINE=4187907633
GH="/c/Program Files/GitHub CLI/gh.exe"
echo "[poll] Baseline: $BASELINE — waiting for Copilot review on HEAD"
for i in $(seq 1 25); do
    sleep 60
    LATEST=$("$GH" api repos/sepivip/SeekerClaw/pulls/343/reviews 2>/dev/null | python -c "import json,sys; r=json.load(sys.stdin); print(r[-1]['id'] if r else 0)" 2>/dev/null)
    if [ -n "$LATEST" ] && [ "$LATEST" != "$BASELINE" ]; then
        echo "[poll] NEW REVIEW: $LATEST (after ${i} min)"
        "$GH" api repos/sepivip/SeekerClaw/pulls/343/reviews/$LATEST 2>&1 | python -c "
import json, sys, re
r = json.load(sys.stdin)
body = r.get('body','')
m = re.search(r'generated (\d+)|generated no new', body)
print(f'State: {r[\"state\"]}')
print(f'Commit: {r.get(\"commit_id\",\"?\")[:7]}')
print(f'Summary: {m.group(0) if m else \"?\"}')
"
        break
    fi
    echo "[poll] tick $i — still id=$LATEST"
done
echo "[poll] done"
