# Teacher workbench

- Scope: one Hermes teacher plugin, SQLite and files; reuse ASR and courseware. The next authorized iteration adds the React/Electron desktop file uploader and a thin receiver using the same Store. No Aliyun or school platform work.
- Keep real teaching data, runtime state and credentials outside the repository. Tests use explicitly fictional records.
- Use native Hermes plugin APIs; do not patch Hermes core, upgrade the host, restart unrelated services or mount the Docker socket.
- Model reasoning is flexible; storage, source validation, scores, revisions and task completion are deterministic code.
- Student identity is independent of event interpretation. Unknown speakers remain unknown; speaker labels are local to one recording.
- Teacher corrections preserve originals and revision history, immediately update effective facts and invalidate dependent artifacts.
- Validate citations against current versions. Never count a chat reply or webhook acceptance as persisted business completion.
- Internal development uses ordinary Hermes tools and filesystem access. Do not add plugin authorization hooks, import path/size restrictions, file hash rechecks, or courseware structure gates. Keep source version checks and deterministic business completion.
- Test meaningful invariants and the real Hermes tool surface. Distinguish synthetic-data tests, real ASR and real classroom acceptance.
- For desktop-client deliveries, also build a local Windows installer with `npm run pack:local` and provide its local file path. Keep local installers in ignored `uploader/release-local/`, with local version labels and GitHub auto-update disabled. GitHub Actions continues to build and publish the official installer with `npm run pack:win`.
