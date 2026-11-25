export const activationKey = 'signup-to-activation';
type Steps = [{ event: string }, { event: string }];
export type ActivationMapping = { steps: Steps; window: string };
export type ActivationInsight = { key: string; kind: string; spec: Record<string, unknown> };

export function activationPair(
  signup: string,
  activation: string,
  window = '7d',
): ActivationMapping {
  return { steps: [{ event: signup }, { event: activation }], window };
}

function savedMapping(s: Record<string, unknown>, names: string[]): ActivationMapping | undefined {
  const steps = s.steps as Steps;
  if (
    !Array.isArray(steps) ||
    steps.length !== 2 ||
    !steps.every((step) => step && typeof step.event === 'string') ||
    steps[0].event === steps[1].event
  )
    return undefined;
  if (
    Object.keys(s).some(
      (k) => !['steps', 'window', 'from', 'to', 'kind', 'aggregateBy', 'order'].includes(k),
    )
  )
    return undefined;
  if ((s.order ?? 'ordered') !== 'ordered' || (s.aggregateBy ?? 'person') !== 'person')
    return undefined;
  if (
    !steps.every(
      (step) =>
        Object.keys(step).every((k) => k === 'label' || k === 'event') &&
        names.includes(step.event),
    )
  )
    return undefined;
  return { steps, window: String(s.window ?? '7d') };
}

export function activationMapping(
  project: string,
  insights: ActivationInsight[],
  names: string[],
): ActivationMapping | undefined {
  const saved = insights.find((i) => i.key === activationKey && i.kind === 'funnel');
  if (saved) return savedMapping(saved.spec, names);

  // LevelForge's saved signup_started step records a magic-link request.
  if (project === 'levelforge' && names.includes('signup') && names.includes('project_created'))
    return activationPair('signup', 'project_created');
  const actions: Record<string, string> = {
    controlsfoundry: 'gateway_connected',
    streamconductor: 'stream_started',
    veritas: 'project_created',
    obey: 'relationship_created',
  };
  const action = actions[project];
  if (!action || !names.includes(action) || !names.includes('signup_completed')) return undefined;
  const journey = insights.find(
    (i) =>
      i.kind === 'funnel' &&
      Array.isArray(i.spec.steps) &&
      i.spec.steps.some(
        (step, index, steps) =>
          step?.event === 'signup_completed' && steps[index + 1]?.event === action,
      ),
  );
  return journey
    ? activationPair('signup_completed', action, String(journey.spec.window ?? '7d'))
    : undefined;
}
