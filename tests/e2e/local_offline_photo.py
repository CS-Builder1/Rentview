"""Exercise the shipped offline store and IndexedDB adapter across real Chromium sessions.

Run with python tests/e2e/local_offline_photo.py after installing JS dependencies and
Python Playwright. Uses a temporary Chromium profile, loopback server and a generated
PNG. No app credentials or database are required.
"""
import argparse
import functools
import hashlib
import json
import random
import shutil
import struct
import subprocess
import tempfile
import threading
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def photo_bytes():
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    width, height = 2048, 1024
    rng = random.Random(3024)
    scanlines = b"".join(b"\x00" + rng.randbytes(width * 3) for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b""))


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def run(browser_path):
    image = photo_bytes()
    with tempfile.TemporaryDirectory(prefix="rentview-queue-") as temp:
        path = Path(temp)
        site = path / "site"
        site.mkdir()
        (site / "fixture.png").write_bytes(image)
        # Transpile the actual production modules. The import map supplies the same
        # base64 dependency and extensionless resolution used by Metro.
        subprocess.run(["node", "-e", """
          const ts = require('typescript'), fs = require('fs'), path = require('path');
          for (const name of ['offlineStore', 'offlinePhotos.web', 'uploadPolicy']) {
            const input = fs.readFileSync('lib/' + name + '.ts', 'utf8');
            const result = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022,
              module: ts.ModuleKind.ESNext } });
            fs.writeFileSync(path.join(process.argv[1], name + '.js'), result.outputText);
          }
        """, str(site)], cwd=ROOT, check=True)
        shutil.copy(ROOT / "node_modules/base64-arraybuffer/dist/base64-arraybuffer.es5.js", site / "base64.js")
        mapping = {"imports": {"base64-arraybuffer": "/base64.js", "/uploadPolicy": "/uploadPolicy.js"}}
        (site / "index.html").write_text('<script type="importmap">' + json.dumps(mapping) + '</script>')
        server = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(site)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with sync_playwright() as pw:
                def open_session():
                    context = pw.chromium.launch_persistent_context(str(path / "profile"), executable_path=browser_path,
                                  args=["--no-sandbox", "--disable-background-networking"], service_workers="block")
                    page = context.pages[0]
                    page.goto(f"http://127.0.0.1:{server.server_port}/")
                    page.evaluate("""async () => {
                      const {createOfflineStore,flushOfflineQueue}=await import('/offlineStore.js');
                      const {offlinePhotos}=await import('/offlinePhotos.web.js');
                      window.uid='11111111-1111-4111-8111-111111111111';
                      const meta={ getItem: async key => localStorage.getItem(key),
                        setItem: async (key,value) => localStorage.setItem(key,value),
                        removeItem: async key => localStorage.removeItem(key) };
                      window.queue=createOfflineStore(meta,()=>crypto.randomUUID(),Date.now,
                        work=>navigator.locks.request('rentview.offline.queue.v2',work),offlinePhotos);
                      window.blobs=offlinePhotos;
                      window.flush=flushOfflineQueue;
                    }""")
                    return context, page

                context, page = open_session()
                saved = page.evaluate("""async () => {
                  const {encode}=await import('/base64.js');
                  const {inspectImage}=await import('/uploadPolicy.js');
                  const file=await (await fetch('/fixture.png')).arrayBuffer();
                  const image=await createImageBitmap(new Blob([file],{type:'image/png'}));
                  if(image.width!==2048 || image.height!==1024) throw Error('Invalid photo fixture');
                  image.close();
                  const {mimeType}=inspectImage(new Uint8Array(file));
                  const op=queue.preparePhoto(uid,{base64:encode(file),contentType:mimeType,
                    storagePath:uid+'/work_orders/inspection.png',doc:{owner_id:uid}});
                  await queue.put(op);
                  const [row]=await queue.read(uid);
                  return {id:row.id,key:row.photoKey,size:row.byteLength,metadataBytes:
                    new Blob([localStorage.getItem('rentview.offline.queue.v2.'+uid)]).size};
                }""")
                context.close()
                assert saved["size"] == len(image) and len(image) > 6 * 1024 * 1024
                assert saved["metadataBytes"] < 2048
                # A new browser process, IndexedDB connection and store must recover the exact file.
                context, page = open_session()
                replay = page.evaluate("""async () => {
                  const [op]=await queue.read(uid);
                  const seen=[];
                  let sends=0;
                  const transport={
                    async upload(photo,bytes) {
                      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
                        n=>n.toString(16).padStart(2,'0')).join('');
                      seen.push([photo.id,photo.storagePath,hash]);
                    },
                    async insert(){ return {error:++sends===1?Error('Failed to fetch'):null}; },
                    documentPayload(photo){return photo.doc;}
                  };
                  await flush(queue,transport,uid,()=>true);
                  const pending=(await queue.read(uid)).length, kept=(await blobs.list(uid)).length;
                  await flush(queue,transport,uid,()=>true);
                  return {seen,pending,kept,remaining:(await queue.read(uid)).length,files:(await blobs.list(uid)).length};
                }""")
                context.close()
                assert replay["seen"][0] == replay["seen"][1]
                assert replay["seen"][0][0] == saved["id"] and replay["seen"][0][2] == hashlib.sha256(image).hexdigest()
                assert (replay["pending"], replay["kept"], replay["remaining"], replay["files"]) == (1, 1, 0, 0)
                print(f"PASS: {len(image)} PNG bytes, {saved['metadataBytes']} metadata bytes, restart and retry matched SHA-256; queue and blob removed.")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", default="/usr/bin/chromium")
    run(parser.parse_args().browser)
