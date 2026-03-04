# Calgit

Calgit is a VS Code extension that shows a calendar view of Git history for the currently active file.

Publisher: MOkrucky

## What It Does

- Adds a **Calgit** view in the activity bar.
- Loads commit history for the active file (`git log --follow`).
- Marks calendar days that have commits for that file.
- Opens read-only snapshots of the file at a selected commit.
- Opens diffs:
  - selected commit vs current working tree
  - selected commit vs previous commit
  - any two selected commits (compare base workflow)
- Automatically updates when you switch to a different file.

## Requirements

- VS Code `1.109.0` or newer.
- Git available on your system and on `PATH`.
- The active file must be inside a Git repository.

## Usage

1. Open a Git repository folder in VS Code.
2. Open any tracked file in the editor.
3. Click the **Calgit** icon in the activity bar.
4. In the calendar:
   - Click a highlighted day to load commits from that date.
   - Click a commit entry to open a snapshot.
   - Right-click a commit/day for diff actions.

### Context Menu Actions

- `Open Snapshot`
- `Diff vs Current File`
- `Diff vs Previous Version`
- `Set <hash> as Compare Base`
- `Diff <base> <-> <selected>`
- `Clear Compare Base`

## Commands

- `Calgit: Show Debug Log` (`calgit.showDebugLog`)

## Notes

- Snapshot documents are opened as read-only.
- If no repository is found through the VS Code Git API, Calgit falls back to Git CLI detection.
- Commit history is collected across local and remote branches (`git log --all`) for the active file.


## Release Notes

### 0.0.1

- Initial Calgit release with calendar-based file history browsing and diff actions.
