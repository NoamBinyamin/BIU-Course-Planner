"""Local server: pulls course data from courses.biu.ac.il and serves the web app.

The BIU site is protected by Radware bot detection, so searches run inside a real
Chrome window (persistent profile in .browser-profile). If a captcha shows up, it is
solved once in that window and the cookies are kept for later searches.
"""
import asyncio
import json
import sys
import threading
import time
import traceback
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
PROFILE_DIR = ROOT / ".browser-profile"
CACHE_FILE = ROOT / "data" / "cache.json"
SNAPSHOT_FILE = WEB_DIR / "data" / "snapshot.json"  # what the static (GitHub Pages) copy loads
SITE = "https://courses.biu.ac.il/"
PORT = 8765
CACHE_TTL = 12 * 3600
LOG_FILE = ROOT / "data" / "server.log"


def log_exception(context):
    """Errors go to the console and to data/server.log, so failures can be diagnosed later."""
    text = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {context}\n{traceback.format_exc()}\n"
    print(text, file=sys.stderr)
    try:
        LOG_FILE.parent.mkdir(exist_ok=True)
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(text)
    except OSError:
        pass

# Runs inside the BIU page: submits the search form via fetch, follows
# GridView paging, then fetches every group's details page (location etc.).
SEARCH_JS = r"""
async ([code, year]) => {
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const lines = (el) => el ? el.innerHTML.split(/<br\s*\/?>/i)
      .map(s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim()).filter(Boolean) : [];
  const text = (el) => el ? el.textContent.trim() : '';
  const formData = (doc) => {
    const fd = new URLSearchParams();
    for (const el of doc.querySelectorAll('#form1 input[type=hidden]')) fd.set(el.name, el.value);
    return fd;
  };
  const post = async (url, fd) => {
    const r = await fetch(url, {method: 'POST', body: fd,
      headers: {'Content-Type': 'application/x-www-form-urlencoded'}});
    return {url: r.url, html: await r.text()};
  };
  const blocked = (html) => /Radware|perfdrive|captcha/i.test(html.slice(0, 4000)) && !html.includes('form1');

  const homeHtml = await (await fetch('./')).text();
  if (blocked(homeHtml)) return {error: 'captcha'};
  const fd = formData(parse(homeHtml));
  fd.set('ctl00$ContentPlaceHolder1$cmbYear', year);
  fd.set('ctl00$ContentPlaceHolder1$cmbDepartments', '-1');
  fd.set('ctl00$ContentPlaceHolder1$txLessonCode', code);
  fd.set('ctl00$ContentPlaceHolder1$btnSearch', 'חיפוש');
  let res = await post('./', fd);
  if (blocked(res.html)) return {error: 'captcha'};

  const rows = [];
  for (let page = 1; page < 30; page++) {
    const doc = parse(res.html);
    const grid = doc.getElementById('ContentPlaceHolder1_gvLessons');
    if (!grid) break;
    const get = (name, i) => doc.getElementById(`ContentPlaceHolder1_gvLessons_${name}_${i}`);
    for (let i = 0; get('lblLessonCode', i); i++) {
      const link = get('lnkDetails', i);
      rows.push({
        code: text(get('lblLessonCode', i)),
        name: text(get('lblLessonname', i)),
        group: text(get('lblGroupCode', i)),
        teachers: lines(get('lblTeacher', i)),
        types: lines(get('lblSessionType', i)),
        semesters: lines(get('lblSemester', i)),
        days: lines(get('lblSesssionDay', i)),
        hours: lines(get('lblSessionHours', i)),
        lid: link ? (link.getAttribute('href').match(/lid=(\d+)/) || [])[1] : null,
      });
    }
    const next = [...grid.querySelectorAll('.cssPager a')]
        .find(a => a.textContent.trim() === String(page + 1));
    if (!next) break;
    const pfd = formData(doc);
    pfd.set('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$gvLessons');
    pfd.set('__EVENTARGUMENT', 'Page$' + (page + 1));
    res = await post(res.url, pfd);
    if (blocked(res.html)) return {error: 'captcha'};
  }

  const details = async (row) => {
    if (!row.lid) return;
    const doc = parse(await (await fetch('CourseDetails.aspx?lid=' + row.lid)).text());
    const cells = (id) => {
      const el = doc.getElementById(id);
      if (!el) return [];
      const tds = el.querySelectorAll('td');
      return tds.length ? [...tds].map(text) : lines(el);
    };
    row.buildings = cells('ContentPlaceHolder1_tdBuilding');
    row.rooms = cells('ContentPlaceHolder1_tdRoom');
    row.credits = text(doc.getElementById('ContentPlaceHolder1_tdPoints'));
    row.remark = text(doc.getElementById('ContentPlaceHolder1_tdRemark'));
    row.englishName = text(doc.getElementById('ContentPlaceHolder1_tdLessonEnglishName'));
    row.exams = [];
    for (let i = 0; doc.getElementById('ContentPlaceHolder1_gvTermRooms_lblTermType_' + i); i++) {
      const g = (n) => text(doc.getElementById(`ContentPlaceHolder1_gvTermRooms_${n}_${i}`));
      row.exams.push({term: g('lblTermType'), date: g('lblTermDate'), hour: g('lblTermHour')});
    }
  };
  const queue = [...rows];
  await Promise.all(Array.from({length: 4}, async () => {
    while (queue.length) await details(queue.shift()).catch(() => {});
  }));
  return {rows};
}
"""

