#!/usr/bin/env bash
# Refresh gitignored test fixtures with live Rightmove pages.
# Usage: ./fetch-fixtures.sh [propertyId]
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fixtures

UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

echo "Fetching search page (London)..."
curl -s -A "$UA" "https://www.rightmove.co.uk/property-for-sale/find.html?locationIdentifier=REGION%5E87490" -o fixtures/search.html

PROP_ID="${1:-$(grep -o '/properties/[0-9]*' fixtures/search.html | head -1 | grep -o '[0-9]*')}"
echo "Fetching property page ${PROP_ID}..."
curl -s -A "$UA" "https://www.rightmove.co.uk/properties/${PROP_ID}" -o fixtures/property.html

ls -la fixtures/
