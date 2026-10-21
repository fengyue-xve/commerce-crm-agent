"""Actual local HTTP + owned-process restart; synthetic CRM records only."""
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = "http://127.0.0.1:15273"

def call(path, body=None):
    request = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Origin": BASE})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

def main():
    if call("/api/health")["provider"] != "official-pi-faux":
        raise RuntimeError("This smoke test requires the offline Faux engine")
    baseline = call("/api/state")
    call("/api/demo/reset", {"confirmed": True, "generation": baseline["generation"]})
    draft = call("/api/drafts", {"sku": "AUD-001", "mode": "historical_replay"})
    update = next(p for p in draft["proposals"] if p["effect"] == "reversible_write")
    external = next(p for p in draft["proposals"] if p["effect"] == "external")
    call(f'/api/drafts/{draft["id"]}/review', {"revision": 1})
    call(f'/api/proposals/{update["id"]}/execute', {"revision": 1})
    before = call("/api/state")
    for command in ["stop", "start"]:
        subprocess.run([sys.executable, "scripts/portfolio/demo.py", command], cwd=ROOT, check=True)
    after = call("/api/state")
    assert before == after, "Restart lost or changed persisted state"
    undone = call(f'/api/proposals/{update["id"]}/undo', {"revision": 2})
    assert undone["opportunity"]["version"] == 3 and undone["opportunity"]["stage"] == "new"
    approved = call(f'/api/proposals/{external["id"]}/approve', {"revision": 1})
    assert approved["proposal"]["status"] == "approved" and approved["sent"] is False
    result = {"checks_passed": 7, "real_http": True, "real_process_restart": True,
              "persisted_draft_review_proposal_snapshot_audit": before == after,
              "compensation_version": 3, "external_approved": True, "sent": False}
    output = ROOT / "output/portfolio/persistence-summary.json"
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result))

if __name__ == "__main__":
    main()
