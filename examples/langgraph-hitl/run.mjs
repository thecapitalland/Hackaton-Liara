import { createMockGraph, Command } from './graph.mjs';
const graph=createMockGraph();
const config={ configurable:{ thread_id:'isolated-mock-thread' }};
const paused=await graph.invoke({target:'opspilot-isolated-demo',action:'set_demo_variable',params:{name:'DEMO_MESSAGE',value:'fixed'}},config);
console.log('Paused for approval; no Liara request has been sent.');
if (!paused.proposal?.hash) throw Error('Proposal missing');
const result=await graph.invoke(new Command({resume:{approved:false,hash:paused.proposal.hash}}),config);
console.log(result.result); // DENIED_NO_WRITE
