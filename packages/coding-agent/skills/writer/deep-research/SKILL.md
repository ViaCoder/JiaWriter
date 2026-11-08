---
name: deep-research
description: Researches a question across many sources and writes a sourced report, briefing or news round-up. Use when the user asks to research, investigate or compile news on a topic.
metadata:
  title: Deep research（深度研究）
  style_packs: core-zh,core-en
  negation_threshold: 3
---

# Deep research

Answer from sources a careful reader would trust, showing where each fact comes from. Use this only when the user asks for research.

## Steps

1. Split the question into the 2–5 sub-questions an answer needs; a single fact takes a few searches, a comparison or situation report every sub-question searched.
2. Choose each search's method by where its sources are: international outlets through firecrawl (news: true for recent reports), Chinese sources through deepseek, papers through anysearch with tag academic.paper. Start with a short, broad query, then narrow with the names, dates and sites the first results show.
3. Open the two or three most authoritative pages for each sub-question (official releases, the outlet's own page rather than a repost, the original paper); a result list is a lead. Record each fact with material_add: fact, date, outlet, address.
4. Check the gaps: sub-questions with no recorded fact, and facts that conflict. Search once more for those; what is still missing is said in the answer.
5. Write from the record only; before finishing, check every statement against it and drop or source one with no entry.

## Reports

- Conclusions and main recommendations first, then findings by sub-question; each problem has a recommendation.
- Give each figure with its definition, period and source; state the assumptions behind an estimate; trace causes to a level where action is possible.

## News round-ups

- Report only facts and what named sources said, never your own analysis or a conclusion in a source's name.
- Order items by importance, or by date in a chronology, each dated; when the user names the materials, use only those.
