#!/usr/bin/env bash
# Example: CI/CD Quality Gate for AL Profiles
#
# Usage in Azure DevOps pipeline:
#   - script: bash examples/ci-gate.sh path/to/profile.alcpuprofile
#     displayName: 'Performance Gate'
#
# Usage in GitHub Actions:
#   - run: bash examples/ci-gate.sh path/to/profile.alcpuprofile
#
# Prerequisites: bun installed, al-profile-analyzer available
# Install: bun add al-profile-analyzer

set -euo pipefail

PROFILE="${1:?Usage: ci-gate.sh <profile-path> [--source <source-dir>]}"
shift

# Run the gate command
RESULT=$(bun run src/cli/index.ts gate "$PROFILE" -f json "$@" 2>&1) || true

# Parse result
VERDICT=$(echo "$RESULT" | jq -r '.verdict')
CRITICAL=$(echo "$RESULT" | jq -r '.counts.critical')
WARNING=$(echo "$RESULT" | jq -r '.counts.warning')
INFO=$(echo "$RESULT" | jq -r '.counts.info')

echo "Performance Gate: $VERDICT"
echo "  Critical: $CRITICAL | Warning: $WARNING | Info: $INFO"

# Show violations if any
VIOLATIONS=$(echo "$RESULT" | jq -r '.violations[]' 2>/dev/null)
if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "Violations:"
  echo "$VIOLATIONS" | while read -r v; do echo "  - $v"; done
fi

# Show patterns
PATTERNS=$(echo "$RESULT" | jq -r '.patterns[] | "  [\(.severity)] \(.title)"' 2>/dev/null)
if [ -n "$PATTERNS" ]; then
  echo ""
  echo "Detected Patterns:"
  echo "$PATTERNS"
fi

# Exit with gate verdict
if [ "$VERDICT" = "pass" ]; then
  exit 0
else
  exit 1
fi
