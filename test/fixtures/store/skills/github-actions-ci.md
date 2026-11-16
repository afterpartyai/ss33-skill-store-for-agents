---
name: github-actions-ci
description: Set up a GitHub Actions CI pipeline with lint, test and type-check steps for Node.js projects.
---

# GitHub Actions CI

1. Create `.github/workflows/ci.yml`.
2. Run `npm ci`, then lint, type-check and test as separate steps.
3. Use a Node version matrix that matches `engines` in package.json.
