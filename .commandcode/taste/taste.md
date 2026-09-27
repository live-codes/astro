# Taste

- When extending a tool/library, prefers reusing existing infrastructure over building new mechanisms (e.g., hinting to leverage LiveCodes' compiler-in-compiler support rather than a bespoke solution). Confidence: 0.55
- For architecture/design questions, expects the agent to ground recommendations in the real code — exploring the repo and reading the referenced source files (often shared as direct source links) before answering. Confidence: 0.5
- Prefers work kept scoped to the current repo: don't modify downstream/consumer projects (e.g. LiveCodes) until the integration is considered ready. Confidence: 0.7
- Doesn't accept features left as "untested": asks the agent to actually verify the specific edge cases end-to-end (e.g. request to test client:visible/idle/media rather than take an unverified claim). Confidence: 0.5
