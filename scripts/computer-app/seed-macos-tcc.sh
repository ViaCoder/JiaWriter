#!/usr/bin/env bash
# For GitHub's macOS runners only, where nobody can answer a dialog: records the user's two approvals for the signed
# driver app in the system permission database, which these throwaway machines allow. Never for a real machine.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "only on a GitHub runner" >&2; exit 1; }
app=/Applications/CuaDriver.app
client=com.trycua.driver
db="/Library/Application Support/com.apple.TCC/TCC.db"
tmp="$(mktemp -d)"
# The app's designated requirement, compiled, is what the system checks a grant against.
codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p' > "$tmp/requirement.txt"
csreq -r "$tmp/requirement.txt" -b "$tmp/csreq.bin"
hex="$(od -An -tx1 -v "$tmp/csreq.bin" | tr -d ' \n')"
now="$(date +%s)"
for service in kTCCServiceAccessibility kTCCServiceScreenCapture; do
  sudo sqlite3 -cmd ".timeout 30000" "$db" \
    "INSERT OR REPLACE INTO access(service,client,client_type,auth_value,auth_reason,auth_version,csreq,flags,indirect_object_identifier_type,indirect_object_identifier,last_modified) VALUES('$service','$client',0,2,2,1,X'$hex',0,0,'UNUSED',$now);"
done
sudo sqlite3 "$db" "SELECT service, auth_value FROM access WHERE client='$client';"
sudo killall tccd || true
