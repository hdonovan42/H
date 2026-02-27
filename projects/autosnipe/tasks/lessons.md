# AutoSnipe — Lessons

## 1. Don't implement things with zero merit just because the plan says so
**Date**: 27 Feb 2026
**Context**: Plan called for `X-Admin-Token` middleware on admin GET endpoints. Implemented it despite the endpoints already being behind nginx basic auth. The middleware immediately broke the admin dashboard (no token was set), and the approach itself (shared static secret) has no advantages over the existing nginx auth — and is worse than role-based auth for multi-user scaling.
**Rule**: If a plan item adds complexity with no clear benefit over what already exists, push back before implementing. Ask: "What does this protect against that the existing setup doesn't?"
