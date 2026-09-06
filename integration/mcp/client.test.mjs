import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

test('official MCP client initializes, notifies, lists tools and calls free and paid fixtures', { timeout: 20000 }, async () => {
  const child = spawn(process.env.PYTHON ?? 'python', ['-u', 'fixture_server.py'], {
    env: {...process.env, PYTHONPATH: '../..:../../tests', LIVE402_FIXTURE: '1', LOCAL_FREE: '', LIVE402_ROUTE_RPM:'60'},
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const clients = [];
  try {
    const line = await new Promise((resolve, reject) => {
      let data='';
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`fixture exited ${code}: ${errors}`)));
      child.stdout.on('data', chunk => { data += chunk.toString(); if(data.includes('\n')) resolve(data.split('\n')[0]); });
    });
    const fixture = JSON.parse(line);
    const connect = async headers => {
      const client = new Client({name:'402Signal-regression',version:'1.0.0'}, {capabilities:{}});
      const transport = new StreamableHTTPClientTransport(new URL(fixture.url), {requestInit:{headers}});
      clients.push(client);
      await client.connect(transport);
      return client;
    };
    const free = await connect({});
    const tools = await free.listTools();
    assert(tools.tools.some(tool => tool.name === 'route'));
    const preview = await free.callTool({name:'preview',arguments:{need:'weather'}});
    assert.equal(preview.isError, false);
    assert.equal(preview.structuredContent.not_probed, true);
    const invalid = await free.callTool({name:'validate',arguments:{url:'invalid'}});
    assert.equal(invalid.isError, true);
    await assert.rejects(free.callTool({name:'route',arguments:{need:'weather'}}), /402/);
    const paid = await connect(fixture.headers);
    const args = {need:'weather',url:'https://fixture.402signal.local/weather'};
    const result = await paid.callTool({name:'route',arguments:args});
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.billing.settled, true);
    const again = await paid.callTool({name:'route',arguments:args});
    assert.deepEqual(again.structuredContent, result.structuredContent);
  } finally {
    await Promise.allSettled(clients.map(client => client.close()));
    if (child.exitCode === null) { child.kill(); await once(child,'exit'); }
  }
});
