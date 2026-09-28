import { createContext } from 'react';

/** Whether an agent is waiting for questions on this session, which is what "Ask Claude" needs. */
export const AgentListeningContext = createContext(false);
