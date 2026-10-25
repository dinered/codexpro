import type {AnswerSnapshot} from '../src/core/types.ts';
import {driverFailure} from '../src/driver/types.ts';
import {normalizeText} from '../src/md/markdown.ts';

type Row = {id: string | null; role: 'user' | 'assistant'; text: string; html: string};
export type SubmissionSnapshot = AnswerSnapshot & {
  submission: {supported: boolean; composerEmpty: boolean; composerText: string; rows: Row[]};
};

/** Per-send DOM witness. A journal records intent; only a new user turn proves acceptance. */
export class SubmissionGuard {
  private readonly baseline: Set<string>;
  private readonly expected: string;
  private readonly deadline: number;
  private userId: string | null = null;
  private answerId: string | null = null;

  constructor(snapshot: SubmissionSnapshot, text: string, now: number) {
    this.baseline = new Set(this.rows(snapshot).map(row => row.id!));
    this.expected = normalizeText(text);
    if (!this.expected) throw driverFailure('platform', 'Cannot send an empty composer');
    if (normalizeText(snapshot.submission.composerText) !== this.expected) {
      throw driverFailure('platform', 'Composer changed after typing; refusing to send different text');
    }
    this.deadline = now + 10_000;
  }

  private rows(snapshot: SubmissionSnapshot): Row[] {
    const evidence = snapshot.submission;
    if (!evidence?.supported || !Array.isArray(evidence.rows)
      || evidence.rows.some(row => !row.id)
      || new Set(evidence.rows.map(row => row.id)).size !== evidence.rows.length) {
      throw driverFailure('platform', 'Stable user/assistant turn identities are unavailable; submission cannot be verified');
    }
    return evidence.rows;
  }

  answer(snapshot: SubmissionSnapshot, now: number): AnswerSnapshot {
    const rows = this.rows(snapshot);
    if (!this.userId && now >= this.deadline) {
      throw driverFailure('platform', 'New user turn was not confirmed in time; send outcome is unknown. No automatic resend');
    }
    const users = rows.filter(row => row.role === 'user');
    const added = users.filter(row => !this.baseline.has(row.id!));
    const pending = () => ({...snapshot, html: '', busy: true, sendIdle: false});
    if (!added.length) {
      if (this.userId || now >= this.deadline) {
        throw driverFailure('platform', 'New user turn was not confirmed; send outcome is unknown. No automatic resend');
      }
      return pending();
    }
    const user = added[0]!;
    if (added.length !== 1 || users.at(-1) !== user || normalizeText(user.text) !== this.expected
      || (this.userId && this.userId !== user.id)) {
      throw driverFailure('platform', 'New user turn does not uniquely match this submission; manual review required');
    }
    if (!snapshot.submission.composerEmpty) {
      if (now >= this.deadline) throw driverFailure('platform', 'Composer is not empty after send; submission is unconfirmed. No automatic resend');
      return pending();
    }
    this.userId = user.id;
    const answer = rows[rows.indexOf(user) + 1];
    if (!answer) return pending();
    if (answer.role !== 'assistant' || answer !== rows.at(-1) || this.baseline.has(answer.id!)
      || (this.answerId && this.answerId !== answer.id)) {
      throw driverFailure('platform', 'Assistant turn does not belong to the confirmed submission');
    }
    this.answerId = answer.id;
    // Keep the original stable-answer, stop, streaming and idle-control checks.
    return {...snapshot, html: answer.html};
  }
}
