export function verifyAgentTickSecret(request: Request): boolean {
  const expected = String(process.env.CARER_AUTOMATION_TICK_SECRET || '').trim();
  const provided = String(request.headers.get('x-carer-automation-tick-secret') || '').trim();
  const ok = Boolean(expected && provided && provided === expected);
  if (!ok) {
    console.warn('[AGENT_JOBS_API_AUTH_FAILED] unauthorized agent request');
  }
  return ok;
}
