/** A review session: one ref reviewed at one commit of one checkout. */
export interface ReviewSession {
  id: string;
  ref: string;
  headHash: string;
}
