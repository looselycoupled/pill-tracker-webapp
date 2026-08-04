"use strict";

// All date/time reasoning happens here on the client so the app follows the
// phone's clock, not the container's. The server only stores what we send it.

let state = { medications: [], log: [] };
let backups = [];
let editingMedId = null;
let dayModalDate = null;

// ---- Date helpers ----

function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return localDateStr(new Date());
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function lastNDays(n) {
  const days = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d);
  }
  return days;
}

// ---- Data helpers ----

function activeMeds() {
  return state.medications.filter((m) => m.active);
}

function isTaken(medId, dateStr, time) {
  return state.log.some(
    (e) => e.medication_id === medId && e.date === dateStr && e.time === time
  );
}

/** Every scheduled dose for a date, flattened and sorted by time. */
function dosesForDate(dateStr) {
  const doses = [];
  for (const med of activeMeds()) {
    for (const slot of med.schedule) {
      doses.push({
        med,
        time: slot.time,
        label: slot.label,
        taken: isTaken(med.id, dateStr, slot.time),
      });
    }
  }
  doses.sort((a, b) => a.time.localeCompare(b.time));
  return doses;
}

/** A medication only counts toward a past day if it existed on that day. */
function medExistedOn(med, dateStr) {
  if (!med.created_at) return true;
  return localDateStr(new Date(med.created_at)) <= dateStr;
}

// ---- API ----

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

async function loadData() {
  state = await api("/api/data");
}

async function loadBackups() {
  // Non-critical: a failure here shouldn't blank out the Manage tab.
  try {
    const result = await api("/api/backups");
    backups = result.backups;
  } catch (err) {
    backups = [];
  }
}

// ---- Rendering ----

function render() {
  renderHeader();
  renderToday();
  renderHistory();
  renderManage();
  renderBackups();
}

