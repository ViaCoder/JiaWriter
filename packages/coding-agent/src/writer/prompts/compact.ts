/** Stage 10: what the model is asked at compaction. The program keeps the rest (writer/compact/state.ts). */

/** The three headings the model writes. */
const HEADINGS = `## Decisions
[What the user settled: scope, structure, which parts need cases]

## Preferences
[How the user wants the work done]

## Next
[What comes next]

Write (none) under an empty heading.`;

/** First compaction of a session. */
export const SUMMARY_PROMPT = `The messages above are a writing session. The program keeps the drafts, the research and the user's words, so write only what those do not show, in the user's language, in at most 800 characters:

${HEADINGS}`;

/** The start of a long turn whose end is kept. */
export const SUMMARY_TURN_PROMPT = `The messages above are earlier context from an ongoing conversation. Its later messages are kept, and the program keeps the drafts and research, so write only what the user asked and what was settled, in the user's language, in at most 300 characters. Do not infer or recreate later messages.`;

/** Later compactions. */
export const SUMMARY_UPDATE_PROMPT = `Update <previous-summary> with the messages above, keeping what still holds, in the user's language, in at most 800 characters:

${HEADINGS}`;
