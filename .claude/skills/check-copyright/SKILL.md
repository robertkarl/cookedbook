---
name: check-copyright
description: >
  Compare a recipe markdown file against OCR of the original cookbook page(s)
  to flag text that's copied too closely. Ingredients lists, temperatures, and
  basic measurements are exempt — only prose, instructions wording, and notes
  are checked. Takes a recipe .md path and source image path(s) as arguments.
argument-hint: <recipe.md> <source-image1.jpg> [source-image2.jpg ...]
---

# Copyright Check

Compare a CookedBook recipe against its source material to catch text that hews
too closely to the original.

**Arguments:** $ARGUMENTS

## Legal model

Per CLAUDE.md: ingredient lists and bare factual instructions (temperatures,
times, measurements) are **not copyrightable**. What IS copyrightable:

- Prose descriptions, anecdotes, headnotes, stories
- Creative/distinctive phrasing of instructions
- Notes, tips, and commentary that go beyond bare technique
- Specific word choices and sentence structures when they reflect the author's voice

The goal is NOT to strip all similarity — it's to ensure the recipe reads like
**our words**, not a lightly-edited copy of theirs.

## Steps

1. **Convert images if needed.** Same as ingest — use `sips` to convert HEIC
   to JPEG at 900px max in `/tmp/cookedbook-copyright-check/`.

```bash
mkdir -p /tmp/cookedbook-copyright-check
for f in <each source image>; do
  sips -s format jpeg -Z 900 "$f" --out "/tmp/cookedbook-copyright-check/$(basename ${f%.*}).jpg"
done
```

2. **Read the recipe markdown** from the path provided.

3. **Spawn a subagent** to do the comparison. The subagent should:
   - Read ALL source images in `/tmp/cookedbook-copyright-check/` (filename order)
   - Read the recipe markdown file
   - Perform a line-by-line comparison

   Pass this prompt to the subagent:

   > You are a copyright reviewer. Read the source cookbook images in
   > /tmp/cookedbook-copyright-check/ and the recipe markdown file at
   > [RECIPE_PATH].
   >
   > Compare the recipe against the original source material. For each
   > section of the recipe, check whether the wording is too close to
   > the original.
   >
   > ## What's EXEMPT (not copyrightable — ignore these)
   >
   > - Ingredient lists (quantities, ingredient names, prep descriptions
   >   like "diced" or "sliced thin")
   > - Temperatures ("oven at 250", "until internal temp reads 135°F")
   > - Times ("cook 5 minutes", "rest 10 minutes")
   > - Bare measurements and ratios
   > - Standard cooking verbs used the same way anyone would
   >   ("sear", "deglaze", "fold in", "bring to a simmer")
   > - Equipment references ("Dutch oven", "wire rack", "rimmed baking sheet")
   >
   > ## What to FLAG
   >
   > - Sentences or phrases where 5+ consecutive non-trivial words match
   >   the source verbatim
   > - Instructions that follow the source's sentence structure closely,
   >   even if a few words are swapped (light paraphrase)
   > - Notes or commentary that echo the source's voice or distinctive phrasing
   > - Descriptive language borrowed from the source ("the signature ingredient",
   >   creative metaphors, distinctive adjective choices)
   >
   > ## Output format
   >
   > For each issue found, report:
   >
   > ```
   > LINE <n>: <severity: CLOSE | VERBATIM>
   >   Recipe text: "<the text in question>"
   >   Source text: "<the original text from the cookbook>"
   >   Suggestion: "<how to rewrite it in our own words>"
   > ```
   >
   > Severity levels:
   > - **VERBATIM**: 5+ consecutive words copied exactly (excluding exempt content)
   > - **CLOSE**: Sentence structure and phrasing clearly derived from source,
   >   even if not word-for-word
   >
   > If the recipe is clean, say so: "No copyright concerns found."
   >
   > At the end, give an overall verdict:
   > - **CLEAN**: No issues
   > - **NEEDS REWRITE**: Has VERBATIM matches that should be rewritten
   > - **REVIEW**: Has CLOSE matches worth a human look

4. **Report results.** Show the subagent's findings to the user. If there are
   flagged lines, offer to rewrite them. If the user accepts, edit the recipe
   file with rewritten text and re-run the check to confirm it's clean.