function renderHeader() {
  const d = new Date();
  document.getElementById("header-date").textContent = d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function renderToday() {
  const dateStr = todayStr();
  const doses = dosesForDate(dateStr);
  const summary = document.getElementById("today-summary");
  const nextEl = document.getElementById("today-next");
  const listEl = document.getElementById("today-list");

  if (doses.length === 0) {
    summary.innerHTML = "";
    nextEl.innerHTML = "";
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#128138;</div>
        <p>No medications yet.</p>
        <button class="btn btn-primary" onclick="switchView('view-manage')">Add your first</button>
      </div>`;
    return;
  }

  const takenCount = doses.filter((d) => d.taken).length;
  const pct = Math.round((takenCount / doses.length) * 100);
  const allDone = takenCount === doses.length;

  summary.innerHTML = `
    <div class="summary-title">${allDone ? "All done for today" : "Taken today"}</div>
    <div class="summary-count">${takenCount}<small> / ${doses.length} doses</small></div>
    <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>`;

  // "Next up" — earliest untaken dose. Overdue if its time has already passed.
  const next = doses.find((d) => !d.taken);
  if (next) {
    const overdue = timeToMinutes(next.time) < nowMinutes();
    nextEl.innerHTML = `
      <div class="next-up-card${overdue ? " overdue" : ""}">
        <div style="flex:1">
          <div class="next-up-label">${overdue ? "Overdue" : "Next up"}</div>
          <div class="dose-name">${escapeHtml(next.med.name)}</div>
          <div class="dose-meta">${formatTime(next.time)}${
            next.med.dosage ? " &middot; " + escapeHtml(next.med.dosage) : ""
          }</div>
        </div>
        <button class="btn btn-primary btn-sm" data-toggle="${next.med.id}|${dateStr}|${next.time}">Take</button>
      </div>`;
  } else {
    nextEl.innerHTML = `
      <div class="next-up-card">
        <div style="flex:1">
          <div class="next-up-label">Nothing left</div>
          <div class="dose-meta">Every dose is logged for today.</div>
        </div>
      </div>`;
  }

  // Group into Morning / Afternoon / Evening for scanability.
  const groups = [
    { title: "Morning", from: 0, to: 719 },
    { title: "Afternoon", from: 720, to: 1019 },
    { title: "Evening", from: 1020, to: 1439 },
  ];

  let html = "";
  for (const group of groups) {
    const inGroup = doses.filter((d) => {
      const mins = timeToMinutes(d.time);
      return mins >= group.from && mins <= group.to;
    });
    if (inGroup.length === 0) continue;
    html += `<div class="dose-group-title">${group.title}</div>`;
    for (const dose of inGroup) {
      html += doseRowHtml(dose, dateStr);
    }
  }
  listEl.innerHTML = html;
}

function doseRowHtml(dose, dateStr) {
  const overdue = !dose.taken && timeToMinutes(dose.time) < nowMinutes();
  const classes = ["dose-row"];
  if (dose.taken) classes.push("taken");
  if (overdue) classes.push("overdue");
  return `
    <div class="${classes.join(" ")}">
      <button class="dose-check" data-toggle="${dose.med.id}|${dateStr}|${dose.time}"
              aria-label="${dose.taken ? "Mark not taken" : "Mark taken"}">&#10003;</button>
      <div class="dose-info">
        <div class="dose-name">${escapeHtml(dose.med.name)}</div>
        ${dose.med.dosage ? `<div class="dose-meta">${escapeHtml(dose.med.dosage)}</div>` : ""}
        ${dose.med.instructions ? `<div class="dose-instructions">${escapeHtml(dose.med.instructions)}</div>` : ""}
      </div>
      <div class="dose-time">${dose.label ? escapeHtml(dose.label) + "<br>" : ""}${formatTime(dose.time)}</div>
    </div>`;
}

function renderHistory() {
  const grid = document.getElementById("history-grid");
  const meds = activeMeds();
  const days = lastNDays(7);
  const today = todayStr();

  if (meds.length === 0) {
    grid.innerHTML = `<div class="empty-state"><p>Nothing to chart yet.</p></div>`;
    document.getElementById("history-activity").innerHTML = "";
    return;
  }

  let html = `<div class="grid-row grid-header"><div></div>`;
  for (const d of days) {
    html += `<div class="grid-day-label">${d.toLocaleDateString(undefined, { weekday: "narrow" })}</div>`;
  }
  html += `</div>`;

  for (const med of meds) {
    html += `<div class="grid-row"><div class="grid-med-name">${escapeHtml(med.name)}</div>`;
    for (const d of days) {
      const dateStr = localDateStr(d);
      html += `<button class="grid-cell ${cellClass(med, dateStr, today)}"
                 data-day="${dateStr}" title="${dateStr}">${cellGlyph(med, dateStr, today)}</button>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;

  renderActivity();
}

function cellStatus(med, dateStr, today) {
  if (!medExistedOn(med, dateStr)) return "future";
  const total = med.schedule.length;
  const taken = med.schedule.filter((s) => isTaken(med.id, dateStr, s.time)).length;
  if (taken === total) return "full";
  if (taken > 0) return "partial";
  // Today's remaining doses aren't misses yet.
  if (dateStr === today) return "future";
  return "missed";
}

function cellClass(med, dateStr, today) {
  return cellStatus(med, dateStr, today);
}

function cellGlyph(med, dateStr, today) {
  const status = cellStatus(med, dateStr, today);
  if (status === "full") return "&#10003;";
  if (status === "partial") {
    const taken = med.schedule.filter((s) => isTaken(med.id, dateStr, s.time)).length;
    return String(taken);
  }
  if (status === "missed") return "&times;";
  return "&middot;";
}

function renderActivity() {
  const el = document.getElementById("history-activity");
  const recent = [...state.log]
    .sort((a, b) => (b.taken_at || "").localeCompare(a.taken_at || ""))
    .slice(0, 20);

  if (recent.length === 0) {
    el.innerHTML = `<div class="empty-state"><p>No doses logged yet.</p></div>`;
    return;
  }

  const medsById = Object.fromEntries(state.medications.map((m) => [m.id, m]));
  el.innerHTML = recent
    .map((entry) => {
      const med = medsById[entry.medication_id];
      if (!med) return "";
      const when = new Date(entry.taken_at);
      return `
        <div class="activity-row">
          <span class="activity-dot">&#10003;</span>
          <span>${escapeHtml(med.name)} <span style="color:var(--text-faint)">&middot; ${formatTime(entry.time)} dose</span></span>
          <span class="activity-when">${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
        </div>`;
    })
    .join("");
}

function renderManage() {
  const el = document.getElementById("manage-list");
  if (state.medications.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="icon">&#128138;</div><p>No medications yet.</p></div>`;
    return;
  }

  el.innerHTML = state.medications
    .map(
      (med) => `
      <div class="med-card${med.active ? "" : " paused"}">
        <div class="med-card-top">
          <div>
            <div class="med-card-name">${escapeHtml(med.name)}</div>
            ${med.dosage ? `<div class="med-card-dosage">${escapeHtml(med.dosage)}</div>` : ""}
            ${med.instructions ? `<div class="med-card-instructions">${escapeHtml(med.instructions)}</div>` : ""}
          </div>
          ${med.active ? "" : `<span class="paused-chip">Paused</span>`}
        </div>
        <div class="med-card-schedule">
          ${med.schedule
            .map((s) => `<span class="time-chip">${formatTime(s.time)}${s.label ? " &middot; " + escapeHtml(s.label) : ""}</span>`)
            .join("")}
        </div>
        <div class="med-card-actions">
          <button class="btn btn-ghost btn-sm" data-edit="${med.id}">Edit</button>
          <button class="btn btn-ghost btn-sm" data-toggle-active="${med.id}">${med.active ? "Pause" : "Resume"}</button>
          <button class="btn btn-danger btn-sm" data-delete="${med.id}">Delete</button>
        </div>
      </div>`
    )
    .join("");
}

function renderBackups() {
  const el = document.getElementById("backup-list");
  if (backups.length === 0) {
    el.innerHTML = `<div class="backup-empty">No backups yet. Tap Backup to snapshot your data.</div>`;
    return;
  }

  el.innerHTML = backups
    .slice(0, 10)
    .map((b) => {
      const when = new Date(b.created_at);
      return `
        <div class="backup-row">
          <span class="backup-name">${escapeHtml(b.filename)}</span>
          <span class="backup-meta">${when.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}, ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          &middot; ${formatBytes(b.size)}</span>
        </div>`;
    })
    .join("") +
    (backups.length > 10
      ? `<div class="backup-empty">+ ${backups.length - 10} older</div>`
      : "");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function createBackup() {
  const btn = document.getElementById("btn-backup");
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    const result = await api("/api/backup", { method: "POST" });
    await loadBackups();
    renderBackups();
    showToast(`Saved ${result.filename}`);
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Backup";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

// ---- Interaction ----

function switchView(viewId) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === viewId));
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === viewId));
  window.scrollTo(0, 0);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 1800);
}

