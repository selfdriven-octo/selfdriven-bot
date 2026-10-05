#!/usr/bin/env bash
# selfdriven.bot AID: incept once with witnesses, then export the KEL that /oobi serves.
# Re-run after any rotation or interaction to refresh keri/selfdriven-bot.cesr, then run publish-oobi.
#
# Needs kli (pip install keri==1.2.7 on Python 3.12) and curl.
# Passcode: prompted, or KERI_PASSCODE in the environment. Keep it safe; it encrypts the keystore.
set -euo pipefail
cd "$(dirname "$0")"

NAME=${KERI_NAME:-selfdriven-bot}
ALIAS=${KERI_ALIAS:-selfdriven-bot}

command -v kli >/dev/null || { echo "kli not found: pip install keri==1.2.7 (Python 3.12)"; exit 1; }

if grep -q "REPLACE_" config/keri/cf/witness-oobis.json incept.json; then
    echo "Fill in your witnesses first: keri/config/keri/cf/witness-oobis.json (their OOBIs) and keri/incept.json (their AIDs, toad)."
    exit 1
fi

if [ -z "${KERI_PASSCODE:-}" ]; then
    read -r -s -p "Keystore passcode (21 chars): " KERI_PASSCODE; echo
fi

if [ ! -s selfdriven-bot.aid ]; then
    echo "→ Creating keystore '$NAME' and resolving witness OOBIs"
    kli init --name "$NAME" --passcode "$KERI_PASSCODE" --config-dir ./config --config-file witness-oobis

    echo "→ Incepting '$ALIAS' (waits for witness receipts)"
    kli incept --name "$NAME" --alias "$ALIAS" --passcode "$KERI_PASSCODE" --file incept.json

    kli aid --name "$NAME" --alias "$ALIAS" --passcode "$KERI_PASSCODE" | tr -d '[:space:]' > selfdriven-bot.aid
fi

AID=$(cat selfdriven-bot.aid)

echo "→ Exporting KEL for $AID from its first witness"
WITNESS_OOBIS=$(kli oobi generate --name "$NAME" --alias "$ALIAS" --passcode "$KERI_PASSCODE" --role witness)
WITNESS_OOBI=$(printf '%s\n' "$WITNESS_OOBIS" | head -n 1)
curl -sf -H 'Accept: application/json+cesr' "$WITNESS_OOBI" -o selfdriven-bot.cesr

echo
echo "AID:  $AID"
echo "KEL:  keri/selfdriven-bot.cesr ($(wc -c < selfdriven-bot.cesr | tr -d ' ') bytes, from $WITNESS_OOBI)"
echo "Next: cd ../deploy && node publish-oobi.js"
