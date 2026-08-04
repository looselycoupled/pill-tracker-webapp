"""Pill Tracker — a tiny Flask app for tracking daily medications.

All "what day is it / what time is it" logic happens client-side (the
front-end sends explicit date/time strings with every request) so the app
behaves correctly on a phone regardless of what timezone the server
container happens to run in. The server just persists medications and a
log of taken doses to a JSON file.
"""
from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
DATA_FILE = os.path.join(DATA_DIR, "pills.json")
BACKUP_DIR = os.path.join(DATA_DIR, "backups")

# Keep the activity log from growing forever on a device that's never cleaned up.
LOG_RETENTION_DAYS = 120


def get_default_data() -> dict:
    return {"medications": [], "log": []}


def load_data() -> dict:
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            data = json.load(f)
        data.setdefault("medications", [])
        data.setdefault("log", [])
        return data
    return get_default_data()


def save_data(data: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp_path = DATA_FILE + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, DATA_FILE)


def prune_log(data: dict) -> None:
    """Drop log entries older than LOG_RETENTION_DAYS to keep the file small."""
    cutoff = datetime.now(timezone.utc).timestamp() - LOG_RETENTION_DAYS * 86400
    kept = []
    for entry in data["log"]:
        try:
            logged_at = datetime.fromisoformat(entry["date"]).timestamp()
        except (KeyError, ValueError):
            kept.append(entry)
            continue
        if logged_at >= cutoff:
            kept.append(entry)
    data["log"] = kept


def find_medication(data: dict, med_id: str) -> dict | None:
    for med in data["medications"]:
        if med["id"] == med_id:
            return med
    return None


def normalize_schedule(raw_schedule) -> list:
    schedule = []
    if not isinstance(raw_schedule, list):
        return schedule
    for item in raw_schedule:
        if not isinstance(item, dict):
            continue
        time_str = str(item.get("time", "")).strip()
        if not time_str:
            continue
        try:
            hh, mm = time_str.split(":")
            hh, mm = int(hh), int(mm)
            if not (0 <= hh <= 23 and 0 <= mm <= 59):
                continue
            time_str = f"{hh:02d}:{mm:02d}"
        except (ValueError, AttributeError):
            continue
        schedule.append({
            "time": time_str,
            "label": str(item.get("label", "")).strip(),
        })
    schedule.sort(key=lambda s: s["time"])
    return schedule


# ---- Routes ----

@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/data")
def api_data():
    data = load_data()
    return jsonify(data)


@app.post("/api/medications")
def add_medication():
    data = load_data()
    body = request.get_json(silent=True) or {}

    name = str(body.get("name", "")).strip()
    if not name:
        return jsonify(error="Name is required"), 400

    schedule = normalize_schedule(body.get("schedule"))
    if not schedule:
        return jsonify(error="At least one scheduled time is required"), 400

    med = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "dosage": str(body.get("dosage", "")).strip(),
        "instructions": str(body.get("instructions", "")).strip(),
        "schedule": schedule,
        "active": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    data["medications"].append(med)
    save_data(data)
    return jsonify(med), 201


@app.put("/api/medications/<med_id>")
def update_medication(med_id):
    data = load_data()
    med = find_medication(data, med_id)
    if med is None:
        return jsonify(error="Medication not found"), 404

    body = request.get_json(silent=True) or {}

    if "name" in body:
        name = str(body.get("name", "")).strip()
        if not name:
            return jsonify(error="Name is required"), 400
        med["name"] = name

    if "dosage" in body:
        med["dosage"] = str(body.get("dosage", "")).strip()

    if "instructions" in body:
        med["instructions"] = str(body.get("instructions", "")).strip()

    if "schedule" in body:
        schedule = normalize_schedule(body.get("schedule"))
        if not schedule:
            return jsonify(error="At least one scheduled time is required"), 400
        med["schedule"] = schedule

    if "active" in body:
        med["active"] = bool(body.get("active"))

    save_data(data)
    return jsonify(med)


