#!/usr/bin/env python3
"""WaymoNet reject-pruning tool — fast keyboard traversal of the reject pool to mark frames to
EXCLUDE from future training. Runs on the VPS (waymo.db + the reject frames live here); surfaced at
dash.waymonet.com/prune/ via an nginx location that inherits the dash's basic-auth.

PRUNE is a REVERSIBLE status flip 'reject' -> 'pruned' (never a file delete): the row + frame +
hourly backup are all kept, build_real_dataset.py (status='reject') stops using it, and 'u' undoes it
in one step. Recover everything later with: UPDATE candidates SET status='reject' WHERE status='pruned'.

UI keys:  ->  next (random; re-walks forward history if you went back)
          <-  back (same order)
          1   prune the current frame + advance
          u   undo the last prune (valid only until the next keypress)

Env: WAYMONET_DB (default ../data/waymo.db), WAYMONET_PRUNE_HOST/PORT (default 127.0.0.1:3107).
Powered by TfL Open Data.
"""
import json
import os
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
DB = os.environ.get("WAYMONET_DB", os.path.join(BASE, "data", "waymo.db"))
HOST = os.environ.get("WAYMONET_PRUNE_HOST", "127.0.0.1")
PORT = int(os.environ.get("WAYMONET_PRUNE_PORT", "3107"))

PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WaymoNet — prune rejects</title><style>
:root{--bg:#0a0c10;--panel:#12161d;--line:#222a35;--ink:#d6e0ea;--dim:#7c8a9a;--accent:#2ea6ff;--bad:#ff5470;--hi:#27d27a;
--mono:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--mono);height:100vh;
display:flex;flex-direction:column}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:14px}
header h1{margin:0;font-size:15px}header .sub{color:var(--dim);font-size:11px}
.bar{padding:8px 16px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:16px;font-size:13px;flex-wrap:wrap}
.bar b{color:var(--ink)}.bar .dim{color:var(--dim)}
.keys{color:var(--dim);font-size:11px}.keys kbd{background:#1b212b;border:1px solid var(--line);border-radius:4px;
padding:1px 6px;color:var(--ink);margin:0 2px}
.stage{flex:1;display:flex;align-items:center;justify-content:center;padding:14px;min-height:0;
background:repeating-linear-gradient(45deg,#0b0e13,#0b0e13 10px,#0c1015 10px,#0c1015 20px)}
.stage img{max-width:100%;max-height:84vh;display:block;box-shadow:0 0 0 1px var(--line)}
.flash{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#12161d;border:1px solid var(--line);
padding:8px 16px;border-radius:8px;opacity:0;transition:opacity .15s;pointer-events:none;font-size:13px}
.flash.show{opacity:1}.flash.prune{border-color:var(--bad);color:var(--bad)}.flash.undo{border-color:var(--hi);color:var(--hi)}
.btn{cursor:pointer;user-select:none;background:#1b212b;border:1px solid var(--line);border-radius:6px;padding:4px 12px;color:var(--ink)}
.btn:hover{border-color:var(--accent)}
</style></head><body>
<header><h1>WaymoNet · prune rejects</h1><span class="sub">reversible — flips status to <b>pruned</b>; <kbd>u</kbd> undoes</span></header>
<div class="bar">
  <span class="btn" id="back">&larr; back</span><span class="btn" id="next">next &rarr;</span>
  <input id="goto" type="number" placeholder="# look up" title="view any candidate # (any status)"
    style="width:100px;background:#1b212b;border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:3px 8px;font-family:var(--mono);font-size:13px">
  <span class="dim">id</span> <b id="id">—</b>
  <span class="dim">status</span> <b id="status">—</b>
  <span class="dim">cam</span> <b id="cam">—</b>
  <span class="dim">run1 conf</span> <b id="conf">—</b>
  <span class="dim">rejects left</span> <b id="left">—</b>
  <label class="dim" style="cursor:pointer;user-select:none"><input type="checkbox" id="modechk"> newest-first</label>
  <span class="keys"><kbd>&larr;</kbd>/<kbd>&rarr;</kbd> traverse &nbsp; <kbd>1</kbd> prune &nbsp; <kbd>u</kbd> undo &nbsp; <kbd>m</kbd> mode &nbsp; type a <kbd>#</kbd> + enter to look up</span>
</div>
<div class="stage"><img id="img" alt="reject frame"></div>
<div class="flash" id="flash"></div>
<script>
const $=id=>document.getElementById(id);
let hist=[], i=-1, cur=null, lastPruned=null, ftimer=null, mode='random';
function flash(msg,cls){const f=$('flash');f.textContent=msg;f.className='flash show '+(cls||'');
  clearTimeout(ftimer);ftimer=setTimeout(()=>f.className='flash',1400);}
const SCOL={waymo:'#27d27a',pruned:'#ff5470',reject:'#ffb43a',new:'#d6e0ea',near:'#7c8a9a'};
function render(meta){ $('id').textContent=cur!=null?('#'+cur):'—';
  if(meta){$('cam').textContent=meta.camera||'—';
    $('status').textContent=meta.status||'—'; $('status').style.color=SCOL[meta.status]||'#d6e0ea';
    $('conf').textContent=(meta.conf==null?'—':(+meta.conf).toFixed(3));
    if(meta.remaining!=null)$('left').textContent=meta.remaining;}}
function show(id,meta){cur=id;$('img').src='img?id='+id+'&t='+Date.now();render(meta);}
async function fetchNext(){              // next item in the CURRENT mode (forward-at-front + post-prune)
  if(mode==='newest') return await fetch('api/next'+(cur!=null?('?after='+cur):'')).then(r=>r.json());
  return await fetch('api/random').then(r=>r.json());
}
async function next(){
  if(i<hist.length-1){ i++; show(hist[i].id,hist[i]); lastPruned=null; return; }
  const r=await fetchNext();
  if(r.id==null){ flash(mode==='newest'?'reached the oldest reject':'no rejects left'); return; }
  hist.push(r); i=hist.length-1; show(r.id,r); lastPruned=null;
}
function setMode(m){
  if(mode===m)return; mode=m; $('modechk').checked=(m==='newest');
  hist=[]; i=-1; cur=null; lastPruned=null; next();   // restart traversal in the new mode
}
function back(){ if(i>0){ i--; show(hist[i].id,hist[i]); } else flash('start of history'); lastPruned=null; }
async function prune(){
  if(cur==null)return; const id=cur;
  const r=await fetch('api/prune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
  if(!r.changed){ flash('#'+id+' is not a reject — not pruned'); return; }
  flash('pruned #'+id+'  ·  press u to undo','prune');
  const nx=await fetchNext();
  if(nx.id!=null){ hist.push(nx); i=hist.length-1; show(nx.id,nx); }
  if(r&&r.remaining!=null)$('left').textContent=r.remaining;
  lastPruned=id;                       // set AFTER advancing so undo targets the pruned one
}
async function undo(){
  if(lastPruned==null){flash('nothing to undo');return;}
  const id=lastPruned; lastPruned=null;
  const r=await fetch('api/unprune',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json());
  flash('restored #'+id,'undo');
  if(r&&r.remaining!=null)$('left').textContent=r.remaining;
}
async function lookup(id){     // view ANY candidate # (any status), not just rejects
  const r=await fetch('api/lookup?id='+id).then(r=>r.json());
  if(r.id==null){ flash('no candidate #'+id); return; }
  if(!r.has_frame){ flash('#'+id+' has no frame on disk'); return; }
  hist.push(r); i=hist.length-1; show(r.id,r); lastPruned=null;
}
$('next').onclick=next; $('back').onclick=back;
$('modechk').onchange=e=>setMode(e.target.checked?'newest':'random');
$('goto').addEventListener('keydown',e=>{ if(e.key==='Enter'){ const v=parseInt(e.target.value,10); if(!isNaN(v))lookup(v); e.target.blur(); } });
document.addEventListener('keydown',e=>{
  if(e.target.id==='goto')return;        // typing an id to look up — let the field handle it
  if(e.key==='ArrowRight'){e.preventDefault();next();}
  else if(e.key==='ArrowLeft'){e.preventDefault();back();}
  else if(e.key==='1'){e.preventDefault();prune();}
  else if(e.key==='u'||e.key==='U'){e.preventDefault();undo();}
  else if(e.key==='m'||e.key==='M'){e.preventDefault();setMode(mode==='random'?'newest':'random');}
  else { lastPruned=null; }            // any other key invalidates the undo
});
next();   // load the first random reject
</script></body></html>"""


def _conn(readonly=True):
    if readonly:
        return sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=60)
    return sqlite3.connect(DB, timeout=60)


def random_reject():
    con = _conn()
    try:
        row = con.execute("SELECT id, camera_id, wn_conf FROM candidates "
                          "WHERE status='reject' AND frame_path IS NOT NULL "
                          "ORDER BY RANDOM() LIMIT 1").fetchone()
        remaining = con.execute("SELECT COUNT(*) FROM candidates WHERE status='reject'").fetchone()[0]
    finally:
        con.close()
    if not row:
        return {"id": None, "remaining": remaining}
    return {"id": row[0], "status": "reject", "camera": row[1], "conf": row[2], "remaining": remaining}


def next_reject(after=None):
    """Newest-first sequential traversal: the highest-id reject (id < `after` if given). 'newest' =
    most-recently-captured candidate (id is monotonic with ingest) — the usual case for fresh rejects."""
    con = _conn()
    try:
        if after is None:
            row = con.execute("SELECT id, camera_id, wn_conf FROM candidates "
                              "WHERE status='reject' AND frame_path IS NOT NULL "
                              "ORDER BY id DESC LIMIT 1").fetchone()
        else:
            row = con.execute("SELECT id, camera_id, wn_conf FROM candidates "
                              "WHERE status='reject' AND frame_path IS NOT NULL AND id<? "
                              "ORDER BY id DESC LIMIT 1", (after,)).fetchone()
        remaining = con.execute("SELECT COUNT(*) FROM candidates WHERE status='reject'").fetchone()[0]
    finally:
        con.close()
    if not row:
        return {"id": None, "remaining": remaining}
    return {"id": row[0], "status": "reject", "camera": row[1], "conf": row[2], "remaining": remaining}


def lookup(cid):
    """Metadata for ANY candidate id (any status) — for direct frame lookup/review, not just rejects."""
    con = _conn()
    try:
        r = con.execute("SELECT id, status, camera_id, wn_conf, frame_path "
                        "FROM candidates WHERE id=?", (cid,)).fetchone()
    finally:
        con.close()
    if not r:
        return {"id": None, "error": "no such candidate"}
    return {"id": r[0], "status": r[1], "camera": r[2], "conf": r[3],
            "has_frame": bool(r[4] and os.path.exists(r[4]))}


def frame_path(cid):
    con = _conn()
    try:
        r = con.execute("SELECT frame_path FROM candidates WHERE id=?", (cid,)).fetchone()
    finally:
        con.close()
    return r[0] if r else None


def set_status(cid, frm, to):
    """Flip status frm->to for one id; returns rows changed + the current reject count."""
    con = _conn(readonly=False)
    try:
        cur = con.execute("UPDATE candidates SET status=? WHERE id=? AND status=?", (to, cid, frm))
        con.commit()
        remaining = con.execute("SELECT COUNT(*) FROM candidates WHERE status='reject'").fetchone()[0]
    finally:
        con.close()
    return cur.rowcount, remaining


class Handler(BaseHTTPRequestHandler):
    server_version = "waymonet-prune"

    def log_message(self, *a):
        pass

    def _send(self, code, ctype, body, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, "application/json", json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        path = urlparse(self.path).path
        qs = parse_qs(urlparse(self.path).query)
        if path in ("/", "/index.html"):
            self._send(200, "text/html; charset=utf-8", PAGE.encode())
            return
        if path == "/api/random":
            self._json(random_reject())
            return
        if path == "/api/next":
            after = qs.get("after", [None])[0]
            try:
                after = int(after) if after is not None else None
            except ValueError:
                after = None
            self._json(next_reject(after))
            return
        if path == "/api/lookup":
            try:
                cid = int(qs.get("id", [""])[0])
            except ValueError:
                self._json({"id": None, "error": "bad id"}, 400)
                return
            self._json(lookup(cid))
            return
        if path == "/img":
            try:
                cid = int(qs.get("id", [""])[0])
            except ValueError:
                self._json({"error": "bad id"}, 400)
                return
            fp = frame_path(cid)
            if fp and os.path.exists(fp):
                self._send(200, "image/jpeg", open(fp, "rb").read(), "no-store")
            else:
                self._json({"error": "frame not found"}, 404)
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        cid = self._body().get("id")
        if not isinstance(cid, int):
            self._json({"error": "id (int) required"}, 400)
            return
        if path == "/api/prune":
            changed, remaining = set_status(cid, "reject", "pruned")
            self._json({"ok": True, "changed": changed, "remaining": remaining})
        elif path == "/api/unprune":
            changed, remaining = set_status(cid, "pruned", "reject")
            self._json({"ok": True, "changed": changed, "remaining": remaining})
        else:
            self._json({"error": "not found"}, 404)


if __name__ == "__main__":
    print(f"waymonet-prune {HOST}:{PORT} | db={DB}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
