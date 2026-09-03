export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;

  constructor(status: number, code: string, title: string, detail = title) {
    super(detail);
    this.name = 'ProblemError';
    this.status = status;
    this.code = code;
    this.type = `https://resonance-ledger.invalid/problems/${code.toLowerCase()}`;
  }
}
