In this project we're making a website for recipes.

All websites on the internet that have recipes on them are the worst website in the world. They're all tied for worst.

Cookedbook is different. and after we build this I'm going to register cookedbook.net for $12 (it's available).

The idea is simple: store recipes.

The backend data format? Markdown.

The ad / revenue model? Just serve the webpages there are no ads.

We'll do some server-side analytics with something pre-canned.


# features

- Push new markdown files to a github repo. a static site generator turns them into html. Use a git hook or a Makefile before committing. give me options for commonly used SSG setups.
- serve directly from github pages just to be easy.
- our copyright working model: instructions and ingredients lists are not copyrighted. so recipes can be included from sources like Meat Illustrated or Joy of Cooking.
  the copy, descriptions of how our grandmother used to make this back in the old country, and fables about types of apple trees aren't desired anyways.
- This website is for people that are working in a kitchen, not fucking around. Large text. Support a wide variety of devices (web first). My primary use will be on iPad. no horizontal scrolling. greasy fingers will be poking at this. big buttons. 
- Interactivity. It should provide check boxes so cooks and sous chefs can mark items as completed or ingredients acquired/prepped. Save their state in local memory and offer a button to clear them.
- Add an index page that lists all known recipes and a bit of info about each.
- Add a page that has search: it accepts ingredients or techniques with completion and shows recipes that match.

# recipes to start with
Claude should suggest a few to start with. I have a couple in markdown as well. We'll iterate on the structure required for recipes. Let's not have a fixed schema, since they can vary widely and have sub-steps.



