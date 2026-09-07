---
name: taste-skill
description: Design new browser-facing artifacts or substantial visual redesigns using the deployment's house style and the bundled design references.
---

# Design references

Use existing components and tokens for small UI fixes. New designs use the
installed `*-design` skill for house style, or
`skills/popular-web-designs/SKILL.md` when the user requests a specific brand.

Read relevant sections of `references/tasteskill.md` for a new design or redesign.
For dense product/admin UI, use its accessibility and anti-tell guidance rather
than its landing-page process. Its block library is a schema, not shipped files;
there is no `blocks/` directory in this bundle.

Build in the requested repository's stack, or as local HTML when standalone.
Verify the affected page and states with local Chromium. Use the available
`write`, `read`, `execute`, and `background` tools; hosted-only callbacks and
artifact tools named by the reference are not provided by this runtime.

Publish with `skills/publish/SKILL.md` when a hosted artifact and its audience
are authorized. Otherwise return the local artifact.

## Provenance

`references/tasteskill.md` is vendored verbatim from
[leonxlnx/taste-skill](https://github.com/leonxlnx/taste-skill) (MIT); keep its
`LICENSE`. Update by re-copying the source skill rather than editing the reference.
