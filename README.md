# BIU Course Planner

A timetable planner built on the Bar-Ilan University course catalog ([courses.biu.ac.il](https://courses.biu.ac.il/)).
Add courses by year and semester, pick lecture and tutorial groups, build several alternative timetables
and compare them, or let the automatic builder rank every possible combination by what matters to you.

The interface is in Hebrew.

Built by **Noam Binyamin**.

**Live (view-only) version:** https://noambinyamin.github.io/BIU-Course-Planner/

## Features

- Course data pulled straight from the BIU catalog: every lecture and tutorial group with day, hours, lecturer, room, credits and exam dates
- Year › semester › alternatives structure, each semester with its own courses and timetables
- Weekly calendar with conflict detection, hover preview and personal blocked times (work, training…)
- Per-course filters (day, lecturer, hours), rejecting groups, merging groups that meet at the same time
- Automatic builder: ranks every conflict-free combination by fewest campus days, fewest gaps and comfortable hours, with preferred / avoided lecturers and other preferences
- Side-by-side comparison of alternatives with automatic change summaries
- PDF export (timetable or full group catalog) and calendar export (`.ics`) for Google Calendar / Outlook
- Undo / redo, notes per alternative, phone and tablet layouts, dark mode

## Two ways to use it

| | Local app (your computer) | GitHub Pages copy |
|---|---|---|
| Add courses and pull data from BIU | ✓ | – |
| Refresh a course's data | ✓ | – |
| Pick groups, alternatives, comparison, automatic builder | ✓ | ✓ |
| Blocked times, undo, calendar export (`.ics`) | ✓ | ✓ |
| Styled PDF | Direct PDF file | Through the browser's "Print / Save as PDF" |

The GitHub Pages copy is a static site: it has no server, so it cannot reach the BIU website.
It shows the data published from the local app and clearly marks itself as a view-only version.
Changes made there are saved in that device's browser only.

## Running locally

Requirements: Windows, Python 3, Google Chrome and the `playwright` package (`pip install playwright`).

1. Double-click `start.bat`.
2. The app opens at `http://localhost:8765`. A minimized Chrome window also opens; it is used to pull data from the BIU site.
3. If the BIU site asks for a captcha, that window pops up — solve it once and carry on.

## Publishing to GitHub Pages

1. In the local app, click the **publish** button in the page footer (next to the credit line). This saves all courses, alternatives and settings to `web/data/snapshot.json`.
2. Run `publish.bat` (or `git add web/data/snapshot.json && git commit && git push`).
3. The GitHub Pages copy updates within a minute or two.

> **Note:** on a free GitHub plan, Pages requires a public repository — everything you publish (including personal notes) is visible to anyone.

### One-time GitHub Pages setup

On GitHub: Settings → Pages → Source: **GitHub Actions**. From then on, every push to `main` deploys the `web` folder automatically.

## Project structure

- `server.py` — local server: serves the app, pulls data from BIU through Chrome, renders PDFs and writes the published snapshot.
- `web/` — the app itself (`index.html`, `app.js`, `style.css`, bundled fonts, `data/snapshot.json`).
- `start.bat` — starts the local app; `publish.bat` — uploads the published data.
- `.github/workflows/pages.yml` — deploys `web/` to GitHub Pages on every push.
