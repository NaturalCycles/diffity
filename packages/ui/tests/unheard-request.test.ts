import { describe, it, expect } from 'vitest';
import { unheardNote } from '../src/lib/unheard-request';

describe('unheardNote', () => {
  it('says nothing when an agent is waiting, because the button did what it looks like', () => {
    expect(unheardNote('ask', true)).toBeNull();
    expect(unheardNote('act', true)).toBeNull();
  });

  it('says so when nobody is, and that the request is kept', () => {
    const note = unheardNote('ask', false)!;

    expect(note.title).toBe('No agent is connected');
    expect(note.description).toContain('saved');
    expect(note.description).toContain('reconnects');
  });

  // Act and Ask are different promises, so the note should not claim the wrong one.
  it('does not promise an answer to a request for a change', () => {
    expect(unheardNote('act', false)!.description).toContain('change request');
    expect(unheardNote('ask', false)!.description).toContain('question');
  });
});