DAYS = {"א": 0, "ב": 1, "ג": 2, "ד": 3, "ה": 4, "ו": 5, "ש": 6}


def semester_key(label):
    if "שנתי" in label:
        return "yearly"
    # BIU labels read "Semester A", "Semester B" and "Semester K" (summer), written in Hebrew letters
    rest = label.replace("סמסטר", "")
    if "קיץ" in rest or "ק" in rest:
        return "summer"
    if "ב" in rest:
        return "B"
    if "א" in rest:
        return "A"
    return "other"


def pick(values, i):
    if not values:
        return ""
    return values[i] if i < len(values) else values[-1]


def normalize(code, year, rows):
    groups = []
    for r in rows:
        sessions = []
        # several lecturers on one session come as extra lines, not one per session
        if len(r["teachers"]) != len(r["hours"]):
            r["teachers"] = [", ".join(dict.fromkeys(r["teachers"]))]
        # a twice-weekly group lists its days on one line, comma-separated (e.g. "Mon,Tue" in Hebrew letters)
        if len(r["days"]) < len(r["hours"]):
            r["days"] = [d.strip() for line in r["days"] for d in line.split(",")]
        for i, hours in enumerate(r["hours"]):
            parts = [p.strip() for p in hours.split("-")]
            day = pick(r["days"], i).replace("'", "").strip()
            building, room = pick(r.get("buildings", []), i), pick(r.get("rooms", []), i)
            sessions.append({
                "day": DAYS.get(day[:1], -1),
                "dayLabel": day,
                # BIU lists "start - end"
                "start": parts[0] if len(parts) == 2 else "",
                "end": parts[1] if len(parts) == 2 else "",
                "type": pick(r["types"], i),
                "teacher": pick(r["teachers"], i),
                "building": building,
                "room": room,
                "location": ", ".join(x for x in [building and f"בניין {building}", room and f"חדר {room}"] if x),
            })
        semester = pick(r["semesters"], 0)
        groups.append({
            "lid": r["lid"],
            "group": r["group"],
            "type": " / ".join(dict.fromkeys(r["types"])) or "",
            "teacher": ", ".join(dict.fromkeys(r["teachers"])),
            "semester": semester,
            "semesterKey": semester_key(semester),
            "sessions": sessions,
            "credits": r.get("credits", ""),
            "remark": r.get("remark", ""),
            "exams": r.get("exams", []),
        })
    first = rows[0] if rows else {}
    return {
        "code": code,
        "year": year,
        "name": first.get("name", ""),
        "englishName": first.get("englishName", ""),
        "groups": groups,
        "fetchedAt": time.time(),
    }


class Cache:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        try:
            self.data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.data = {}

    def get(self, key):
        entry = self.data.get(key)
        if entry and time.time() - entry["fetchedAt"] < CACHE_TTL:
            return entry
        return None

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            self.path.parent.mkdir(exist_ok=True)
            self.path.write_text(json.dumps(self.data, ensure_ascii=False), encoding="utf-8")


