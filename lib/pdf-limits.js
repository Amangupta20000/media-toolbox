// PDF limits are shared by the browser intake and every server/agent route so
// the UI and processing locations enforce the same upload policy.
export const MAX_PDF_COUNT = 5;
export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_PDF_TOTAL_BYTES = 200 * 1024 * 1024;
