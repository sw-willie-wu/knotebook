// Compared with `!==`, not `<`: a server rollback also needs a reload. A collab token without it counts as 0.
// Bump on any schema change (block/inline/style types, prop names, defaults); the digest test in
// note-schema-version.test.ts enforces it. The first gated version is 1.
export const NOTE_SCHEMA_VERSION = 3;