class SiteError(Exception):
    """A problem the user can act on; the message is shown in the UI as is."""


class BiuBrowser:
    """Owns a Chrome window on its own asyncio loop thread."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.page = None
        self.lock = None
        self.start_error = None
        self.window_state = None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._start())
        except Exception as e:  # noqa: BLE001 - keep the loop alive and report on every search
            self.start_error = e
            log_exception("browser start failed")
        self.ready.set()
        self.loop.run_forever()

    async def _start(self):
        self.lock = asyncio.Lock()
        pw = await async_playwright().start()
        ctx = await pw.chromium.launch_persistent_context(
            str(PROFILE_DIR), channel="chrome", headless=False, locale="he-IL")
        self.page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        # the window stays minimized; it pops up only when the site asks for a captcha
        await self._set_window("minimized")
        # open the site right away so a captcha (if any) shows up before the first search
        async with self.lock:
            try:
                await self._open_site()
            except SiteError:
                pass

    async def _open_site(self, force=False):
        if self.page.is_closed():
            self.page = await self.page.context.new_page()
            force = True
        if force or not self.page.url.startswith(SITE) or "Radware" in await self.page.title():
            try:
                await self.page.goto(SITE, timeout=45000)
            except Exception:  # noqa: BLE001 - Radware redirects abort the first navigation
                pass
        try:
            await self.page.wait_for_selector("#form1", timeout=20000)
        except Exception:  # noqa: BLE001 - most likely the captcha page
            # don't hold every other search hostage: show the window, tell the user and let them retry
            await self._set_window("normal")
            await self.page.bring_to_front()
            raise SiteError("האתר של בר אילן מבקש אימות. פתרו את ה-captcha בחלון Chrome שנפתח, ואז נסו שוב.")
        # site reachable (captcha solved, if there was one): back out of the way
        await self._set_window("minimized")

    async def _set_window(self, window_state):
        """Minimize / restore the Chrome window via the DevTools protocol."""
        if self.window_state == window_state:
            return
        try:
            cdp = await self.page.context.new_cdp_session(self.page)
            win = await cdp.send("Browser.getWindowForTarget")
            await cdp.send("Browser.setWindowBounds", {"windowId": win["windowId"], "bounds": {"windowState": window_state}})
            await cdp.detach()
            self.window_state = window_state
        except Exception:  # noqa: BLE001 - a visible window is an acceptable fallback
            log_exception(f"could not set the Chrome window to {window_state}")

    async def _search(self, code, year):
        async with self.lock:
            await self._open_site()
            for attempt in range(2):
                try:
                    result = await asyncio.wait_for(self.page.evaluate(SEARCH_JS, [code, year]), timeout=90)
                except asyncio.TimeoutError:
                    raise SiteError("האתר של בר אילן לא הגיב בזמן. נסו שוב בעוד רגע.")
                except Exception:  # noqa: BLE001 - the page navigated mid-search (Radware redirect)
                    result = {"error": "captcha"}
                if isinstance(result, dict) and result.get("error") != "captcha":
                    return result
                await self._open_site(force=True)
            raise SiteError("האתר של בר אילן מבקש אימות. פתרו את ה-captcha בחלון Chrome שנפתח, ואז נסו שוב.")

    def search(self, code, year):
        if not self.ready.wait(timeout=60) or self.start_error:
            raise SiteError("חלון Chrome של המערכת לא נפתח. ודאו שהמערכת לא פתוחה פעמיים (start.bat), סגרו את כל חלונות המערכת והפעילו מחדש.")
        return asyncio.run_coroutine_threadsafe(self._search(code, year), self.loop).result(timeout=240)


# load every Heebo weight the print styles use (Hebrew + Latin + symbols) before rendering
FONT_LOAD_JS = """async () => {
  const weights = [400, 500, 600, 700, 800];
  await Promise.all(weights.map((w) => document.fonts.load(`${w} 16px Heebo`, "אבג abc 0123 ✓")));
  await document.fonts.ready;
}"""


class PdfRenderer:
    """Turns the print sheet built by the page into a PDF file, using a headless Chromium.

    Unlike the browser's print dialog this adds no header/footer (URL, date, page numbers).
    Kept separate from BiuBrowser so exporting works even while the BIU window waits on a captcha.
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.browser = None
        self.lock = None
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    async def _render(self, html):
        if self.lock is None:
            self.lock = asyncio.Lock()
        async with self.lock:
            if self.browser is None or not self.browser.is_connected():
                pw = await async_playwright().start()
                self.browser = await pw.chromium.launch()
            page = await self.browser.new_page()
            try:
                # print media first: the sheet is display:none on screen, so fonts used only
                # in print would otherwise never load before the PDF is taken
                await page.emulate_media(media="print")
                await page.set_content(html, wait_until="networkidle", timeout=60000)
                await page.evaluate(FONT_LOAD_JS)
                return await page.pdf(prefer_css_page_size=True, print_background=True)
            finally:
                await page.close()

    def render(self, html):
        return asyncio.run_coroutine_threadsafe(self._render(html), self.loop).result(timeout=120)


