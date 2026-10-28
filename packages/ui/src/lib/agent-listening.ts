import { createContext } from 'react';

/** Whether an agent is waiting for questions on this session, which is what "Ask Claude" needs. */
export const AgentListeningContext = createContext(false);

/** Diffity called the user's routine for this session, and no agent is listening yet. */
export const AgentCalledContext = createContext(false);

/** Diffity has a routine to call for this user, so a question gets answered even while no agent is listening. */
export const AgentReachableContext = createContext(false);
