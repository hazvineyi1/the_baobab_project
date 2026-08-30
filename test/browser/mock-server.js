// A stand-in for the real server that can be told to misbehave, so the tests
// can reproduce each way the shared tree used to be lost.
const http = require('http'), fs = require('fs'), path = require('path');
let blob = null;           // the shared tree, as the server holds it
let mode = 'ok';           // ok | corrupt | error5 | gone410 | notfound | writefail
let writes = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/__mode'){                       // test control channel
    mode = req.headers['x-mode'] || 'ok';
    return res.end('mode=' + mode);
  }
  if (url === '/__blob'){
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ blob, writes }));
  }
  if (url === '/__seed'){
    let b = ''; req.on('data', c => b += c);
    return req.on('end', () => { blob = b; writes = 0; res.end('seeded'); });
  }
  if (url.startsWith('/api/shared/')){
    if (mode === 'notfound') { res.statusCode = 404; return res.end('not found'); }
    if (mode === 'gone410')  { res.statusCode = 410; res.setHeader('Content-Type','application/json');
                               return res.end('{"error":"blob_api_retired"}'); }
    if (mode === 'error5')   { res.statusCode = 500; return res.end('boom'); }
    if (req.method === 'GET'){
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'corrupt') return res.end('{"value":"{not json at all"}');
      return res.end(JSON.stringify({ value: blob }));
    }
    if (req.method === 'PUT'){
      let b = ''; req.on('data', c => b += c);
      return req.on('end', () => {
        if (mode === 'writefail'){ res.statusCode = 500; return res.end('nope'); }
        writes++; blob = JSON.parse(b).value;
        res.setHeader('Content-Type', 'application/json');
        res.end('{"ok":true}');
      });
    }
  }
  const f = path.join(__dirname, '..', 'home', 'user', 'muti-wemhuri', 'public',
                      url === '/' ? 'index.html' : url.slice(1));
  fs.readFile(path.resolve('/home/user/muti-wemhuri/public', url === '/' ? 'index.html' : url.slice(1)),
    (e, d) => { if (e){ res.statusCode = 404; return res.end('nf'); }
                if (url.endsWith('.png')) res.setHeader('Content-Type','image/png');
                else res.setHeader('Content-Type','text/html');
                res.end(d); });
});
server.listen(3931, '127.0.0.1', () => console.log('mock server on 3931'));
