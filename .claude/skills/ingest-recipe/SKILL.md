---
name: ingest-recipe
description: >
  OCR cookbook photos and generate CookedBook recipe markdown drafts.
  Takes image file paths as arguments. Spawns a subagent to read the images
  (keeps them out of main context), identify recipe boundaries, and write
  one markdown file per recipe to content/recipes/.
argument-hint: <image1.jpg> [image2.jpg ...]
---

# Recipe Ingestion

Ingest cookbook photos into CookedBook recipe drafts.

**Images to process:** $ARGUMENTS

## Steps

1. **Convert HEIC to JPEG if needed.** Use `sips` to convert any HEIC files to JPEG at 900px max dimension in `/tmp/cookedbook-ingest/`. This keeps file sizes under 256KB so the subagent can read them.

```bash
mkdir -p /tmp/cookedbook-ingest
for f in <each image>; do
  sips -s format jpeg -Z 900 "$f" --out "/tmp/cookedbook-ingest/$(basename ${f%.*}).jpg"
done
```

2. **Spawn a subagent** (using the Agent tool) to do the actual extraction. The subagent should:
   - Read ALL the converted images (in filename order — this is page order)
   - Identify recipe boundaries (recipes may span pages, pages may contain multiple recipes)
   - For EACH recipe found, write a markdown file to `content/recipes/<slug>.md`

   Pass this prompt to the subagent:

   > Read all the images in /tmp/cookedbook-ingest/ in filename-sorted order. These are photos of cookbook pages.
   >
   > For each distinct recipe you find across the pages:
   >
   > 1. Extract: title, ingredients list, instructions, prep time, cook time, servings, source (cookbook + page number if visible), and relevant tags.
   > 2. Rewrite instructions as SHORT, TERSE, IMPERATIVE steps. Strip ALL stories, anecdotes, "my grandmother" prose, brand plugs, history, and filler. Keep ONLY what a cook standing at the stove needs.
   > 3. Steps should be 1-2 sentences max.
   > 4. Use specific temps, times, and measurements.
   > 5. Add inline timer shortcodes wherever a step has a specific wait/cook time. Format: `{{</* timer "Xm" "label" */>}}` where X is the duration and label describes what's timing. Examples:
   >    - "Roast for 25 minutes" → `Roast for 25 minutes. {{</* timer "25m" "roast" */>}}`
   >    - "Sear 4 minutes per side" → `Sear 4 minutes per side. {{</* timer "4m" "sear side 1" */>}}`
   >    - "Braise 3 hours" → `Braise 3 hours. {{</* timer "3h" "braise" */>}}`
   >    - "Rest 10 minutes" → `Rest 10 minutes. {{</* timer "10m" "rest" */>}}`
   >    Only add timers for explicit durations, not vague times like "until golden" or "until tender".
   > 6. Mark anything unclear or hard to read with [?].
   > 7. Pick tags from: beef, pork, chicken, seafood, vegetarian, vegan, pasta, baking, grilling, cast iron, dutch oven, pressure cooker, slow cooker, weeknight, quick, soup, salad, side, dessert, breakfast, sauce, fermentation, smoking, sous vide.
   >
   > Write each recipe to /Users/robertkarl/Code/cookedbook/content/recipes/<slug>.md using this format:
   >
   > ```
   > ---
   > title: "Recipe Title"
   > summary: "One punchy sentence. No fluff."
   > prep_time: "X min"
   > cook_time: "X min"
   > servings: "X"
   > source: "Cookbook Name, p. XX"
   > tags: ["tag1", "tag2"]
   > ---
   >
   > ## Ingredients
   >
   > - ingredient 1
   > - ingredient 2
   >
   > ## Instructions
   >
   > 1. Terse imperative step.
   > 2. Another step.
   >
   > ## Notes
   >
   > - Only practical tips. No fluff.
   > ```
   >
   > Rules:
   > - No stories, no history, no "this recipe has been in my family"
   > - No "you will love this" or "perfect for a weeknight"
   > - If a recipe spans multiple pages, combine it into one file
   > - If a page has parts of two recipes, split them correctly
   > - If a recipe is cut off (missing pages), note it and mark with [?]
   > - Skip the "WHY THIS RECIPE WORKS" sections — that's prose, not instructions
   > - Do NOT skip any recipe you can identify, even partial ones
   >
   > When done, list all files you created.

3. **Report results.** Tell the user which recipes were created and remind them to review for [?] markers and correctness. Offer to open them in vim.
