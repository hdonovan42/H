# Chess Analysis: Bug Fixes + Lichess Chrome Extension

## Part 1: Accuracy Bug Fixes
- [x] Bug 1+2: Fix accuracy formula (win% loss instead of cp loss) + Lichess win probability formula
- [x] Bug 3: Default starting position eval to 0.0
- [x] Bug 4: Scale mate scores by distance
- [x] Bug 5: Increase graph analysis depth to 12

## Part 2: Lichess Integration
- [x] Add URL parameter support (`?game=GAME_ID`)
- [x] Add `fetchLichessGame()` function + loading state
- [x] Build Chrome extension (manifest.json, content.js, styles, icons)
- [ ] Bookmarklet fallback

## Verification
- [x] Test accuracy scores against expected values (verified via Node.js)
- [ ] Test URL parameter with real Lichess game (needs browser)
- [ ] Test Chrome extension on lichess.org (needs browser)
