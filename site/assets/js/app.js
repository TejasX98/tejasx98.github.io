/* Portfolio engine — reads content/*.yml and builds the pages.
   You normally never need to edit this file. */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const page = document.body.dataset.page;

  /* ---------- helpers ---------- */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  marked.use({ renderer: { html: () => "" }, walkTokens: (t) => { if (t.type === "link" || t.type === "image") t.href = safeUrl(t.href); } });
  const md = (s) => (s ? marked.parse(String(s)) : "");
  const list = (x) => (Array.isArray(x) ? x : []);
  const visible = (arr) => list(arr).filter((x) => x && !x.hidden);
  const isExternal = (u) => /^https?:\/\//i.test(u || "");
  // only allow web links, email links and files inside this site
  const safeUrl = (u) => {
    u = String(u ?? "").trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) return "#";
    return u;
  };
  const href = (u) => esc(safeUrl(u));
  const linkAttrs = (u) => (isExternal(u) || /\.pdf$/i.test(u || "") ? ' target="_blank" rel="noopener"' : "");

  async function loadYaml(path, required) {
    let res;
    try {
      res = await fetch(path, { cache: "no-cache" });
    } catch (e) {
      throw new Error(
        location.protocol === "file:"
          ? "This site can't be opened by double-clicking index.html. Use GitHub Pages, or run a local preview (see README)."
          : "Couldn't load " + path
      );
    }
    if (!res.ok) {
      if (!required) return [];
      throw new Error("Couldn't find " + path);
    }
    const text = await res.text();
    try {
      return jsyaml.load(text) || (required ? {} : []);
    } catch (e) {
      const line = e.mark ? " (around line " + (e.mark.line + 1) + ")" : "";
      throw new Error("There's a formatting mistake in " + path + line + ". Check indentation and colons.\n\n" + (e.reason || e.message));
    }
  }

  function showError(err) {
    app.innerHTML = '<div class="error"><h2>Something needs fixing</h2><pre>' + esc(err.message) + "</pre></div>";
    console.error(err);
  }

  const initials = (n) => String(n || "").split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("");
  const pad = (n) => String(n).padStart(2, "0");

  // brand mark: an ISA instrument balloon with initials
  const brandMark = (n) =>
    '<svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="12.5" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
    '<line x1="1.5" y1="14" x2="26.5" y2="14" stroke="var(--accent)" stroke-width="1.5"/>' +
    '<text x="14" y="11.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="7.5" font-weight="700" fill="currentColor">' + esc(initials(n).slice(0, 3)) + "</text>" +
    '<text x="14" y="22" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="6.5" fill="var(--accent)">01</text></svg>';

  function applyTheme(site) {
    if (site.accent) document.documentElement.style.setProperty("--accent-base", site.accent);
    document.getElementById("brand").innerHTML = brandMark(site.name) + "<span>" + esc(site.name) + "</span>";
    const year = new Date().getFullYear();
    document.getElementById("footer").innerHTML =
      "<span>© " + year + " " + esc(site.name) + "</span>" +
      "<span>Drawn by: " + esc(initials(site.name)) + "</span>" +
      "<span>Rev: " + esc(site.updated || year) + "</span>" +
      "<span>Sheet 1 of 1</span>" +
      (site.contact && site.contact.email ? '<a href="mailto:' + esc(site.contact.email) + '">' + esc(site.contact.email) + "</a>" : "");
  }

  // section heading drawn like a P&ID line: balloon ── TITLE ───────▶
  const SECTION_CODES = { about: "ABT", projects: "PRJ", publications: "PUB", experience: "EXP", education: "EDU", contact: "COM", gallery: "MED", details: "DOC" };
  let secNo = 0;
  const head = (key, title) =>
    '<div class="sec-head"><span class="balloon" aria-hidden="true"><b>' + SECTION_CODES[key] + "</b><i>" + pad(++secNo) + "</i></span>" +
    "<h2>" + esc(title) + '</h2><span class="pipe" aria-hidden="true"></span></div>';

  // normally-open contact symbol  ─┤ ├─  for the ladder timeline
  const CONTACT =
    '<svg class="contact-sym" viewBox="0 0 64 28" aria-hidden="true"><g stroke="currentColor" stroke-width="2.5" fill="none">' +
    '<line x1="0" y1="14" x2="24" y2="14"/><line x1="24" y1="4" x2="24" y2="24"/>' +
    '<line x1="40" y1="4" x2="40" y2="24"/><line x1="40" y1="14" x2="64" y2="14"/></g></svg>';

  const ICONS = {
    email: '<path d="M3 6h18v12H3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m3 7 9 6 9-6" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    linkedin: '<path fill="currentColor" d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05C20.6 8.65 21 11.2 21 14.5V21h-4v-5.8c0-1.4-.03-3.2-1.95-3.2-1.95 0-2.25 1.52-2.25 3.1V21H9z"/>',
    github: '<path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>',
    scholar: '<path fill="currentColor" d="M12 3 1 9l11 6 9-4.9V17h2V9L12 3Zm-6 9.2V16c0 1.7 2.7 3 6 3s6-1.3 6-3v-3.8l-6 3.3-6-3.3Z"/>',
    orcid: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M8 10h1.6v6H8zM8.8 7a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM11 10h2.4c2 0 3.2 1.3 3.2 3s-1.2 3-3.2 3H11zm1.6 1.4v3.2h.8c1 0 1.6-.6 1.6-1.6s-.6-1.6-1.6-1.6z"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
  };
  const icon = (k) => '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' + (ICONS[k] || ICONS.link) + "</svg>";
  const LABELS = { email: "Email", linkedin: "LinkedIn", github: "GitHub", scholar: "Google Scholar", orcid: "ORCID" };

  function contactLinks(contact) {
    return Object.entries(contact || {}).filter(([, v]) => v).map(([k, v]) => {
      const link = k === "email" ? "mailto:" + v : v;
      return '<a class="icon-link" href="' + href(link) + '"' + linkAttrs(link) + ' title="' + esc(LABELS[k] || k) + '">' + icon(k) + "<span>" + esc(LABELS[k] || k) + "</span></a>";
    }).join("");
  }

  /* ---------- HOME ---------- */
  const SECTION_TITLES = { about: "About", projects: "Projects", publications: "Publications", experience: "Experience", education: "Education", contact: "Contact" };

  function renderHome(site, projects, pubs) {
    document.title = site.name + " — " + (site.headline || "Portfolio");
    const sections = list(site.sections).length ? site.sections : Object.keys(SECTION_TITLES);

    document.getElementById("nav").innerHTML =
      sections.filter((s) => SECTION_TITLES[s]).map((s) => '<a href="#' + s + '">' + SECTION_TITLES[s] + "</a>").join("") +
      (site.cv ? '<a class="btn btn-small" href="' + href(site.cv) + '" target="_blank" rel="noopener">CV</a>' : "");

    const tb = list(site.titleblock).length ? site.titleblock : [
      { label: "Discipline", value: site.discipline || "Instrumentation & Controls" },
      { label: "Location", value: site.location },
      { label: "Status", value: site.status ? "Available" : "—" },
      { label: "Dwg no.", value: initials(site.name) + "-CV-001" }
    ];
    let html =
      '<section class="hero">' +
        (site.photo ? '<div class="frame"><img class="avatar" src="' + href(site.photo) + '" alt="' + esc(site.name) + '"></div>' : "") +
        '<div class="hero-text">' +
          (site.status ? '<p class="lamp">' + esc(site.status) + "</p>" : "") +
          '<p class="eyebrow">' + esc(site.headline) + "</p>" +
          "<h1>" + esc(site.name) + "</h1>" +
          '<p class="tagline">' + esc(site.tagline) + "</p>" +
          '<div class="hero-actions">' +
            (site.cv ? '<a class="btn" href="' + href(site.cv) + '" target="_blank" rel="noopener">Download CV</a>' : "") +
            '<a class="btn btn-ghost" href="#projects">See projects</a>' +
          "</div>" +
          '<div class="socials">' + contactLinks(site.contact) + "</div>" +
        "</div>" +
        '<dl class="titleblock">' + tb.map((r) => "<div><dt>" + esc(r.label) + "</dt><dd>" + esc(r.value) + "</dd></div>").join("") + "</dl>" +
      "</section>" + highlights(site.highlights);

    secNo = 0;
    for (const s of sections) {
      if (s === "about") html += sectionAbout(site);
      if (s === "projects") html += sectionProjects(projects);
      if (s === "publications") html += sectionPubs(pubs);
      if (s === "experience") html += sectionExperience(site.experience);
      if (s === "education") html += sectionEducation(site.education);
      if (s === "contact") html += sectionContact(site);
    }
    app.innerHTML = html;
    wireFilters();
  }

  function highlights(items) {
    items = visible(items);
    if (!items.length) return "";
    return '<section class="readouts" aria-label="Highlights">' + items.map((h) =>
      '<div class="readout"><p class="ro-value">' + esc(h.value) + (h.unit ? ' <span class="ro-unit">' + esc(h.unit) + "</span>" : "") +
      '</p><p class="ro-label">' + esc(h.label) + "</p></div>").join("") + "</section>";
  }

  function sectionAbout(site) {
    const skills = list(site.skills).map((g) =>
      '<div class="skill-group"><h4>' + esc(g.group) + '</h4><ul class="chips">' +
      list(g.items).map((i) => "<li>" + esc(i) + "</li>").join("") + "</ul></div>").join("");
    return '<section id="about" class="section">' + head("about", "About") + '<div class="about-grid">' +
      '<div class="prose">' + md(site.about) + "</div>" +
      (skills ? '<div class="skills">' + skills + "</div>" : "") + "</div></section>";
  }

  function projectCard(p) {
    const cover = p.cover
      ? '<img src="' + href(p.cover) + '" alt="" loading="lazy">'
      : '<div class="cover-fallback">' + esc((p.title || "?").slice(0, 1)) + "</div>";
    return '<a class="card" href="project.html?id=' + encodeURIComponent(p.id) + '" data-cat="' + esc(p.category || "") + '">' +
      '<div class="card-strip"><span class="tagno">' + esc(p._tag) + "</span>" +
        (p.featured ? '<span class="lamp">Featured</span>' : "<span>" + esc(p.category) + "</span>") + "</div>" +
      '<div class="card-cover">' + cover + "</div>" +
      '<div class="card-body">' +
        (p.date ? '<p class="meta">' + (p.featured ? esc(p.category) + " · " : "") + esc(p.date) + "</p>" : "") +
        "<h3>" + esc(p.title) + "</h3>" +
        "<p>" + esc(p.summary) + "</p>" +
        '<ul class="tags">' + list(p.tags).map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" +
      "</div></a>";
  }

  function sectionProjects(projects) {
    tagProjects(projects);
    const items = visible(projects).map((p, i) => ({ p, i }))
      .sort((a, b) => (b.p.featured ? 1 : 0) - (a.p.featured ? 1 : 0) || a.i - b.i).map((x) => x.p);
    if (!items.length) return "";
    const cats = [...new Set(items.map((p) => p.category).filter(Boolean))];
    const filters = cats.length > 1
      ? '<div class="filters" role="tablist"><button class="on" data-f="*">All</button>' +
        cats.map((c) => '<button data-f="' + esc(c) + '">' + esc(c) + "</button>").join("") + "</div>"
      : "";
    return '<section id="projects" class="section">' + head("projects", "Projects") + filters +
      '<div class="grid">' + items.map(projectCard).join("") + "</div></section>";
  }

  function wireFilters() {
    document.querySelectorAll(".filters button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll(".filters button").forEach((x) => x.classList.toggle("on", x === b));
      const f = b.dataset.f;
      document.querySelectorAll(".grid .card").forEach((c) => { c.hidden = !(f === "*" || c.dataset.cat === f); });
    }));
  }

  // give every visible project a drawing-style tag number: PRJ-01, PRJ-02 ...
  function tagProjects(projects) {
    visible(projects).forEach((p, i) => { p._tag = p.tag || "PRJ-" + pad(i + 1); });
  }

  function sectionPubs(pubs) {
    const items = visible(pubs);
    if (!items.length) return "";
    return '<section id="publications" class="section">' + head("publications", "Publications") +
      '<div class="register" role="table">' +
      '<div class="reg-row reg-head" role="row"><span>Doc no.</span><span>Title / authors</span><span>Type</span><span>Year</span></div>' +
      items.map((p, i) => {
        const link = p.url || p.file;
        const title = link ? '<a href="' + href(link) + '"' + linkAttrs(link) + ">" + esc(p.title) + "</a>" : esc(p.title);
        const extra = p.url && p.file ? ' · <a href="' + href(p.file) + '" target="_blank" rel="noopener">PDF</a>' : "";
        return '<div class="reg-row" role="row"><span class="reg-no">PUB-' + pad(i + 1) + "</span><div>" +
          '<p class="pub-title">' + title + "</p>" +
          '<p class="pub-meta">' + esc(p.authors) + (p.venue ? " — <em>" + esc(p.venue) + "</em>" : "") + extra + "</p></div>" +
          '<span class="reg-type">' + esc(p.type) + '</span><span class="reg-year">' + esc(p.year) + "</span></div>";
      }).join("") + "</div></section>";
  }

  function ladder(items, body) {
    return '<div class="ladder">' + items.map((e) =>
      '<div class="rung"><p class="rung-period">' + esc(e.period) + "</p>" + CONTACT +
      '<div class="rung-body">' + body(e) + "</div></div>").join("") + "</div>";
  }

  function sectionExperience(exp) {
    const items = visible(exp);
    if (!items.length) return "";
    return '<section id="experience" class="section">' + head("experience", "Experience") +
      ladder(items, (e) => "<h3>" + esc(e.role) + '</h3><p class="rung-org">' + esc(e.org) + "</p>" +
        (list(e.points).length ? "<ul>" + e.points.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "")) +
      "</section>";
  }

  function sectionEducation(edu) {
    const items = visible(edu);
    if (!items.length) return "";
    return '<section id="education" class="section">' + head("education", "Education") +
      ladder(items, (e) => "<h3>" + esc(e.degree) + '</h3><p class="rung-org">' + esc(e.org) + "</p>" +
        (e.note ? "<p>" + esc(e.note) + "</p>" : "")) +
      "</section>";
  }

  function sectionContact(site) {
    return '<section id="contact" class="section contact">' + head("contact", "Contact") +
      "<p>Open to controls, automation and commissioning roles. The quickest way to reach me is email.</p>" +
      (site.contact && site.contact.email ? '<a class="btn" href="mailto:' + esc(site.contact.email) + '">' + esc(site.contact.email) + "</a>" : "") +
      '<div class="socials">' + contactLinks(site.contact) + "</div></section>";
  }

  /* ---------- PROJECT PAGE ---------- */
  function mediaItem(m) {
    const cap = m.caption ? "<figcaption>" + esc(m.caption) + "</figcaption>" : "";
    switch (m.type) {
      case "image":
        return '<figure class="m-image"><button class="zoom" data-src="' + href(m.src) + '" data-cap="' + esc(m.caption) + '"><img src="' + href(m.src) + '" alt="' + esc(m.caption) + '" loading="lazy"></button>' + cap + "</figure>";
      case "video":
        return '<figure class="m-wide"><video controls preload="metadata" src="' + href(m.src) + '"' + (m.poster ? ' poster="' + href(m.poster) + '"' : "") + "></video>" + cap + "</figure>";
      case "youtube":
        return '<figure class="m-wide"><div class="ratio"><iframe src="https://www.youtube-nocookie.com/embed/' + esc(String(m.id || "").replace(/[^\w-]/g, "")) + '" title="' + esc(m.caption || "Video") + '" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>' + cap + "</figure>";
      case "pdf":
        return '<figure class="m-wide"><div class="pdf"><iframe src="' + href(m.src) + '" title="' + esc(m.caption || "PDF") + '" loading="lazy"></iframe></div>' +
          '<figcaption>' + esc(m.caption || "Document") + ' · <a href="' + href(m.src) + '" target="_blank" rel="noopener">Open PDF</a></figcaption></figure>';
      default:
        return "";
    }
  }

  function renderProject(site, projects) {
    const id = new URLSearchParams(location.search).get("id");
    tagProjects(projects);
    const all = visible(projects);
    const idx = all.findIndex((x) => String(x.id) === id);
    const p = all[idx];
    if (!p) {
      app.innerHTML = '<div class="error"><h2>Project not found</h2><p><a href="./#projects">Back to all projects</a></p></div>';
      return;
    }
    document.title = p.title + " — " + site.name;
    secNo = 0;
    const prev = all[idx - 1], next = all[idx + 1];

    app.innerHTML =
      '<article class="project"><header class="project-head">' +
        '<p class="meta">' + esc(p._tag) + " · " + esc(p.category) + (p.date ? " · " + esc(p.date) : "") + "</p>" +
        "<h1>" + esc(p.title) + "</h1>" +
        '<p class="lead">' + esc(p.summary) + "</p>" +
        (p.role ? '<p class="role"><strong>My role:</strong> ' + esc(p.role) + "</p>" : "") +
        (p.team ? '<p class="role"><strong>Team:</strong> ' + esc(p.team) + "</p>" : "") +
        '<ul class="tags">' + list(p.tags).map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>" +
        (list(p.links).length ? '<div class="hero-actions">' + p.links.map((l, i) =>
          '<a class="btn' + (i ? " btn-ghost" : "") + '" href="' + href(l.url) + '"' + linkAttrs(l.url) + ">" + esc(l.label) + "</a>").join("") + "</div>" : "") +
        "</header>" +
        (p.details ? '<section class="section">' + head("details", "Details") + '<div class="prose">' + md(p.details) + "</div></section>" : "") +
        (list(p.media).length ? '<section class="section">' + head("gallery", "Gallery") + '<div class="gallery">' + p.media.map(mediaItem).join("") + "</div></section>" : "") +
        '<nav class="pager">' +
          (prev ? '<a href="project.html?id=' + encodeURIComponent(prev.id) + '">← ' + esc(prev.title) + "</a>" : "<span></span>") +
          (next ? '<a href="project.html?id=' + encodeURIComponent(next.id) + '">' + esc(next.title) + " →</a>" : "<span></span>") +
        "</nav>" +
      "</article>";
    wireLightbox();
  }

  function wireLightbox() {
    const lb = document.getElementById("lightbox");
    if (!lb) return;
    const img = lb.querySelector("img"), cap = lb.querySelector(".lb-cap");
    const close = () => { lb.hidden = true; img.src = ""; };
    document.querySelectorAll(".zoom").forEach((b) => b.addEventListener("click", () => {
      img.src = b.dataset.src; img.alt = b.dataset.cap || ""; cap.textContent = b.dataset.cap || ""; lb.hidden = false;
    }));
    lb.addEventListener("click", (e) => { if (e.target !== img) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  }

  /* ---------- boot ---------- */
  (async function () {
    try {
      const [site, projects, pubs] = await Promise.all([
        loadYaml("content/site.yml", true),
        loadYaml("content/projects.yml", false),
        loadYaml("content/publications.yml", false)
      ]);
      applyTheme(site);
      if (page === "project") renderProject(site, projects);
      else renderHome(site, projects, pubs);
      if (location.hash) { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }
    } catch (err) {
      showError(err);
    }
  })();
})();
