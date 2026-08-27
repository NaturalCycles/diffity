/**
 * What to say when a question is asked and no agent is there to hear it.
 *
 * Nothing is lost — a request sits in the queue until an agent claims it — but until now the only
 * sign was a tooltip on the button, which nobody hovers before pressing. Silence reads as sent.
 */
export function unheardNote(
  intent: 'ask' | 'act',
  listening: boolean,
): { title: string; description: string } | null {
  if (listening) {
    return null;
  }

  return {
    title: 'No agent is connected',
    description: intent === 'act'
      ? 'Your change request is saved and will be picked up when one reconnects.'
      : 'Your question is saved and will be answered when one reconnects.',
  };
}
