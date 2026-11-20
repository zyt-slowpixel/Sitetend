// A tiny MCP server for tests. stdio by default; `node fake-mcp-server.mjs http <port> <token>` serves Streamable HTTP
// (answers with an event stream, like many hosted servers). The notes it serves change when NOTES_FILE changes.
import http from 'node:http';
import fs from 'node:fs';
import readline from 'node:readline';

const notes = () => process.env.NOTES_FILE && fs.existsSync(process.env.NOTES_FILE) ? fs.readFileSync(process.env.NOTES_FILE, 'utf8') : '# Notes\n\nEmail: alex.mcp@example.com\n';
function handle(m, token) {
  const r = result => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return r({ protocolVersion: m.params.protocolVersion, capabilities: { resources: {}, tools: {} }, serverInfo: { name: 'fake-notes', version: '1.0' } });
    case 'resources/list': return m.params?.cursor ? r({ resources: [{ uri: 'notes://data.json', name: 'Data', mimeType: 'application/json' }] })
      : r({ resources: [{ uri: 'notes://profile', name: 'Profile notes', mimeType: 'text/markdown' }], nextCursor: 'p2' });
    case 'resources/read':
      if (m.params.uri === 'notes://profile') return r({ contents: [{ uri: m.params.uri, mimeType: 'text/markdown', text: notes() }] });
      if (m.params.uri === 'notes://data.json') return r({ contents: [{ uri: m.params.uri, mimeType: 'application/json', text: '{"github":"alexm"}' }] });
      return { jsonrpc: '2.0', id: m.id, error: { code: -32002, message: 'Resource not found' } };
    case 'tools/list': return r({ tools: [
      { name: 'get_bio', description: 'Bio text', inputSchema: { type: 'object', properties: { lang: { type: 'string' } }, required: ['lang'] }, annotations: { readOnlyHint: true } },
      { name: 'broken', description: 'Always fails', inputSchema: { type: 'object' } }] });
    case 'tools/call':
      if (m.params.name === 'get_bio') return r({ content: [{ type: 'text', text: `Bio (${m.params.arguments.lang}): designer.` }] });
      return r({ content: [{ type: 'text', text: 'boom' }], isError: true });
    case 'ping': return r({});
    default: return m.id != null ? { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } } : null;
  }
}

if (process.argv[2] === 'http') {
  const [port, token] = [Number(process.argv[3]), process.argv[4]];
  http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    if (token && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    const m = JSON.parse(body); const out = handle(m, token);
    if (!out) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'abc' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
  }).listen(port, '127.0.0.1', () => process.stdout.write('ready\n'));
} else {
  console.log('fake-notes starting (a log line that is not JSON)');
  if (process.env.EXPECT_TOKEN && process.env.MY_TOKEN !== process.env.EXPECT_TOKEN) { console.error('missing token'); process.exit(3); }
  readline.createInterface({ input: process.stdin }).on('line', line => { const out = handle(JSON.parse(line)); if (out) process.stdout.write(JSON.stringify(out) + '\n'); });
}
