#!/usr/bin/env bash
#
# ingest-recipe.sh — OCR cookbook photos and generate CookedBook markdown drafts.
#
# Usage:
#   ./scripts/ingest-recipe.sh photo1.jpg                  # single page, one recipe
#   ./scripts/ingest-recipe.sh page1.jpg page2.jpg ...     # multi-page, auto-detect recipe boundaries
#
# Handles: one recipe spanning multiple pages, multiple recipes across pages,
# or a recipe that starts mid-page after another one ends.
#
# Requires: ANTHROPIC_API_KEY env var, jq, base64.
# Output:   content/recipes/<slug>.md files (drafts for human review)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <image-file> [image-file ...]"
  echo ""
  echo "  Pass one or more photos of cookbook pages."
  echo "  Claude will figure out recipe boundaries and generate"
  echo "  one markdown file per recipe found."
  exit 1
fi

if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
  echo "Error: ANTHROPIC_API_KEY not set"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required. Install with: brew install jq"
  exit 1
fi

# Build the image content blocks as a JSON array
IMAGE_BLOCKS="[]"

for IMAGE in "$@"; do
  if [[ ! -f "$IMAGE" ]]; then
    echo "Error: file not found: $IMAGE"
    exit 1
  fi

  EXT="${IMAGE##*.}"
  EXT_LOWER=$(echo "$EXT" | tr '[:upper:]' '[:lower:]')
  ACTUAL_IMAGE="$IMAGE"

  case "$EXT_LOWER" in
    jpg|jpeg) MEDIA_TYPE="image/jpeg" ;;
    png)      MEDIA_TYPE="image/png" ;;
    gif)      MEDIA_TYPE="image/gif" ;;
    webp)     MEDIA_TYPE="image/webp" ;;
    heic)
      TMPJPG=$(mktemp /tmp/ingest-XXXXX.jpg)
      sips -s format jpeg "$IMAGE" --out "$TMPJPG" >/dev/null 2>&1
      ACTUAL_IMAGE="$TMPJPG"
      MEDIA_TYPE="image/jpeg"
      ;;
    *)
      echo "Error: unsupported image format: $EXT (file: $IMAGE)"
      exit 1
      ;;
  esac

  echo "Encoding: $IMAGE"
  BASE64_IMAGE=$(base64 < "$ACTUAL_IMAGE")

  IMAGE_BLOCKS=$(echo "$IMAGE_BLOCKS" | jq \
    --arg media_type "$MEDIA_TYPE" \
    --arg base64_image "$BASE64_IMAGE" \
    '. + [{
      type: "image",
      source: {
        type: "base64",
        media_type: $media_type,
        data: $base64_image
      }
    }]')
done

NUM_IMAGES=$#
echo "Sending $NUM_IMAGES image(s) to Claude..."

PROMPT="You are a recipe extraction tool for CookedBook. You receive $NUM_IMAGES photo(s) of cookbook pages, in order.

Your job:
1. Read all pages. Identify every distinct recipe across the images.
2. A single recipe may span multiple pages. Combine them.
3. A single page may contain parts of two recipes. Split them.
4. For each recipe, extract title, ingredients, and instructions.
5. Rewrite instructions as SHORT, TERSE, IMPERATIVE steps. Strip all stories, anecdotes, prose, brand plugs, and filler. Keep only what a cook at the stove needs.
6. Extract metadata: prep time, cook time, servings, source (cookbook name + page number if visible).
7. Pick tags from: beef, pork, chicken, seafood, vegetarian, vegan, pasta, baking, grilling, cast iron, dutch oven, pressure cooker, slow cooker, weeknight, quick, soup, salad, side, dessert, breakfast, sauce, fermentation, smoking, sous vide.

Output format — you MUST output a JSON array (no markdown fences, no explanation before or after):

[
  {
    \"slug\": \"kebab-style-slug\",
    \"markdown\": \"---\\ntitle: \\\"Recipe Title\\\"\\nsummary: \\\"One punchy sentence.\\\"\\nprep_time: \\\"X min\\\"\\ncook_time: \\\"X min\\\"\\nservings: \\\"X\\\"\\nsource: \\\"Cookbook Name, p. XX\\\"\\ntags: [\\\"tag1\\\", \\\"tag2\\\"]\\n---\\n\\n## Ingredients\\n\\n- ingredient 1\\n\\n## Instructions\\n\\n1. Step one.\\n\\n## Notes\\n\\n- Practical tip.\\n\"
  }
]

Rules:
- No stories, history, or \"my grandmother\" prose
- No \"you will love this\" or \"perfect for weeknight\"
- Steps: 1-2 sentences max, imperative voice
- Use specific temps, times, measurements
- Mark anything unclear with [?]
- slug should be lowercase, hyphenated, concise (e.g. \"chicken-parm\", \"braised-short-ribs\")
- Output ONLY the JSON array. Nothing else."

# Build the full content array: all images + the text prompt
CONTENT=$(echo "$IMAGE_BLOCKS" | jq \
  --arg prompt "$PROMPT" \
  '. + [{type: "text", text: $prompt}]')

RESPONSE=$(curl -s https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n \
    --argjson content "$CONTENT" \
    '{
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{
        role: "user",
        content: $content
      }]
    }')")

# Extract text from response
TEXT=$(echo "$RESPONSE" | jq -r '.content[0].text // empty')

if [[ -z "$TEXT" ]]; then
  echo "Error: no response from API."
  echo "$RESPONSE" | jq .
  exit 1
fi

# Parse the JSON array of recipes
NUM_RECIPES=$(echo "$TEXT" | jq 'length')

if [[ "$NUM_RECIPES" == "null" ]] || [[ "$NUM_RECIPES" -lt 1 ]]; then
  echo "Error: could not parse recipes from response."
  echo "Raw response:"
  echo "$TEXT"
  exit 1
fi

echo ""
echo "Found $NUM_RECIPES recipe(s):"
echo ""

for i in $(seq 0 $((NUM_RECIPES - 1))); do
  SLUG=$(echo "$TEXT" | jq -r ".[$i].slug")
  MARKDOWN=$(echo "$TEXT" | jq -r ".[$i].markdown")
  OUTFILE="content/recipes/${SLUG}.md"

  if [[ -f "$OUTFILE" ]]; then
    echo "  SKIP: $OUTFILE already exists"
    continue
  fi

  echo "$MARKDOWN" > "$OUTFILE"
  echo "  DRAFT: $OUTFILE"
done

echo ""
echo "IMPORTANT: These are DRAFTS. You must:"
echo "  1. Read each file and verify instructions are correct"
echo "  2. Check for [?] markers where OCR was uncertain"
echo "  3. Cook it or sanity-check it before publishing"
