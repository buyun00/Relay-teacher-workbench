# Teacher workbench

- Scope: one Hermes teacher plugin, SQLite and files; reuse ASR and courseware. No uploader, Aliyun or school platform in this iteration.
- Keep real teaching data, runtime state and credentials outside the repository. Tests use explicitly fictional records.
- Use native Hermes plugin APIs; do not patch Hermes core, upgrade the host, restart unrelated services or mount the Docker socket.
- Model reasoning is flexible; storage, source validation, scores, revisions and task completion are deterministic code.
- Student identity is independent of event interpretation. Unknown speakers remain unknown; speaker labels are local to one recording.
- Teacher corrections preserve originals and revision history, immediately update effective facts and invalidate dependent artifacts.
- Validate citations against current versions. Never count a chat reply or webhook acceptance as persisted business completion.
- Test meaningful invariants and the real Hermes tool surface. Distinguish synthetic-data tests, real ASR and real classroom acceptance.
