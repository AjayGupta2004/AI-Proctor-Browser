# Application screenshots and demo capture checklist

The repository currently has no verified screenshots or demo recording. Capture these from a running application build rather than using mockups or generated images.

## Suggested screenshots

- Teacher dashboard with synthetic sample exam data.
- Create/edit exam screen with fake questions and no real institution/student information.
- Candidate exam room showing a demo exam and camera panel.
- Live monitoring screen using a synthetic test session.
- Post-exam report with fabricated scores and event data.

## Capture and privacy checklist

- Use test accounts and synthetic names, IDs, questions, answers, and scores.
- Do not include real student records, faces, camera frames, microphone recordings, credentials, environment files, access tokens, or evidence images.
- Close developer tools and terminals that might expose environment variables or connection strings.
- Confirm the application is running against a development database, not a production/student database.
- Save approved, redacted captures in `docs/screenshots/` and link them from the root README.
- For a demo video, narrate the teacher setup, candidate exam, monitoring workflow, and report review. Clearly label any simulated monitoring events.
