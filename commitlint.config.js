// Commit messages follow Conventional Commits (feat:, fix:, chore(release): ...), checked by the
// commit-msg hook in .husky/. The changelog and the release notes are written from these.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Subjects often start with a name: "fix: Windows-safe path hints", "docs: README for Claude Code".
    'subject-case': [0],
  },
};
