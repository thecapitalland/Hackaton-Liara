// Mock-only LangGraph HITL scaffold. No Liara writes are possible here.
import { Annotation, StateGraph, START, END, MemorySaver, interrupt, Command } from '@langchain/langgraph';
import { createHash } from 'node:crypto';

function canonicalHash(target, action, params) {
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify({ target, action, params: sorted })).digest('hex');
}
const State = Annotation.Root({
  target: Annotation(), action: Annotation(), params: Annotation(),
  proposal: Annotation(), decision: Annotation(), result: Annotation()
});
export function createMockGraph() {
  return new StateGraph(State)
    .addNode('propose', async (state) => ({ proposal: {
      target: state.target, action: state.action, params: state.params,
      hash: canonicalHash(state.target, state.action, state.params)
    }}))
    .addNode('approve', async (state) => {
      const decision = interrupt({ message: 'Approve exact mocked operation?', proposal: state.proposal });
      return { decision };
    })
    .addNode('execute_mock', async (state) => ({
      result: state.decision?.approved === true &&
        state.decision?.hash === state.proposal?.hash &&
        state.proposal.target === 'opspilot-isolated-demo'
          ? 'MOCK_ONLY_NO_LIARA_WRITE' : 'DENIED_NO_WRITE'
    }))
    .addEdge(START, 'propose')
    .addEdge('propose', 'approve')
    .addEdge('approve', 'execute_mock')
    .addEdge('execute_mock', END)
    .compile({ checkpointer: new MemorySaver() });
}
export { Command };
// Production requires persisted state, authenticated grants and external-effect reconciliation.
