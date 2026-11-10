/* Portfolio Admin — browser side. Talks only to the local admin server. */
(function () {
  "use strict";
  const TOKEN = document.querySelector('meta[name="admin-token"]').content;
  let S = null;            // server state
  let cur = null;          // project being edited (working copy)
  let curOriginal = null;  // its id when loaded (null = new)
  let uploadId = null;     // folder used for uploads of a new project
  let dirty = false;
  let pubs = [];

  /* ---------- tiny DOM helper ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const $ = (s) => document.querySelector(s);
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");

  function toast(msg, type) {
    const t = h("div", { class: "toast" + (type ? " " + type : "") }, msg);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), type === "err" ? 12000 : 4500);
  }

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN }, body: JSON.stringify(body)
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* non-json */ }
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  function confirmBox(title, message, okLabel, extra) {
    return new Promise((resolve) => {
      const d = $("#dialog"), f = $("#dialog-form");
      f.replaceChildren(h("h3", {}, title), h("p", {}, message), extra || "",
        h("div", { class: "row-gap" },
          h("button", { class: "btn", value: "cancel" }, "Cancel"),
          h("button", { class: "btn " + (/delete|remove/i.test(okLabel) ? "danger" : "primary"), value: "ok" }, okLabel)));
      d.onclose = () => resolve(d.returnValue === "ok");
      d.showModal();
    });
  }

  /* ---------- tabs ---------- */
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", async () => {
    if (dirty && !(await confirmBox("Unsaved changes", "You have unsaved project changes. Leave without saving?", "Leave"))) return;
    if (dirty) { dirty = false; cur = null; curOriginal = null; renderEditor(); renderList(); }
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + b.dataset.tab));
    if (b.dataset.tab === "publish") renderGit();
  }));
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  async function load() {
    S = await api("/api/state");
    pubs = JSON.parse(JSON.stringify(S.publications || []));
    renderList(); renderPubs(); renderProfile(); refreshBadge();
  }

  async function refreshBadge() {
    try {
      const g = await api("/api/git");
      const n = g.ok ? g.change_count + (g.unpushed ? 1 : 0) : 0;
      $("#change-badge").hidden = !n; $("#change-badge").textContent = n;
    } catch (e) { /* ignore */ }
  }

  /* ============ PROJECTS ============ */
  function renderList() {
    const ol = $("#project-list");
    ol.replaceChildren(...S.projects.map((p, i) => h("li", {
      class: cur && (curOriginal || uploadId) === p.id ? "sel" : "",
      onclick: () => openProject(p.id)
    },
      h("div", {},
        h("div", { class: "t" }, p.title || p.id),
        h("div", { class: "m" },
          p.hidden ? h("span", { class: "tag draft" }, "DRAFT") : "",
          p.featured ? h("span", { class: "tag feat" }, "FEATURED") : "",
          [p.category, p.date].filter(Boolean).join(" · "))),
      h("div", { class: "arrows" },
        h("button", { class: "icon-btn", title: "Move up", disabled: i === 0, onclick: (e) => { e.stopPropagation(); move(i, -1); } }, "▲"),
        h("button", { class: "icon-btn", title: "Move down", disabled: i === S.projects.length - 1, onclick: (e) => { e.stopPropagation(); move(i, 1); } }, "▼"))
    )));
  }

  async function move(i, d) {
    const ids = S.projects.map((p) => p.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { await api("/api/projects/reorder", { ids }); await load(); refreshBadge(); }
    catch (e) { toast(e.message, "err"); }
  }

  async function openProject(id) {
    if (dirty && !(await confirmBox("Unsaved changes", "Discard changes to this project?", "Discard"))) return;
    const p = S.projects.find((x) => x.id === id);
    cur = JSON.parse(JSON.stringify(p));
    cur.links = cur.links || []; cur.media = cur.media || [];
    curOriginal = id; uploadId = null; dirty = false;
    renderEditor(); renderList();
  }

  $("#new-project").addEventListener("click", async () => {
    if (dirty && !(await confirmBox("Unsaved changes", "Discard changes to this project?", "Discard"))) return;
    cur = { id: "", title: "", category: "", date: String(new Date().getFullYear()), summary: "", role: "", team: "",
            tags: [], hidden: true, featured: false, details: "", links: [], media: [] };
    curOriginal = null; uploadId = null; dirty = false;
    renderEditor(); renderList();
    setTimeout(() => { const t = $("#f-title"); if (t && (document.activeElement === document.body || !document.activeElement)) t.focus(); }, 50);
  });

  function markDirty() { dirty = true; const d = $("#dirty"); if (d) d.hidden = false; }

  function field(label, input, help) {
    return h("label", { class: "field" }, h("span", {}, label), input, help ? h("small", {}, help) : "");
  }
  function bind(key, el, transform) {
    el.addEventListener("input", () => { cur[key] = transform ? transform(el.value) : el.value; markDirty(); });
    return el;
  }

  function renderEditor() {
    const ed = $("#editor");
    if (!cur) { ed.replaceChildren(h("div", { class: "empty" }, "Select a project on the left, or create a new one.")); return; }
    const isNew = !curOriginal;
    const lockedId = !isNew || !!uploadId;

    const title = bind("title", h("input", { id: "f-title", value: cur.title, maxlength: 200, placeholder: "e.g. Quadruped Robot" }));
    const idIn = h("input", { value: cur.id, maxlength: 60, disabled: isNew && lockedId });
    idIn.addEventListener("input", () => { cur.id = slug(idIn.value); markDirty(); });
    title.addEventListener("input", () => { if (isNew && !uploadId) { cur.id = slug(title.value); idIn.value = cur.id; } });

    const cats = h("datalist", { id: "cat-list" }, ...(S.categories || []).map((c) => h("option", { value: c })));
    const show = h("input", { type: "checkbox", checked: !cur.hidden });
    show.addEventListener("change", () => { cur.hidden = !show.checked; markDirty(); });
    const feat = h("input", { type: "checkbox", checked: !!cur.featured });
    feat.addEventListener("change", () => { cur.featured = feat.checked; markDirty(); });

    const summary = bind("summary", h("textarea", { rows: 3, maxlength: 600, value: cur.summary || "" }));
    const count = h("small", {}, (cur.summary || "").length + " / ~220 recommended");
    summary.addEventListener("input", () => { count.textContent = summary.value.length + " / ~220 recommended"; });

    const details = bind("details", h("textarea", { rows: 14, value: cur.details || "" }));
    const preview = h("div", { class: "md-preview" });
    const drawPreview = () => {
      const html = window.marked ? window.marked.parse(details.value || "*Nothing yet*") : details.value;
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script,iframe,object,embed,style").forEach((n) => n.remove());
      preview.replaceChildren(...doc.body.childNodes);
    };
    details.addEventListener("input", drawPreview); drawPreview();

    ed.replaceChildren(
      h("div", { class: "ed-head" },
        h("div", {}, h("h1", {}, isNew ? "New project" : cur.title || "Untitled"),
          h("div", { class: "hint" }, isNew ? "New projects start as drafts. Tick ‘Show on live site’ when it's ready." : "ID: " + curOriginal)),
        !isNew ? h("a", { class: "btn", href: "/site/project.html?id=" + encodeURIComponent(curOriginal), target: "_blank", rel: "noopener" }, "Preview page ↗") : ""),

      h("div", { class: "card" }, h("h3", {}, "Basics"),
        field("Title *", title),
        h("div", { class: "grid3" },
          field("ID (used in the web link)", idIn, lockedId && isNew ? "Locked after the first upload" : "Lowercase, dashes only"),
          field("Category", bind("category", h("input", { value: cur.category || "", list: "cat-list", placeholder: "Work, College…" }))),
          field("Date", bind("date", h("input", { value: cur.date || "", placeholder: "2019 or 2020 – 2022" })))),
        cats,
        h("div", { class: "row-gap" },
          h("label", { class: "check" }, show, "Show on live site"),
          h("label", { class: "check" }, feat, "Featured (shown first)"))),

      h("div", { class: "card" }, h("h3", {}, "Card text"),
        field("Summary — one or two lines on the card", summary, count),
        h("div", { class: "grid2" },
          field("My role", bind("role", h("input", { value: cur.role || "", maxlength: 400, placeholder: "What YOU did" }))),
          field("Team / credit", bind("team", h("input", { value: cur.team || "", maxlength: 300, placeholder: "e.g. GCOER Robotics Lab, with R. Bangal" })))),
        field("Tags (comma-separated)", bind("tags", h("input", { value: (cur.tags || []).join(", ") }), (v) => v.split(",").map((t) => t.trim()).filter(Boolean)))),

      h("div", { class: "card" }, h("h3", {}, "Write-up (project page)"),
        h("p", { class: "hint" }, "**bold**   *italic*   - bullet point   [link text](https://…)   — blank line = new paragraph"),
        h("div", { class: "md-wrap" }, details, preview)),

      mediaCard(),
      linksCard(),

      h("div", { class: "ed-foot" },
        h("button", { class: "btn primary", onclick: saveProject }, "Save project"),
        h("span", { class: "dirty", id: "dirty", hidden: !dirty }, "● unsaved changes"),
        h("span", { class: "spacer" }),
        !isNew ? h("button", { class: "btn danger-ghost", onclick: deleteProject }, "Delete project") : "")
    );
  }

  /* ----- media ----- */
  function thumb(m) {
    if (m.type === "image") return h("img", { src: "/site/" + m.src, alt: "", loading: "lazy" });
    if (m.type === "video") return m.poster ? h("img", { src: "/site/" + m.poster, alt: "" }) : h("video", { src: "/site/" + m.src, preload: "metadata", muted: true });
    if (m.type === "pdf") return h("div", { class: "ph" }, "PDF\n" + m.src.split("/").pop());
    if (m.type === "youtube") return h("div", { class: "ph" }, "YouTube\n" + m.id);
    return h("div", { class: "ph" }, "?");
  }

  function mediaCard() {
    const grid = h("div", { class: "media-grid" });
    const draw = () => grid.replaceChildren(...cur.media.map((m, i) => {
      const coverSrc = m.type === "image" ? m.src : m.type === "video" ? m.poster : null;
      const isCover = coverSrc && cur.cover === coverSrc;
      const cap = h("input", { value: m.caption || "", placeholder: "Caption" });
      cap.addEventListener("input", () => { m.caption = cap.value; markDirty(); });
      return h("div", { class: "mitem" + (isCover ? " is-cover" : "") },
        h("div", { class: "mthumb" }, thumb(m)),
        h("div", { class: "mbody" }, cap,
          h("div", { class: "mtools" },
            h("span", { class: "kind" }, m.type),
            coverSrc ? h("button", { class: "icon-btn" + (isCover ? " on" : ""), title: "Use as card cover", onclick: () => { cur.cover = coverSrc; markDirty(); draw(); } }, "★") : "",
            h("button", { class: "icon-btn", title: "Move left", disabled: i === 0, onclick: () => { [cur.media[i - 1], cur.media[i]] = [cur.media[i], cur.media[i - 1]]; markDirty(); draw(); } }, "◀"),
            h("button", { class: "icon-btn", title: "Move right", disabled: i === cur.media.length - 1, onclick: () => { [cur.media[i + 1], cur.media[i]] = [cur.media[i], cur.media[i + 1]]; markDirty(); draw(); } }, "▶"),
            h("button", { class: "icon-btn", title: "Remove from project", onclick: () => {
              if (cur.cover && (cur.cover === m.src || cur.cover === m.poster)) cur.cover = "";
              cur.media.splice(i, 1); markDirty(); draw();
            } }, "✕"))));
    }));
    draw();

    const progress = h("div", { class: "progress" });
    const input = h("input", { type: "file", multiple: true, accept: "image/*,video/mp4,video/webm,video/quicktime,application/pdf", hidden: true });
    const handle = async (files) => {
      if (!cur.title.trim()) { toast("Give the project a title first.", "err"); return; }
      const target = curOriginal || (uploadId = uploadId || cur.id || slug(cur.title));
      for (const file of files) {
        progress.textContent = "Uploading " + file.name + (file.type.startsWith("video") ? " (videos are compressed — this can take a minute)…" : "…");
        try {
          const r = await upload(file, target);
          const item = { type: r.type, src: r.src };
          if (r.poster) item.poster = r.poster;
          cur.media.push(item);
          if (!cur.cover && (r.type === "image" || r.poster)) cur.cover = r.type === "image" ? r.src : r.poster;
          (r.warnings || []).forEach((w) => toast(w, "warn"));
          markDirty();
        } catch (e) { toast(file.name + ": " + e.message, "err"); }
      }
      progress.textContent = "";
      draw();
      if (!curOriginal) renderEditor(); // locks the ID field
    };
    input.addEventListener("change", () => { handle([...input.files]); input.value = ""; });
    const drop = h("div", { class: "drop" }, "Drop photos, videos or PDFs here, or ",
      h("button", { class: "btn small", onclick: () => input.click() }, "choose files"), input,
      h("div", { class: "hint" }, "Photos are resized and their location data removed. " +
        (S.ffmpeg ? "Videos are compressed automatically." : "Big videos: put them on YouTube (Unlisted) and add the link below.")));
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); handle([...e.dataTransfer.files]); });

    const yt = h("input", { placeholder: "Paste a YouTube link, e.g. https://youtu.be/…" });
    const addYt = () => {
      const m = yt.value.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{6,20})/) || yt.value.match(/^([\w-]{11})$/);
      if (!m) { toast("That doesn't look like a YouTube link.", "err"); return; }
      cur.media.push({ type: "youtube", id: m[1], caption: "" }); yt.value = ""; markDirty(); draw();
    };
    return h("div", { class: "card" }, h("h3", {}, "Photos, videos & documents"),
      h("p", { class: "hint" }, "★ = picture shown on the project card. Only share photos you're allowed to (no confidential client sites)."),
      grid, drop, progress,
      h("div", { class: "row-gap", style: null }, yt, h("button", { class: "btn", onclick: addYt }, "Add YouTube video")));
  }

  async function upload(file, target, kind) {
    const headers = { "X-Admin-Token": TOKEN, "X-Filename": encodeURIComponent(file.name), "X-Target": target };
    if (kind) headers["X-Kind"] = kind;
    const res = await fetch("/api/upload", { method: "POST", headers, body: file });
    let data = {};
    try { data = await res.json(); } catch (e) { /* */ }
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data;
  }

  /* ----- links ----- */
  function linksCard() {
    const box = h("div");
    const draw = () => box.replaceChildren(...cur.links.map((l, i) => {
      const lab = h("input", { value: l.label || "", placeholder: "Button text, e.g. Code on GitHub" });
      const url = h("input", { value: l.url || "", placeholder: "https://…" });
      lab.addEventListener("input", () => { l.label = lab.value; markDirty(); });
      url.addEventListener("input", () => { l.url = url.value; markDirty(); });
      return h("div", { class: "links-row" }, lab, url,
        h("button", { class: "icon-btn", title: "Remove", onclick: () => { cur.links.splice(i, 1); markDirty(); draw(); } }, "✕"));
    }));
    draw();
    return h("div", { class: "card" }, h("h3", {}, "Buttons / links"),
      h("p", { class: "hint" }, "Shown as buttons at the top of the project page — code, paper, report, demo."),
      box, h("button", { class: "btn", onclick: () => { cur.links.push({ label: "", url: "" }); draw(); } }, "+ Add link"));
  }

  async function saveProject() {
    try {
      const r = await api("/api/projects/save", { original_id: curOriginal, upload_id: uploadId, project: cur });
      dirty = false;
      await load();
      openProjectAfterSave(r.saved_id);
      toast("Saved. Preview it, then Publish when you're ready.");
      refreshBadge();
    } catch (e) { toast(e.message, "err"); }
  }
  function openProjectAfterSave(id) {
    const p = S.projects.find((x) => x.id === id);
    cur = JSON.parse(JSON.stringify(p)); cur.links = cur.links || []; cur.media = cur.media || [];
    curOriginal = id; uploadId = null; renderEditor(); renderList();
  }

  async function deleteProject() {
    const box = h("input", { type: "checkbox" });
    const ok = await confirmBox("Delete project?", "“" + cur.title + "” will be removed from the site.", "Delete",
      h("label", { class: "check" }, box, "Also delete its photos/videos from this computer"));
    if (!ok) return;
    try {
      await api("/api/projects/delete", { id: curOriginal, delete_media: box.checked });
      cur = null; curOriginal = null; dirty = false;
      await load(); renderEditor(); toast("Deleted."); refreshBadge();
    } catch (e) { toast(e.message, "err"); }
  }

  /* ============ PUBLICATIONS ============ */
  function renderPubs() {
    const list = $("#pub-list");
    list.replaceChildren(...pubs.map((p, i) => {
      const inp = (key, ph, attrs) => {
        const el = h("input", Object.assign({ value: p[key] || "", placeholder: ph }, attrs || {}));
        el.addEventListener("input", () => { p[key] = el.value; });
        return el;
      };
      const show = h("input", { type: "checkbox", checked: !p.hidden });
      show.addEventListener("change", () => { p.hidden = !show.checked; });
      const fileIn = h("input", { type: "file", accept: "application/pdf", hidden: true });
      fileIn.addEventListener("change", async () => {
        try { const r = await upload(fileIn.files[0], "publications"); p.file = r.src; renderPubs(); (r.warnings || []).forEach((w) => toast(w, "warn")); }
        catch (e) { toast(e.message, "err"); }
      });
      return h("div", { class: "card pub" },
        h("div", {},
          field("Title", inp("title", "Paper title")),
          h("div", { class: "grid2" }, field("Authors", inp("authors", "T. Chaudhari, A. N. Other")), field("Venue", inp("venue", "Conference / journal"))),
          h("div", { class: "grid3" }, field("Link (DOI / IEEE Xplore)", inp("url", "https://…")), field("Year", inp("year", "2019")), field("Type", inp("type", "Conference paper"))),
          h("div", { class: "row-gap" },
            h("label", { class: "check" }, show, "Show on site"),
            h("span", { class: "mono" }, p.file ? "PDF: " + p.file.split("/").pop() : "No PDF attached"),
            h("button", { class: "btn small", onclick: () => fileIn.click() }, p.file ? "Replace PDF" : "Attach PDF"),
            p.file ? h("button", { class: "btn small danger-ghost", onclick: () => { delete p.file; renderPubs(); } }, "Remove PDF") : "", fileIn)),
        h("div", { class: "arrows" },
          h("button", { class: "icon-btn", disabled: i === 0, onclick: () => { [pubs[i - 1], pubs[i]] = [pubs[i], pubs[i - 1]]; renderPubs(); } }, "▲"),
          h("button", { class: "icon-btn", disabled: i === pubs.length - 1, onclick: () => { [pubs[i + 1], pubs[i]] = [pubs[i], pubs[i + 1]]; renderPubs(); } }, "▼"),
          h("button", { class: "icon-btn", title: "Remove", onclick: () => { pubs.splice(i, 1); renderPubs(); } }, "✕")));
    }));
    if (!pubs.length) list.append(h("p", { class: "hint" }, "No publications yet."));
  }
  $("#add-pub").addEventListener("click", () => { pubs.unshift({ title: "", year: String(new Date().getFullYear()), type: "Conference paper" }); renderPubs(); });
  $("#save-pubs").addEventListener("click", async () => {
    try { await api("/api/publications/save", { publications: pubs }); await load(); toast("Publications saved."); refreshBadge(); }
    catch (e) { toast(e.message, "err"); }
  });

  /* ============ PROFILE ============ */
  function renderProfile() {
    $("#site-text").value = S.site_text;
    $("#photo-preview").src = S.site.photo ? "/site/" + S.site.photo + "?t=" + Date.now() : "";
    $("#cv-status").textContent = S.site.cv ? "Linked: " + S.site.cv : "No CV linked — the Download CV button is hidden.";
    $("#cv-remove").hidden = !S.site.cv;
  }
  $("#photo-input").addEventListener("change", async (e) => {
    try { await upload(e.target.files[0], "profile", "photo"); await load(); toast("Photo updated."); refreshBadge(); }
    catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  });
  $("#cv-input").addEventListener("change", async (e) => {
    try { const r = await upload(e.target.files[0], "profile", "cv"); await load(); (r.warnings || []).forEach((w) => toast(w, "warn")); toast("CV uploaded."); refreshBadge(); }
    catch (err) { toast(err.message, "err"); }
    e.target.value = "";
  });
  $("#cv-remove").addEventListener("click", async () => {
    const t = $("#site-text").value.split("\n").filter((l) => !/^cv:/.test(l)).join("\n");
    try { await api("/api/site/save", { text: t }); await load(); toast("CV link removed."); refreshBadge(); }
    catch (e) { toast(e.message, "err"); }
  });
  $("#save-site").addEventListener("click", async () => {
    try { await api("/api/site/save", { text: $("#site-text").value }); await load(); toast("Profile saved."); refreshBadge(); }
    catch (e) { toast(e.message, "err"); }
  });
  $("#site-text").addEventListener("keydown", (e) => {
    if (e.key === "Tab") { // insert two spaces instead of leaving the box (YAML can't use tabs)
      e.preventDefault();
      const t = e.target, s = t.selectionStart;
      t.setRangeText("  ", s, t.selectionEnd, "end");
    }
  });

  /* ============ PUBLISH ============ */
  async function renderGit() {
    const card = $("#git-card");
    card.replaceChildren(h("h3", {}, "Status"), h("p", { class: "hint" }, "Checking…"));
    try {
      const g = await api("/api/git");
      if (!g.ok) { card.replaceChildren(h("h3", {}, "Status"), h("p", { class: "bad" }, g.reason)); $("#publish-btn").disabled = true; return; }
      $("#publish-btn").disabled = false;
      card.replaceChildren(h("h3", {}, "Status"),
        h("p", { class: "mono" }, "GitHub repo: " + (g.remote || "(none — see README)"), h("br"), "Branch: " + g.branch),
        g.change_count || g.unpushed
          ? h("div", {}, h("p", {}, h("b", {}, g.change_count + " changed file(s) waiting to publish" + (g.unpushed ? " + saved versions not yet sent" : ""))),
              g.changes.length ? h("div", { class: "changes" }, g.changes.map((c) => h("div", {}, c))) : "")
          : h("p", { class: "ok" }, "✓ Everything is published."));
    } catch (e) { card.replaceChildren(h("p", { class: "bad" }, e.message)); }
  }
  $("#publish-btn").addEventListener("click", async (e) => {
    const btn = e.target, log = $("#publish-log");
    btn.disabled = true; btn.textContent = "Publishing…"; log.hidden = false; log.textContent = "Working…";
    try {
      const r = await api("/api/publish", { message: $("#commit-msg").value });
      log.textContent = r.log; (r.warnings || []).forEach((w) => toast(w, "warn"));
      toast("Published! The live site updates in about a minute.");
    } catch (err) { log.textContent = err.message; toast("Not published — see the message below.", "err"); }
    btn.disabled = false; btn.textContent = "Publish to GitHub";
    renderGit(); refreshBadge();
  });
  $("#pull-btn").addEventListener("click", async () => {
    try { const r = await api("/api/pull", {}); toast(r.log || "Up to date."); await load(); renderGit(); }
    catch (e) { toast(e.message, "err"); }
  });
  $("#cleanup-btn").addEventListener("click", async () => {
    const out = $("#cleanup-out");
    const r = await api("/api/cleanup");
    if (!r.files.length) { out.replaceChildren(h("p", { class: "ok" }, "✓ No unused files.")); return; }
    out.replaceChildren(h("div", { class: "changes" }, r.files.map((f) => h("div", {}, f))),
      h("button", { class: "btn danger-ghost", onclick: async () => {
        if (!(await confirmBox("Delete unused files?", r.files.length + " file(s) will be deleted from this computer.", "Delete"))) return;
        await api("/api/cleanup", { delete: true }); out.replaceChildren(h("p", { class: "ok" }, "✓ Removed.")); refreshBadge();
      } }, "Delete these " + r.files.length + " files"));
  });

  load().catch((e) => toast(e.message, "err"));
})();
