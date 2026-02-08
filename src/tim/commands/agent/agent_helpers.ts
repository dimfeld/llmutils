import { sendStructured } from '../../../logging.js';

export type FailureReportDetails = {
  requirements?: string;
  problems?: string;
  solutions?: string;
  sourceAgent?: string;
};

export function timestamp(): string {
  return new Date().toISOString();
}

export function sendFailureReport(summary: string, details?: FailureReportDetails): void {
  sendStructured({
    type: 'failure_report',
    timestamp: timestamp(),
    summary,
    requirements: details?.requirements,
    problems: details?.problems,
    solutions: details?.solutions,
    sourceAgent: details?.sourceAgent,
  });
}
