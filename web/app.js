const DAY_SHORT = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'"];
const DAY_FULL = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי"];
const SEMESTERS = { A: "סמסטר א'", B: "סמסטר ב'", summer: "סמסטר קיץ" };
const COLORS = ["#3b6fd4", "#d9782b", "#1f9a6a", "#c4466f", "#7a5bd1", "#0e93a6", "#b38a14", "#d0503f", "#4f6aa8", "#5e8a32"];
const PX_PER_MIN = 0.95; // natural scale; when stacked the calendar gets this height, when sticky it stretches to fit

const ICONS = {
  check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  chev: '<svg viewBox="0 0 20 20"><path d="M5 8l5 5 5-5"/></svg>',
  focus: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3"/><path d="M10 2v3M10 15v3M2 10h3M15 10h3"/></svg>',
  refresh: '<svg viewBox="0 0 20 20"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3v4h-4"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  warn: '<svg viewBox="0 0 16 16"><path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.8v.1"/></svg>',
  ban: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>',
  undo: '<svg viewBox="0 0 16 16"><path d="M4 6.5h5.5a3 3 0 0 1 0 6H6M6.5 4L4 6.5 6.5 9"/></svg>',
  filter: '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z"/></svg>',
};

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

const state = {
  courses: store.get("biu.courses", []),            // [{key, code, year, semester, color}]
  view: loadTerm(),                                 // active term "<year>:<semester>" (list, planner, plans)
  plans: loadPlans(),                               // [{id, term, name, notes, selected: Set("<courseKey>|<group>")}]
  activePlanByTerm: loadActivePlans(),              // term -> id of the plan being edited there
  comparing: false,
  cmpBase: null,
  cmpShowSame: false,
  collapsed: new Set(store.get("biu.collapsed", [])),
  onlySelected: store.get("biu.onlySelected", false),
  hideConflicts: store.get("biu.hideConflicts", false),
  rejected: new Set(store.get("biu.rejected", [])), // selection keys the user ruled out
  filters: store.get("biu.filters", {}),            // course key -> {days, teacher, from, to}
  merge: store.get("biu.merge", false),             // merge same-time groups into one row
  groupBy: store.get("biu.groupBy", "course"),      // list split: "course" cards or "type" (lectures, tutorials...) cards
  hideEmptyDays: store.get("biu.hideEmptyDays", false), // calendars show only days with something scheduled
  busy: store.get("biu.busy", {}),                   // term -> [{id, day, start, end, label}] personal blocked times
  termDates: store.get("biu.termDates", {}),         // term -> {start, end} for the calendar (.ics) export
  genPrefs: {
    criteria: ["days", "gaps", "comfort"], comfortFrom: "10:00", comfortTo: "18:00", freeDays: [], notBefore: "", notAfter: "", useBlocks: true, useFilters: false, keep: false,
    skipNoTeacher: false, lecturesFirst: false, teachers: [], avoidTeachers: [], morningCourses: [], ...migrateGenPrefs(store.get("biu.genPrefs", {})),
  },
  generating: false,
  offline: false,                                    // no local server: the static copy on GitHub Pages
  mobileDay: null,                                   // day shown in the one-day phone view
  data: {},                                          // "<year>:<code>" -> server entry
  loading: new Set(),                                // course keys being fetched
  errors: {},                                        // course key -> message
  preview: null,                                     // selection key hovered in the list
};

const PLAN_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
function uid() { return Math.random().toString(36).slice(2, 9); }

// BIU names the academic year by the year it ends in (Hebrew year 5787 = 2027, which starts in Oct 2026)
function currentAcademicYear() {
  const now = new Date();
  return now.getMonth() >= 8 ? now.getFullYear() + 1 : now.getFullYear();
}

function loadTerm() {
  const saved = store.get("biu.term", null);
  if (typeof saved === "string" && saved.includes(":")) return saved;
  // older versions only remembered a semester: pair it with the year of a saved course
  const courses = store.get("biu.courses", []);
  const sem = store.get("biu.calSemester", null);
  const match = courses.find((c) => c.semester === sem) || courses[0];
  if (match) return `${match.year}:${match.semester}`;
  const m = new Date().getMonth();
  return `${currentAcademicYear()}:${m >= 1 && m <= 6 ? "B" : "A"}`;
}

// older versions had one "priority" choice instead of ticked criteria
function migrateGenPrefs(saved) {
  if (saved.criteria || !saved.priority) return saved;
  const { priority, ...rest } = saved;
  return { ...rest, criteria: priority === "balanced" ? ["days", "gaps", "comfort"] : [priority] };
}

function loadActivePlans() {
  const saved = store.get("biu.activePlanByTerm", null);
  if (saved && typeof saved === "object") return saved;
  // older versions had a single active plan; it keeps its id in the term it was split into first
  const old = store.get("biu.activePlan", null);
  const plan = old && loadPlans().find((p) => p.id === old);
  return plan ? { [plan.term]: plan.id } : {};
}

function termOfSelection(key) {
  const [year, , semester] = key.split("|")[0].split(":");
  return `${year}:${semester}`;
}

function loadPlans() {
  let saved = store.get("biu.plans", null);
  if (!Array.isArray(saved) || !saved.length) {
    // first run after plans were introduced: keep the existing selection as the first plan
    saved = [{ id: uid(), name: "מערכת א'", notes: "", selected: store.get("biu.selected", []) }];
  }
  const out = [];
  for (const p of saved) {
    if (p.term) { out.push({ ...p, selected: new Set(p.selected) }); continue; }
    // plans from before terms existed: split each into one plan per term it has choices in
    const terms = [...new Set([...p.selected].map(termOfSelection))];
    if (!terms.length) terms.push(loadTerm());
    terms.forEach((term, i) => out.push({
      ...p, id: i ? uid() : p.id, term,
      selected: new Set([...p.selected].filter((k) => termOfSelection(k) === term)),
    }));
  }
  return out;
}

/* terms: a year + semester ("2027:A"); every term has its own courses and its own plans */
const termOf = (course) => `${course.year}:${course.semester}`;
const termKey = (year, semester) => `${year}:${semester}`;
const splitTerm = (term) => { const [year, semester] = (term || ":").split(":"); return { year, semester }; };
const termLabel = (term) => { const t = splitTerm(term); return `${SEMESTERS[t.semester] || ""} · ${yearLabel(t.year)}`; };
const termPlans = (term = state.view) => state.plans.filter((p) => p.term === term);

function activePlan() {
  let plans = termPlans();
  if (!plans.length) {
    // every term starts with one (empty) plan
    state.plans.push({ id: uid(), term: state.view, name: "מערכת א'", notes: "", selected: new Set() });
    plans = termPlans();
  }
  return plans.find((p) => p.id === state.activePlanByTerm[state.view]) || plans[0];
}
// everything that reads/writes the current choices goes through the active plan
Object.defineProperty(state, "selected", { get: () => activePlan().selected });

function nextPlanName() {
  const used = new Set(termPlans().map((p) => p.name));
  const letter = PLAN_LETTERS.find((l) => !used.has(`מערכת ${l}'`));
  return letter ? `מערכת ${letter}'` : `מערכת ${termPlans().length + 1}`;
}

function save() {
  store.set("biu.courses", state.courses);
  store.set("biu.plans", state.plans.map((p) => ({ ...p, selected: [...p.selected] })));
  store.set("biu.activePlanByTerm", state.activePlanByTerm);
  store.set("biu.collapsed", [...state.collapsed]);
  store.set("biu.term", state.view);
  store.set("biu.onlySelected", state.onlySelected);
  store.set("biu.hideConflicts", state.hideConflicts);
  store.set("biu.rejected", [...state.rejected]);
  store.set("biu.filters", state.filters);
  store.set("biu.merge", state.merge);
  store.set("biu.groupBy", state.groupBy);
  store.set("biu.hideEmptyDays", state.hideEmptyDays);
  store.set("biu.busy", state.busy);
  store.set("biu.termDates", state.termDates);
  store.set("biu.genPrefs", state.genPrefs);
}

