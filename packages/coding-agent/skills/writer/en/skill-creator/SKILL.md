---
name: skill-creator
description: For creating or changing a writing skill, also from sample texts or the requests of a session.
disable-model-invocation: true
metadata:
  title: Writing skill creator
  style_packs: core-en
  negation_threshold: 3
---

# Writing skill creator

Creates or changes a writing skill: concrete, checkable rules, as short as possible.

## File format

- A skill is a folder with SKILL.md. The file starts with frontmatter:
  - name: lowercase letters, digits and hyphens, at most 64 characters, the same as the folder name;
  - description: what the skill does and when to use it, at most 1024 characters;
  - metadata.title: a display title; metadata.style_packs: the packs style_check uses.
- The body has Markdown sections: before writing, structure, style, citations, final checks.

## Wording

- Write each rule as an instruction that says what to do, for example "use common words", "one point per paragraph".
- Make rules specific enough to check: length ranges, heading levels, citation format.
- Keep exact values from the user's own words (font size, line spacing, length) as given.
- When a topic has several requests, keep the latest.

## Learning from samples

- Import the sample texts with import_document and measure sentence length, paragraph length, heading levels and the usual openings and endings.
- Write the reusable practices as rules and leave the sample content in its files.

## Saving

- Save new skills as ~/.jiawriter/agent/skills/<name>/SKILL.md; back up an existing skill before changing it.
- After saving, tell the user to run /reload.
