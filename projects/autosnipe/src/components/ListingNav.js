// Opens a thin nav-bar popup window and returns a handle to update/close it.
// Communicates back to the opener via postMessage.

const ACCENT = '#FF6B00'
const BG_DARK = '#0a0a0f'
const TEXT_DIM = '#9090a8'

export const NAV_HEIGHT = 80
export const POPUP_WIDTH = 1000

function buildHTML(listing, current, total) {
  const title = listing?.title || 'Listing'
  const price = listing?.price ? `\u00a3${listing.price.toLocaleString()}` : ''
  const prevDim = current <= 0
  const nextDim = current >= total - 1

  const dots = Array.from({ length: total }, (_, i) =>
    `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${i === current ? ACCENT : TEXT_DIM + '44'}"></span>`
  ).join('')

  return `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'IBM Plex Mono',monospace;background:${BG_DARK};overflow:hidden;user-select:none;cursor:default}</style>
</head><body>
<div style="padding:10px 16px;display:flex;align-items:center;gap:12px;font-size:10px;border-bottom:1px solid ${ACCENT}33">
  <span style="color:${ACCENT};font-weight:700;letter-spacing:2px;font-size:11px">AUTOSNIPE</span>
  <span style="color:${ACCENT}44">\u2502</span>
  <span style="color:#f8f8ff;font-size:12px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${title.replace(/</g, '&lt;')}</span>
  ${price ? `<span style="color:${ACCENT};font-weight:700;font-size:13px">${price}</span>` : ''}
  <span style="color:${ACCENT}44">\u2502</span>
  <span id="close" style="color:${TEXT_DIM};cursor:pointer;font-size:10px">[ CLOSE ]</span>
</div>
<div style="padding:8px 16px;display:flex;align-items:center;justify-content:space-between;font-size:10px;background:linear-gradient(180deg,${BG_DARK},#161620)">
  <span id="prev" style="color:${prevDim ? TEXT_DIM + '44' : TEXT_DIM};cursor:${prevDim ? 'default' : 'pointer'}">\u2190 Prev</span>
  <div style="display:flex;gap:5px">${dots}</div>
  <span id="next" style="color:${nextDim ? TEXT_DIM + '44' : TEXT_DIM};cursor:${nextDim ? 'default' : 'pointer'}">Next \u2192</span>
</div>
<script>
function send(action) { window.opener && window.opener.postMessage({ source: 'autosnipe-nav', action }, '*') }
document.getElementById('prev').onclick = function() { send('prev') }
document.getElementById('next').onclick = function() { send('next') }
document.getElementById('close').onclick = function() { send('close') }
</script>
</body></html>`
}

export function openNavPopup(listing, current, total) {
  const left = screen.availWidth - POPUP_WIDTH
  const features = `popup=yes,width=${POPUP_WIDTH},height=${NAV_HEIGHT},top=0,left=${left},menubar=no,toolbar=no,location=no,status=no,resizable=no,scrollbars=no`
  const nav = window.open('', 'autosnipe-nav', features)
  if (!nav) return null
  nav.document.open()
  nav.document.write(buildHTML(listing, current, total))
  nav.document.close()
  // Force position in case browser ignored features
  try { nav.moveTo(left, 0); nav.resizeTo(POPUP_WIDTH, NAV_HEIGHT) } catch {}
  return nav
}

export function updateNavPopup(navWin, listing, current, total) {
  if (!navWin || navWin.closed) return
  navWin.document.open()
  navWin.document.write(buildHTML(listing, current, total))
  navWin.document.close()
}