const toMin = (t) => { const [h, m] = (t || "").split(":").map(Number); return h * 60 + (m || 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const range = (s) => (s.start ? `<bdi dir="ltr">${esc(s.start)}–${esc(s.end)}</bdi>` : "");
// Hebrew year in gematria letters: 2027 -> 5787 -> Tav-Shin-Pe-Zayin (with gershayim before the last letter)
function yearLabel(y) {
  let n = (Number(y) + 3760) % 1000;
  if (!n) return String(y);
  let out = "";
  for (const [v, ch] of [[400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"]]) while (n >= v) { out += ch; n -= v; }
  if (n === 15 || n === 16) { out += n === 15 ? "טו" : "טז"; n = 0; }
  for (const [v, ch] of [[90, "צ"], [80, "פ"], [70, "ע"], [60, "ס"], [50, "נ"], [40, "מ"], [30, "ל"], [20, "כ"], [10, "י"]]) if (n >= v) { out += ch; n -= v; }
  if (n) out += "אבגדהוזחט"[n - 1];
  return out.length > 1 ? `${out.slice(0, -1)}"${out.slice(-1)}` : `${out}'`;
}

/* ---------- server ---------- */

async function fetchCourse(code, year, refresh = false) {
  const dataKey = `${year}:${code}`;
  if (!refresh && state.data[dataKey]) return state.data[dataKey];
  if (state.offline) {
    // static copy (GitHub Pages): only what was published from the local app
    const entry = published?.data?.[dataKey];
    if (!entry) throw new Error("הקורס הזה לא נכלל בנתונים שפורסמו. אפשר להוסיף אותו בהרצה המקומית ולפרסם מחדש.");
    state.data[dataKey] = entry;
    return entry;
  }
  // never wait forever: the server gives up on BIU well before this
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 260000);
  let res;
  try {
    res = await fetch(`/api/course?code=${encodeURIComponent(code)}&year=${year}${refresh ? "&refresh=1" : ""}`, { signal: abort.signal });
  } catch {
    throw new Error("אין תשובה מהשרת. ודאו שחלון המערכת (start.bat) עדיין פתוח ונסו שוב.");
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({ error: "השרת לא החזיר תשובה תקינה" }));
  if (!res.ok) throw new Error(body.error || "שגיאה");
  state.data[dataKey] = body;
  return body;
}

/* ---------- derived data ---------- */

const entryOf = (course) => state.data[`${course.year}:${course.code}`];
const selKey = (course, g) => `${course.key}|${g.group}`;
const typeRank = (t) => (t.includes("הרצאה") ? 0 : t.includes("תרגיל") ? 1 : t.includes("מעבדה") ? 2 : 3);
const SECTION_NAMES = { "הרצאה": "הרצאות", "תרגיל": "תרגולים", "תגבור": "תגבורים", "מעבדה": "מעבדות", "סמינריון": "סמינריונים" };

function groupsFor(course) {
  const entry = entryOf(course);
  if (!entry) return [];
  return entry.groups
    .filter((g) => g.semesterKey === course.semester || g.semesterKey === "yearly" || g.semesterKey === "other")
    .sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.group.localeCompare(b.group, "he", { numeric: true }));
}

function sectionsFor(course) {
  const map = new Map();
  for (const g of groupsFor(course)) {
    const t = g.type || "מפגש";
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(g);
  }
  return [...map.entries()];
}

const timedSessions = (g) => g.sessions.filter((s) => s.day >= 0 && s.start && s.end);
const overlaps = (a, b) => a.day === b.day && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

function selectedGroups(term, selected = state.selected) {
  const out = [];
  for (const course of state.courses) {
    if (term && termOf(course) !== term) continue;
    for (const g of groupsFor(course)) if (selected.has(selKey(course, g))) out.push({ course, g });
  }
  return out;
}

const busyFor = (term = state.view) => state.busy[term] || [];

// clashes with chosen groups ({course, g}) and with the user's blocked times ({busy})
function conflictsWith(course, g, picked) {
  const mine = timedSessions(g);
  const groups = picked.filter(({ course: c2, g: g2 }) =>
    termOf(c2) === termOf(course) && selKey(c2, g2) !== selKey(course, g) &&
    timedSessions(g2).some((s2) => mine.some((s) => overlaps(s, s2))));
  const busy = busyFor(termOf(course)).filter((b) => mine.some((s) => overlaps(s, b))).map((b) => ({ busy: b }));
  return [...groups, ...busy];
}
const clashName = (x) => (x.busy ? `אילוץ${x.busy.label ? ` (${x.busy.label})` : ""}` : `${entryOf(x.course).name} ${x.g.group}`);

const credits = (g) => Number(g.credits) || 0;
// BIU splits a course's credits between its components (lecture, tutorial...)
function courseCredits(course) {
  return sectionsFor(course).reduce((sum, [, gs]) => sum + Math.max(0, ...gs.map(credits)), 0);
}

function whereLines(g) {
  return g.sessions.map((s) => {
    if (s.building || s.room) return [s.building, s.room && `חדר ${s.room}`].filter(Boolean).join(" · ");
    return (s.location || "").replace(/^בניין /, "").replace(", ", " · ");
  });
}

const visibleCourses = () => state.courses.filter((c) => termOf(c) === state.view);

const teachersOf = (g) => g.teacher.split(",").map((t) => t.trim()).filter(Boolean);
const filterOf = (course) => state.filters[course.key] || {};
const filterActive = (f) => !!(f.days?.length || f.teacher || f.from || f.to);

function passesFilter(course, g) {
  const f = filterOf(course);
  if (!filterActive(f)) return true;
  const ts = timedSessions(g);
  if (f.days?.length && (!ts.length || !ts.every((s) => f.days.includes(s.day)))) return false;
  if (f.teacher && !teachersOf(g).includes(f.teacher)) return false;
  if (f.from && (!ts.length || ts.some((s) => toMin(s.start) < toMin(f.from)))) return false;
  if (f.to && (!ts.length || ts.some((s) => toMin(s.end) > toMin(f.to)))) return false;
  return true;
}

// groups whose sessions are at exactly the same days and hours share a slot
const slotOf = (g) => timedSessions(g).map((s) => `${s.day}@${s.start}-${s.end}`).sort().join("|");

function toUnits(gs) {
  if (!state.merge) return gs.map((g) => [g]);
  const slots = new Map();
  for (const g of gs) {
    const slot = slotOf(g) || `solo:${g.group}`;
    if (!slots.has(slot)) slots.set(slot, []);
    slots.get(slot).push(g);
  }
  return [...slots.values()];
}

function toggleUnit(keys) {
  const available = keys.filter((k) => !state.rejected.has(k));
  const removing = keys.some((k) => state.selected.has(k));
  if (!removing && !available.length) return;
  checkpoint(removing ? "הסרת בחירה" : "בחירת קבוצה");
  if (removing) keys.forEach((k) => state.selected.delete(k));
  else if (available.length) state.selected.add(available[0]);
  render();
  if (available[0] && state.selected.has(available[0])) warnIfDuplicate(available[0]);
}

function pickInSlot(key, keys) {
  if (state.rejected.has(key)) return;
  checkpoint(state.selected.has(key) ? "הסרת בחירה" : "בחירת קבוצה");
  if (state.selected.has(key)) state.selected.delete(key);
  else { keys.forEach((k) => state.selected.delete(k)); state.selected.add(key); }
  render();
  if (state.selected.has(key)) warnIfDuplicate(key);
}

/* each course needs exactly one lecture group and one tutorial group */
const needsOne = (type) => typeRank(type) < 2;

// (course, type) pairs where more than one group is chosen
function duplicates(term, selected = state.selected) {
  const out = [];
  for (const course of state.courses) {
    if (term && termOf(course) !== term) continue;
    for (const [type, gs] of sectionsFor(course)) {
      const chosen = gs.filter((g) => selected.has(selKey(course, g)));
      if (needsOne(type) && chosen.length > 1) out.push({ course, type, chosen });
    }
  }
  return out;
}

function warnIfDuplicate(key) {
  const course = state.courses.find((c) => key.startsWith(c.key + "|"));
  const g = course && groupsFor(course).find((x) => selKey(course, x) === key);
  if (!g || !needsOne(g.type)) return;
  const others = groupsFor(course).filter((x) => x !== g && x.type === g.type && state.selected.has(selKey(course, x)));
  if (!others.length) return;
  toast(`ב${entryOf(course).name} כבר בחרת ${g.type} ${others.map((x) => x.group).join(", ")}. לכל קורס בוחרים קבוצת ${g.type} אחת בלבד.`, "warn", {
    label: `להשאיר רק את ${g.group}`,
    run() {
      checkpoint("השארת קבוצה אחת");
      others.forEach((x) => state.selected.delete(selKey(course, x)));
      render();
      undoToast(`נשארה רק קבוצה ${g.group}`);
    },
  });
}

function toggleReject(keys) {
  const restoring = keys.every((k) => state.rejected.has(k));
  checkpoint(restoring ? "ביטול פסילה" : "פסילת קבוצה");
  if (restoring) keys.forEach((k) => state.rejected.delete(k));
  else keys.forEach((k) => { state.rejected.add(k); state.selected.delete(k); });
  render();
}

function setFilter(courseKey, patch) {
  checkpoint("שינוי סינון");
  const f = { ...(state.filters[courseKey] || {}), ...patch };
  if (filterActive(f)) state.filters[courseKey] = f;
  else delete state.filters[courseKey];
  render();
}

/* ---------- rendering: list ---------- */

// keys of the collapsible cards in the current list view
function cardKeys() {
  return state.groupBy === "type"
    ? categories().map(([type]) => catKey(type))
    : visibleCourses().map((c) => c.key);
}

// year › semester navigation; the add form's year/semester always mirror the active term
function renderTermNav() {
  const { year, semester } = splitTerm(state.view);
  const cur = currentAcademicYear();
  const years = [...new Set([cur + 1, cur, cur - 1, cur - 2, cur - 3, ...state.courses.map((c) => Number(c.year))])].sort((a, b) => b - a);
  const count = (y, sem) => state.courses.filter((c) => String(c.year) === String(y) && (!sem || c.semester === sem)).length;
  const yearOpts = years.map((y) => `<option value="${y}" ${String(y) === year ? "selected" : ""}>${yearLabel(y)} · ${y}${count(y) ? ` (${count(y)})` : ""}</option>`).join("");
  $("termYear").innerHTML = yearOpts;
  $("yearInput").innerHTML = yearOpts;
  $("yearInput").value = year;
  $("semesterInput").value = semester;
  $("termSem").innerHTML = Object.keys(SEMESTERS).map((sem) => {
    const n = count(year, sem);
    return `<button type="button" role="tab" data-sem="${sem}" aria-selected="${sem === semester}">${SEMESTERS[sem]}${n ? `<span class="count">${n}</span>` : ""}</button>`;
  }).join("");
}

function setTerm(term) {
  if (term === state.view) return;
  state.view = term;
  state.preview = null;
  render();
  scheduleLookup();
}

function renderToolbar() {
  renderTermNav();
  const n = visibleCourses().length;
  $("coursesHead").hidden = !state.courses.length;
  $("coursesTitle").textContent = `הקורסים ב${termLabel(state.view)}`;
  $("coursesCount").textContent = n ? `${n} ${n === 1 ? "קורס" : "קורסים"}` : "";
  $("toolbar").hidden = !visibleCourses().length;
  $("onlySelected").checked = state.onlySelected;
  $("hideConflicts").checked = state.hideConflicts;
  $("mergeSlots").checked = state.merge;
  $("groupByTabs").querySelectorAll("[data-groupby]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.groupby === state.groupBy)));
  const keys = cardKeys();
  const allCollapsed = keys.length && keys.every((k) => state.collapsed.has(k));
  $("toggleAll").textContent = allCollapsed ? "פתיחת הכל" : "קיפול הכל";
  $("toggleAll").hidden = keys.length < 2;
}

function courseHeadHTML(course, entry) {
  const sections = entry ? sectionsFor(course) : [];
  const picks = sections.map(([type, gs]) => {
    const chosen = gs.filter((g) => state.selected.has(selKey(course, g)));
    if (chosen.length > 1 && needsOne(type)) {
      return `<span class="pick dup" title="נבחרה יותר מקבוצת ${esc(type)} אחת">${ICONS.warn}${esc(type)} <b>${chosen.map((g) => esc(g.group)).join(", ")}</b></span>`;
    }
    return chosen.length
      ? `<span class="pick on">${esc(type)} <b>${chosen.map((g) => esc(g.group)).join(", ")}</b></span>`
      : `<span class="pick">${esc(type)} —</span>`;
  }).join("");
  const cr = entry ? courseCredits(course) : 0;
  const busy = state.loading.has(course.key);
  return `
    <div class="course-head" role="button" tabindex="0" aria-expanded="${!state.collapsed.has(course.key)}" data-act="toggle">
      <div class="course-icon" aria-hidden="true">${esc(course.code.slice(-3))}</div>
      <div class="course-title">
        <h3>${esc(entry ? entry.name : `קורס ${course.code}`)}</h3>
        <p><span>${esc(course.code)}</span>${cr ? `<span>${cr} נ"ז</span>` : ""}<span>${SEMESTERS[course.semester]} ${yearLabel(course.year)}</span></p>
      </div>
      <div class="head-actions">
        <button type="button" class="ha" data-act="focus" title="מיקוד בקורס הזה" aria-label="מיקוד">${ICONS.focus}</button>
        ${state.offline ? "" : `<button type="button" class="ha ${busy ? "spinning" : ""}" data-act="refresh" title="רענון מהאתר" aria-label="רענון">${ICONS.refresh}</button>`}
        <button type="button" class="ha" data-act="remove" title="הסרת הקורס (אפשר לבטל עם Ctrl+Z)" aria-label="הסרה">${ICONS.trash}</button>
      </div>
      <span class="chev" aria-hidden="true">${ICONS.chev}</span>
      ${picks ? `<div class="picks">${picks}</div>` : ""}
    </div>`;
}

// one row in the list: a single group, or several same-time groups when merging is on.
// Every row is a single line (two fixed lines in a narrow card) so rows keep the same height;
// details that don't fit (conflicts, extra sessions/places) live in tooltips.
function unitRowHTML(course, gs, picked) {
  const keys = gs.map((g) => selKey(course, g));
  const chosen = gs.find((g) => state.selected.has(selKey(course, g)));
  const isSel = !!chosen;
  const allRejected = keys.every((k) => state.rejected.has(k));
  const lead = chosen || gs.find((g) => !state.rejected.has(selKey(course, g))) || gs[0];
  const clashes = conflictsWith(course, lead, picked).filter((x) => x.busy || !keys.includes(selKey(x.course, x.g)));
  const more = (n, all) => (n ? `<span class="more" title="${esc(all)}">+${n}</span>` : "");

  // sessions at the same hours share one label: "ב', ג' 10:00–12:00"
  const timed = timedSessions(lead);
  const slots = [];
  for (const s of timed) {
    const slot = slots.find((x) => x.start === s.start && x.end === s.end);
    if (slot) slot.days.push(s.dayLabel); else slots.push({ start: s.start, end: s.end, days: [s.dayLabel] });
  }
  const slotText = (x) => `${x.days.map((d) => `${d}'`).join(", ")} ${x.start}–${x.end}`;
  const when = slots.length
    ? `<b>${esc(slots[0].days.map((d) => `${d}'`).join(", "))}</b>${range(slots[0])}${more(slots.length - 1, slots.map(slotText).join(" · "))}`
    : '<span class="tba">מועד לא נקבע</span>';

  const places = [...new Set(gs.flatMap(whereLines).filter(Boolean))];
  const where = places.length ? `<span class="ell">${esc(places[0])}</span>${more(places.length - 1, places.join(" · "))}` : '<span class="tba">—</span>';
  const teachers = [...new Set(gs.flatMap(teachersOf))];
  const who = teachers.length ? `<span class="ell">${esc(teachers[0])}</span>${more(teachers.length - 1, teachers.join(", "))}` : '<span class="tba">טרם נקבע</span>';

  const num = gs.length === 1 ? esc(lead.group)
    : `<span class="gchips" title="${gs.length} קבוצות באותה שעה – בוחרים את מספר הקבוצה">${gs.map((g) => {
        const k = selKey(course, g);
        return `<button type="button" class="gchip ${state.selected.has(k) ? "on" : ""} ${state.rejected.has(k) ? "rej" : ""}"
          data-pick="${esc(k)}" title="${esc(`קבוצה ${g.group} · ${g.teacher || "מרצה טרם נקבע"}${whereLines(g)[0] ? ` · ${whereLines(g)[0]}` : ""}`)}">${esc(g.group)}</button>`;
      }).join("")}</span>`;

  const clashText = clashes.length ? `מתנגש עם ${clashes.map(clashName).join(", ")}` : "";
  const rejectLabel = allRejected ? "ביטול הפסילה" : gs.length > 1 ? "פסילת כל הקבוצות בשעה הזו" : "פסילת הקבוצה";
  return `
    <li class="grp ${isSel ? "picked" : ""} ${clashes.length ? "conflict" : ""} ${allRejected ? "rejected" : ""} ${gs.length > 1 ? "merged" : ""}"
        role="checkbox" aria-checked="${isSel}" aria-disabled="${allRejected}" tabindex="0"
        data-key="${esc(selKey(course, lead))}" data-keys="${esc(keys.join(","))}">
      <span class="tick">${ICONS.check}</span>
      <span class="num">${num}</span>
      <span class="who">${who}</span>
      <span class="when">${when}</span>
      <span class="where">${where}</span>
      ${clashes.length && !allRejected
        ? `<button type="button" class="flag" data-clash="${esc(clashText)}" title="${esc(clashText)}" aria-label="${esc(clashText)}">${ICONS.warn}</button>`
        : '<span class="flag-space"></span>'}
      <button type="button" class="rej-btn" data-reject="${esc(keys.join(","))}" title="${rejectLabel}" aria-label="${rejectLabel}">${allRejected ? ICONS.undo : ICONS.ban}</button>
    </li>`;
}

const openFilters = new Set(); // course keys whose folded (phone) filter bar is open

function filterBarHTML(course) {
  const f = filterOf(course);
  const all = groupsFor(course);
  const days = [...new Set(all.flatMap((g) => timedSessions(g).map((s) => s.day)))].sort();
  const teachers = [...new Set(all.flatMap(teachersOf))].sort((a, b) => a.localeCompare(b, "he"));
  const mins = all.flatMap((g) => timedSessions(g).flatMap((s) => [toMin(s.start), toMin(s.end)]));
  const hours = [];
  if (mins.length) for (let h = Math.floor(Math.min(...mins) / 60); h <= Math.ceil(Math.max(...mins) / 60); h++) hours.push(`${String(h).padStart(2, "0")}:00`);
  const opts = (list, cur, empty) => `<option value="">${empty}</option>` +
    list.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  const shown = all.filter((g) => passesFilter(course, g)).length;
  // narrow cards (phones) fold the bar into one "filter" line that opens on tap
  const active = (f.days?.length ? 1 : 0) + (f.teacher ? 1 : 0) + (f.from || f.to ? 1 : 0);
  const open = openFilters.has(course.key);
  return `<div class="fbar ${open ? "open" : ""}" role="group" aria-label="סינון קבוצות">
    <button type="button" class="fbar-toggle" data-act="togglef" aria-expanded="${open}">
      ${ICONS.filter}<span>סינון${active ? ` <b>· ${active} פעילים</b>` : ""}</span>${ICONS.chev}
    </button>
    <span class="fbar-label">${ICONS.filter}סינון</span>
    <div class="fdays">${days.map((d) => `<button type="button" class="fday ${f.days?.includes(d) ? "on" : ""}" data-day="${d}" aria-pressed="${!!f.days?.includes(d)}" title="יום ${DAY_FULL[d]}">${DAY_SHORT[d]}</button>`).join("")}</div>
    ${teachers.length > 1 ? `<select data-f="teacher" aria-label="מרצה">${opts(teachers, f.teacher, "כל המרצים")}</select>` : ""}
    ${hours.length ? `<span class="fhours"><select data-f="from" aria-label="משעה">${opts(hours.slice(0, -1), f.from, "משעה")}</select>
      <span>–</span><select data-f="to" aria-label="עד שעה">${opts(hours.slice(1), f.to, "עד שעה")}</select></span>` : ""}
    ${filterActive(f) ? `<span class="fcount">${shown} מתוך ${all.length}</span><button type="button" class="btn text fclear" data-act="clearf">ניקוי</button>` : ""}
  </div>`;
}

function visibleRows(course, gs, picked) {
  return gs.filter((g) => {
    if (state.selected.has(selKey(course, g))) return true; // chosen groups stay visible whatever the filters say
    if (state.onlySelected) return false;
    if (!passesFilter(course, g)) return false;
    if (state.hideConflicts && conflictsWith(course, g, picked).length) return false;
    return true;
  });
}

/* list split by session type: one card per type, one block per course inside it */
const catKey = (type) => `cat:${type}`;

function categories() {
  const map = new Map();
  for (const course of visibleCourses()) {
    if (!entryOf(course)) continue;
    for (const [type, gs] of sectionsFor(course)) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push({ course, gs });
    }
  }
  return [...map.entries()].sort((a, b) => typeRank(a[0]) - typeRank(b[0]));
}

function categoryHTML(type, items, step, picked) {
  const key = catKey(type);
  const collapsed = state.collapsed.has(key);
  const done = items.filter(({ course, gs }) => gs.some((g) => state.selected.has(selKey(course, g))));
  const required = typeRank(type) < 2;
  const lecturesPending = typeRank(type) === 1 && categories().some(([t, its]) => typeRank(t) === 0 &&
    its.some(({ course, gs }) => !gs.some((g) => state.selected.has(selKey(course, g)))));
  const picks = items.map(({ course, gs }) => {
    const chosen = gs.filter((g) => state.selected.has(selKey(course, g)));
    return `<span class="pick ${chosen.length ? "on" : ""} ${needsOne(type) && chosen.length > 1 ? "dup" : ""}" style="--c:${course.color};--c-soft:color-mix(in srgb, ${course.color} 12%, var(--surface))">${esc(entryOf(course).name)} ${chosen.length ? `<b>${chosen.map((g) => esc(g.group)).join(", ")}</b>` : "—"}</span>`;
  }).join("");

  const blocks = items.map(({ course, gs }) => {
    const rows = visibleRows(course, gs, picked);
    const chosen = gs.filter((g) => state.selected.has(selKey(course, g)));
    const filtered = filterActive(filterOf(course));
    return `<div class="cat-course" style="--c:${course.color}">
      <div class="cat-course-head">
        <i class="dot"></i><b>${esc(entryOf(course).name)}</b><span class="muted">${esc(course.code)} · ${gs.length} קבוצות</span>
        ${filtered ? '<span class="tag-filter" title="יש סינון פעיל על הקורס הזה בתצוגה לפי קורס">מסונן</span>' : ""}
        ${required && chosen.length > 1 ? `<span class="cat-status dup">${ICONS.warn}נבחרו ${chosen.map((g) => esc(g.group)).join(", ")} – יש לבחור אחת</span>`
          : chosen.length ? `<span class="cat-status on">נבחרה ${chosen.map((g) => esc(g.group)).join(", ")}</span>`
          : required ? '<span class="cat-status">בחרו קבוצה</span>' : ""}
      </div>
      ${rows.length ? `<ul class="grp-list">${toUnits(rows).map((unit) => unitRowHTML(course, unit, picked)).join("")}</ul>`
        : '<p class="empty-sec">אין קבוצות להצגה לפי הסינון.</p>'}
    </div>`;
  }).join("");

  return `<article class="course category ${collapsed ? "collapsed" : ""}" data-course="${esc(key)}" style="--c:var(--accent)">
    <div class="course-head" role="button" tabindex="0" aria-expanded="${!collapsed}" data-act="toggle">
      <div class="course-icon cat-icon" aria-hidden="true">${step}</div>
      <div class="course-title">
        <h3>${esc(SECTION_NAMES[type] || type)}</h3>
        <p><span>שלב ${step}</span><span>${items.length} קורסים</span><span class="${done.length === items.length ? "all-done" : ""}">נבחרו ב-${done.length} מתוך ${items.length}</span></p>
      </div>
      <div class="head-actions">
        <button type="button" class="ha" data-act="focus" title="מיקוד בקטגוריה הזו" aria-label="מיקוד">${ICONS.focus}</button>
      </div>
      <span class="chev" aria-hidden="true">${ICONS.chev}</span>
      <div class="picks">${picks}</div>
    </div>
    <div class="course-body"><div class="inner"><div class="body-pad">
      ${lecturesPending ? '<p class="cat-hint">כדאי לבחור קודם את כל ההרצאות – כך יסומנו כאן התרגולים שמתנגשים איתן.</p>' : ""}
      ${blocks}
    </div></div></div>
  </article>`;
}

function courseBodyHTML(course, entry, picked) {
  const sections = sectionsFor(course);
  let html = filterBarHTML(course);
  let any = false;
  for (const [type, gs] of sections) {
    const rows = visibleRows(course, gs, picked);
    if (!rows.length) continue;
    any = true;
    const nChosen = gs.filter((g) => state.selected.has(selKey(course, g))).length;
    html += `<div class="section-title">${esc(SECTION_NAMES[type] || type)}<span class="n">${rows.length < gs.length ? `${rows.length}/` : ""}${gs.length}</span>
      ${needsOne(type) && nChosen > 1 ? `<span class="need dup">${ICONS.warn}נבחרו ${nChosen} – יש לבחור אחת</span>`
        : needsOne(type) && !nChosen ? '<span class="need">בחרו קבוצה</span>' : ""}</div>
      <ul class="grp-list">${toUnits(rows).map((unit) => unitRowHTML(course, unit, picked)).join("")}</ul>`;
  }
  if (!any) html += `<p class="empty-sec">${state.onlySelected ? "לא נבחרו קבוצות בקורס הזה." : "אין קבוצות שמתאימות לסינון."}</p>`;

  const lecture = groupsFor(course).find((g) => state.selected.has(selKey(course, g)) && g.exams?.length)
    || groupsFor(course).find((g) => g.exams?.length);
  if (lecture) {
    html += `<div class="exams">${lecture.exams.map((e) =>
      `<span><b>${esc(e.term)}</b> ${esc(e.date)} ${esc(e.hour)}</span>`).join("")}</div>`;
  }
  return `<div class="course-body"><div class="inner"><div class="body-pad">${html}</div></div></div>`;
}

function welcomeHTML() {
  // the view-only copy cannot add courses, so it only explains what is (not) there
  if (state.offline) {
    return `<div class="welcome">
      <h2>עדיין לא פורסמו קורסים</h2>
      <p>זו גרסת צפייה: הקורסים מגיעים מהנתונים שמפרסם בעל האתר, ועדיין לא פורסמו כאן קורסים.</p>
    </div>`;
  }
  return `<div class="welcome">
    <h2>בונים את מערכת השעות</h2>
    <p>מוסיפים את הקורסים של הסמסטר, והמערכת מושכת מאתר בר אילן את כל קבוצות ההרצאה והתרגול שלהם.</p>
    <ol class="steps">
      <li><div><b>מקלידים מספר קורס</b><span>השם יושלם אוטומטית מהמאגר של האוניברסיטה.</span></div></li>
      <li><div><b>בוחרים קבוצות</b><span>לוחצים על שורה כדי לבחור אותה. קבוצות מתנגשות מסומנות.</span></div></li>
      <li><div><b>רואים את השבוע</b><span>הקבוצות שבחרתם משובצות בלוח השבועי שליד הרשימה.</span></div></li>
    </ol>
    <button type="button" class="btn text try" data-try="89110">נסו לדוגמה: 89110 – מבוא למדעי המחשב</button>
  </div>`;
}

function skeletonHTML() {
  return `<div class="course skeleton" aria-hidden="true">
    <div class="sk" style="width:40px;height:40px;border-radius:12px"></div>
    <div style="flex:1;display:grid;gap:8px"><div class="sk" style="height:14px;width:45%"></div><div class="sk" style="height:11px;width:28%"></div></div>
  </div>`;
}

function renderCourses() {
  const list = $("courseList");
  const focusedField = document.activeElement?.dataset?.f;
  const focusedKey = document.activeElement?.dataset?.key;
  const focusedAct = document.activeElement?.closest?.(".course")?.dataset.course;
  const picked = selectedGroups();
  if (!state.courses.length) {
    list.innerHTML = state.loading.size ? skeletonHTML() : welcomeHTML();
    return;
  }
  if (!visibleCourses().length) {
    const others = [...new Set(state.courses.map(termOf))];
    list.innerHTML = `<div class="welcome term-empty">
      <h2>${state.offline ? "לא פורסמו קורסים" : "אין עדיין קורסים"} ב${esc(termLabel(state.view))}</h2>
      <p>${state.offline
        ? "בגרסת הצפייה מוצגים רק הקורסים שפורסמו. אפשר לעבור לסמסטר שיש בו קורסים:"
        : "מוסיפים קורס בשורה למעלה – הוא יישמר תחת השנה והסמסטר האלה, עם מערכות וחלופות משלהם."}</p>
      <div class="term-jump"><span class="muted">יש קורסים ב:</span>${others.map((t) =>
        `<button type="button" class="pick on" data-term="${esc(t)}">${esc(termLabel(t))} <b>${state.courses.filter((c) => termOf(c) === t).length}</b></button>`).join("")}</div>
    </div>`;
    return;
  }
  if (state.groupBy === "type") {
    const loading = visibleCourses().filter((c) => !entryOf(c) && state.loading.has(c.key));
    const failed = visibleCourses().filter((c) => !entryOf(c) && !state.loading.has(c.key));
    list.innerHTML = categories().map(([type, items], i) => categoryHTML(type, items, i + 1, picked)).join("") +
      failed.map((c) => `<p class="empty-sec">קורס ${esc(c.code)}: ${esc(state.errors[c.key] || "הנתונים לא נטענו.")} אפשר לרענן בתצוגה לפי קורס.</p>`).join("") +
      (loading.length ? skeletonHTML() : "");
  } else list.innerHTML = visibleCourses().map((course) => {
    const entry = entryOf(course);
    if (!entry && state.loading.has(course.key)) return skeletonHTML();
    const collapsed = state.collapsed.has(course.key);
    const body = entry
      ? courseBodyHTML(course, entry, picked)
      : `<div class="course-body"><div class="inner"><div class="body-pad"><p class="empty-sec">${esc(state.errors[course.key] || "הנתונים לא נטענו.")} לחצו על ⟳ כדי לנסות שוב.</p></div></div></div>`;
    return `<article class="course ${collapsed ? "collapsed" : ""}" data-course="${esc(course.key)}" style="--c:${course.color}">
      ${courseHeadHTML(course, entry)}${body}</article>`;
  }).join("");

  // keep keyboard focus across re-renders
  if (focusedField && focusedAct) list.querySelector(`.course[data-course="${CSS.escape(focusedAct)}"] [data-f="${focusedField}"]`)?.focus({ preventScroll: true });
  else if (focusedKey) list.querySelector(`.grp[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
  else if (focusedAct) list.querySelector(`.course[data-course="${CSS.escape(focusedAct)}"] .course-head`)?.focus({ preventScroll: true });
  // course cards should only animate in on first appearance
  list.querySelectorAll(".course").forEach((el) => {
    if (seen.has(el.dataset.course)) el.style.animation = "none";
    else seen.add(el.dataset.course);
  });
}
const seen = new Set();

/* ---------- rendering: planner ---------- */

function layoutLanes(events) {
  events.sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const ev of cluster) {
      let lane = lanes.findIndex((end) => end <= ev.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = ev.end;
      ev.lane = lane;
    }
    for (const ev of cluster) ev.lanes = lanes.length;
    cluster = [];
  };
  for (const ev of events) {
    if (ev.start >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(ev);
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  flush();
}

// which weekday columns a calendar shows: Sun–Thu (+Fri when needed), or only the used days
function dayColumns(usedDays, friday) {
  const used = [...new Set(usedDays)].filter((d) => d >= 0 && d <= 5).sort();
  if (state.hideEmptyDays && used.length) return used;
  return friday || used.includes(5) ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4];
}

/* phones: the planner shows one day at a time, with a day strip and swiping between days */
const mobileMQ = window.matchMedia("(max-width: 640px)");
let mobileDays = [];

function mobileDayView(allDays, items, busy) {
  const strip = $("dayStrip");
  if (!mobileMQ.matches) { strip.hidden = true; return allDays; }
  const used = new Set([...items.filter((i) => !i.ghost).flatMap(({ g }) => timedSessions(g).map((s) => s.day)), ...busy.map((b) => b.day)]);
  let day = state.mobileDay;
  if (!allDays.includes(day)) {
    const today = new Date().getDay();
    // today if there are classes today, otherwise the first day that has any
    day = used.has(today) && allDays.includes(today) ? today : allDays.find((d) => used.has(d)) ?? allDays[0];
    // remember the choice only once every course of the term has loaded
    if (used.size && visibleCourses().every(entryOf)) state.mobileDay = day;
  }
  mobileDays = allDays;
  strip.hidden = false;
  strip.innerHTML = allDays.map((d) => `<button type="button" role="tab" data-mday="${d}" aria-selected="${d === day}">
    <b>${DAY_SHORT[d]}</b><small>${DAY_FULL[d]}</small>${used.has(d) ? '<i class="has" aria-label="יש שיעורים"></i>' : ""}</button>`).join("");
  return [day];
}

function stepMobileDay(dir) {
  const current = calFrame?.dayList?.[0] ?? state.mobileDay;
  const idx = mobileDays.indexOf(current) + dir;
  if (idx < 0 || idx >= mobileDays.length) return;
  state.mobileDay = mobileDays[idx];
  renderPlanner();
  const cal = $("calendar");
  cal.classList.remove("slide-next", "slide-prev");
  void cal.offsetWidth;
  cal.classList.add(dir > 0 ? "slide-next" : "slide-prev");
}

function initMobileDays() {
  $("dayStrip").addEventListener("click", (e) => {
    const d = e.target.closest("[data-mday]")?.dataset.mday;
    if (d == null) return;
    const delta = mobileDays.indexOf(Number(d)) - mobileDays.indexOf(calFrame?.dayList?.[0] ?? state.mobileDay);
    if (delta) stepMobileDay(delta);
  });
  let touch = null;
  $("calWrap").addEventListener("touchstart", (e) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  $("calWrap").addEventListener("touchend", (e) => {
    if (!touch || !mobileMQ.matches) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    stepMobileDay(dx > 0 ? 1 : -1); // right-to-left week: the next day is to the left, so swipe right to reach it
  }, { passive: true });
  mobileMQ.addEventListener("change", renderPlanner);
}

let shownEvents = new Set();
let calFrame = null; // {start, end, dayList} of the planner grid, for drag-to-block
function renderPlanner() {
  const sem = state.view;
  const picked = selectedGroups(sem);
  const items = picked.map((p) => ({ ...p, ghost: false }));
  if (state.preview && !state.selected.has(state.preview)) {
    const course = state.courses.find((c) => state.preview.startsWith(c.key + "|"));
    const g = course && groupsFor(course).find((x) => selKey(course, x) === state.preview);
    if (g && termOf(course) === sem) items.push({ course, g, ghost: true });
  }

  // fit the grid to the hours/days actually used by this semester's courses
  let minM = 9 * 60, maxM = 17 * 60, friday = false;
  const busy = busyFor(sem);
  const sessionsInTerm = state.courses.filter((c) => termOf(c) === sem).flatMap((c) => groupsFor(c).flatMap(timedSessions));
  for (const s of [...sessionsInTerm, ...busy]) {
    minM = Math.min(minM, toMin(s.start)); maxM = Math.max(maxM, toMin(s.end));
    if (s.day === 5) friday = true;
  }
  const start = Math.max(7 * 60, Math.floor(minM / 60) * 60);
  const end = Math.min(23 * 60, Math.ceil(maxM / 60) * 60);
  // positions are percentages of the day column, so the grid can stretch to whatever height it gets
  const span = end - start;
  const at = (m) => `${(((Math.min(Math.max(m, start), end) - start) / span) * 100).toFixed(3)}%`;
  const len = (a, b) => `calc(${(((Math.min(b, end) - Math.max(a, start)) / span) * 100).toFixed(3)}% - 3px)`;
  $("calWrap").style.setProperty("--cal-natural", `${Math.round(span * PX_PER_MIN) + 36}px`);
  // the preview counts as "used", so hovering a group on a hidden day still shows it
  const allDays = dayColumns([...items.flatMap(({ g }) => timedSessions(g).map((s) => s.day)), ...busy.map((b) => b.day)], friday);
  const dayList = mobileDayView(allDays, items, busy);
  calFrame = { start, end, dayList };

  const byDay = new Map(dayList.map((d) => [d, []]));
  const unscheduled = [];
  for (const { course, g, ghost } of items) {
    const timed = timedSessions(g);
    if (!timed.length && !ghost) unscheduled.push({ course, g });
    for (const s of timed) {
      byDay.get(s.day)?.push({ course, g, s, ghost, name: entryOf(course).name, start: toMin(s.start), end: toMin(s.end) });
    }
  }

  // only blocks that weren't on screen before get the entry animation (hover previews re-render often)
  const nextShown = new Set();
  const cal = $("calendar");
  cal.style.gridTemplateColumns = `48px repeat(${dayList.length}, minmax(0, 1fr))`;
  cal.style.minWidth = dayList.length < 4 ? "0" : "";
  let html = `<div class="cal-corner"></div>` + dayList.map((d) => `<div class="cal-head">${DAY_FULL[d]}</div>`).join("");
  let times = "", lines = "";
  for (let m = start; m <= end; m += 30) {
    if (m % 60 === 0 && m > start && m < end) times += `<span style="top:${at(m)}">${String(m / 60).padStart(2, "0")}:00</span>`;
    if (m > start && m < end) lines += `<div class="cal-line ${m % 60 ? "half" : ""}" style="top:${at(m)}"></div>`;
  }
  html += `<div class="cal-times">${times}</div>`;

  byDay.forEach((events, day) => {
    layoutLanes(events);
    const dayBusy = busy.filter((b) => b.day === day);
    const busyHtml = dayBusy.map((b) => {
      return `<div class="busy" data-busy="${esc(b.id)}" style="top:calc(${at(toMin(b.start))} + 1px);height:${len(toMin(b.start), toMin(b.end))}" title="${esc(`${b.label || "אילוץ"} · ${b.start}–${b.end}
לחיצה לעריכה`)}">
        <b>${esc(b.label || "אילוץ")}</b><span>${range(b)}</span>
        <button type="button" class="x" data-unbusy="${esc(b.id)}" aria-label="הסרת האילוץ">${ICONS.x}</button>
      </div>`;
    }).join("");
    const blocks = events.map((ev) => {
      const w = 100 / ev.lanes;
      const key = selKey(ev.course, ev.g);
      const clash = !ev.ghost && (events.some((o) => o !== ev && !o.ghost && o.start < ev.end && ev.start < o.end) ||
        dayBusy.some((b) => toMin(b.start) < ev.end && ev.start < toMin(b.end)));
      const type = ev.s.type || ev.g.type;
      const id = `${key}@${ev.s.day}${ev.s.start}`;
      const enter = !ev.ghost && !shownEvents.has(id);
      if (!ev.ghost) nextShown.add(id);
      return `<div class="event ${enter ? "enter" : ""} ${ev.ghost ? "ghost" : ""} ${clash ? "clash" : ""} ${state.preview === key && !ev.ghost ? "hl" : ""}"
          data-key="${esc(key)}" style="--c:${ev.course.color};top:calc(${at(ev.start)} + 1px);height:${len(ev.start, ev.end)};inset-inline-start:calc(${ev.lane * w}% + 3px);width:calc(${w}% - 6px)"
          title="${esc(`${ev.name}\n${type} ${ev.g.group} · ${ev.s.teacher || ev.g.teacher}\nיום ${ev.s.dayLabel}' ${ev.s.start}–${ev.s.end}\n${ev.s.location || ""}`)}">
        <b>${esc(ev.name)}</b>
        <span class="t">${esc(type)} ${esc(ev.g.group)}</span>
        <span class="tm">${range(ev.s)}</span>
        <span>${esc(ev.s.teacher || ev.g.teacher)}</span>
        ${ev.s.building || ev.s.room ? `<span>${esc([ev.s.building, ev.s.room && `חדר ${ev.s.room}`].filter(Boolean).join(" · "))}</span>` : ""}
        ${ev.ghost ? "" : `<button type="button" class="x" data-unpick="${esc(key)}" aria-label="הסרה מהמערכת">${ICONS.x}</button>`}
      </div>`;
    }).join("");
    html += `<div class="cal-day" data-day="${day}">${lines}${busyHtml}${blocks}</div>`;
  });
  cal.innerHTML = html;
  shownEvents = nextShown;

  $("calEmpty").hidden = items.length > 0 || busy.length > 0;
  $("unscheduled").innerHTML = unscheduled.length
    ? `<span>ללא מועד קבוע:</span>` + unscheduled.map(({ course, g }) =>
      `<span class="pick on" style="--c:${course.color};--c-soft:color-mix(in srgb, ${course.color} 12%, var(--surface))">${esc(entryOf(course).name)} <b>${esc(g.type)} ${esc(g.group)}</b></span>`).join("")
    : "";

  const total = picked.reduce((sum, { g }) => sum + credits(g), 0);
  const nCourses = new Set(picked.map(({ course }) => course.key)).size;
  const hours = picked.reduce((sum, { g }) => sum + timedSessions(g).reduce((s, x) => s + toMin(x.end) - toMin(x.start), 0), 0) / 60;
  const dups = duplicates(sem);
  $("plannerWarn").hidden = !dups.length;
  $("plannerWarn").innerHTML = dups.length
    ? ICONS.warn + `<span>יותר מקבוצה אחת: ${dups.map((d) => `${esc(d.type)} ב${esc(entryOf(d.course).name)} (${d.chosen.map((g) => esc(g.group)).join(", ")})`).join(" · ")}</span>`
    : "";
  $("plannerTitle").textContent = `${activePlan().name} · ${termLabel(sem)}`;
  $("plannerStats").textContent = picked.length
    ? `${nCourses} קורסים · ${picked.length} קבוצות · ${hours} שעות שבועיות${total ? ` · ${total} נ"ז` : ""}`
    : "עדיין לא נבחרו קבוצות";
}

/* ---------- plans (alternative timetables) ---------- */

function renderPlans() {
  const active = activePlan();
  const deletable = termPlans().length > 1;
  $("planTabs").innerHTML = termPlans().map((p) => {
    const n = selectedGroups(state.view, p.selected).length;
    const on = !state.comparing && !state.generating && p.id === active.id;
    return `<div class="plan-tab-wrap ${on ? "on" : ""} ${deletable ? "deletable" : ""}">
      <button type="button" role="tab" class="plan-tab" data-plan="${p.id}" aria-selected="${on}"
        title="${esc(p.notes || p.name)}">${esc(p.name)}<span class="count">${n}</span>${p.notes ? '<i class="has-notes" aria-label="יש הערות"></i>' : ""}</button>
      ${deletable ? `<button type="button" class="plan-del" data-delplan="${p.id}" title="מחיקת החלופה (אפשר לבטל)" aria-label="מחיקת ${esc(p.name)}">${ICONS.x}</button>` : ""}
    </div>`;
  }).join("");
  // keep the open plan visible inside the sideways-scrolling strip
  const on = $("planTabs").querySelector(".plan-tab-wrap.on");
  const strip = $("planScroll");
  if (on && strip.scrollWidth > strip.clientWidth) {
    const a = on.getBoundingClientRect(), b = strip.getBoundingClientRect();
    if (a.left < b.left || a.right > b.right) strip.scrollLeft += a.left < b.left ? a.left - b.left - 12 : a.right - b.right + 12;
  }
  $("compareBtn").classList.toggle("on", state.comparing);
  $("compareBtn").querySelector("span").textContent = state.comparing ? "חזרה לבנייה" : "השוואת חלופות";
  $("generateBtn").classList.toggle("on", state.generating);
  $("generateBtn").querySelector("span").textContent = state.generating ? "חזרה לבנייה" : "בנייה אוטומטית";
  if (document.activeElement !== $("planNotes")) $("planNotes").value = active.notes || "";
}

function createPlan(kind) {
  checkpoint("יצירת חלופה");
  const plan = { id: uid(), term: state.view, name: nextPlanName(), notes: "", selected: kind === "copy" ? new Set(activePlan().selected) : new Set() };
  state.plans.push(plan);
  state.activePlanByTerm[state.view] = plan.id;
  state.comparing = false;
  state.generating = false;
  render();
}

function switchPlan(id) {
  state.activePlanByTerm[state.view] = id;
  state.comparing = false;
  state.generating = false;
  state.preview = null;
  render();
}

function deletePlan(id) {
  const siblings = termPlans();
  const plan = siblings.find((p) => p.id === id);
  if (!plan || siblings.length < 2) return;
  const { name } = plan;
  checkpoint(`מחיקת "${name}"`);
  const idx = siblings.indexOf(plan);
  const wasActive = plan.id === activePlan().id;
  state.plans = state.plans.filter((p) => p.id !== id);
  // deleting the open plan moves to its neighbour; deleting another one leaves the open plan as is
  if (wasActive) state.activePlanByTerm[state.view] = (siblings[idx - 1] || siblings[idx + 1]).id;
  if (state.cmpBase === id) state.cmpBase = null;
  render();
  undoToast(`החלופה "${name}" נמחקה`);
}

function startRename() {
  const input = $("planNameInput");
  input.value = activePlan().name;
  input.hidden = false;
  $("plannerTitle").hidden = true;
  input.focus();
  input.select();
}

function finishRename(commit) {
  const input = $("planNameInput");
  if (input.hidden) return;
  const name = input.value.trim();
  if (commit && name && name !== activePlan().name) {
    checkpoint("שינוי שם החלופה");
    activePlan().name = name;
  }
  input.hidden = true;
  $("plannerTitle").hidden = false;
  render();
}

/* ---------- plan metrics + comparison ---------- */

const DAY_LETTER = (d) => DAY_SHORT[d] || "";
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtHours = (h) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
// returns HTML like "06 (<day letter> 11:00–13:00)", with the time kept left-to-right
const describe = (g) => {
  const t = timedSessions(g).map((s) => `${esc(s.dayLabel)}' ${range(s)}`).join(", ");
  return `${esc(g.group)}${t ? ` (${t})` : ""}`;
};

// components = (course, type) pairs; each plan picks group(s) for each
function components(sem) {
  const out = [];
  for (const course of state.courses.filter((c) => termOf(c) === sem)) {
    if (!entryOf(course)) continue;
    for (const [type, gs] of sectionsFor(course)) out.push({ id: `${course.key}|${type}`, course, type, gs });
  }
  return out;
}

function planMetrics(plan, sem) {
  const picked = selectedGroups(sem, plan.selected);
  const sessions = picked.flatMap(({ course, g }) => timedSessions(g).map((s) => ({ course, g, day: s.day, start: toMin(s.start), end: toMin(s.end) })));
  const byDay = new Map();
  for (const s of sessions) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  let gaps = 0, conflicts = 0;
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start - b.start);
    let end = list[0].end;
    for (let i = 1; i < list.length; i++) {
      if (list[i].start < end) conflicts++;
      else gaps += list[i].start - end;
      end = Math.max(end, list[i].end);
    }
  }
  conflicts += sessions.filter((s) => busyFor(sem).some((b) => b.day === s.day && toMin(b.start) < s.end && s.start < toMin(b.end))).length;
  const comps = components(sem);
  const missing = comps.filter((c) => typeRank(c.type) < 2 && !c.gs.some((g) => plan.selected.has(selKey(c.course, g))));
  return {
    picked,
    days: [...byDay.keys()].sort(),
    hours: sessions.reduce((sum, s) => sum + s.end - s.start, 0) / 60,
    gaps: gaps / 60,
    earliest: sessions.length ? Math.min(...sessions.map((s) => s.start)) : null,
    latest: sessions.length ? Math.max(...sessions.map((s) => s.end)) : null,
    credits: picked.reduce((sum, { g }) => sum + credits(g), 0),
    conflicts,
    missing: missing.length,
    dupes: duplicates(sem, plan.selected).length,
  };
}

function planChanges(base, plan, sem) {
  const changes = [];
  for (const c of components(sem)) {
    const a = c.gs.filter((g) => base.selected.has(selKey(c.course, g)));
    const b = c.gs.filter((g) => plan.selected.has(selKey(c.course, g)));
    if (a.map((g) => g.group).join() === b.map((g) => g.group).join()) continue;
    const label = `${c.type} ב${entryOf(c.course).name}`;
    const color = c.course.color;
    if (a.length && b.length) changes.push({ kind: "swap", color, html: `<b>${esc(label)}</b>: ${b.map(describe).join(", ")} <span class="was">במקום ${a.map(describe).join(", ")}</span>` });
    else if (b.length) changes.push({ kind: "add", color, html: `נוסף <b>${esc(label)}</b>: ${b.map(describe).join(", ")}` });
    else changes.push({ kind: "remove", color, html: `הוסר <b>${esc(label)}</b> <span class="was">(${a.map(describe).join(", ")})</span>` });
  }
  const mb = planMetrics(base, sem), mp = planMetrics(plan, sem);
  const freed = mb.days.filter((d) => !mp.days.includes(d));
  const added = mp.days.filter((d) => !mb.days.includes(d));
  if (freed.length) changes.push({ kind: "good", html: `${freed.map((d) => `יום ${DAY_FULL[d]}`).join(" ו")} ${freed.length > 1 ? "פנויים" : "פנוי"}` });
  if (added.length) changes.push({ kind: "bad", html: `מגיעים גם ב${added.map((d) => `יום ${DAY_FULL[d]}`).join(" וב")}` });
  return changes;
}

function miniCalHTML(picked, frame) {
  const span = frame.end - frame.start;
  let lines = "";
  for (let m = frame.start + 60; m < frame.end; m += 60) lines += `<div class="mc-line" style="top:${pct((m - frame.start) / span)}"><span>${fmtMin(m)}</span></div>`;
  const byDay = new Map(frame.dayList.map((d) => [d, []]));
  for (const { course, g } of picked) {
    for (const s of timedSessions(g)) {
      byDay.get(s.day)?.push({ course, g, s, start: toMin(s.start), end: toMin(s.end) });
    }
  }
  const cols = [...byDay.values()].map((events) => {
    layoutLanes(events);
    return `<div class="mc-col">${events.map((ev) => {
      const w = 100 / ev.lanes;
      return `<div class="mc-ev" style="--c:${ev.course.color};top:${pct((ev.start - frame.start) / span)};height:${pct((ev.end - ev.start) / span)};inset-inline-start:${pct(ev.lane * w / 100)};width:${pct(w / 100)}"
        title="${esc(`${entryOf(ev.course).name} · ${ev.s.type || ev.g.type} ${ev.g.group}\n${ev.s.dayLabel}' ${ev.s.start}–${ev.s.end}`)}">
        <b>${esc(entryOf(ev.course).name)}</b><span>${esc(ev.s.type || ev.g.type)} ${esc(ev.g.group)}</span></div>`;
    }).join("")}</div>`;
  }).join("");
  return `<div class="mini-cal" style="--days:${frame.dayList.length}">
    <div class="mc-heads">${frame.dayList.map((d) => `<span>${DAY_SHORT[d]}</span>`).join("")}</div>
    <div class="mc-body">${lines}${cols}</div>
  </div>`;
}

function deltaHTML(cur, base, { better = null, unit = "", fmt = (v) => fmtHours(v) } = {}) {
  if (base == null || cur == null || cur === base) return "";
  const d = cur - base;
  const good = better === "less" ? d < 0 : better === "more" ? d > 0 : null;
  const cls = good === null ? "neutral" : good ? "good" : "bad";
  return `<span class="delta ${cls}"><bdi dir="ltr">${d > 0 ? "+" : "−"}${fmt(Math.abs(d))}${unit}</bdi></span>`;
}

function renderCompare() {
  const sem = state.view;
  const plans = termPlans();
  if (!plans.some((p) => p.id === state.cmpBase)) state.cmpBase = plans[0].id;
  const base = plans.find((p) => p.id === state.cmpBase);
  $("cmpTitle").textContent = `השוואת חלופות · ${termLabel(sem)}`;
  $("cmpBase").innerHTML = plans.map((p) => `<option value="${p.id}" ${p.id === base.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  $("cmpShowSame").checked = state.cmpShowSame;

  const metrics = new Map(plans.map((p) => [p.id, planMetrics(p, sem)]));
  const mb = metrics.get(base.id);
  // one shared frame so the mini calendars are comparable at a glance
  const all = [...metrics.values()];
  let start = Math.min(...all.map((m) => m.earliest ?? 10 * 60)), end = Math.max(...all.map((m) => m.latest ?? 16 * 60));
  start = Math.floor(start / 60) * 60; end = Math.ceil(end / 60) * 60;
  if (end - start < 6 * 60) end = start + 6 * 60;
  // union of days across plans, so the mini calendars stay comparable when empty days are hidden
  const frame = { start, end, dayList: dayColumns(all.flatMap((m) => m.days), false) };

  const stat = (label, value, delta = "", cls = "") => `<div class="cs ${cls}"><span>${label}</span><b>${value}${delta}</b></div>`;
  $("cmpCards").innerHTML = plans.map((p) => {
    const m = metrics.get(p.id);
    const isBase = p.id === base.id;
    const changes = isBase ? [] : planChanges(base, p, sem);
    const d = (cur, b, opts) => (isBase ? "" : deltaHTML(cur, b, opts));
    return `<article class="cmp-card ${isBase ? "is-base" : ""} ${p.id === activePlan().id ? "is-active" : ""}">
      <header>
        <h3>${esc(p.name)}</h3>
        ${isBase ? '<span class="badge">בסיס</span>' : ""}
        <button type="button" class="btn text" data-open="${p.id}">פתיחה לעריכה</button>
      </header>
      <div class="cmp-stats">
        ${stat("ימים בקמפוס", `${m.days.length}<small>${m.days.map(DAY_LETTER).join(" ")}</small>`, d(m.days.length, mb.days.length, { better: "less" }))}
        ${stat("שעות שבועיות", fmtHours(m.hours), d(m.hours, mb.hours))}
        ${stat("שעות חלון", fmtHours(m.gaps), d(m.gaps, mb.gaps, { better: "less" }))}
        ${stat("התחלה מוקדמת", m.earliest != null ? fmtMin(m.earliest) : "—")}
        ${stat("סיום מאוחר", m.latest != null ? fmtMin(m.latest) : "—")}
        ${stat('נ"ז', fmtHours(m.credits), d(m.credits, mb.credits))}
        ${m.conflicts ? stat("התנגשויות", m.conflicts, "", "warn") : ""}
        ${m.missing ? stat("רכיבים חסרים", m.missing, "", "warn") : ""}
        ${m.dupes ? stat("נבחרה יותר מקבוצה אחת", m.dupes, "", "warn") : ""}
      </div>
      ${miniCalHTML(m.picked, frame)}
      <div class="cmp-changes">
        <h4>${isBase ? "חלופת הבסיס" : `שינויים מול ${esc(base.name)}`}</h4>
        ${isBase ? '<p class="muted">שאר החלופות מושוות לחלופה הזו.</p>'
          : changes.length ? `<ul>${changes.map((c) => `<li class="${c.kind}" ${c.color ? `style="--c:${c.color}"` : ""}>${c.html}</li>`).join("")}</ul>`
          : '<p class="muted">זהה לחלופת הבסיס.</p>'}
      </div>
      <label class="cmp-notes">הערות
        <textarea data-notes="${p.id}" rows="3" placeholder="מה חשוב לזכור על החלופה הזו?">${esc(p.notes || "")}</textarea>
      </label>
    </article>`;
  }).join("") + (plans.length < 2 ? `<div class="cmp-hint"><b>יש כרגע חלופה אחת</b><span>צרו חלופה נוספת כדי לראות את ההבדלים.</span>
      <button type="button" class="btn primary" data-new="copy">שכפול "${esc(activePlan().name)}"</button></div>` : "");

  // diff table: one row per course component, one column per plan
  const comps = components(sem);
  let rows = "", hiddenSame = 0;
  for (const c of comps) {
    const cells = plans.map((p) => c.gs.filter((g) => p.selected.has(selKey(c.course, g))));
    const sig = cells.map((gs) => gs.map((g) => g.group).join());
    const baseSig = sig[plans.indexOf(base)];
    const same = sig.every((s) => s === sig[0]);
    if (same && !state.cmpShowSame) { hiddenSame++; continue; }
    rows += `<tr class="${same ? "same" : ""}" style="--c:${c.course.color}">
      <th scope="row"><i class="dot"></i>${esc(entryOf(c.course).name)}<small>${esc(c.type)}</small></th>
      ${cells.map((gs, i) => `<td class="${sig[i] !== baseSig ? "diff" : ""} ${!gs.length ? "none" : ""}">${gs.length
        ? gs.map((g) => `<div><b>${esc(g.group)}</b> <span>${timedSessions(g).map((s) => `${esc(s.dayLabel)}' ${range(s)}`).join(", ") || "מועד לא נקבע"}</span></div>`).join("")
        : "—"}</td>`).join("")}
    </tr>`;
  }
  $("cmpTable").innerHTML = comps.length ? `
    <thead><tr><th></th>${plans.map((p) => `<th class="${p.id === base.id ? "base" : ""}">${esc(p.name)}</th>`).join("")}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${plans.length + 1}" class="all-same">כל החלופות זהות${plans.length < 2 ? "" : " – אין הבדלים לתצוגה"}.</td></tr>`}</tbody>
    ${hiddenSame && rows ? `<tfoot><tr><td colspan="${plans.length + 1}">${hiddenSame} רכיבים זהים בכל החלופות הוסתרו</td></tr></tfoot>` : ""}`
    : `<tbody><tr><td class="all-same">עדיין אין קורסים בסמסטר הזה.</td></tr></tbody>`;
}

/* ---------- undo / redo ---------- */

// snapshots of everything the user edits; taken right before each change
const undoStack = [], redoStack = [];
const UNDO_LIMIT = 60;

function snapshot() {
  return JSON.stringify({
    courses: state.courses,
    plans: state.plans.map((p) => ({ ...p, selected: [...p.selected] })),
    activePlanByTerm: state.activePlanByTerm,
    view: state.view,
    rejected: [...state.rejected],
    filters: state.filters,
    busy: state.busy,
    collapsed: [...state.collapsed],
  });
}

function restoreSnapshot(snap) {
  const d = JSON.parse(snap);
  state.courses = d.courses;
  state.plans = d.plans.map((p) => ({ ...p, selected: new Set(p.selected) }));
  state.activePlanByTerm = d.activePlanByTerm;
  state.view = d.view;
  state.rejected = new Set(d.rejected);
  state.filters = d.filters;
  state.busy = d.busy;
  state.collapsed = new Set(d.collapsed);
  state.preview = null;
  render();
}

function checkpoint(label) {
  undoStack.push({ snap: snapshot(), label });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function undo() {
  const step = undoStack.pop();
  if (!step) return toast("אין פעולה לבטל");
  redoStack.push({ snap: snapshot(), label: step.label });
  restoreSnapshot(step.snap);
  toast(`בוטל: ${step.label}`, "", { label: "חזרה", run: redo });
}

function redo() {
  const step = redoStack.pop();
  if (!step) return toast("אין פעולה לשחזר");
  undoStack.push({ snap: snapshot(), label: step.label });
  restoreSnapshot(step.snap);
  toast(`שוחזר: ${step.label}`, "", { label: "ביטול", run: undo });
}

// message after a destructive action, with a one-click way back
const undoToast = (msg) => toast(msg, "", { label: "ביטול", run: undo });

/* ---------- personal blocked times ---------- */

let editingBusy = null; // id of the blocked time open in the dialog, or null for a new one

function openBusyDialog(busy) {
  editingBusy = busy?.id || null;
  $("blkDay").innerHTML = DAY_FULL.map((d, i) => `<option value="${i}">${d}</option>`).join("");
  $("blkLabel").value = busy?.label || "";
  $("blkDay").value = String(busy?.day ?? 0);
  $("blkStart").value = busy?.start || "09:00";
  $("blkEnd").value = busy?.end || "12:00";
  $("blkDelete").hidden = !editingBusy;
  $("blockTitle").textContent = editingBusy ? "עריכת אילוץ" : "אילוץ חדש";
  $("blkError").hidden = true;
  $("blockDialog").showModal();
  $("blkLabel").focus();
}

function saveBusy(e) {
  e.preventDefault();
  const start = $("blkStart").value, end = $("blkEnd").value;
  if (!start || !end || toMin(end) <= toMin(start)) {
    $("blkError").textContent = "שעת הסיום צריכה להיות אחרי שעת ההתחלה.";
    $("blkError").hidden = false;
    return;
  }
  checkpoint(editingBusy ? "עריכת אילוץ" : "הוספת אילוץ");
  const item = { id: editingBusy || uid(), day: Number($("blkDay").value), start, end, label: $("blkLabel").value.trim() };
  const list = busyFor().filter((b) => b.id !== item.id);
  state.busy[state.view] = [...list, item].sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  $("blockDialog").close();
  render();
  const hit = selectedGroups().filter(({ g }) => timedSessions(g).some((s) => overlaps(s, item)));
  if (hit.length) toast(`האילוץ מתנגש עם ${hit.map(({ course, g }) => `${entryOf(course).name} ${g.group}`).join(", ")}`, "warn");
}

function removeBusy(id) {
  const item = busyFor().find((b) => b.id === id);
  if (!item) return;
  checkpoint("מחיקת אילוץ");
  state.busy[state.view] = busyFor().filter((b) => b.id !== id);
  render();
  undoToast(`האילוץ "${item.label || `${item.start}–${item.end}`}" נמחק`);
}

// drag on an empty part of a day column to block that time
function initBusyDrag() {
  const cal = $("calendar");
  let drag = null;
  const minuteAt = (col, clientY) => {
    const r = col.getBoundingClientRect();
    const m = calFrame.start + ((clientY - r.top) / r.height) * (calFrame.end - calFrame.start);
    return Math.max(calFrame.start, Math.min(calFrame.end, Math.round(m / 30) * 30));
  };
  cal.addEventListener("pointerdown", (e) => {
    const col = e.target.closest(".cal-day");
    // on touch screens a drag scrolls / swipes days; blocked times are added with the button there
    if (!col || e.button !== 0 || e.pointerType === "touch" || e.target.closest(".event, .busy") || !calFrame) return;
    const m = minuteAt(col, e.clientY);
    const ghost = document.createElement("div");
    ghost.className = "busy drafting";
    col.appendChild(ghost);
    drag = { col, day: Number(col.dataset.day), from: m, to: m, ghost };
    col.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  cal.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.to = minuteAt(drag.col, e.clientY);
    const a = Math.min(drag.from, drag.to), b = Math.max(drag.from, drag.to);
    const span = calFrame.end - calFrame.start;
    Object.assign(drag.ghost.style, { top: `${((a - calFrame.start) / span) * 100}%`, height: `${(Math.max(b - a, 0) / span) * 100}%` });
    drag.ghost.innerHTML = b - a >= 30 ? `<span><bdi dir="ltr">${fmtMin(a)}–${fmtMin(b)}</bdi></span>` : "";
  });
  const finish = () => {
    if (!drag) return;
    const { day, from, to, ghost } = drag;
    drag = null;
    ghost.remove();
    const a = Math.min(from, to), b = Math.max(from, to);
    if (b - a >= 30) openBusyDialog({ day, start: fmtMin(a), end: fmtMin(b) });
  };
  cal.addEventListener("pointerup", finish);
  cal.addEventListener("pointercancel", finish);
}

/* ---------- automatic schedule builder ---------- */

const GEN_KEEP = 40;          // best results kept
const GEN_LIMIT = 400000;     // search steps before giving up on exhaustiveness

// metrics of a full combination; each session carries its owner option ({day, start, end, opt})
function comboMetrics(sessions, prefs) {
  const comfortFrom = toMin(prefs.comfortFrom || "10:00"), comfortTo = toMin(prefs.comfortTo || "18:00");
  const byDay = new Map();
  for (const s of sessions) {
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push(s);
  }
  let gaps = 0, outside = 0, span = 0, ends = 0;
  for (const list of byDay.values()) {
    list.sort((a, b) => a.start - b.start);
    let end = list[0].end;
    for (let i = 1; i < list.length; i++) { gaps += Math.max(0, list[i].start - end); end = Math.max(end, list[i].end); }
    outside += Math.max(0, comfortFrom - list[0].start) + Math.max(0, end - comfortTo); // minutes outside the comfortable hours
    span += end - list[0].start;
    ends += end;
  }
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const startsOf = (pred) => sessions.filter((s) => pred(s.opt)).map((s) => s.start);
  const lectures = startsOf((o) => typeRank(o.type) === 0);
  // a tutorial that comes before a lecture on the same day (the order "lectures first" wants to avoid)
  const isLecture = (s) => typeRank(s.opt.type) === 0, isTutorial = (s) => typeRank(s.opt.type) === 1;
  const tutorialsBefore = sessions.filter(isTutorial)
    .filter((t) => sessions.some((l) => isLecture(l) && l.day === t.day && t.start < l.start)).length;
  const morning = startsOf((o) => prefs.morningCourses.includes(o.course.key));
  return {
    days: [...byDay.keys()].sort(),
    gaps: gaps / 60,
    outside: outside / 60,
    span: span / 60,
    endAvg: byDay.size ? ends / byDay.size : 0, // minutes; earlier is better
    hours: sessions.reduce((sum, s) => sum + s.end - s.start, 0) / 60,
    earliest: sessions.length ? Math.min(...sessions.map((s) => s.start)) : null,
    latest: sessions.length ? Math.max(...sessions.map((s) => s.end)) : null,
    // "lectures first" measures only how early the lectures are and same-day order, so it can never
    // be satisfied by pushing a tutorial later in the day (that made days end later for no reason)
    lectureLate: lectures.length ? Math.max(0, avg(lectures) - comfortFrom) / 60 : 0,
    tutorialsBefore,
    // average start of the "morning" courses, in hours after 08:00
    morningLate: morning.length ? (avg(morning) - 480) / 60 : 0,
  };
}

/* what "better" means: each criterion the user can tick, its weight and how to read it from the metrics */
const CRITERIA = {
  days: { w: 3, val: (m) => m.days.length, label: "ימים בקמפוס" },   // one more campus day ~ 3 gap hours
  gaps: { w: 1, val: (m) => m.gaps, label: "שעות חלון" },
  comfort: { w: 1, val: (m) => m.outside, label: "שעות מחוץ לשעות הנוחות" },
};
const activeCriteria = (prefs) => (prefs.criteria?.length ? prefs.criteria : Object.keys(CRITERIA));

// lower is better, compared element by element:
// [clashes (added by the search), missed preferred teachers, weighted score of the ticked criteria,
//  how early the days end on average, the unticked criteria, hours spent on campus]
// ending earlier only decides between timetables that are equal on what the user ticked, so it never
// pushes a day outside the comfortable hours (those are part of the score when "comfort" is ticked)
function rankKey(m, prefs, teacherMiss) {
  const ticked = activeCriteria(prefs);
  let score = 0, tie = 0;
  for (const [k, c] of Object.entries(CRITERIA)) {
    if (ticked.includes(k)) score += c.w * c.val(m);
    else tie += c.w * c.val(m);
  }
  // soft preferences only reorder timetables that are close on the ticked criteria
  if (prefs.lecturesFirst) score += m.lectureLate * 0.25 + m.tutorialsBefore * 0.5;
  if (prefs.morningCourses.length) score += m.morningLate * 0.5;
  return [teacherMiss, Math.round(score * 1000) / 1000, Math.round(m.endAvg), Math.round(tie * 1000) / 1000, m.span];
}

// a result is dominated when another one is at least as good on every ticked criterion and better on one
function markDominated(results, prefs) {
  const ticked = activeCriteria(prefs);
  const vals = results.map((r) => ticked.map((k) => CRITERIA[k].val(r.m)));
  results.forEach((r, i) => {
    r.dominatedBy = results.findIndex((o, j) => j !== i && o.clashes.length <= r.clashes.length &&
      vals[j].every((v, n) => v <= vals[i][n]) && vals[j].some((v, n) => v < vals[i][n]));
  });
}
const compareKeys = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

// allowClash: when no conflict-free timetable exists, find the ones with the fewest clashes instead
function generateSchedules(prefs, allowClash = false) {
  const term = state.view;
  const busy = prefs.useBlocks ? busyFor(term) : [];
  const notBefore = prefs.notBefore ? toMin(prefs.notBefore) : null;
  const notAfter = prefs.notAfter ? toMin(prefs.notAfter) : null;
  const fits = (g) => timedSessions(g).every((s) =>
    !prefs.freeDays.includes(s.day) &&
    (notBefore == null || toMin(s.start) >= notBefore) &&
    (notAfter == null || toMin(s.end) <= notAfter) &&
    !busy.some((b) => overlaps(s, b)));
  const liked = (g) => teachersOf(g).some((t) => prefs.teachers.includes(t));

  const comps = [], blocked = [];
  for (const course of visibleCourses().filter(entryOf)) {
    for (const [type, gs] of sectionsFor(course)) {
      if (!needsOne(type)) continue;
      const kept = prefs.keep ? gs.filter((g) => state.selected.has(selKey(course, g))) : [];
      let cands = kept.length ? kept : gs.filter((g) => !state.rejected.has(selKey(course, g)));
      if (!kept.length) {
        // a group with no published time would look "free" and win every ranking - skip it when real times exist
        if (gs.some((g) => timedSessions(g).length)) cands = cands.filter((g) => timedSessions(g).length);
        if (prefs.skipNoTeacher) cands = cands.filter((g) => teachersOf(g).length);
        if (prefs.avoidTeachers.length) cands = cands.filter((g) => !teachersOf(g).some((t) => prefs.avoidTeachers.includes(t)));
        if (prefs.useFilters) cands = cands.filter((g) => passesFilter(course, g));
        cands = cands.filter(fits);
      }
      // same days + hours = one option; the user picks the exact group number later
      const slots = new Map();
      for (const g of cands) {
        const k = slotOf(g) || `solo:${g.group}`;
        if (!slots.has(k)) slots.set(k, []);
        slots.get(k).push(g);
      }
      const options = [...slots.values()].map((groups) => {
        // a preferred teacher's group goes first, so it's the one that gets saved
        groups.sort((a, b) => liked(b) - liked(a));
        return {
          course, type, groups, liked: liked(groups[0]),
          sessions: timedSessions(groups[0]).map((s) => ({ day: s.day, start: toMin(s.start), end: toMin(s.end) })),
        };
      });
      const wantsTeacher = options.some((o) => o.liked);
      options.forEach((o) => { o.wantsTeacher = wantsTeacher; });
      if (!options.length) blocked.push({ course, type, total: gs.length });
      comps.push(options);
    }
  }
  if (!comps.length || blocked.length) return { comps: comps.length, blocked, results: [], valid: 0, steps: 0, capped: false };

  comps.sort((a, b) => a.length - b.length); // fewest options first prunes the search early
  let results = [], valid = 0, steps = 0;
  const chosen = [], taken = [], clashes = []; // taken: sessions with their owner option
  const prune = () => {
    results.sort((a, b) => compareKeys(a.key, b.key));
    results.length = Math.min(results.length, GEN_KEEP);
  };
  (function search(i) {
    if (steps > GEN_LIMIT) return;
    if (i === comps.length) {
      valid++;
      const m = comboMetrics(taken, prefs);
      const teacherMiss = chosen.filter((o) => o.wantsTeacher && !o.liked).length;
      results.push({ options: [...chosen], m, clashes: [...clashes], key: [clashes.length, ...rankKey(m, prefs, teacherMiss)] });
      if (results.length > GEN_KEEP * 5) prune();
      return;
    }
    for (const opt of comps[i]) {
      steps++;
      const hits = taken.filter((t) => opt.sessions.some((s) => t.day === s.day && s.start < t.end && t.start < s.end));
      if (hits.length && !allowClash) continue;
      const newClashes = [...new Set(hits.map((t) => t.opt))].map((other) => [other, opt]);
      if (allowClash && clashes.length + newClashes.length > 2) continue; // more than 2 clashes is not useful
      chosen.push(opt);
      taken.push(...opt.sessions.map((s) => ({ ...s, opt })));
      clashes.push(...newClashes);
      search(i + 1);
      chosen.pop();
      taken.length -= opt.sessions.length;
      clashes.length -= newClashes.length;
    }
  })(0);
  prune();
  markDominated(results, prefs);
  return { comps: comps.length, blocked, results, valid, steps, capped: steps > GEN_LIMIT };
}

let genShown = 12;
let genSaved = new Map(); // result signature -> plan id, so a result is saved once
const resultSig = (r) => r.options.map((o) => `${o.course.key}|${o.groups[0].group}`).sort().join(",");

function renderGenerator() {
  const prefs = state.genPrefs;
  $("genTitle").textContent = `בנייה אוטומטית · ${termLabel(state.view)}`;
  $("genForm").querySelectorAll("[name=criteria]").forEach((c) => { c.checked = activeCriteria(prefs).includes(c.value); });
  // the user's own comfortable hours
  const hourList = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => fmtMin((from + i) * 60));
  $("genComfortFrom").innerHTML = hourList(7, 13).map((h) => `<option ${h === prefs.comfortFrom ? "selected" : ""} ${toMin(h) >= toMin(prefs.comfortTo) ? "disabled" : ""}>${h}</option>`).join("");
  // phones: the panel is folded to a one-line summary so the results show right away
  const crit = activeCriteria(prefs).map((k) => ({ days: "פחות ימים", gaps: "פחות חלונות", comfort: `שעות ${prefs.comfortFrom}–${prefs.comfortTo}` }[k]));
  $("genPrefsSummary").textContent = [crit.join(" · "), prefs.freeDays.length ? `${prefs.freeDays.length} ימים פנויים` : ""].filter(Boolean).join(" · ");
  $("genComfortTo").innerHTML = hourList(13, 22).map((h) => `<option ${h === prefs.comfortTo ? "selected" : ""} ${toMin(h) <= toMin(prefs.comfortFrom) ? "disabled" : ""}>${h}</option>`).join("");
  $("comfortHint").textContent = `כמה שפחות לפני ${prefs.comfortFrom} ואחרי ${prefs.comfortTo}`;
  $("comfortHours").classList.toggle("off", !activeCriteria(prefs).includes("comfort"));
  $("genFreeDays").innerHTML = [0, 1, 2, 3, 4, 5].map((d) =>
    `<button type="button" class="fday ${prefs.freeDays.includes(d) ? "on" : ""}" data-freeday="${d}" aria-pressed="${prefs.freeDays.includes(d)}" title="יום ${DAY_FULL[d]} פנוי">${DAY_SHORT[d]}</button>`).join("");
  const hourOpts = (from, to, cur, empty) => `<option value="">${empty}</option>` +
    Array.from({ length: to - from + 1 }, (_, i) => fmtMin((from + i) * 60)).map((h) => `<option ${h === cur ? "selected" : ""}>${h}</option>`).join("");
  $("genNotBefore").innerHTML = hourOpts(8, 13, prefs.notBefore, "ללא הגבלה");
  $("genNotAfter").innerHTML = hourOpts(13, 22, prefs.notAfter, "ללא הגבלה");
  $("genUseBlocks").checked = prefs.useBlocks;
  $("genUseFilters").checked = prefs.useFilters;
  $("genKeep").checked = prefs.keep;
  $("genSkipNoTeacher").checked = prefs.skipNoTeacher;
  $("genLecturesFirst").checked = prefs.lecturesFirst;

  // tooltips that depend on the current term / plan
  const filtered = visibleCourses().filter((c) => filterActive(filterOf(c)));
  $("genFiltersTip").dataset.tip = "בתצוגה 'לפי קורס' יש לכל קורס שורת סינון (יום, מרצה, שעות). כשהאפשרות פעילה, הבנייה משתמשת רק בקבוצות שעוברות את הסינון של כל קורס; קורס בלי סינון – כל הקבוצות שלו נכללות. " +
    (filtered.length ? `כרגע יש סינון ב: ${filtered.map((c) => entryOf(c)?.name || c.code).join(", ")}.` : "כרגע אין סינון באף קורס, כך שלאפשרות אין השפעה.");
  const keptNow = selectedGroups();
  $("genKeepTip").dataset.tip = `הקבוצות שכבר סימנת בחלופה הפתוחה ("${activePlan().name}") נשארות קבועות, והמערכת משלימה רק את מה שעוד לא נבחר – למשל: בחרת הרצאה, והמערכת תמצא רק תרגולים שמתאימים לה. ` +
    (keptNow.length ? `כרגע נבחרו שם ${keptNow.length} קבוצות.` : "כרגע לא נבחרה שם אף קבוצה, כך שלאפשרות אין השפעה.");

  // courses that should sit in the morning
  const termCourses = visibleCourses().filter(entryOf);
  prefs.morningCourses = prefs.morningCourses.filter((k) => termCourses.some((c) => c.key === k));
  $("genMorningCourses").innerHTML = termCourses.length
    ? termCourses.map((c) => `<button type="button" class="pick-chip ${prefs.morningCourses.includes(c.key) ? "on" : ""}" data-morning="${esc(c.key)}"
        aria-pressed="${prefs.morningCourses.includes(c.key)}" style="--c:${c.color}">${esc(entryOf(c).name)}</button>`).join("")
    : '<span class="muted">אין קורסים בסמסטר הזה</span>';

  // preferred lecturers / tutors, grouped by course in the picker
  const byCourse = termCourses.map((c) => ({ c, names: [...new Set(groupsFor(c).filter((g) => needsOne(g.type)).flatMap(teachersOf))].sort((a, b) => a.localeCompare(b, "he")) }));
  const taken = new Set([...prefs.teachers, ...prefs.avoidTeachers]);
  const teacherOpts = (first) => `<option value="">${first}</option>` + byCourse.filter((x) => x.names.length).map(({ c, names }) =>
    `<optgroup label="${esc(entryOf(c).name)}">${names.map((n) => `<option value="${esc(n)}" ${taken.has(n) ? "disabled" : ""}>${esc(n)}</option>`).join("")}</optgroup>`).join("");
  const chips = (list, attr) => list.map((t) => `<span class="chip-sel">${esc(t)}<button type="button" ${attr}="${esc(t)}" aria-label="הסרת ${esc(t)}">${ICONS.x}</button></span>`).join("");
  $("genTeacherAdd").innerHTML = teacherOpts("+ הוספת מרצה או מתרגל…");
  $("genTeachers").innerHTML = chips(prefs.teachers, "data-unteacher");
  $("genAvoidAdd").innerHTML = teacherOpts("+ הוספת מרצה או מתרגל להתעלמות…");
  $("genAvoid").innerHTML = chips(prefs.avoidTeachers, "data-unavoid");

  fitGenPanel();

  const out = $("genResults");
  if (!visibleCourses().some(entryOf)) {
    out.innerHTML = `<div class="gen-empty"><b>אין קורסים ב${esc(termLabel(state.view))}</b><span>מוסיפים קורסים, ואז חוזרים לכאן.</span></div>`;
    return;
  }
  const t0 = performance.now();
  const res = generateSchedules(prefs);
  const ms = Math.round(performance.now() - t0);
  if (res.blocked.length) {
    out.innerHTML = `<div class="gen-empty warn"><b>אין אף צירוף שעומד בכל הדרישות</b>
      <span>לרכיבים האלה לא נשארה אף קבוצה מתאימה:</span>
      <ul>${res.blocked.map((b) => `<li style="--c:${b.course.color}"><i class="dot"></i>${esc(b.type)} ב${esc(entryOf(b.course).name)} <span class="muted">(${b.total} קבוצות, כולן נפסלו או לא מתאימות)</span></li>`).join("")}</ul>
      <span>נסו לשחרר יום פנוי, להרחיב את השעות או לבטל פסילה של קבוצה.</span></div>`;
    return;
  }
  let banner = "";
  if (!res.results.length) {
    const near = generateSchedules(prefs, true);
    if (!near.results.length) {
      out.innerHTML = `<div class="gen-empty warn"><b>כל הצירופים מתנגשים</b>
        <span>לכל רכיב יש קבוצות מתאימות, אבל אין דרך לשלב אותן בלי כמה התנגשויות. נסו להקל על אחת הדרישות.</span></div>`;
      return;
    }
    Object.assign(res, near);
    banner = `<div class="gen-empty warn gen-banner"><b>אין מערכת בלי התנגשויות</b>
      <span>לכל רכיב יש קבוצות מתאימות, אבל אי אפשר לשלב את כולן בלי חפיפה. אלה הצירופים הכי קרובים – ההתנגשויות מסומנות בכל כרטיס.
      ${visibleCourses().some((c) => groupsFor(c).some((g) => !timedSessions(g).length && needsOne(g.type))) ? "קבוצות בלי מועד ידוע לא נכללות בחישוב." : ""}</span></div>`;
  }

  const shown = res.results.slice(0, genShown);
  const all = shown.flatMap((r) => r.options.flatMap((o) => o.sessions));
  let fStart = Math.floor(Math.min(...all.map((s) => s.start), 600) / 60) * 60;
  let fEnd = Math.ceil(Math.max(...all.map((s) => s.end), 960) / 60) * 60;
  if (fEnd - fStart < 360) fEnd = fStart + 360;
  const frame = { start: fStart, end: fEnd, dayList: dayColumns(all.map((s) => s.day), false) };

  const summary = banner ? "" : `נמצאו ${res.valid.toLocaleString("he-IL")} צירופים אפשריים${res.capped ? " (החיפוש נעצר באמצע – יש עוד)" : ""} · מדורגים מהטוב ביותר כלפי מטה · ${ms} מ"ש`;
  const optName = (o) => `${o.type} ${o.groups.map((g) => g.group).join("/")} ב${entryOf(o.course).name}`;
  const ticked = activeCriteria(prefs);
  const best = shown[0];

  // shared pieces of the featured card and the regular cards
  const partsHTML = (r) => {
    const byCourse = new Map();
    for (const o of r.options) {
      if (!byCourse.has(o.course.key)) byCourse.set(o.course.key, { course: o.course, parts: [] });
      byCourse.get(o.course.key).parts.push(o);
    }
    return `<ul class="gen-parts">${[...byCourse.values()].map(({ course, parts }) => `<li style="--c:${course.color}">
      <i class="dot"></i><b>${esc(entryOf(course).name)}</b>
      ${parts.map((o) => `<span class="${o.liked ? "liked" : ""}" title="${esc([...new Set(o.groups.flatMap(teachersOf))].join(", "))}">${o.liked ? "★ " : ""}${esc(o.type)} ${o.groups.map((g) => esc(g.group)).join("/")}</span>`).join("")}
    </li>`).join("")}</ul>`;
  };
  const clashHTML = (r) => (r.clashes.length
    ? `<div class="gen-clash">${ICONS.warn}<span>${r.clashes.map(([a, b]) => `${esc(optName(a))} ↔ ${esc(optName(b))}`).join("<br>")}</span></div>` : "");
  const saveBtn = (r, i, big) => {
    const savedId = genSaved.get(resultSig(r));
    const saved = savedId && state.plans.some((p) => p.id === savedId);
    return `<button type="button" class="btn ${saved ? "ghost" : "primary"} gen-save ${big ? "big" : ""}" data-gen="${i}" ${saved ? "disabled" : ""}>
      ${saved ? "נשמרה כחלופה ✓" : big ? "שמירת ההמלצה כחלופה" : "שמירה כחלופה"}</button>`;
  };
  const picked = (r) => r.options.map((o) => ({ course: o.course, g: o.groups[0] }));
  const tagsHTML = (m) => `
    <span>${m.days.length} ימים <small>${m.days.map(DAY_LETTER).join(" ")}</small></span>
    <span>${m.gaps ? `${fmtHours(m.gaps)} ש' חלון` : "בלי חלונות"}</span>
    ${m.earliest != null ? `<span><bdi dir="ltr">${fmtMin(m.earliest)}–${fmtMin(m.latest)}</bdi></span>` : ""}`;

  // why the recommendation wins, in plain words
  const reasons = (m) => {
    const out = [];
    if (ticked.includes("days")) out.push(`${m.days.length} ימים בקמפוס בלבד (${m.days.map((d) => DAY_FULL[d]).join(", ")})`);
    const hrs = (h) => (h === 1 ? "שעה אחת" : `${fmtHours(h)} שעות`);
    if (ticked.includes("gaps")) out.push(m.gaps ? (m.gaps === 1 ? "רק שעת חלון אחת בשבוע" : `רק ${fmtHours(m.gaps)} שעות חלון בשבוע`) : "בלי אף חלון בין שיעורים");
    const comfort = `${prefs.comfortFrom}–${prefs.comfortTo}`;
    if (ticked.includes("comfort")) out.push(m.outside ? `רק ${hrs(m.outside)} מחוץ ל-${comfort}` : `הכל בין ${prefs.comfortFrom} ל-${prefs.comfortTo}`);
    if (m.endAvg) out.push(`מסיימים בממוצע ב-${fmtMin(Math.round(m.endAvg / 5) * 5)}`);
    return out;
  };
  // what is worse than the recommendation, criterion by criterion
  const deltas = (r) => {
    const out = [];
    for (const k of ticked) {
      const d = CRITERIA[k].val(r.m) - CRITERIA[k].val(best.m);
      if (Math.abs(d) < 0.01) continue;
      const amount = k === "days" ? `${Math.abs(d)} ${Math.abs(d) === 1 ? "יום" : "ימים"}` : `${fmtHours(Math.abs(d))} ש'${k === "gaps" ? " חלון" : " מחוץ לשעות"}`;
      out.push(`<span class="delta ${d > 0 ? "bad" : "good"}"><bdi dir="ltr">${d > 0 ? "+" : "−"}</bdi>${amount}</span>`);
    }
    if (r.clashes.length > best.clashes.length) out.push(`<span class="delta bad">+${r.clashes.length - best.clashes.length} התנגשות</span>`);
    const later = (r.m.endAvg - best.m.endAvg) / 60;
    if (Math.abs(later) >= 0.25) {
      out.push(`<span class="delta ${later > 0 ? "bad" : "good"}">מסיימים ${later > 0 ? "מאוחר" : "מוקדם"} יותר ב-${fmtHours(Math.round(Math.abs(later) * 4) / 4)} ש'</span>`);
    }
    return out.length ? out.join("") : `<span class="delta neutral">שקולה להמלצה</span>`;
  };

  const featured = `<article class="gen-featured ${best.clashes.length ? "has-clash" : ""}">
    <div class="gf-info">
      <span class="gf-badge">${best.clashes.length ? "הכי קרובה" : "ההמלצה"}</span>
      <h3>${best.clashes.length ? "הצירוף עם הכי מעט התנגשויות" : "המערכת הטובה ביותר לפי מה שסימנת"}</h3>
      <ul class="gf-reasons">${reasons(best.m).map((t) => `<li>${ICONS.check}<span>${esc(t)}</span></li>`).join("")}</ul>
      ${clashHTML(best)}
      ${partsHTML(best)}
      ${saveBtn(best, 0, true)}
    </div>
    <div class="gf-cal">${miniCalHTML(picked(best), frame)}</div>
  </article>`;

  const rest = shown.slice(1);
  out.innerHTML = `${banner}${summary ? `<p class="gen-summary">${summary}</p>` : ""}${featured}
  ${rest.length ? `<h3 class="gen-rest-title">חלופות נוספות <span class="muted">· מהטובה לפחות טובה, עם מה שפחות טוב בהן לעומת ההמלצה</span></h3>
  <div class="gen-grid">${rest.map((r, n) => {
    const i = n + 1;
    const dominated = r.dominatedBy >= 0 && r.dominatedBy < shown.length;
    return `<article class="gen-card ${r.clashes.length ? "has-clash" : ""} ${dominated ? "dominated" : ""}">
      <header>
        <span class="rank">${i + 1}</span>
        <div class="gen-tags">${tagsHTML(r.m)}</div>
      </header>
      <div class="gen-deltas">${deltas(r)}</div>
      ${dominated ? `<p class="gen-dominated">חלופה ${r.dominatedBy + 1} טובה ממנה בכל מה שסימנת</p>` : ""}
      ${clashHTML(r)}
      ${miniCalHTML(picked(r), frame)}
      ${partsHTML(r)}
      ${saveBtn(r, i, false)}
    </article>`;
  }).join("")}</div>` : ""}
  ${res.results.length > genShown ? `<button type="button" class="btn ghost gen-more" id="genMore">הצגת עוד תוצאות</button>` : ""}`;
  lastGen = res;
}
let lastGen = null;

// the preferences panel is sticky; when it's taller than the window, stick it by its bottom edge
// instead, so scrolling the page reveals all of it (an inner scrollbar would clip the ⓘ tooltips)
function fitGenPanel() {
  const panel = $("genForm");
  if (!panel.offsetParent) return;
  panel.style.top = `${Math.min(16, window.innerHeight - panel.offsetHeight - 16)}px`;
}

function saveGenerated(i) {
  const r = lastGen?.results[i];
  if (!r) return;
  checkpoint("שמירת חלופה אוטומטית");
  const m = r.m;
  const plan = {
    id: uid(), term: state.view, name: `אוטומטית ${i + 1}`,
    notes: `נוצרה בבנייה אוטומטית: ${m.days.length} ימים (${m.days.map(DAY_LETTER).join(" ")}), ${fmtHours(m.gaps)} שעות חלון.` +
      (r.options.some((o) => o.groups.length > 1) ? " יש קבוצות חלופיות באותה שעה – אפשר להחליף ביניהן בתצוגת 'איחוד קבוצות באותן שעות'." : ""),
    selected: new Set(r.options.map((o) => selKey(o.course, o.groups[0]))),
  };
  if (termPlans().some((p) => p.name === plan.name)) plan.name = nextPlanName();
  state.plans.push(plan);
  genSaved.set(resultSig(r), plan.id);
  save();
  renderGenerator();
  renderPlans();
  toast(`נשמרה החלופה "${plan.name}"`, "", { label: "להשוואה", run: () => { state.generating = false; state.comparing = true; render(); } });
}

/* ---------- calendar export (.ics) ---------- */

// rough BIU semester dates; the user confirms/edits them in the dialog
function defaultTermDates(term) {
  const { year, semester } = splitTerm(term);
  const y = Number(year);
  if (semester === "B") return { start: `${y}-03-08`, end: `${y}-06-19` };
  if (semester === "summer") return { start: `${y}-07-05`, end: `${y}-08-20` };
  return { start: `${y - 1}-10-25`, end: `${y}-01-22` };
}

const icsText = (s) => String(s ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
const icsDate = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const icsTime = (hhmm) => `${hhmm.replace(":", "")}00`;

// RFC 5545: lines longer than 75 octets are folded with CRLF + space
function icsFold(line) {
  const enc = new TextEncoder();
  const parts = [];
  let cur = "", bytes = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) { parts.push(cur); cur = ""; bytes = 0; limit = 74; }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

const ICS_TZ = [
  "BEGIN:VTIMEZONE", "TZID:Asia/Jerusalem",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0300", "TZNAME:IDT", "DTSTART:19700327T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0200", "TZNAME:IST", "DTSTART:19701025T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD", "END:VTIMEZONE",
];

function buildIcs({ start, end, exams, busy }) {
  const first = new Date(`${start}T00:00:00`), last = new Date(`${end}T00:00:00`);
  const until = `${icsDate(last)}T235959Z`;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const firstOn = (day) => { const d = new Date(first); d.setDate(d.getDate() + ((day - d.getDay() + 7) % 7)); return d; };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BIU course planner//HE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(`לימודים · ${termLabel(state.view)}`)}`, "X-WR-TIMEZONE:Asia/Jerusalem", ...ICS_TZ];
  const event = (uidPart, date, from, to, summary, location, description, rrule) => {
    lines.push("BEGIN:VEVENT", `UID:${uidPart}-${stamp}@biu-planner`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Asia/Jerusalem:${icsDate(date)}T${icsTime(from)}`, `DTEND;TZID=Asia/Jerusalem:${icsDate(date)}T${icsTime(to)}`,
      `SUMMARY:${icsText(summary)}`);
    if (rrule) lines.push(rrule);
    if (location) lines.push(`LOCATION:${icsText(location)}`);
    if (description) lines.push(`DESCRIPTION:${icsText(description)}`);
    lines.push("END:VEVENT");
  };
  let count = 0;
  for (const { course, g } of selectedGroups()) {
    const name = entryOf(course).name;
    timedSessions(g).forEach((s, i) => {
      const date = firstOn(s.day);
      if (date > last) return;
      const type = s.type || g.type;
      event(`${course.key}-${g.group}-${i}`, date, s.start, s.end, `${name} · ${type} ${g.group}`, fmtWhere(s),
        [`מרצה: ${s.teacher || g.teacher || "—"}`, `קורס ${course.code}, קבוצה ${g.group}`, s.location && `מיקום: ${s.location}`].filter(Boolean).join("\n"),
        `RRULE:FREQ=WEEKLY;UNTIL=${until}`);
      count++;
    });
  }
  if (busy) {
    for (const b of busyFor()) {
      event(`busy-${b.id}`, firstOn(b.day), b.start, b.end, b.label || "אילוץ", "", "אילוץ במערכת הקורסים", `RRULE:FREQ=WEEKLY;UNTIL=${until}`);
      count++;
    }
  }
  if (exams) {
    const seen = new Set();
    for (const { course, g } of selectedGroups()) {
      for (const e of g.exams || []) {
        const k = `${course.key}|${e.term}|${e.date}|${e.hour}`;
        if (seen.has(k) || !e.date) continue;
        seen.add(k);
        const d = parseDate(e.date);
        const from = /^\d{1,2}:\d{2}$/.test(e.hour || "") ? e.hour.padStart(5, "0") : "09:00";
        const to = fmtMin(Math.min(toMin(from) + 180, 23 * 60 + 59));
        event(`exam-${course.key}-${e.term}-${e.date}`.replace(/[^\w-]/g, ""), d, from, to, `מבחן · ${entryOf(course).name} · ${e.term}`, "",
          `קורס ${course.code}. משך המבחן משוער – כדאי לוודא מול הודעות הקורס.`);
        count++;
      }
    }
  }
  lines.push("END:VCALENDAR");
  return { text: lines.map(icsFold).join("\r\n") + "\r\n", count };
}

function openIcsDialog() {
  if (!selectedGroups().length) return toast(`לא נבחרו קבוצות ב${termLabel(state.view)} – אין מה לייצא עדיין.`, "error");
  const dates = state.termDates[state.view] || defaultTermDates(state.view);
  $("icsStart").value = dates.start;
  $("icsEnd").value = dates.end;
  $("icsBlocks").checked = busyFor().length > 0;
  $("icsBlocks").closest("label").hidden = !busyFor().length;
  $("icsIntro").textContent = `השיעורים של "${activePlan().name}" ב${termLabel(state.view)} יתווספו כאירועים שבועיים, עם המרצה והחדר.`;
  $("icsError").hidden = true;
  $("icsDialog").showModal();
}

function downloadIcs(e) {
  e.preventDefault();
  const start = $("icsStart").value, end = $("icsEnd").value;
  if (!start || !end || end <= start) {
    $("icsError").textContent = "תאריך הסיום צריך להיות אחרי תאריך ההתחלה.";
    $("icsError").hidden = false;
    return;
  }
  state.termDates[state.view] = { start, end };
  save();
  const { text, count } = buildIcs({ start, end, exams: $("icsExams").checked, busy: $("icsBlocks").checked });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
  link.download = pdfName("schedule").replace(/\.pdf$/, ".ics");
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  $("icsDialog").close();
  toast(`הקובץ נשמר: ${link.download} (${count} אירועים)`);
}

/* ---------- print sheet ---------- */

const pct = (v) => `${(v * 100).toFixed(3)}%`;
const fmtWhere = (s) => [s.building, s.room && `חדר ${s.room}`].filter(Boolean).join(" · ") || (s.location || "").replace(/^בניין /, "");
const parseDate = (d) => { const [dd, mm, yy] = (d || "").split("/").map(Number); return new Date(yy, mm - 1, dd); };

function printSheetHTML() {
  const sem = state.view;
  const picked = selectedGroups(sem);
  const year = splitTerm(sem).year;
  const byCourse = new Map();
  for (const p of picked) {
    if (!byCourse.has(p.course.key)) byCourse.set(p.course.key, { course: p.course, groups: [] });
    byCourse.get(p.course.key).groups.push(p.g);
  }

  // grid fitted to the chosen sessions, at least 8 hours tall
  const timed = picked.flatMap(({ course, g }) => timedSessions(g).map((s) => ({ course, g, s })));
  const busy = busyFor(sem);
  let minM = Math.min(...timed.map((x) => toMin(x.s.start)), ...busy.map((b) => toMin(b.start)), 10 * 60);
  let maxM = Math.max(...timed.map((x) => toMin(x.s.end)), ...busy.map((b) => toMin(b.end)), 16 * 60);
  minM = Math.floor(minM / 60) * 60; maxM = Math.ceil(maxM / 60) * 60;
  if (maxM - minM < 8 * 60) maxM = Math.min(23 * 60, minM + 8 * 60);
  const span = maxM - minM;
  const dayList = dayColumns([...timed.map((x) => x.s.day), ...busy.map((b) => b.day)], false);
  const days = dayList.length;

  const byDay = new Map(dayList.map((d) => [d, []]));
  for (const x of timed) {
    byDay.get(x.s.day)?.push({ ...x, name: entryOf(x.course).name, start: toMin(x.s.start), end: toMin(x.s.end) });
  }

  let hours = "", bands = "";
  for (let m = minM; m < maxM; m += 60) {
    const top = pct((m - minM) / span), h = pct(60 / span);
    hours += `<div class="ps-hour" style="top:${top}">${String(m / 60).padStart(2, "0")}:00</div>`;
    bands += `<div class="ps-band ${((m - minM) / 60) % 2 ? "alt" : ""}" style="top:${top};height:${h}"></div>`;
  }

  const cols = [...byDay.entries()].map(([day, events]) => {
    layoutLanes(events);
    const busyHtml = busy.filter((b) => b.day === day).map((b) =>
      `<div class="ps-busy" style="top:${pct((toMin(b.start) - minM) / span)};height:${pct((toMin(b.end) - toMin(b.start)) / span)}">
        <b>${esc(b.label || "אילוץ")}</b><span><bdi dir="ltr">${esc(b.start)}–${esc(b.end)}</bdi></span></div>`).join("");
    return `<div class="ps-col">${bands}${busyHtml}${events.map((ev) => {
      const w = 100 / ev.lanes;
      const mins = ev.end - ev.start;
      const type = ev.s.type || ev.g.type;
      return `<div class="ps-ev ${mins <= 75 ? "short" : ""}" style="--c:${ev.course.color};top:${pct((ev.start - minM) / span)};height:${pct(mins / span)};inset-inline-start:${pct(ev.lane * w / 100)};width:${pct(w / 100)}">
        <div class="ps-ev-in">
          <b>${esc(ev.name)}</b>
          <span class="ps-tag">${esc(type)} ${esc(ev.g.group)}</span>
          <span class="ps-time"><bdi dir="ltr">${esc(ev.s.start)}–${esc(ev.s.end)}</bdi></span>
          <span>${esc(ev.s.teacher || ev.g.teacher)}</span>
          <span>${esc(fmtWhere(ev.s))}</span>
        </div>
      </div>`;
    }).join("")}</div>`;
  }).join("");

  const totalCredits = picked.reduce((sum, { g }) => sum + credits(g), 0);
  const weekly = timed.reduce((sum, x) => sum + toMin(x.s.end) - toMin(x.s.start), 0) / 60;
  const activeDays = new Set(timed.map((x) => x.s.day)).size;
  const title = termLabel(sem);
  const today = new Date().toLocaleDateString("he-IL");

  const legend = [...byCourse.values()].map(({ course, groups }) => {
    const cr = groups.reduce((s, g) => s + credits(g), 0);
    return `<div class="ps-leg" style="--c:${course.color}"><i></i><b>${esc(entryOf(course).name)}</b><span>${esc(course.code)}${cr ? ` · ${cr} נ"ז` : ""}</span></div>`;
  }).join("");

  const rows = [...byCourse.values()].map(({ course, groups }) => groups.map((g, i) => {
    const sessions = g.sessions.length ? g.sessions : [{}];
    return `<tr style="--c:${course.color}" class="${i === 0 ? "first" : ""}">
      ${i === 0 ? `<td class="ps-course" rowspan="${groups.length}"><b>${esc(entryOf(course).name)}</b><span>${esc(course.code)}</span></td>` : ""}
      <td><span class="ps-pill">${esc(g.type)}</span></td>
      <td class="ps-num">${esc(g.group)}</td>
      <td>${esc(g.teacher)}</td>
      <td>${sessions.map((s) => s.start ? `<div>יום ${esc(s.dayLabel)}' · <bdi dir="ltr">${esc(s.start)}–${esc(s.end)}</bdi></div>` : "<div>לא נקבע</div>").join("")}</td>
      <td>${sessions.map((s) => `<div>${esc(fmtWhere(s)) || "—"}</div>`).join("")}</td>
      <td class="ps-num">${credits(g) || "—"}</td>
    </tr>`;
  }).join("")).join("");

  const exams = [...byCourse.values()].flatMap(({ course, groups }) => {
    const src = groups.find((g) => g.exams?.length) || groupsFor(course).find((g) => g.exams?.length);
    return (src?.exams || []).map((e) => ({ course, ...e }));
  }).sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const examRows = exams.map((e) => `<tr style="--c:${e.course.color}">
    <td class="ps-date"><bdi dir="ltr">${esc(e.date)}</bdi></td>
    <td>${esc(DAY_FULL[parseDate(e.date).getDay()] || "")}</td>
    <td class="ps-num">${esc(e.hour)}</td>
    <td><i class="ps-dot"></i>${esc(entryOf(e.course).name)}</td>
    <td>${esc(e.term)}</td>
  </tr>`).join("");

  const header = (sub) => `<header class="ps-header">
      <div>
        <div class="ps-kicker">${esc(activePlan().name)} · מערכת השעות שלי · אוניברסיטת בר אילן</div>
        <h1>${esc(title)}</h1>
        ${sub ? `<p>${sub}</p>` : ""}
      </div>
      <div class="ps-stats">
        <div><b>${byCourse.size}</b><span>קורסים</span></div>
        <div><b>${weekly}</b><span>שעות בשבוע</span></div>
        <div><b>${activeDays}</b><span>ימי לימוד</span></div>
        ${totalCredits ? `<div><b>${totalCredits}</b><span>נקודות זכות</span></div>` : ""}
      </div>
    </header>`;
  const footer = `<footer class="ps-footer"><span>הופק ב-${today}</span><span>מקור הנתונים: courses.biu.ac.il · שיבוץ החדרים אינו סופי</span></footer>`;

  return `
    <section class="ps-page">
      ${header("")}
      <div class="ps-cal" style="--days:${days}">
        <div class="ps-corner"></div>
        ${dayList.map((d) => `<div class="ps-dayhead">${DAY_FULL[d]}</div>`).join("")}
        <div class="ps-hours">${hours}</div>
        ${cols}
      </div>
      <div class="ps-legend">${legend}</div>
      ${footer}
    </section>
    <section class="ps-page ps-flow">
      ${header("פירוט הקבוצות ומועדי הבחינות")}
      <h2>הקבוצות שבחרתי</h2>
      <table class="ps-table">
        <thead><tr><th>קורס</th><th>סוג</th><th>קבוצה</th><th>מרצה</th><th>מועד</th><th>מיקום</th><th>נ"ז</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${exams.length ? `<h2>מועדי בחינות</h2>
      <table class="ps-table ps-exams">
        <thead><tr><th>תאריך</th><th>יום</th><th>שעה</th><th>קורס</th><th>מועד</th></tr></thead>
        <tbody>${examRows}</tbody>
      </table>` : ""}
      ${activePlan().notes ? `<h2>הערות</h2><div class="ps-notes">${esc(activePlan().notes)}</div>` : ""}
      ${footer}
    </section>`;
}

function catalogHTML() {
  const sem = state.view;
  const plan = activePlan();
  const courses = visibleCourses().filter(entryOf);
  const all = courses.flatMap((c) => groupsFor(c).map((g) => ({ c, g })));
  const nPicked = all.filter(({ c, g }) => plan.selected.has(selKey(c, g))).length;
  const today = new Date().toLocaleDateString("he-IL");

  const body = courses.map((course) => {
    const entry = entryOf(course);
    const lecture = groupsFor(course).find((g) => plan.selected.has(selKey(course, g)) && g.exams?.length)
      || groupsFor(course).find((g) => g.exams?.length);
    const sections = sectionsFor(course).map(([type, gs]) => `
      <h3>${esc(SECTION_NAMES[type] || type)} <span>${gs.length} קבוצות</span></h3>
      <table class="pc-table">
        <thead><tr><th class="pc-mark"></th><th>קבוצה</th><th>מרצה</th><th>יום</th><th>שעות</th><th>מיקום</th><th>נ"ז</th></tr></thead>
        <tbody>${gs.map((g) => {
          const key = selKey(course, g);
          const picked = plan.selected.has(key), rejected = state.rejected.has(key);
          const sessions = g.sessions.length ? g.sessions : [{}];
          const lines = (fn) => sessions.map((s) => `<div>${fn(s) || "—"}</div>`).join("");
          return `<tr class="${picked ? "picked" : ""} ${rejected ? "rejected" : ""}">
            <td class="pc-mark">${picked ? '<span class="pc-yes">✓ נבחרה</span>' : rejected ? '<span class="pc-no">נפסלה</span>' : ""}</td>
            <td class="pc-num">${esc(g.group)}</td>
            <td>${esc(g.teacher) || "—"}</td>
            <td>${lines((s) => s.dayLabel && `${esc(DAY_FULL[s.day] || s.dayLabel)}`)}</td>
            <td>${lines((s) => range(s))}</td>
            <td>${lines((s) => esc(fmtWhere(s)))}</td>
            <td class="pc-num">${credits(g) || "—"}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`).join("");
    const cr = courseCredits(course);
    return `<section class="pc-course" style="--c:${course.color}">
      <header class="pc-head">
        <div>
          <h2>${esc(entry.name)}</h2>
          <p>${esc(course.code)}${cr ? ` · ${cr} נ"ז` : ""}${entry.englishName ? ` · <bdi>${esc(entry.englishName)}</bdi>` : ""}</p>
        </div>
        ${lecture ? `<div class="pc-exams">${lecture.exams.map((e) => `<span><b>${esc(e.term)}</b> <bdi dir="ltr">${esc(e.date)}</bdi> ${esc(e.hour)}</span>`).join("")}</div>` : ""}
      </header>
      ${sections}
    </section>`;
  }).join("");

  return `<section class="pc-sheet"><table class="pc-frame">
    <thead><tr><td><div class="pc-gap-top"></div></td></tr></thead>
    <tfoot><tr><td><div class="pc-gap-bottom"></div></td></tr></tfoot>
    <tbody><tr><td>
    <header class="ps-header">
      <div>
        <div class="ps-kicker">קטלוג קבוצות · ${esc(plan.name)} · אוניברסיטת בר אילן</div>
        <h1>${esc(termLabel(sem))}</h1>
        <p>כל הקבוצות של כל הקורסים. קבוצות שנבחרו ב"${esc(plan.name)}" מודגשות ומסומנות ב-✓.</p>
      </div>
      <div class="ps-stats">
        <div><b>${courses.length}</b><span>קורסים</span></div>
        <div><b>${all.length}</b><span>קבוצות</span></div>
        <div><b>${nPicked}</b><span>נבחרו</span></div>
      </div>
    </header>
    ${body}
    <footer class="ps-footer"><span>הופק ב-${today}</span><span>מקור הנתונים: courses.biu.ac.il · שיבוץ החדרים אינו סופי</span></footer>
    </td></tr></tbody>
  </table></section>`;
}

let printKind = null;
function preparePrint() {
  const kind = printKind || "schedule";
  const empty = (msg) => `<section class="ps-page"><p class="ps-empty">${msg}</p></section>`;
  if (kind === "catalog") {
    $("printSheet").innerHTML = visibleCourses().some(entryOf) ? catalogHTML() : empty("אין קורסים להדפסה עדיין.");
  } else {
    $("printSheet").innerHTML = selectedGroups(state.view).length
      ? printSheetHTML()
      : empty(`לא נבחרו קבוצות ב${termLabel(state.view)} – אין מה להדפיס עדיין.`);
  }
}

let toastTimer;
function toast(msg, kind = "", action = null) {
  const el = $("toast");
  el.className = `toast ${kind}`;
  el.innerHTML = (kind === "busy" ? '<span class="spinner"></span>' : kind === "warn" ? ICONS.warn : "") +
    `<span>${esc(msg)}</span>` +
    (action ? `<button type="button" class="toast-action">${esc(action.label)}</button>` : "") +
    (kind !== "busy" ? `<button type="button" class="toast-close" aria-label="סגירה">${ICONS.x}</button>` : "");
  el.hidden = false;
  el.querySelector(".toast-action")?.addEventListener("click", () => { el.hidden = true; action.run(); });
  el.querySelector(".toast-close")?.addEventListener("click", () => { el.hidden = true; });
  clearTimeout(toastTimer);
  if (kind !== "busy") toastTimer = setTimeout(() => { el.hidden = true; }, action ? 9000 : kind === "error" ? 6000 : 3500);
}

function pdfName(kind) {
  const when = termLabel(state.view).replace(" · ", " ");
  const name = kind === "catalog" ? `קטלוג קבוצות - ${when}` : `${activePlan().name} - ${when}`;
  return name.replace(/[\\/:*?"<>|]/g, "").trim() + ".pdf";
}

/* ---------- PDF made in the browser (view-only copy: no server) ---------- */

// loaded only when someone exports; html2canvas draws the sheet, jsPDF assembles the file
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = () => { el.remove(); reject(new Error("load failed")); };
    document.head.appendChild(el);
  });
}

// html2canvas 1.4 cannot parse color(srgb r g b / a), which is what color-mix() computes to:
// rewrite those colors as rgba() on every element of the copy it draws from
const COLOR_PROPS = ["color", "background-color", "background-image", "border-top-color", "border-right-color",
  "border-bottom-color", "border-left-color", "box-shadow", "outline-color", "text-decoration-color"];
function flattenColors(doc) {
  const toRgba = (v) => v.replace(/color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+))?\)/g,
    (_, r, g, b, a) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`);
  for (const el of doc.querySelectorAll(".pdf-stage, .pdf-stage *")) {
    const cs = doc.defaultView.getComputedStyle(el);
    for (const prop of COLOR_PROPS) {
      const v = cs.getPropertyValue(prop);
      if (v.includes("color(")) el.style.setProperty(prop, toRgba(v), "important");
    }
  }
}

// opens the browser's print dialog with the designed sheet (it can save as PDF)
function printAs(kind) {
  printKind = kind;
  preparePrint();
  window.print();
  printKind = null;
}

// The print rules (@media print in style.css), re-scoped to a ".pdf-stage" box so the
// designed sheet can be laid out on screen for html2canvas.
function stageCss() {
  const out = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if (!(rule instanceof CSSMediaRule) || !/\bprint\b/.test(rule.media.mediaText)) continue;
      for (const r of rule.cssRules) {
        if (!(r instanceof CSSStyleRule)) continue;
        const sel = r.selectorText.split(",").map((x) => x.trim())
          .filter((x) => !/^(html|body)\b/.test(x))          // page-level rules (hide everything else, white page)
          .map((x) => `.pdf-stage ${x}`).join(", ");
        if (sel) out.push(`${sel} { ${r.style.cssText} }`);
      }
    }
  }
  return out.join("\n");
}

// Lays the print sheet out in an A4-wide box pinned to the top of the viewport (behind a
// "preparing" overlay) and photographs it slice by slice. Works on iPhone / iPad, where the
// browser's print dialog is unreliable. html2canvas only measures this reliably when the box
// sits at the viewport's top-left, so the page is scrolled to the top meanwhile and restored after.
async function exportPdfInBrowser(kind) {
  printKind = kind;
  preparePrint();
  printKind = null;
  const overlay = document.createElement("div");
  overlay.className = "pdf-busy";
  overlay.innerHTML = '<span class="spinner"></span><span>מכין את קובץ ה-PDF…</span>';
  document.body.appendChild(overlay);
  const scrollBack = window.scrollY;
  let stage;
  try {
    await Promise.all(PDF_LIBS.map(loadScript));
    const portrait = kind === "catalog";
    const W = portrait ? 794 : 1123, H = portrait ? 1123 : 794; // A4 at 96 px per inch
    const MARGIN = 38;                                            // ~10mm
    if (!$("pdfStageCss")) {
      const st = document.createElement("style");
      st.id = "pdfStageCss";
      st.textContent = stageCss() + `
        .pdf-stage { position: fixed; top: 0; left: 0; z-index: -1; pointer-events: none; background: #fff; direction: rtl; }
        .pdf-stage .print-sheet { display: block; }
        .pdf-stage .ps-page { box-sizing: border-box; }
        .pdf-stage .pc-gap-top, .pdf-stage .pc-gap-bottom { height: 8px; }`;
      document.head.appendChild(st);
    }
    stage = document.createElement("div");
    stage.className = "pdf-stage";
    stage.setAttribute("aria-hidden", "true");
    stage.style.width = `${W}px`;
    stage.innerHTML = `<div class="print-sheet">${$("printSheet").innerHTML}</div>`;
    stage.querySelectorAll(".ps-page").forEach((el) => {
      el.style.padding = el.classList.contains("ps-flow") ? `0 ${MARGIN}px` : `34px ${MARGIN}px`;
      if (!el.classList.contains("ps-flow")) el.style.height = `${H}px`;
    });
    stage.querySelectorAll(".pc-sheet").forEach((el) => { el.style.padding = `0 ${MARGIN + 4}px`; });
    document.body.appendChild(stage);
    window.scrollTo({ top: 0, behavior: "instant" });
    await document.fonts.ready;

    const total = Math.ceil(stage.getBoundingClientRect().height);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: portrait ? "portrait" : "landscape", unit: "mm", format: "a4", compress: true });
    const mmW = portrait ? 210 : 297, mm = mmW / W;
    // one horizontal slice of the stage, in stage coordinates
    const shot = (y, h) => window.html2canvas(stage, {
      scale: 2, backgroundColor: "#ffffff", logging: false, onclone: flattenColors,
      x: 0, y, width: W, height: h, windowWidth: W, windowHeight: total,
    });
    const add = (canvas, top, h, first) => {
      if (!first) pdf.addPage();
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, top * mm, mmW, h * mm);
    };
    const top0 = stage.getBoundingClientRect().top;
    const at = (el) => Math.round(el.getBoundingClientRect().top - top0);

    // flowing content is cut into pages between rows / headings, never through one
    let first = true;
    const flow = async (from, to, cutSel) => {
      const avail = H - 2 * MARGIN;
      const cuts = [...stage.querySelectorAll(cutSel)].map(at).filter((c) => c > from && c < to).sort((a, b) => a - b);
      let y = from;
      while (y < to - 2) {
        let next = Math.min(to, y + avail);
        if (next < to) {
          const fit = cuts.filter((c) => c > y + 40 && c <= y + avail);
          if (fit.length) next = fit[fit.length - 1];
        }
        add(await shot(y, next - y), MARGIN, next - y, first);
        first = false;
        y = next;
      }
    };
    if (!portrait) {
      // timetable: the calendar is one fixed page; the details page may run over several
      for (const page of stage.querySelectorAll(".ps-page")) {
        const top = at(page);
        if (page.classList.contains("ps-flow")) await flow(top, top + page.offsetHeight, ".ps-flow h2, .ps-flow tbody tr, .ps-flow .ps-notes, .ps-flow .ps-footer");
        else { add(await shot(top, H), 0, H, first); first = false; }
      }
    } else {
      await flow(0, total, ".pc-course, .pc-course h3, .pc-table tbody tr:not(:first-child), .ps-footer");
    }
    const name = pdfName(kind);
    pdf.save(name);
    toast(`הקובץ נשמר: ${name}`);
  } catch (e) {
    console.warn("in-browser PDF export failed:", e);
    // no internet for the libraries (or a very old browser): fall back to the print dialog
    toast("לא הצלחתי ליצור קובץ PDF כאן – נפתח חלון ההדפסה, ומשם אפשר לשמור כ-PDF.", "warn");
    stage?.remove();
    stage = null;
    printAs(kind);
  } finally {
    stage?.remove();
    overlay.remove();
    window.scrollTo({ top: scrollBack, behavior: "instant" });
  }
}

// a real PDF file rendered by the server - no browser print header/footer
async function exportPdf(kind) {
  printKind = kind;
  preparePrint();
  printKind = null;
  toast("מכין את קובץ ה-PDF…", "busy");
  try {
    // the server renders this outside our origin, so point the bundled fonts at absolute URLs
    const css = (await (await fetch("style.css")).text()).replaceAll("url(fonts/", `url(${location.origin}/fonts/`);
    const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
      <style>${css}</style></head><body>${$("printSheet").outerHTML}</body></html>`;
    const res = await fetch("/api/pdf", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html }) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "יצירת ה-PDF נכשלה");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await res.blob());
    link.download = pdfName(kind);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast(`הקובץ נשמר: ${link.download}`);
  } catch (e) {
    toast(e.message, "error");
  }
}

function render() {
  renderToolbar();
  const mode = state.generating ? "generate" : state.comparing ? "compare" : "build";
  $("compare").hidden = mode !== "compare";
  $("generator").hidden = mode !== "generate";
  $("buildView").hidden = mode !== "build";
  $("addForm").hidden = mode !== "build" || state.offline;
  if (mode === "compare") renderCompare();
  else if (mode === "generate") renderGenerator();
  else {
    renderCourses();
    renderPlanner();
  }
  renderPlans();
  save();
}

/* ---------- actions ---------- */

async function loadCourse(course, refresh = false) {
  state.loading.add(course.key);
  delete state.errors[course.key];
  render();
  try {
    await fetchCourse(course.code, course.year, refresh);
  } catch (e) {
    state.errors[course.key] = e.message;
  }
  state.loading.delete(course.key);
  render();
}

function nextColor() {
  const used = new Set(state.courses.map((c) => c.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[state.courses.length % COLORS.length];
}

function setLookup(kind, html) {
  const el = $("lookup");
  el.className = `lookup ${kind}`;
  el.innerHTML = html;
}
const idleLookup = () => setLookup("", "מקלידים מספר קורס (ללא קוד קבוצה) – השם יושלם אוטומטית.");

// the add button only works once the course was actually fetched from BIU for this year + semester
let lookupReady = null; // "<code>|<year>|<semester>" of the last successful lookup
const formKey = () => `${$("codeInput").value.replace(/\D/g, "")}|${$("yearInput").value}|${$("semesterInput").value}`;
function setAddReady(ready) {
  lookupReady = ready ? formKey() : null;
  $("addBtn").disabled = !ready;
  $("addBtn").title = ready ? "" : "ההוספה תתאפשר אחרי שהקורס יימצא באתר בר אילן";
}

function addCourse(e) {
  e.preventDefault();
  const code = $("codeInput").value.replace(/\D/g, "");
  const year = $("yearInput").value, semester = $("semesterInput").value;
  if (!code || lookupReady !== formKey()) return; // not fetched (yet) - the button is disabled too
  const key = `${year}:${code}:${semester}`;
  if (state.courses.some((c) => c.key === key)) {
    setLookup("error", `הקורס הזה כבר נמצא ב${termLabel(termKey(year, semester))}.`);
    return;
  }
  const entry = state.data[`${year}:${code}`];
  checkpoint(`הוספת ${entry.name}`);
  state.courses.push({ key, code, year, semester, color: nextColor() });
  state.view = termKey(year, semester);
  $("codeInput").value = "";
  setAddReady(false);
  setLookup("found", `נוסף ל${termLabel(state.view)}: ${esc(entry.name)}`);
  setTimeout(() => { if ($("lookup").classList.contains("found") && !$("codeInput").value) idleLookup(); }, 2500);
  render();
  $("codeInput").focus();
}

function removeCourse(key) {
  const course = state.courses.find((c) => c.key === key);
  if (!course) return;
  checkpoint(`הסרת ${entryOf(course)?.name || course.code}`);
  state.courses = state.courses.filter((c) => c.key !== key);
  state.collapsed.delete(key);
  delete state.filters[key];
  for (const set of [state.rejected, ...state.plans.map((p) => p.selected)]) {
    for (const k of [...set]) if (k.startsWith(key + "|")) set.delete(k);
  }
  render();
  undoToast(`הקורס "${entryOf(course)?.name || course.code}" הוסר`);
}

function toggleCollapse(key, force) {
  const collapse = force ?? !state.collapsed.has(key);
  collapse ? state.collapsed.add(key) : state.collapsed.delete(key);
  const el = document.querySelector(`.course[data-course="${CSS.escape(key)}"]`);
  if (el) {
    el.classList.toggle("collapsed", collapse);
    el.querySelector(".course-head").setAttribute("aria-expanded", String(!collapse));
  }
  renderToolbar();
  save();
}

function focusCourse(key) {
  for (const k of cardKeys()) toggleCollapse(k, k !== key);
  document.querySelector(`.course[data-course="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function revealGroup(key) {
  const row = [...document.querySelectorAll(".grp")].find((r) => r.dataset.keys.split(",").includes(key));
  if (!row) return;
  const card = row.closest(".course").dataset.course;
  if (state.collapsed.has(card)) toggleCollapse(card, false);
  setTimeout(() => {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }, 120);
}

let lookupTimer, lookupSeq = 0;
function scheduleLookup() {
  clearTimeout(lookupTimer);
  setAddReady(false);
  const code = $("codeInput").value.replace(/\D/g, ""), year = $("yearInput").value;
  if (code.length < 4) return idleLookup();
  const seq = ++lookupSeq;
  setLookup("", `<span class="spinner"></span>מחפש את ${esc(code)} באתר בר אילן (${esc(yearLabel(year))})… ההוספה תתאפשר כשהקורס יימצא`);
  lookupTimer = setTimeout(async () => {
    try {
      const entry = await fetchCourse(code, year);
      if (seq !== lookupSeq) return;
      const sem = $("semesterInput").value;
      const n = groupsFor({ code, year, semester: sem }).length;
      setLookup(n ? "found" : "error", n
        ? `${esc(entry.name)} <span class="sub">· ${n} קבוצות ב${esc(termLabel(termKey(year, sem)))} · Enter להוספה</span>`
        : `${esc(entry.name)} – אין קבוצות ב${esc(termLabel(termKey(year, sem)))}`);
      setAddReady(n > 0);
    } catch (e) {
      if (seq === lookupSeq) setLookup("error", esc(e.message));
    }
  }, 600);
}

/* ---------- init ---------- */

function init() {
  idleLookup();
  setAddReady(false);

  $("addForm").addEventListener("submit", addCourse);
  $("codeInput").addEventListener("input", scheduleLookup);
  // the add form's year/semester are the active term: changing them switches the whole view
  const formTerm = () => setTerm(termKey($("yearInput").value, $("semesterInput").value));
  $("yearInput").addEventListener("change", formTerm);
  $("semesterInput").addEventListener("change", formTerm);
  $("termYear").addEventListener("change", (e) => setTerm(termKey(e.target.value, splitTerm(state.view).semester)));
  $("termSem").addEventListener("click", (e) => {
    const sem = e.target.closest("[data-sem]")?.dataset.sem;
    if (sem) setTerm(termKey(splitTerm(state.view).year, sem));
  });

  $("onlySelected").addEventListener("change", (e) => { state.onlySelected = e.target.checked; render(); });
  $("hideConflicts").addEventListener("change", (e) => { state.hideConflicts = e.target.checked; render(); });
  $("mergeSlots").addEventListener("change", (e) => { state.merge = e.target.checked; render(); });
  $("hideEmptyDays").checked = state.hideEmptyDays;
  $("hideEmptyDays").addEventListener("change", (e) => { state.hideEmptyDays = e.target.checked; render(); });
  $("toggleAll").addEventListener("click", () => {
    const keys = cardKeys();
    const collapse = !keys.every((k) => state.collapsed.has(k));
    for (const k of keys) toggleCollapse(k, collapse);
  });
  $("groupByTabs").addEventListener("click", (e) => {
    const mode = e.target.closest("[data-groupby]")?.dataset.groupby;
    if (mode && mode !== state.groupBy) { state.groupBy = mode; render(); }
  });

  const list = $("courseList");
  list.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-term]");
    if (jump) return setTerm(jump.dataset.term);
    const tryBtn = e.target.closest("[data-try]");
    if (tryBtn) { $("codeInput").value = tryBtn.dataset.try; $("codeInput").focus(); return scheduleLookup(); }
    const courseKey = e.target.closest(".course")?.dataset.course;
    const flag = e.target.closest("[data-clash]");
    if (flag) return toast(flag.dataset.clash, "warn");
    const rej = e.target.closest("[data-reject]");
    if (rej) return toggleReject(rej.dataset.reject.split(","));
    const chip = e.target.closest("[data-pick]");
    if (chip) return pickInSlot(chip.dataset.pick, chip.closest(".grp").dataset.keys.split(","));
    const day = e.target.closest("[data-day]");
    if (day) {
      const days = new Set(filterOf({ key: courseKey }).days || []);
      const d = Number(day.dataset.day);
      days.has(d) ? days.delete(d) : days.add(d);
      return setFilter(courseKey, { days: [...days] });
    }
    if (e.target.closest("[data-act=togglef]")) {
      openFilters.has(courseKey) ? openFilters.delete(courseKey) : openFilters.add(courseKey);
      return renderCourses();
    }
    if (e.target.closest(".fbar")) {
      if (e.target.closest("[data-act=clearf]")) { checkpoint("ניקוי סינון"); delete state.filters[courseKey]; render(); }
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    const row = e.target.closest(".grp");
    if (row) return toggleUnit(row.dataset.keys.split(","));
    if (!courseKey || !act) return;
    if (act === "toggle") return toggleCollapse(courseKey);
    if (act === "focus") return focusCourse(courseKey);
    if (act === "refresh") return loadCourse(state.courses.find((c) => c.key === courseKey), true);
    if (act === "remove") return removeCourse(courseKey);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".grp");
    if (row && e.target === row) { e.preventDefault(); return toggleUnit(row.dataset.keys.split(",")); }
    if (e.target.classList.contains("course-head")) { e.preventDefault(); toggleCollapse(e.target.closest(".course").dataset.course); }
  });
  list.addEventListener("change", (e) => {
    const field = e.target.dataset.f;
    if (field) setFilter(e.target.closest(".course").dataset.course, { [field]: e.target.value });
  });
  // hovering a group previews it in the planner
  const canHover = window.matchMedia("(hover: hover)");
  const setPreview = (key) => {
    if (!canHover.matches) key = null; // touch screens: a tap must not leave a preview behind
    if (state.preview !== key) { state.preview = key; renderPlanner(); }
  };
  const previewKey = (e) => e.target.closest(".grp:not(.rejected)")?.dataset.key || null;
  list.addEventListener("mouseover", (e) => setPreview(previewKey(e)));
  list.addEventListener("mouseleave", () => setPreview(null));
  list.addEventListener("focusin", (e) => setPreview(previewKey(e)));

  /* plans */
  $("planTabs").addEventListener("click", (e) => {
    const del = e.target.closest("[data-delplan]")?.dataset.delplan;
    if (del) return deletePlan(del);
    const id = e.target.closest("[data-plan]")?.dataset.plan;
    if (id) switchPlan(id);
  });
  $("planTabs").addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-plan]")) startRename();
  });
  const menu = $("newPlan").querySelector(".menu");
  const setMenu = (open) => { menu.hidden = !open; $("newPlanBtn").setAttribute("aria-expanded", String(open)); };
  $("newPlanBtn").addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  document.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-new]")?.dataset.new;
    setMenu(false);
    if (kind) createPlan(kind);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
  $("compareBtn").addEventListener("click", () => {
    state.comparing = !state.comparing;
    state.generating = false;
    state.preview = null;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("generateBtn").addEventListener("click", () => {
    state.generating = !state.generating;
    state.comparing = false;
    state.preview = null;
    genShown = 12;
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* automatic builder */
  const genPref = (patch) => { Object.assign(state.genPrefs, patch); genShown = 12; save(); renderGenerator(); };
  $("genForm").addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "criteria") {
      const ticked = [...$("genForm").querySelectorAll("[name=criteria]:checked")].map((c) => c.value);
      if (!ticked.length) { t.checked = true; return toast("צריך לסמן לפחות שיקול אחד"); }
      genPref({ criteria: ticked });
    }
    else if (t.id === "genComfortFrom") genPref({ comfortFrom: t.value });
    else if (t.id === "genComfortTo") genPref({ comfortTo: t.value });
    else if (t.id === "genNotBefore") genPref({ notBefore: t.value });
    else if (t.id === "genNotAfter") genPref({ notAfter: t.value });
    else if (t.id === "genUseBlocks") genPref({ useBlocks: t.checked });
    else if (t.id === "genUseFilters") genPref({ useFilters: t.checked });
    else if (t.id === "genKeep") genPref({ keep: t.checked });
    else if (t.id === "genSkipNoTeacher") genPref({ skipNoTeacher: t.checked });
    else if (t.id === "genLecturesFirst") genPref({ lecturesFirst: t.checked });
    else if (t.id === "genTeacherAdd" && t.value) genPref({ teachers: [...state.genPrefs.teachers, t.value] });
    else if (t.id === "genAvoidAdd" && t.value) genPref({ avoidTeachers: [...state.genPrefs.avoidTeachers, t.value] });
  });
  $("genForm").addEventListener("click", (e) => {
    const morning = e.target.closest("[data-morning]")?.dataset.morning;
    if (morning) {
      const set = new Set(state.genPrefs.morningCourses);
      set.has(morning) ? set.delete(morning) : set.add(morning);
      return genPref({ morningCourses: [...set] });
    }
    const drop = e.target.closest("[data-unteacher]")?.dataset.unteacher;
    if (drop) return genPref({ teachers: state.genPrefs.teachers.filter((t) => t !== drop) });
    const unavoid = e.target.closest("[data-unavoid]")?.dataset.unavoid;
    if (unavoid) genPref({ avoidTeachers: state.genPrefs.avoidTeachers.filter((t) => t !== unavoid) });
  });
  $("genPrefsToggle").addEventListener("click", () => {
    const open = $("genForm").classList.toggle("open");
    $("genPrefsToggle").setAttribute("aria-expanded", String(open));
    fitGenPanel();
  });
  $("genFreeDays").addEventListener("click", (e) => {
    const d = e.target.closest("[data-freeday]");
    if (!d) return;
    const days = new Set(state.genPrefs.freeDays);
    const n = Number(d.dataset.freeday);
    days.has(n) ? days.delete(n) : days.add(n);
    genPref({ freeDays: [...days].sort() });
  });
  $("genResults").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gen]");
    if (btn) return saveGenerated(Number(btn.dataset.gen));
    if (e.target.closest("#genMore")) { genShown += 12; renderGenerator(); }
  });

  /* blocked times */
  $("addBlockBtn").addEventListener("click", () => openBusyDialog(null));
  $("blockForm").addEventListener("submit", saveBusy);
  $("blkDelete").addEventListener("click", () => { $("blockDialog").close(); removeBusy(editingBusy); });
  document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  initBusyDrag();
  initMobileDays();
  window.addEventListener("resize", fitGenPanel);

  /* undo / redo: Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z (by key position, so it works in a Hebrew layout too) */
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const typing = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]");
    if (typing || document.querySelector("dialog[open]")) return;
    if (e.code === "KeyZ" && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) { e.preventDefault(); redo(); }
  });

  /* calendar export */
  $("icsForm").addEventListener("submit", downloadIcs);
  $("renamePlanBtn").addEventListener("click", startRename);
  $("planNameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") finishRename(true);
    if (e.key === "Escape") finishRename(false);
  });
  $("planNameInput").addEventListener("blur", () => finishRename(true));
  $("planNotes").addEventListener("input", (e) => { activePlan().notes = e.target.value; save(); });
  $("planNotes").addEventListener("change", renderPlans);

  /* compare view */
  $("cmpBase").addEventListener("change", (e) => { state.cmpBase = e.target.value; render(); });
  $("cmpShowSame").addEventListener("change", (e) => { state.cmpShowSame = e.target.checked; render(); });
  $("cmpCards").addEventListener("click", (e) => {
    const id = e.target.closest("[data-open]")?.dataset.open;
    if (id) { switchPlan(id); window.scrollTo({ top: 0, behavior: "smooth" }); }
  });
  $("cmpCards").addEventListener("input", (e) => {
    const plan = state.plans.find((p) => p.id === e.target.dataset.notes);
    if (plan) { plan.notes = e.target.value; save(); }
  });
  $("cmpCards").addEventListener("change", (e) => { if (e.target.dataset.notes) renderPlans(); });

  const printMenu = $("printMenu").querySelector(".menu");
  const setPrintMenu = (open) => { printMenu.hidden = !open; $("printBtn").setAttribute("aria-expanded", String(open)); };
  $("printBtn").addEventListener("click", (e) => { e.stopPropagation(); setPrintMenu(printMenu.hidden); });
  printMenu.addEventListener("click", (e) => {
    const kind = e.target.closest("[data-print]")?.dataset.print;
    setPrintMenu(false);
    if (kind === "ics") openIcsDialog();
    else if (kind && state.offline) exportPdfInBrowser(kind);
    else if (kind) exportPdf(kind);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest("#printMenu")) setPrintMenu(false); });
  // Ctrl+P should print the designed sheet too
  window.addEventListener("beforeprint", preparePrint);

  $("calendar").addEventListener("click", (e) => {
    const unbusy = e.target.closest("[data-unbusy]")?.dataset.unbusy;
    if (unbusy) return removeBusy(unbusy);
    const busyEl = e.target.closest("[data-busy]");
    if (busyEl) return openBusyDialog(busyFor().find((b) => b.id === busyEl.dataset.busy));
    const unpick = e.target.closest("[data-unpick]")?.dataset.unpick;
    if (unpick) {
      const c = state.courses.find((x) => unpick.startsWith(x.key + "|"));
      checkpoint("הסרת בחירה");
      state.selected.delete(unpick);
      state.preview = null;
      render();
      return undoToast(`${entryOf(c)?.name || ""} ${unpick.split("|")[1]} הוסרה מהמערכת`);
    }
    const ev = e.target.closest(".event");
    if (ev) revealGroup(ev.dataset.key);
  });

  $("publishBtn").addEventListener("click", publishSnapshot);
  $("loadSnapshotBtn").addEventListener("click", () => importSnapshot(true));
  applyModeUI();

  render();
  // the server drives a single browser window, so load saved courses one at a time
  (async () => {
    for (const course of state.courses) await loadCourse(course);
  })();
}

