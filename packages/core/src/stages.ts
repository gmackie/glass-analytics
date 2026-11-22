/**
 * How settled each feature is, in one place. Every surface that shows a feature (the
 * dashboard, MCP tool descriptions, the API index, CLI help, docs) labels it from this list,
 * so "alpha" means the same everywhere.
 *
 * Alpha: it works and is tested, but its settings, payloads and APIs may change between
 * releases without a migration. Beta: settled, still collecting feedback. Stable: neither.
 */

export type Stage = 'alpha' | 'beta' | 'stable';

export const FEATURE_STAGES = {
  destinations: 'alpha',
  transformations: 'alpha',
  exports: 'alpha',
  imports: 'alpha',
} as const satisfies Record<string, Stage>;

export type StagedFeature = keyof typeof FEATURE_STAGES;

export const STAGE_NOTES: Record<Exclude<Stage, 'stable'>, string> = {
  alpha:
    'Alpha: settings and payloads may change between releases. Try it on a test project, or send to a webhook, before pointing it at a production tool.',
  beta: 'Beta: settled, and still collecting feedback.',
};

/** "(alpha) " for a feature that isn't stable, to put in front of a description; "" otherwise. */
export function stagePrefix(feature: StagedFeature): string {
  const stage = FEATURE_STAGES[feature] as Stage;
  return stage === 'stable' ? '' : `(${stage}) `;
}
