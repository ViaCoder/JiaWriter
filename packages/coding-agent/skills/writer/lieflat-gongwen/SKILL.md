---
name: lieflat-gongwen
description: "公文: reports, speeches, plans, notices."
license: PolyForm-Noncommercial-1.0.0 (see LICENSE in this folder)
metadata:
  title: 公文写作（lieflat-gongwen）
  style_packs: core-zh,gongwen-zh
  negation_threshold: 3
  source: https://github.com/larashero3-dotcom/lieflat-gongwen (commit 24147448, 2026-11-02), rewritten for JiaWriter at the user's request
---

# Official documents (公文)

Write each genre as an experienced drafter would: judgment first, specific evidence, restrained wording. Analysis paragraphs follow the writing rules. The program checks citation form, heading numbers, in-text ordinals, placeholders and AI style; this skill covers only what the program cannot check.

## Steps

1. Pick the genre. Surveying a situation and proposing measures: research report (调研报告). Deploying work at a meeting: leader's speech (领导讲话). Setting rules for lower units: work opinion (工作意见). Reporting practices: experience material (经验材料). Setting goals and dividing tasks: work plan (工作方案). Statutory documents (通知, 请示, 批复, 函) follow the layouts in `参考/法定公文样例/`.
2. When asked for one paragraph or section, write only that part; no outline.
3. For a whole document, first read the genre's section of `公文语料/文章结构模板.md` to lay out the structure, then assign the cases and data in the materials to the judgments, recording with material_add which judgment uses which item.
4. After you write, the program infers the genre from the title and runs the official-document parameter check, reporting only hard conflicts; fix what it reports. You need not call `gongwen_check` yourself.

## Countermeasures

Purpose: each measure answers one problem named earlier, at its cause, in a form someone can carry out.

- One verb-object heading per measure and one paragraph under it, without restating earlier text.
- Open by naming the problem it answers, with the genre's openers (针对, 面向, 围绕, 着眼, 鉴于), varied across measures; state measures as decisions, not hypotheses.
- Then a few sentences of 要 plus a concrete action, each followed by how: channel, mechanism, timing or focus. Write 要, not 应, and no ordinals.
- Concrete actions, not slogans that only name a goal; vary the main verbs.
- Name the responsible party when it is clear, by the body's name or its function; give platforms and standards their full names.
- No cases, dates or sources in countermeasures.

## Statutory documents

- The transition sentence fixes the genre: a notice uses “现将有关事项通知如下：”; a reply uses “……收悉。现批复如下：”.
- A reply states its position in the first sentence, the reasons after. Length follows the matter; stop when it is said.
- Closings: notice 特此通知, request 妥否，请批示, report 特此报告, letter 特此函复. Research reports and experience materials end naturally, with no closing formula.

## Headings

- The document title is issuing body + matter + genre, or states the matter directly.
- A subheading states its section's judgment plainly in at most 20 characters, in concrete words; headings of one level share one sentence pattern; level-1 headings of plans and opinions have 4–8 characters. Read `标题技法库.md` when drafting headings.

## Language

Purpose: official prose persuades by stating facts and judgments plainly; spoken, figurative or emphatic wording weakens it.

- Use the formal written register: say directly what happened and what it means, and replace figures of speech, personification and spoken words with the plain written term.
- Match the strength of a judgment to its evidence, and argue forward rather than by contrast.
- Name actors and things directly, by proper or functional names; refer to one's own side as 我 or 我国.
- Keep obligation words and dashes rare; colons only for quotations, the addressee and the level headings of statutory documents.
- Gloss a term only when it is genuinely obscure.
- Acknowledge achievements before criticizing a system; experience materials leave out the unit's unsolved problems.
- Use only facts in the materials; without data, make the point by reasoning.
- Sentences get their length from parallel elements; read `句子对照库.md` when unsure how to fix one.

Pass: 审批时限由20个工作日压缩至5个工作日。
Fail: 审批像坐上了快车，企业再也不用苦等。(A figure and spoken words in place of the fact.)

## Reference files (read when needed)

- `参数卡.md`: length, sentence length, enumeration-comma density and strong-word counts per genre.
- `公文语料/写作视角与认知框架.md`: stance and attribution in documents to superiors.
- `公文语料/语言DNA.md`: common verbs and adverbs, and words to avoid.