/* ---------- local app vs. static copy (GitHub Pages) ---------- */

let published = null; // web/data/snapshot.json: the data published from the local app

async function detectServer() {
  if (location.protocol === "file:") return false;
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok && (await res.json()).ok === true;
  } catch {
    return false;
  }
}

async function loadSnapshot() {
  try {
    const res = await fetch("data/snapshot.json", { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// replace this device's data with the published data, then start over with it
function importSnapshot(confirmFirst = false) {
  if (!published) return;
  if (confirmFirst && !confirm("לטעון את הנתונים שפורסמו? שינויים שעשית במכשיר הזה יוחלפו בהם.")) return;
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("biu.")).forEach((k) => localStorage.removeItem(k));
    for (const [k, v] of Object.entries(published.storage || {})) localStorage.setItem(k, v);
    localStorage.setItem("biu.snapshotImported", JSON.stringify(published.exportedAt));
  } catch { /* storage unavailable: keep running on the in-memory state */ }
  location.reload();
}

const fmtStamp = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString("he-IL", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

function applyModeUI() {
  $("offlineBanner").hidden = !state.offline;
  $("publishBtn").hidden = state.offline;
  if (!state.offline) return;
  const imported = store.get("biu.snapshotImported", null);
  $("offlineText").textContent = published
    ? `הנתונים עודכנו לאחרונה ב-${fmtStamp(published.exportedAt)}. כאן אי אפשר להוסיף קורסים או לרענן נתונים מאתר בר אילן, וכל שינוי שתעשו נשמר במכשיר הזה בלבד.`
    : "עדיין לא פורסמו נתונים לגרסה הזו.";
  $("offlineAsk").hidden = !published;
  $("loadSnapshotBtn").hidden = !published || imported === published.exportedAt;
}

async function publishSnapshot() {
  save();
  const storage = {};
  try { Object.keys(localStorage).filter((k) => k.startsWith("biu.")).forEach((k) => { storage[k] = localStorage.getItem(k); }); } catch { /* ignore */ }
  const data = {};
  for (const c of state.courses) { const e = entryOf(c); if (e) data[`${c.year}:${c.code}`] = e; }
  toast("שומר את הנתונים לפרסום…", "busy");
  try {
    const res = await fetch("/api/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storage, data }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "השמירה נכשלה");
    toast(`נשמר (${Object.keys(data).length} קורסים). כדי שיופיע באתר: מריצים את publish.bat`);
  } catch (e) {
    toast(e.message, "error");
  }
}

(async () => {
  state.offline = !(await detectServer());
  if (state.offline) {
    published = await loadSnapshot();
    const imported = store.get("biu.snapshotImported", null);
    // first visit on this device (or nothing here yet): start from the published data
    if (published && imported !== published.exportedAt && (!imported || !state.courses.length)) return importSnapshot();
  }
  init();
})();