async function toggleDose(medId, dateStr, time) {
  try {
    const result = await api("/api/log/toggle", {
      method: "POST",
      body: JSON.stringify({ medication_id: medId, date: dateStr, time }),
    });
    // Keep local state in sync without a full refetch.
    if (result.taken) {
      state.log.push(result.entry);
      if (navigator.vibrate) navigator.vibrate(15);
    } else {
      state.log = state.log.filter(
        (e) => !(e.medication_id === medId && e.date === dateStr && e.time === time)
      );
    }
    render();
    if (dayModalDate) renderDayModal(dayModalDate);
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Medication modal ----

function addScheduleRow(time = "08:00", label = "") {
  const container = document.getElementById("schedule-rows");
  const row = document.createElement("div");
  row.className = "schedule-row";
  row.innerHTML = `
    <input type="time" value="${time}" required>
    <input type="text" placeholder="Label (optional)" maxlength="24" value="${escapeHtml(label)}">
    <button type="button" class="btn-remove-time" aria-label="Remove time">&times;</button>`;
  row.querySelector(".btn-remove-time").addEventListener("click", () => {
    if (container.children.length > 1) row.remove();
    else showToast("At least one time is required");
  });
  container.appendChild(row);
}

function openMedModal(med) {
  editingMedId = med ? med.id : null;
  document.getElementById("med-modal-title").textContent = med ? "Edit Medication" : "Add Medication";
  document.getElementById("med-name").value = med ? med.name : "";
  document.getElementById("med-dosage").value = med ? med.dosage : "";
  document.getElementById("med-instructions").value = med ? med.instructions : "";

  const rows = document.getElementById("schedule-rows");
  rows.innerHTML = "";
  if (med && med.schedule.length) {
    med.schedule.forEach((s) => addScheduleRow(s.time, s.label));
  } else {
    addScheduleRow();
  }

  document.getElementById("med-modal").classList.add("open");
}

function closeMedModal() {
  document.getElementById("med-modal").classList.remove("open");
  editingMedId = null;
}

async function submitMedForm(event) {
  event.preventDefault();

  const schedule = [...document.querySelectorAll("#schedule-rows .schedule-row")]
    .map((row) => {
      const inputs = row.querySelectorAll("input");
      return { time: inputs[0].value, label: inputs[1].value.trim() };
    })
    .filter((s) => s.time);

  if (schedule.length === 0) {
    showToast("Add at least one time");
    return;
  }

  const payload = {
    name: document.getElementById("med-name").value.trim(),
    dosage: document.getElementById("med-dosage").value.trim(),
    instructions: document.getElementById("med-instructions").value.trim(),
    schedule,
  };

  try {
    if (editingMedId) {
      await api(`/api/medications/${editingMedId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      showToast("Medication updated");
    } else {
      await api("/api/medications", { method: "POST", body: JSON.stringify(payload) });
      showToast("Medication added");
    }
    closeMedModal();
    await loadData();
    render();
  } catch (err) {
    showToast(err.message);
  }
}

async function toggleActive(medId) {
  const med = state.medications.find((m) => m.id === medId);
  if (!med) return;
  try {
    await api(`/api/medications/${medId}`, {
      method: "PUT",
      body: JSON.stringify({ active: !med.active }),
    });
    await loadData();
    render();
    showToast(med.active ? "Paused" : "Resumed");
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteMedication(medId) {
  const med = state.medications.find((m) => m.id === medId);
  if (!med) return;
  if (!confirm(`Delete ${med.name} and its history?`)) return;
  try {
    await api(`/api/medications/${medId}`, { method: "DELETE" });
    await loadData();
    render();
    showToast("Deleted");
  } catch (err) {
    showToast(err.message);
  }
}

// ---- Day detail modal ----

function renderDayModal(dateStr) {
  const doses = dosesForDate(dateStr);
  const d = new Date(dateStr + "T12:00:00");
  document.getElementById("day-modal-title").textContent = d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  document.getElementById("day-modal-list").innerHTML = doses
    .filter((dose) => medExistedOn(dose.med, dateStr))
    .map(
      (dose) => `
      <div class="day-dose-row">
        <button class="dose-check" data-toggle="${dose.med.id}|${dateStr}|${dose.time}"
                style="${dose.taken ? "background:var(--green);border-color:var(--green);color:#0f1117" : ""}">&#10003;</button>
        <div class="dose-info">
          <div class="dose-name">${escapeHtml(dose.med.name)}</div>
          ${dose.med.dosage ? `<div class="dose-meta">${escapeHtml(dose.med.dosage)}</div>` : ""}
        </div>
        <div class="dose-time">${formatTime(dose.time)}</div>
      </div>`
    )
    .join("") || `<div class="empty-state"><p>Nothing was scheduled.</p></div>`;
}

function openDayModal(dateStr) {
  dayModalDate = dateStr;
  renderDayModal(dateStr);
  document.getElementById("day-modal").classList.add("open");
}

function closeDayModal() {
  document.getElementById("day-modal").classList.remove("open");
  dayModalDate = null;
}

// ---- Wiring ----

document.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const [medId, dateStr, time] = toggle.dataset.toggle.split("|");
    toggleDose(medId, dateStr, time);
    return;
  }

  const editBtn = event.target.closest("[data-edit]");
  if (editBtn) {
    const med = state.medications.find((m) => m.id === editBtn.dataset.edit);
    if (med) openMedModal(med);
    return;
  }

  const activeBtn = event.target.closest("[data-toggle-active]");
  if (activeBtn) {
    toggleActive(activeBtn.dataset.toggleActive);
    return;
  }

  const deleteBtn = event.target.closest("[data-delete]");
  if (deleteBtn) {
    deleteMedication(deleteBtn.dataset.delete);
    return;
  }

  const dayCell = event.target.closest("[data-day]");
  if (dayCell) {
    openDayModal(dayCell.dataset.day);
    return;
  }

  const tab = event.target.closest(".tab-btn");
  if (tab) switchView(tab.dataset.view);
});

document.getElementById("btn-add-med").addEventListener("click", () => openMedModal(null));
document.getElementById("btn-backup").addEventListener("click", createBackup);
document.getElementById("btn-add-time").addEventListener("click", () => addScheduleRow());
document.getElementById("btn-cancel-med").addEventListener("click", closeMedModal);
document.getElementById("med-form").addEventListener("submit", submitMedForm);
document.getElementById("btn-close-day").addEventListener("click", closeDayModal);

// Tapping the dimmed backdrop closes a sheet.
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      overlay.classList.remove("open");
      if (overlay.id === "day-modal") dayModalDate = null;
    }
  });
});

// Re-render when the app comes back to the foreground so "overdue" and the
// current date stay accurate after the phone has been asleep.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadData().then(render).catch(() => {});
});

Promise.all([loadData(), loadBackups()])
  .then(render)
  .catch((err) => showToast(err.message));