@app.delete("/api/medications/<med_id>")
def delete_medication(med_id):
    data = load_data()
    med = find_medication(data, med_id)
    if med is None:
        return jsonify(error="Medication not found"), 404

    data["medications"] = [m for m in data["medications"] if m["id"] != med_id]
    data["log"] = [entry for entry in data["log"] if entry["medication_id"] != med_id]
    save_data(data)
    return jsonify(status="ok")


@app.post("/api/log/toggle")
def toggle_log():
    """Flip the taken/not-taken state for one scheduled dose on one date."""
    data = load_data()
    body = request.get_json(silent=True) or {}

    med_id = body.get("medication_id")
    date_str = str(body.get("date", "")).strip()
    time_str = str(body.get("time", "")).strip()

    if not med_id or not date_str or not time_str:
        return jsonify(error="medication_id, date, and time are required"), 400

    if find_medication(data, med_id) is None:
        return jsonify(error="Medication not found"), 404

    existing = next(
        (
            e for e in data["log"]
            if e["medication_id"] == med_id and e["date"] == date_str and e["time"] == time_str
        ),
        None,
    )

    if existing:
        data["log"].remove(existing)
        save_data(data)
        return jsonify(taken=False)

    entry = {
        "id": uuid.uuid4().hex[:12],
        "medication_id": med_id,
        "date": date_str,
        "time": time_str,
        "taken_at": datetime.now(timezone.utc).isoformat(),
    }
    data["log"].append(entry)
    prune_log(data)
    save_data(data)
    return jsonify(taken=True, entry=entry)


@app.post("/api/backup")
def create_backup():
    """Snapshot the data file into data/backups/ with a timestamped name."""
    # Timestamp uses the container's local clock (TZ is set in compose) so the
    # filename reads the way you'd expect when browsing the directory.
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"pills-{stamp}.json"
    os.makedirs(BACKUP_DIR, exist_ok=True)
    destination = os.path.join(BACKUP_DIR, filename)

    if os.path.exists(DATA_FILE):
        shutil.copy2(DATA_FILE, destination)
    else:
        # Nothing saved yet — write out the current (empty) state so the
        # backup is still a valid, restorable file.
        with open(destination, "w") as f:
            json.dump(load_data(), f, indent=2)

    return jsonify(
        filename=filename,
        size=os.path.getsize(destination),
        count=len(list_backups()),
    ), 201


@app.get("/api/backups")
def get_backups():
    return jsonify(backups=list_backups())


def backup_created_at(filename: str, path: str) -> str:
    """When the backup was taken, as an absolute ISO timestamp.

    Read from the filename rather than the file's mtime: shutil.copy2 carries
    the *source* file's mtime across, so a fresh backup of an old pills.json
    would otherwise claim to have been made whenever that file last changed.
    """
    try:
        stamp = filename[len("pills-"):-len(".json")]
        # Naive local time (that's what the filename encodes) — attach the
        # server's UTC offset so clients in another zone still read it right.
        local = datetime.strptime(stamp, "%Y%m%d-%H%M%S").astimezone()
        return local.isoformat()
    except ValueError:
        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()


def list_backups() -> list:
    """Backups newest-first, as {filename, size, created_at}."""
    if not os.path.isdir(BACKUP_DIR):
        return []
    entries = []
    for name in os.listdir(BACKUP_DIR):
        if not (name.startswith("pills-") and name.endswith(".json")):
            continue
        path = os.path.join(BACKUP_DIR, name)
        entries.append({
            "filename": name,
            "size": os.path.getsize(path),
            "created_at": backup_created_at(name, path),
        })
    entries.sort(key=lambda e: e["filename"], reverse=True)
    return entries


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


if __name__ == "__main__":
    # Local dev entry point — Docker uses gunicorn (see Dockerfile CMD).
    app.run(host="0.0.0.0", port=8000, debug=True)
