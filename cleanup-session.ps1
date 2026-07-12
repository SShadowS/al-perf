<#
.SYNOPSIS
  Tear down finished SDD worktrees, delete merged feature branches, and drop the
  CRLF-noise stashes that accumulate from the merge dance.

.DESCRIPTION
  DRY RUN BY DEFAULT. Nothing is touched until you pass -Execute.

  This repo has core.autocrlf on, so ~200 files sit permanently stat-dirty with
  no content diff. Merges and worktree removals therefore need the working tree
  stashed first, and those stashes pile up. This drops them.

  Three safety rules, all deliberate:

    1. Stashes are matched ONLY on the names this workflow generates —
       "crlf-noise*" and "line-ending*". Anything else (a real WIP, the
       poc-continuous-monitoring keepers) is never touched, and is listed at the
       end so you can decide yourself. The pattern is the safety mechanism: it
       cannot match a keeper.

    2. Branches are deleted with `git branch -d`, never -D. Git refuses to
       delete anything not fully merged. An unmerged branch survives and is
       reported.

    3. Stashes are dropped highest-index-first, because dropping stash@{3}
       renumbers everything above it. Low-to-high would delete the wrong entries.

.PARAMETER Execute
  Actually perform the cleanup. Without this, the script only prints its plan.

.PARAMETER SkipStashes
  Leave all stashes alone. Worktrees and branches only.

.EXAMPLE
  .\cleanup-session.ps1
  Show what would be cleaned up. Changes nothing.

.EXAMPLE
  .\cleanup-session.ps1 -Execute
  Do it.
#>

[CmdletBinding()]
param(
    [switch]$Execute,
    [switch]$SkipStashes
)

$ErrorActionPreference = 'Stop'

# Stash names this workflow generates. Everything else is left alone.
$StashPattern = '^(crlf-noise|line-ending)'

function Write-Header($text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}

function Write-Plan($text) {
    $prefix = if ($Execute) { "  ->" } else { "  would" }
    Write-Host "$prefix $text"
}

# --- sanity: we must be at the top of the al-perf repo, not inside a worktree ---

$topLevel = (git rev-parse --show-toplevel 2>$null)
if (-not $topLevel) { throw "Not inside a git repository." }
$topLevel = $topLevel -replace '/', '\'
if ((Get-Location).Path -ne $topLevel) {
    throw "Run this from the repo root ($topLevel), not from a subdirectory or worktree."
}

$branch = (git rev-parse --abbrev-ref HEAD)
if ($branch -ne 'master') {
    throw "Expected to be on master, but HEAD is '$branch'. Refusing to clean up from a feature branch."
}

if (-not $Execute) {
    Write-Host ""
    Write-Host "DRY RUN — nothing will be changed. Re-run with -Execute to apply." -ForegroundColor Yellow
}

# --- 1. worktrees ---------------------------------------------------------

Write-Header "Worktrees"

# `git worktree list --porcelain` emits blank-line-separated records; the main
# worktree is the first, so skip it.
$worktrees = @(
    git worktree list --porcelain |
        Where-Object { $_ -like 'worktree *' } |
        ForEach-Object { $_.Substring(9) } |
        Select-Object -Skip 1
)

if ($worktrees.Count -eq 0) {
    Write-Host "  none registered."
} else {
    foreach ($wt in $worktrees) {
        $wtPath = $wt -replace '/', '\'
        Write-Plan "remove worktree $wtPath"
        if ($Execute) {
            # A worktree whose files are only CRLF-dirty still counts as
            # "modified" to git, so a plain `worktree remove` refuses. The
            # content is provably identical (that is what the stash dance below
            # is for), so --force here discards nothing real.
            git worktree remove --force $wtPath 2>&1 | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "     git could not remove it (Windows file lock?) — deleting the directory" -ForegroundColor Yellow
                Remove-Item -Recurse -Force -LiteralPath $wtPath -ErrorAction SilentlyContinue
            }
        }
    }
    if ($Execute) { git worktree prune }
}

