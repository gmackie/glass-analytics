import { type CapturePolicy, capturePolicySchema } from '@dataflare/core/capture-policy';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export async function loadCapturePolicy(env: Env, project: string): Promise<CapturePolicy | null> {
  const row = await env.DB.prepare('SELECT policy FROM capture_policies WHERE project = ?')
    .bind(project)
    .first<{ policy: string }>();
  if (!row) return null;
  // A damaged policy fails closed instead of silently restoring default collection.
  try {
    return capturePolicySchema.parse(JSON.parse(row.policy));
  } catch {
    throw new HttpError(
      503,
      'Capture policy is invalid.',
      'Have an administrator repair the project policy before collecting data.',
    );
  }
}
export async function requireStandardCapture(env: Env, project: string): Promise<void> {
  const policy = await loadCapturePolicy(env, project);
  if (policy && policy.profile !== 'standard')
    throw new HttpError(403, 'This project policy disables replay and flag evaluation.');
}
