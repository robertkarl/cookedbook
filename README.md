# Cookedbook

Recipes for people who are cooking, not scrolling.

No ads. No life stories. No SEO-optimized filler about how my grandmother discovered garlic in 1947.

## What is this

A static recipe site built with [Hugo](https://gohugo.io/), hosted on GitHub Pages at [cookedbook.net](https://cookedbook.net).

Recipes are markdown files. The site has search, interactive checkboxes for tracking ingredients/steps, and large touch-friendly text for use on tablets and phones in actual kitchens.

## Adding a recipe

Drop a markdown file in `content/recipes/`. Front matter:

```yaml
---
title: "Your Recipe"
summary: "One line description."
prep_time: "10 min"
cook_time: "30 min"
servings: "4"
source: "Optional attribution"
tags: ["chicken", "weeknight", "one-pan"]
---
```

The body is freeform markdown. Use whatever structure fits the recipe — sub-steps, notes, scaling tables, whatever.

## Development

```
make serve    # local dev server at localhost:1313
make build    # build to public/
make clean    # nuke the build output
```

Requires Hugo (`brew install hugo`).

## Deployment

Push to `main`. GitHub Actions builds and deploys to GitHub Pages automatically.