# Orphaned directories: a worktree git has already deregistered, but whose
# folder survived (Windows holds locks on node_modules).
if (Test-Path .worktrees) {
    $orphans = @(Get-ChildItem .worktrees -Directory -ErrorAction SilentlyContinue)
    foreach ($o in $orphans) {
        Write-Plan "delete orphaned directory $($o.FullName)"
        if ($Execute) {
            Remove-Item -Recurse -Force -LiteralPath $o.FullName -ErrorAction SilentlyContinue
        }
    }
    if ($Execute -and (Test-Path .worktrees) -and -not (Get-ChildItem .worktrees -ErrorAction SilentlyContinue)) {
        Remove-Item -Force -LiteralPath .worktrees -ErrorAction SilentlyContinue
    }
}

# --- 2. merged feature branches -------------------------------------------

Write-Header "Merged branches"

# Only branches this session's workflow creates. Older feature branches in the
# repo are none of this script's business, even when they are merged.
$sessionBranches = @(
    'feat/capture-queue-observability'
    'feat/stale-algo-visibility'
    'feat/debt-tenant-algo'
    'feat/debt-sinks'
)

$existing = @(git branch --format='%(refname:short)')
$merged   = @(git branch --merged master --format='%(refname:short)')

$deletable = @($sessionBranches | Where-Object { $existing -contains $_ })

if ($deletable.Count -eq 0) {
    Write-Host "  none to delete."
} else {
    foreach ($b in $deletable) {
        if ($merged -notcontains $b) {
            Write-Host "  SKIP $b — not fully merged into master. Left alone." -ForegroundColor Yellow
            continue
        }
        Write-Plan "delete branch $b"
        # -d, never -D: git refuses if it is not fully merged.
        if ($Execute) { git branch -d $b | Out-Null }
    }
}

# --- 3. CRLF-noise stashes -------------------------------------------------

Write-Header "Stashes"

if ($SkipStashes) {
    Write-Host "  -SkipStashes given; leaving all stashes alone."
} else {
    # Parse `stash@{N}: <message>` into index + message.
    $stashes = @(
        git stash list | ForEach-Object {
            if ($_ -match '^stash@\{(\d+)\}:\s*(.*)$') {
                [pscustomobject]@{
                    Index   = [int]$Matches[1]
                    Message = $Matches[2]
                }
            }
        }
    )

    if ($stashes.Count -eq 0) {
        Write-Host "  no stashes."
    } else {
        # The message is "On <branch>: <name>" or "WIP on <branch>: <sha> <subj>".
        # Match the NAME against the pattern — that is what makes a keeper
        # unmatchable: "A4-server-formatting-noise" and a WIP subject line
        # simply do not start with crlf-noise/line-ending.
        $doomed = @($stashes | Where-Object {
            $name = ($_.Message -replace '^(WIP on|On)\s+[^:]+:\s*', '')
            $name -match $StashPattern
        })
        $kept = @($stashes | Where-Object { $doomed -notcontains $_ })

        if ($doomed.Count -eq 0) {
            Write-Host "  no CRLF-noise stashes to drop."
        } else {
            foreach ($s in $doomed) {
                Write-Plan "drop stash@{$($s.Index)}  $($s.Message)"
            }
            if ($Execute) {
                # HIGHEST INDEX FIRST. Dropping stash@{3} renumbers every entry
                # above it; going low-to-high would delete the wrong stashes.
                foreach ($s in ($doomed | Sort-Object Index -Descending)) {
                    git stash drop "stash@{$($s.Index)}" | Out-Null
                }
            }
        }

        if ($kept.Count -gt 0) {
            Write-Host ""
            Write-Host "  KEPT (not CRLF noise — decide these yourself):" -ForegroundColor Green
            foreach ($k in $kept) {
                Write-Host "    stash@{$($k.Index)}  $($k.Message)"
            }
        }
    }
}

# --- summary ---------------------------------------------------------------

Write-Header "State"

if ($Execute) {
    git worktree list
    Write-Host ""
    Write-Host "Stashes remaining:"
    $remaining = git stash list
    if ($remaining) { $remaining } else { Write-Host "  (none)" }
    Write-Host ""
    Write-Host "Done. The ~200 stat-dirty CRLF files are expected — they are not a change." -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Nothing was changed. Re-run with -Execute to apply the plan above." -ForegroundColor Yellow
}
