#!/usr/bin/env bash
# Creates and updates this repository's labels from .github/labels.yml, with the GitHub CLI.
# Safe to run again: labels that exist are updated, and renamed labels keep their issues.
# Nothing is deleted. Labels that exist on GitHub but not in labels.yml are listed at the end.
#
# Usage:   .github/scripts/sync-labels.sh [--dry-run] [owner/repo]
# Default: mohamedsabith/setupscore
# Needs:   the GitHub CLI (https://cli.github.com), signed in with "gh auth login" as someone
#          who can manage labels (Triage role or higher). --dry-run only prints the gh commands.
set -euo pipefail

dry_run=false
repo=''
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "Unknown option: $arg (see --help)" >&2
      exit 2
      ;;
    *) repo="$arg" ;;
  esac
done
repo="${repo:-mohamedsabith/setupscore}"
file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/labels.yml"

# Prints one line per label in labels.yml: name, color, description and from_name, separated by tabs.
# Values may be in double quotes or in single quotes (where '' stands for one ').
parse() {
  awk '
    function value(line,   q) {
      sub(/^[^:]*:[ \t]*/, "", line)
      sub(/[ \t\r]+$/, "", line)
      q = substr(line, 1, 1)
      if ((q == "\"" || q == "\047") && substr(line, length(line), 1) == q) {
        line = substr(line, 2, length(line) - 2)
        if (q == "\047") gsub(/\047\047/, "\047", line)
      }
      return line
    }
    function flush() {
      if (name != "") printf "%s\t%s\t%s\t%s\n", name, color, desc, from
      name = color = desc = from = ""
    }
    /^[ \t]*(#|$)/ { next }
    /^- name:/ { flush(); name = value($0); next }
    /^  color:/ { color = value($0); next }
    /^  description:/ { desc = value($0); next }
    /^  from_name:/ { from = value($0); next }
    { printf "%s line %d: cannot read \"%s\"\n", FILENAME, NR, $0 > "/dev/stderr"; bad = 1; exit 1 }
    END { if (!bad) flush() }
  ' "$1"
}

labels="$(parse "$file")"

# Check the file before changing anything on GitHub.
problems=0
seen=''
while IFS=$'\t' read -r name color desc _; do
  if [[ ! "$color" =~ ^[0-9a-fA-F]{6}$ ]]; then
    echo "labels.yml: \"$name\" has the color \"$color\". Use 6 hex digits without #." >&2
    problems=1
  fi
  if ((${#desc} > 100)); then
    echo "labels.yml: the description of \"$name\" has ${#desc} characters. GitHub allows 100." >&2
    problems=1
  fi
  if grep -Fxq -- "$name" <<<"$seen"; then
    echo "labels.yml: \"$name\" is listed twice." >&2
    problems=1
  fi
  seen+="$name"$'\n'
done <<<"$labels"
((problems == 0)) || exit 1

if existing="$(gh label list --repo "$repo" --limit 1000 --json name --jq '.[].name' 2>/dev/null)"; then
  :
elif $dry_run; then
  echo "Could not read the labels of $repo (is gh signed in?). Showing every label as new." >&2
  existing=''
else
  echo "Could not read the labels of $repo. Check that gh is installed and signed in: gh auth status" >&2
  exit 1
fi

has() { grep -Fxq -- "$1" <<<"$existing"; }
run() {
  if $dry_run; then
    printf '  would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@" >/dev/null
  fi
}

renamed_from=''
while IFS=$'\t' read -r name color desc from; do
  if [[ -n "$from" ]] && has "$from" && ! has "$name"; then
    echo "Rename \"$from\" to \"$name\""
    run gh label edit "$from" --repo "$repo" --name "$name" --color "$color" --description "$desc"
    renamed_from+="$from"$'\n'
  elif has "$name"; then
    echo "Update \"$name\""
    run gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force
  else
    echo "Create \"$name\""
    run gh label create "$name" --repo "$repo" --color "$color" --description "$desc" --force
  fi
done <<<"$labels"

extra=''
while IFS= read -r name; do
  [[ -z "$name" ]] && continue
  grep -Fxq -- "$name" <<<"$seen" && continue
  grep -Fxq -- "$name" <<<"$renamed_from" && continue
  extra+="  gh label delete $(printf '%q' "$name") --repo $repo --yes"$'\n'
done <<<"$existing"

if [[ -n "$extra" ]]; then
  echo
  echo "These labels are on GitHub but not in labels.yml. They were left alone. If nothing uses them, delete them:"
  printf '%s' "$extra"
fi
$dry_run && echo && echo "Dry run: nothing was changed."
exit 0
