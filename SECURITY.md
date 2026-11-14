# Security Policy

Please report security vulnerabilities privately. Do not open a public issue.

Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository. If that is unavailable, contact the maintainers directly through the contact method listed on the repository owner's profile.

Include a description, reproduction steps, affected version/commit and impact. We aim to acknowledge reports within 5 business days and will coordinate a fix and disclosure timeline with you.

Scope notes: the Firestore/Storage rules and Cloud Functions in `packages/ff-firestore` are security-relevant. Firebase web client config values are public by design; access control is enforced by the rules.