browser = BiuBrowser()
pdf_renderer = PdfRenderer()
cache = Cache(CACHE_FILE)
MAX_PDF_REQUEST = 8 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_error(self, fmt, *args):
        print(fmt % args, file=sys.stderr)

    def end_headers(self):
        # fonts are CORS-fetched; the PDF renderer loads them from an about:blank document
        if self.path.startswith("/fonts/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/api/health":
            # the page uses this to tell the local app apart from the static copy on GitHub Pages
            return self.send_json(200, {"ok": True})
        if url.path != "/api/course":
            return super().do_GET()
        # always answer: an uncaught error would drop the connection and leave the page waiting
        try:
            self.course_api(url)
        except SiteError as e:
            self.send_json(503, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            log_exception(f"GET {self.path}")
            self.send_json(500, {"error": f"שגיאה בשרת: {e}. הפרטים נשמרו בקובץ data/server.log"})

    def course_api(self, url):
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        code = "".join(ch for ch in q.get("code", "") if ch.isdigit())
        year = q.get("year", "")
        if not code or not year.isdigit():
            return self.send_json(400, {"error": "חסר מספר קורס או שנה"})
        key = f"{year}:{code}"
        entry = None if q.get("refresh") else cache.get(key)
        if entry is None:
            result = browser.search(code, year)
            entry = normalize(code, year, result.get("rows") or [])
            if entry["groups"]:
                cache.put(key, entry)
        if not entry["groups"]:
            return self.send_json(404, {"error": f"לא נמצא קורס {code} בשנה {year}"})
        self.send_json(200, entry)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/publish":
            return self.publish()
        if path != "/api/pdf":
            return self.send_json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_PDF_REQUEST:
            return self.send_json(413, {"error": "המסמך גדול מדי לייצוא"})
        try:
            html = json.loads(self.rfile.read(length).decode("utf-8"))["html"]
            pdf = pdf_renderer.render(html)
        except Exception as e:  # noqa: BLE001 - surface any rendering failure to the UI
            log_exception("PDF export")
            return self.send_json(500, {"error": f"יצירת ה-PDF נכשלה: {e}"})
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(pdf)))
        self.end_headers()
        self.wfile.write(pdf)

    def publish(self):
        """Save the user's data + course data for the static copy (web/data/snapshot.json)."""
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_PDF_REQUEST:
            return self.send_json(413, {"error": "הנתונים גדולים מדי"})
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            snapshot = {
                "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "storage": {k: v for k, v in body["storage"].items() if k.startswith("biu.")},
                "data": body["data"],
            }
            SNAPSHOT_FILE.parent.mkdir(parents=True, exist_ok=True)
            SNAPSHOT_FILE.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            log_exception("publish")
            return self.send_json(500, {"error": f"השמירה נכשלה: {e}"})
        self.send_json(200, {"ok": True, "file": "web/data/snapshot.json", "exportedAt": snapshot["exportedAt"]})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Course planner running at http://localhost:{PORT}  (Ctrl+C to stop)")
    webbrowser.open(f"http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
