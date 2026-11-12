# ── SETUP: packages and API key ─────────────────────────────────────────────
# Installs only what is missing (Google Colab already has all of it), then finds
# your API key under the name in API_KEY_NAME (CONFIG cell): the Colab Secrets panel
# first, then the environment variable of that name. MODE = "live" also asks for it with a hidden prompt.
# The key is never printed and never stored in the notebook.
import importlib.util
import os
import subprocess
import sys

_needed = ["requests", "pandas", "matplotlib", "pyarrow", "openpyxl"]
_missing = [p for p in _needed if importlib.util.find_spec(p) is None]
if _missing:
    print("installing:", ", ".join(_missing))
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *_missing])

API_KEY = None
if MODE != "demo":
    try:
        from google.colab import userdata  # Colab: the Secrets panel (key icon, left sidebar)
        API_KEY = userdata.get(API_KEY_NAME)
    except Exception:
        pass
    API_KEY = API_KEY or os.environ.get(API_KEY_NAME)
    if not API_KEY and MODE == "live":
        from getpass import getpass
        API_KEY = getpass("SuReSuite API key (sk_test_… or sk_live_…): ").strip()
    if API_KEY and not API_KEY.startswith("sk_"):
        raise ValueError("an API key starts with sk_test_ or sk_live_ — create one on the app's /developer page")
    if MODE == "live" and not API_KEY:
        raise ValueError(f"MODE is \"live\" but no API key was found under {API_KEY_NAME}")

LIVE = bool(API_KEY)
if LIVE:
    print(f"LIVE mode — {API_KEY.split('_')[1]} key from {API_KEY_NAME}, talking to {BASE_URL}")
else:
    print("DEMO mode — no API key found, so this notebook replays recorded engine output for the\n"
          "Example project (1 product, 2 materials, 3 suppliers). Every cell runs the same way in\n"
          "live mode. To go live, add your key as {API_KEY_NAME} (see the Setup notes) and run all cells again.".replace("{API_KEY_NAME}", API_KEY_NAME))
