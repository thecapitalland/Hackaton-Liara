import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../src/config.js';
import { ensureBuild } from './ensure-build.js';

ensureBuild();

const client = new Client({name:'agate-smoke',version:'1.0.0'});
const offline = process.argv.includes('--offline');
const transport = new StdioClientTransport({command:process.execPath,args:['dist/index.js'],stderr:'pipe', ...(offline ? {env:{...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined)),LIARA_API_TOKEN:''}} : {})});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 29);
  for (const tool of tools) {
    assert.ok(tool.description);
    assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
  }
  const ping = await client.callTool({name:'ping',arguments:{}});
  assert.equal(ping.isError, undefined);
  console.log(`PASS: stdio handshake، کشف ${tools.length} ابزار و ping`);
  if (config.token && !offline) {
    const apps = await client.callTool({name:'liara_list_apps',arguments:{}});
    if (apps.isError) throw new Error('Live list apps failed; run npm run preflight for sanitized diagnostics.');
    const probe = await client.callTool({name:'http_probe',arguments:{target:config.allowedApps[0],count:1}});
    assert.equal((probe.structuredContent as any)?.probe?.ok,true);
    console.log('PASS: live list + HTTP probe (read-only)');
  } else console.log('SKIP: live smoke — حالت offline یا نبود توکن.');
} finally {
  await client.close();
}
