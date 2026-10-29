/**
 * The languages spell checking can run in — exactly the five report languages of the Report page,
 * because those are the only languages PrismLCA asks anyone to write prose in. Each choice names the
 * bundled `.bdic` dictionaries it stands for (resources/dictionaries/); Português carries both
 * variants, since a report language of "pt" promises no less than either.
 *
 * Shared between the main process (which applies them to the session) and the Settings page (which
 * offers them) so the two cannot drift apart.
 */
export const SPELLCHECK_CHOICES: { code: string; label: string; dicts: string[] }[] = [
  { code: 'en', label: 'English', dicts: ['en-US'] },
  { code: 'de', label: 'Deutsch', dicts: ['de-DE'] },
  { code: 'fr', label: 'Français', dicts: ['fr-FR'] },
  { code: 'es', label: 'Español', dicts: ['es-ES'] },
  { code: 'pt', label: 'Português', dicts: ['pt-PT', 'pt-BR'] }
]

/** Every dictionary code a settings value may contain — anything else is dropped on read. */
export const ALL_SPELLCHECK_DICTS: string[] = SPELLCHECK_CHOICES.flatMap((c) => c.dicts)
