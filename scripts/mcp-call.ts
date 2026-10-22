/** Local stdio client. Does not grant approvals or simulate human elicitation. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

const name = process.argv[2];
if (!name) throw new Error('tool name required');
const input = process.argv[3] ?? '{}';
const args = JSON.parse(input.startsWith('@') ? readFileSync(input.slice(1), 'utf8') : input);
const client = new Client({name:'agate-local-operator',version:'1.0.0'});
const transport = new StdioClientTransport({command:process.execPath,args:['dist/index.js'],stderr:'pipe'});
try {
  await client.connect(transport);
  const res = await client.callTool({name,arguments:args},undefined,{timeout:15*60_000});
  console.log(JSON.stringify(res,null,2));
  if (res.isError) process.exitCode = 1;
} finally { await client.close(); }
